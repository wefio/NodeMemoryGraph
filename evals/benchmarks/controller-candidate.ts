import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { CONTROLLER_FEATURE_PROTOCOL_VERSION } from "../../src/lab/controller-protocol.ts";

export interface ControllerCandidateDescriptor {
  sourcePath: string;
  sha256: string;
  featureProtocolVersion: number;
  trainingSteps: number;
}

export interface ControllerActuationSummary {
  attempted: number;
  changed: number;
  actions: Record<"allocate" | "fold" | "rerank", number>;
  maxTrainingSteps: number;
}

interface CandidateState {
  featureProtocolVersion?: unknown;
  controller?: { trainingSteps?: unknown };
}

interface ActuationEvent {
  type?: unknown;
  action?: unknown;
  changed?: unknown;
  controllerTrainingSteps?: unknown;
}

export function loadControllerCandidate(path: string): ControllerCandidateDescriptor {
  const sourcePath = resolve(path);
  if (!existsSync(sourcePath))
    throw new Error(`Controller candidate state not found: ${sourcePath}`);
  const bytes = readFileSync(sourcePath);
  const state = JSON.parse(bytes.toString("utf8")) as CandidateState;
  const featureProtocolVersion = Number(state.featureProtocolVersion);
  const trainingSteps = Number(state.controller?.trainingSteps);
  if (featureProtocolVersion !== CONTROLLER_FEATURE_PROTOCOL_VERSION) {
    throw new Error(
      `Controller candidate feature protocol ${featureProtocolVersion} is incompatible with ${CONTROLLER_FEATURE_PROTOCOL_VERSION}`,
    );
  }
  if (!Number.isInteger(trainingSteps) || trainingSteps < 1) {
    throw new Error("Controller candidate must contain at least one verified training step");
  }
  return {
    sourcePath,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    featureProtocolVersion,
    trainingSteps,
  };
}

export function installControllerCandidate(
  descriptor: ControllerCandidateDescriptor,
  dataDirectory: string,
): void {
  copyFileSync(descriptor.sourcePath, resolve(dataDirectory, "controller-shadow-state.json"));
}

export function readControllerActuation(dataDirectory?: string): ControllerActuationSummary | null {
  if (!dataDirectory) return null;
  const path = resolve(dataDirectory, "controller-shadow-events.jsonl");
  if (!existsSync(path)) return null;
  const summary: ControllerActuationSummary = {
    attempted: 0,
    changed: 0,
    actions: { allocate: 0, fold: 0, rerank: 0 },
    maxTrainingSteps: 0,
  };
  for (const line of readFileSync(path, "utf8").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event: ActuationEvent;
    try {
      event = JSON.parse(line) as ActuationEvent;
    } catch {
      continue;
    }
    if (event.type !== "actuation" || !isAction(event.action)) continue;
    summary.attempted += 1;
    summary.actions[event.action] += 1;
    if (event.changed === true) summary.changed += 1;
    if (typeof event.controllerTrainingSteps === "number") {
      summary.maxTrainingSteps = Math.max(summary.maxTrainingSteps, event.controllerTrainingSteps);
    }
  }
  return summary.attempted > 0 ? summary : null;
}

function isAction(value: unknown): value is keyof ControllerActuationSummary["actions"] {
  return value === "allocate" || value === "fold" || value === "rerank";
}
