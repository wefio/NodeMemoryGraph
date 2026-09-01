// Lightweight full-run resource observability for the unified OmniMemEval
// runner.
//
// The sampler is a pure OBSERVER: it never changes scheduling, concurrency, or
// any runner argument. It enumerates the benchmark process tree at a low fixed
// cadence, records CPU time/utilization and RSS per discovered process (plus
// optional GPU/VRAM when nvidia-smi is available), and emits one bounded
// `resource_report.json` artifact so CPU saturation, memory peaks, GPU use, and
// likely wait sources can be evaluated alongside latency and throughput.
//
// Cross-platform process enumeration without third-party dependencies:
//   - Windows: PowerShell Get-CimInstance Win32_Process (ProcessId,
//     ParentProcessId, WorkingSetSize, kernel/user mode time in 100ns ticks)
//   - POSIX:   `ps -eo pid=,ppid=,rss=,time=` (RSS in KiB, time as [[dd-]hh:]mm:ss)
// GPU (optional): `nvidia-smi --query-gpu=utilization.gpu,memory.used,memory.total
// --format=csv,noheader,nounits` sampled once per tick.

import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface ProcessSample {
  pid: number;
  ppid: number | null;
  /** Resident set size in bytes (0 when the platform view cannot provide it). */
  rssBytes: number;
  /** Cumulative CPU time in milliseconds across the process lifetime. */
  cpuMs: number;
  /** CPU utilization % relative to the sampling interval, 0 when unknown. */
  cpuPercent: number;
  /** Role label: the shallowest known benchmark role (runner/python/worker/other). */
  role: string;
}

export interface GpuSample {
  /** GPU index. */
  index: number;
  /** GPU utilization percent (0..100). */
  utilizationPercent: number;
  /** Used VRAM in bytes. */
  memoryUsedBytes: number;
  /** Total VRAM in bytes. */
  memoryTotalBytes: number;
}

export interface ResourceTick {
  /** ISO timestamp of the tick. */
  at: string;
  /** Wall-clock offset from sampler start, ms. */
  elapsedMs: number;
  processes: ProcessSample[];
  gpu?: GpuSample[];
}

export interface ResourceReport {
  /** Benchmark version/suite label supplied by the caller. */
  label: string;
  /** Sampling cadence in ms. */
  cadenceMs: number;
  /** Root PID whose subtree was sampled. */
  rootPid: number;
  startedAt: string;
  endedAt: string;
  /** Bounded list of ticks (oldest first). */
  ticks: ResourceTick[];
  /** Aggregated summary over all ticks. */
  summary: {
    processCountMax: number;
    /** Peak RSS across all processes in any single tick, bytes. */
    peakTotalRssBytes: number;
    /** Peak per-process RSS observed, bytes. */
    peakProcessRssBytes: number;
    /** CPU utilization % of the root subtree at the tick where it peaked. */
    peakCpuPercent: number;
    gpuPeakUtilizationPercent: number | null;
    gpuPeakMemoryUsedBytes: number | null;
  };
}

const ROLE_PATTERNS: Array<[RegExp, string]> = [
  [/python/i, "python"],
  [/node/i, "node"],
  [/bash|sh\b/i, "shell"],
];

function roleFor(command: string): string {
  for (const [pattern, role] of ROLE_PATTERNS) {
    if (pattern.test(command)) return role;
  }
  return "other";
}

interface RawProcess {
  pid: number;
  ppid: number | null;
  rssBytes: number;
  cpuMs: number;
  command: string;
}

/** Parse CPU seconds from `ps` time format `[[dd-]hh:]mm:ss`. */
export function parsePsCpuTime(value: string): number {
  const match = String(value)
    .trim()
    .match(/(?:(\d+)-)?(\d+):(\d+):(\d+)/);
  if (!match) return 0;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  const seconds = Number(match[4]);
  return ((days * 24 + hours) * 60 + minutes) * 60 + seconds;
}

function parsePsTree(output: string): RawProcess[] {
  const rows: RawProcess[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rssBytes: Number(match[3]) * 1024,
      cpuMs: Math.round(parsePsCpuTime(match[4]) * 1000),
      command: String(match[5]),
    });
  }
  return rows;
}

/** Windows: PowerShell Get-CimInstance (wmic is removed on modern Windows). */
function parseWmicTree(output: string): RawProcess[] {
  const parsed = JSON.parse(output) as
    | Array<{
        ProcessId: number;
        ParentProcessId: number | null;
        WorkingSetSize?: number;
        KernelModeTime?: string;
        UserModeTime?: string;
        Name?: string;
      }>
    | {
        ProcessId: number;
        ParentProcessId: number | null;
        WorkingSetSize?: number;
        KernelModeTime?: string;
        UserModeTime?: string;
        Name?: string;
      };
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rows: RawProcess[] = [];
  for (const item of list) {
    if (!Number.isInteger(item.ProcessId) || item.ProcessId <= 0) continue;
    // CIM times are 100-nanosecond intervals; /10000 converts to ms.
    const kernelMs = Math.round(Number(item.KernelModeTime ?? 0) / 10_000);
    const userMs = Math.round(Number(item.UserModeTime ?? 0) / 10_000);
    rows.push({
      pid: item.ProcessId,
      ppid: Number(item.ParentProcessId) || null,
      rssBytes: Number(item.WorkingSetSize ?? 0),
      cpuMs: kernelMs + userMs,
      command: String(item.Name ?? ""),
    });
  }
  return rows;
}

function windowsEnumerationScript(): string {
  // Run powershell.exe directly (not via cmd.exe, whose /s /c quoting mangles
  // embedded quotes). Get-CimInstance is the modern WMI provider; the legacy
  // wmic.exe is absent on current Windows.
  return (
    "Get-CimInstance Win32_Process | " +
    "Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,Name | " +
    "ConvertTo-Json -Compress"
  );
}

/** Synchronous process-table enumeration (used by the testable tick API). */
function enumerateProcessesSync(): RawProcess[] {
  try {
    if (process.platform === "win32") {
      const output = execFileSync(
        "powershell.exe",
        ["-NoProfile", "-Command", windowsEnumerationScript()],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      return parseWmicTree(output);
    }
    const output = execFileSync("ps", ["-eo", "pid=,ppid=,rss=,time=,comm="], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return parsePsTree(output);
  } catch {
    // Sampling must never crash the benchmark; an unavailable process view
    // yields an empty tree for this tick.
    return [];
  }
}

/** Asynchronous process-table enumeration (non-blocking, used by the sampler). */
function enumerateProcessesAsync(): Promise<RawProcess[]> {
  return new Promise((resolve) => {
    const handle = (error: Error | null, stdout: string) => {
      if (error) return resolve([]);
      try {
        resolve(process.platform === "win32" ? parseWmicTree(stdout) : parsePsTree(stdout));
      } catch {
        resolve([]);
      }
    };
    if (process.platform === "win32") {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-Command", windowsEnumerationScript()],
        { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true },
        (error, stdout) => handle(error, stdout),
      );
    } else {
      execFile(
        "ps",
        ["-eo", "pid=,ppid=,rss=,time=,comm="],
        { encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
        (error, stdout) => handle(error, stdout),
      );
    }
  });
}

/** Walk the process table and return only the subtree rooted at rootPid. */
function subtree(rootPid: number, all: RawProcess[]): Map<number, RawProcess> {
  const selected = new Map<number, RawProcess>();
  const byParent = new Map<number, RawProcess[]>();
  for (const row of all) {
    if (row.ppid == null) continue;
    const children = byParent.get(row.ppid) ?? [];
    children.push(row);
    byParent.set(row.ppid, children);
  }
  const queue = [rootPid];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const row = all.find((candidate) => candidate.pid === pid);
    if (row && !selected.has(pid)) {
      selected.set(pid, row);
      for (const child of byParent.get(pid) ?? []) queue.push(child.pid);
    }
  }
  return selected;
}

function sampleGpu(): GpuSample[] | null {
  try {
    const output = execFileSync(
      "nvidia-smi",
      [
        "--query-gpu=index,utilization.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits",
      ],
      { encoding: "utf8", maxBuffer: 1024 * 1024 },
    );
    const samples: GpuSample[] = [];
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      const parts = line.split(",").map((part) => part.trim());
      if (parts.length < 4) continue;
      samples.push({
        index: Number(parts[0]),
        utilizationPercent: Number(parts[1]),
        memoryUsedBytes: Math.round(Number(parts[2]) * 1024 * 1024),
        memoryTotalBytes: Math.round(Number(parts[3]) * 1024 * 1024),
      });
    }
    return samples.length > 0 ? samples : null;
  } catch {
    return null; // no GPU / nvidia-smi absent — optional by design
  }
}

/** Build one tick from an already-enumerated process table (pure logic). */
function buildTick(
  all: RawProcess[],
  rootPid: number,
  elapsedMs: number,
  previous: Map<number, number> | null,
): ResourceTick {
  const selected = subtree(rootPid, all);
  const nowIso = new Date().toISOString();
  const processes: ProcessSample[] = [];
  for (const [pid, row] of selected) {
    const previousMs = previous?.get(pid) ?? null;
    const cpuPercent =
      previousMs != null && elapsedMs > 0
        ? Math.min(100, Math.max(0, ((row.cpuMs - previousMs) / elapsedMs) * 100))
        : 0;
    processes.push({
      pid,
      ppid: row.ppid,
      rssBytes: row.rssBytes,
      cpuMs: row.cpuMs,
      cpuPercent,
      role: roleFor(row.command),
    });
  }
  processes.sort((left, right) => left.pid - right.pid);
  return { at: nowIso, elapsedMs, processes, gpu: sampleGpu() ?? undefined };
}

/**
 * Collect one resource tick synchronously (testable). cpuPercent is computed
 * against the wall-clock interval since the previous tick (0 on the first
 * tick, where cumulative CPU time is recorded without an interval).
 */
export function sampleResourceTick(
  rootPid: number,
  elapsedMs: number,
  previous: Map<number, number> | null,
): ResourceTick {
  return buildTick(enumerateProcessesSync(), rootPid, elapsedMs, previous);
}

/** Collect one resource tick asynchronously (non-blocking, production path). */
export async function sampleResourceTickAsync(
  rootPid: number,
  elapsedMs: number,
  previous: Map<number, number> | null,
): Promise<ResourceTick> {
  const all = await enumerateProcessesAsync();
  return buildTick(all, rootPid, elapsedMs, previous);
}

export interface ResourceSamplerOptions {
  label: string;
  rootPid: number;
  /** Sampling cadence in ms. Default 5000. */
  cadenceMs?: number;
  /** Maximum number of ticks kept in the report (bounded memory). */
  maxTicks?: number;
}

/**
 * A bounded, interval-driven sampler for one benchmark run. It never touches
 * scheduling; it only reads process/GPU state and records ticks.
 */
export class ResourceSampler {
  readonly report: ResourceReport;
  private previous: Map<number, number> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly maxTicks: number;
  private readonly startedAt: string;

  constructor(options: ResourceSamplerOptions) {
    const cadenceMs = Math.max(250, options.cadenceMs ?? 5_000);
    this.maxTicks = Math.max(1, options.maxTicks ?? 10_000);
    this.startedAt = new Date().toISOString();
    this.report = {
      label: options.label,
      cadenceMs,
      rootPid: options.rootPid,
      startedAt: this.startedAt,
      endedAt: "",
      ticks: [],
      summary: {
        processCountMax: 0,
        peakTotalRssBytes: 0,
        peakProcessRssBytes: 0,
        peakCpuPercent: 0,
        gpuPeakUtilizationPercent: null,
        gpuPeakMemoryUsedBytes: null,
      },
    };
  }

  start(): void {
    if (this.timer) return;
    void this.sampleAsync();
    this.timer = setInterval(() => void this.sampleAsync(), this.report.cadenceMs);
    // Do not keep the process alive just to sample.
    this.timer.unref?.();
  }

  /** Stop sampling. When `awaitFlush` is true, waits for any in-flight tick to
   * land so the report is not truncated at the last unfinished sample. */
  async stop(awaitFlush = true): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (awaitFlush) {
      while (this.sampling) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    this.report.endedAt = new Date().toISOString();
    this.finalize();
  }

  private sampling = false;

  private async sampleAsync(): Promise<void> {
    // Re-entrancy guard: process enumeration can outlast the cadence on
    // Windows (~1-2 s per full CIM query). Skip a tick rather than pile up.
    if (this.sampling) return;
    this.sampling = true;
    try {
      const tick = await sampleResourceTickAsync(
        this.report.rootPid,
        this.report.ticks.length * this.report.cadenceMs,
        this.previous,
      );
      this.previous = new Map(tick.processes.map((process) => [process.pid, process.cpuMs]));
      this.report.ticks.push(tick);
      if (this.report.ticks.length > this.maxTicks) {
        this.report.ticks.splice(0, this.report.ticks.length - this.maxTicks);
      }
    } catch {
      // A transient ps/CIM failure must never crash the benchmark run.
    } finally {
      this.sampling = false;
    }
  }

  private finalize(): void {
    const summary = this.report.summary;
    let peakCpu = 0;
    for (const tick of this.report.ticks) {
      summary.processCountMax = Math.max(summary.processCountMax, tick.processes.length);
      const totalRss = tick.processes.reduce((sum, process) => sum + process.rssBytes, 0);
      summary.peakTotalRssBytes = Math.max(summary.peakTotalRssBytes, totalRss);
      for (const process of tick.processes) {
        summary.peakProcessRssBytes = Math.max(summary.peakProcessRssBytes, process.rssBytes);
        peakCpu = Math.max(peakCpu, process.cpuPercent);
      }
      for (const gpu of tick.gpu ?? []) {
        summary.gpuPeakUtilizationPercent =
          summary.gpuPeakUtilizationPercent == null
            ? gpu.utilizationPercent
            : Math.max(summary.gpuPeakUtilizationPercent, gpu.utilizationPercent);
        summary.gpuPeakMemoryUsedBytes =
          summary.gpuPeakMemoryUsedBytes == null
            ? gpu.memoryUsedBytes
            : Math.max(summary.gpuPeakMemoryUsedBytes, gpu.memoryUsedBytes);
      }
    }
    summary.peakCpuPercent = peakCpu;
  }
}

/** Write the bounded report to `<resultDir>/resource_report.json`. Creates the
 * directory when the runner has not materialized it yet (e.g. a dry run). */
export function writeResourceReport(report: ResourceReport, resultDir: string): string {
  const path = join(resultDir, "resource_report.json");
  mkdirSync(resultDir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return path;
}
