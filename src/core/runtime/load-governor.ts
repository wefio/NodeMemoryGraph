import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import { monitorEventLoopDelay, performance, type IntervalHistogram } from "node:perf_hooks";
import type { RuntimePowerProfile } from "../capability-config.ts";

export type HostLoadState = "idle" | "light" | "heavy";

export interface HostTelemetrySample {
  readonly eventLoopUtilization: number;
  readonly p99DelayMs: number;
  readonly onBattery?: boolean;
  readonly thermalThrottled?: boolean;
  readonly loadAvgPerCore?: number;
  readonly hostCpuUtilization?: number;
  readonly nowMs: number;
}

export interface AdaptiveDispatchBudget {
  readonly profile: RuntimePowerProfile;
  readonly loadState: HostLoadState;
  readonly maxBackgroundConcurrency: number;
  readonly backgroundCpuBudgetMs: number;
  readonly preferWorkerOffload: boolean;
  readonly recommendedWorkers: number;
  readonly hostCpuUtilization?: number;
  readonly onBattery: boolean;
  readonly thermalThrottled: boolean;
  readonly telemetryAvailable: { readonly power: boolean; readonly thermal: boolean };
}

interface ProfileBudgetSpec {
  readonly enterHeavyElu: number;
  readonly exitHeavyElu: number;
  readonly enterIdleElu: number;
  readonly exitIdleElu: number;
  readonly heavyDelayMs: number;
  readonly maxBgByState: Readonly<Record<HostLoadState, number>>;
  readonly cpuBudgetMsByState: Readonly<Record<HostLoadState, number>>;
  readonly maxWorkerRatio: number;
}

const PROFILE_SPECS: Readonly<Record<RuntimePowerProfile, ProfileBudgetSpec>> = {
  eco: {
    enterHeavyElu: 0.65,
    exitHeavyElu: 0.45,
    enterIdleElu: 0.12,
    exitIdleElu: 0.22,
    heavyDelayMs: 35,
    maxBgByState: { idle: 2, light: 1, heavy: 1 },
    cpuBudgetMsByState: { idle: 25, light: 12, heavy: 4 },
    maxWorkerRatio: 0.25,
  },
  balanced: {
    enterHeavyElu: 0.8,
    exitHeavyElu: 0.6,
    enterIdleElu: 0.15,
    exitIdleElu: 0.28,
    heavyDelayMs: 55,
    maxBgByState: { idle: 4, light: 2, heavy: 1 },
    cpuBudgetMsByState: { idle: 50, light: 25, heavy: 8 },
    maxWorkerRatio: 0.5,
  },
  performance: {
    enterHeavyElu: 0.92,
    exitHeavyElu: 0.72,
    enterIdleElu: 0.2,
    exitIdleElu: 0.35,
    heavyDelayMs: 85,
    maxBgByState: { idle: 8, light: 4, heavy: 2 },
    cpuBudgetMsByState: { idle: 100, light: 50, heavy: 16 },
    maxWorkerRatio: 0.85,
  },
};

function probePowerSupply(): { onBattery?: boolean; powerAvailable: boolean } {
  try {
    for (const entry of readdirSync("/sys/class/power_supply")) {
      const onlinePath = `/sys/class/power_supply/${entry}/online`;
      const typePath = `/sys/class/power_supply/${entry}/type`;
      if (!existsSync(onlinePath) || !existsSync(typePath)) continue;
      if (readFileSync(typePath, "utf8").trim() === "Mains") {
        return { powerAvailable: true, onBattery: readFileSync(onlinePath, "utf8").trim() === "0" };
      }
    }
  } catch {
    // Power supply sysfs entries are unavailable in containers or restricted environments.
  }
  return { powerAvailable: false };
}

function probeThermalZones(): { thermalThrottled?: boolean; thermalAvailable: boolean } {
  let thermalAvailable = false;
  try {
    for (const zone of readdirSync("/sys/class/thermal")) {
      const tempPath = `/sys/class/thermal/${zone}/temp`;
      if (!existsSync(tempPath)) continue;
      const milliC = Number.parseInt(readFileSync(tempPath, "utf8").trim(), 10);
      if (!Number.isFinite(milliC)) continue;
      thermalAvailable = true;
      if (milliC >= 85_000) return { thermalAvailable: true, thermalThrottled: true };
    }
  } catch {
    return { thermalAvailable: false };
  }
  return { thermalAvailable };
}

function probeLinuxSysfsTelemetry() {
  if (process.platform !== "linux") {
    return {
      powerAvailable: false,
      thermalAvailable: false,
      onBattery: undefined,
      thermalThrottled: undefined,
    };
  }
  return { ...probePowerSupply(), ...probeThermalZones() };
}

function readCpuTimes(): { total: number; idle: number } {
  let total = 0;
  let idle = 0;
  try {
    for (const { times } of os.cpus()) {
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
  } catch {
    // Some managed hosts expose Node compatibility without host CPU counters.
  }
  return { total, idle };
}

export function availableHostCores(): number {
  try {
    return Math.max(1, os.availableParallelism());
  } catch {
    return 1;
  }
}

/**
 * BOINC-inspired adaptive host load & power/thermal governor.
 * Hysteresis limits changes in background admission. CPU and event-loop counters
 * remain useful when the host exposes no hardware power or thermal telemetry.
 */
export class HostLoadGovernor {
  private profile: RuntimePowerProfile;
  private state: HostLoadState = "idle";
  private lastTransitionMs = 0;
  private readonly minDwellMs: number;
  private lastElu = performance.eventLoopUtilization();
  private lastCpu = readCpuTimes();
  private lastSampleMs = Date.now();
  private lastBudget?: AdaptiveDispatchBudget;
  private sysfs = probeLinuxSysfsTelemetry();
  private lastSysfsMs = Date.now();
  private readonly cores = availableHostCores();
  private readonly delayMonitor?: IntervalHistogram;

  constructor(
    options: {
      readonly profile?: RuntimePowerProfile;
      readonly minDwellMs?: number;
      readonly enableDelayMonitor?: boolean;
    } = {},
  ) {
    this.profile = options.profile ?? "balanced";
    this.minDwellMs = Math.max(0, options.minDwellMs ?? 1500);
    if (options.enableDelayMonitor) {
      this.delayMonitor = monitorEventLoopDelay({ resolution: 20 });
      this.delayMonitor.enable();
    }
  }

  setProfile(profile: RuntimePowerProfile): void {
    this.profile = profile;
    this.lastBudget = undefined;
  }

  currentState(): HostLoadState {
    return this.state;
  }

  sampleHost(nowMs = Date.now()): AdaptiveDispatchBudget {
    if (this.lastBudget && nowMs - this.lastSampleMs < 250) return this.lastBudget;
    const currentElu = performance.eventLoopUtilization(this.lastElu);
    this.lastElu = performance.eventLoopUtilization();
    const p99DelayMs = this.delayMonitor?.count ? this.delayMonitor.percentile(99) / 1e6 : 0;
    this.delayMonitor?.reset();
    const cpu = readCpuTimes();
    const elapsed = cpu.total - this.lastCpu.total;
    const hostCpuUtilization =
      elapsed > 0
        ? Math.max(0, Math.min(1, 1 - (cpu.idle - this.lastCpu.idle) / elapsed))
        : this.lastBudget?.hostCpuUtilization;
    this.lastCpu = cpu;
    this.lastSampleMs = nowMs;
    if (nowMs - this.lastSysfsMs >= 5000) {
      this.sysfs = probeLinuxSysfsTelemetry();
      this.lastSysfsMs = nowMs;
    }
    const sysfs = this.sysfs;
    this.lastBudget = this.evaluateSample(
      {
        eventLoopUtilization: currentElu.utilization,
        p99DelayMs: Number.isFinite(p99DelayMs) ? p99DelayMs : 0,
        onBattery: sysfs.onBattery,
        thermalThrottled: sysfs.thermalThrottled,
        hostCpuUtilization,
        nowMs,
      },
      { power: sysfs.powerAvailable, thermal: sysfs.thermalAvailable },
    );
    return this.lastBudget;
  }

  evaluateSample(
    sample: HostTelemetrySample,
    telemetryAvailable: { readonly power: boolean; readonly thermal: boolean } = {
      power: false,
      thermal: false,
    },
  ): AdaptiveDispatchBudget {
    const spec = PROFILE_SPECS[this.profile];
    const effectiveLoad = Math.max(
      sample.eventLoopUtilization,
      sample.hostCpuUtilization ?? 0,
      sample.loadAvgPerCore !== undefined ? Math.min(1, sample.loadAvgPerCore) : 0,
    );
    const isHeavySignal =
      effectiveLoad >= spec.enterHeavyElu ||
      sample.p99DelayMs >= spec.heavyDelayMs ||
      sample.thermalThrottled === true;
    const isIdleSignal =
      effectiveLoad <= spec.enterIdleElu &&
      sample.p99DelayMs < spec.heavyDelayMs * 0.25 &&
      !sample.thermalThrottled;

    if (sample.nowMs - this.lastTransitionMs >= this.minDwellMs) {
      const next = this.nextState(
        effectiveLoad,
        sample.p99DelayMs,
        isHeavySignal,
        isIdleSignal,
        spec,
      );
      if (next !== this.state) {
        this.state = next;
        this.lastTransitionMs = sample.nowMs;
      }
    }

    const batteryScale = sample.onBattery ? 0.5 : 1;
    const rawBg = Math.max(1, Math.floor(spec.maxBgByState[this.state] * batteryScale));
    return {
      profile: this.profile,
      loadState: this.state,
      maxBackgroundConcurrency: sample.thermalThrottled ? 1 : rawBg,
      backgroundCpuBudgetMs: Math.max(
        4,
        Math.floor(
          spec.cpuBudgetMsByState[this.state] * (sample.thermalThrottled ? 0.5 : batteryScale),
        ),
      ),
      preferWorkerOffload: this.state !== "heavy" && !sample.thermalThrottled,
      recommendedWorkers: this.workerBudget(spec, sample.hostCpuUtilization ?? 0, batteryScale),
      hostCpuUtilization: sample.hostCpuUtilization,
      onBattery: sample.onBattery === true,
      thermalThrottled: sample.thermalThrottled === true,
      telemetryAvailable,
    };
  }

  private workerBudget(spec: ProfileBudgetSpec, cpu: number, batteryScale: number): number {
    if (this.state === "heavy" || this.cores <= 1) return 0;
    const stateScale = this.state === "light" ? 0.5 : 1;
    return Math.max(
      1,
      Math.floor(this.cores * Math.min(spec.maxWorkerRatio * stateScale * batteryScale, 1 - cpu)),
    );
  }

  private nextState(
    elu: number,
    p99DelayMs: number,
    isHeavy: boolean,
    isIdle: boolean,
    spec: ProfileBudgetSpec,
  ): HostLoadState {
    if (isHeavy) return "heavy";
    if (this.state === "heavy") {
      return elu <= spec.exitHeavyElu && p99DelayMs < spec.heavyDelayMs * 0.6 ? "light" : "heavy";
    }
    if (this.state === "idle")
      return elu >= spec.exitIdleElu || p99DelayMs >= spec.heavyDelayMs * 0.6 ? "light" : "idle";
    return isIdle ? "idle" : "light";
  }

  close(): void {
    this.delayMonitor?.disable();
  }
}
