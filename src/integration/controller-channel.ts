import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import type { ActiveGraphBudget, MemoryContext } from "../core/types.ts";
import {
  ControllerRuntime,
  type ControllerBudgetDecision,
  type ControllerMemoryFold,
  type ControllerShadowDecision,
} from "../lab/controller-runtime.ts";
import { CONTROLLER_FEATURE_PROTOCOL_VERSION } from "../lab/controller-protocol.ts";

export type ControllerRuntimeMode = "off" | "shadow" | "controlled" | "active";

export interface ControllerArtifactReference {
  path: string;
  sha256: string;
}

export interface ControllerActivationReceipt {
  version: 1;
  status: "approved";
  approvedAt: string;
  approvedBy: string;
  featureProtocolVersion: typeof CONTROLLER_FEATURE_PROTOCOL_VERSION;
  candidateSha256: string;
  gates: {
    retrieval: ControllerArtifactReference;
    controller: ControllerArtifactReference;
    product: ControllerArtifactReference;
  };
  rollbackTarget: ControllerArtifactReference;
}

export interface ControllerChannelDescriptor {
  mode: ControllerRuntimeMode;
  canActuate: boolean;
  statePath: string;
  candidateSha256: string | null;
  featureProtocolVersion: typeof CONTROLLER_FEATURE_PROTOCOL_VERSION;
  trainingSteps: number;
  activationReceiptPath: string | null;
}

export interface ControllerPolicyChannelOptions {
  mode: ControllerRuntimeMode;
  statePath: string;
  activationReceiptPath?: string;
  collectionOrigin?: "controlled" | "natural";
}

/**
 * Typed runtime boundary between a learned controller candidate and retrieval.
 * Shadow mode can score but never actuate. Controlled mode is reserved for
 * explicitly marked evaluation runs. Active mode requires a reviewed receipt
 * that binds the exact candidate, three external gate artifacts, and rollback.
 */
export class ControllerPolicyChannel {
  readonly descriptor: ControllerChannelDescriptor;
  readonly #runtime: ControllerRuntime;

  constructor(options: ControllerPolicyChannelOptions) {
    const statePath = resolve(options.statePath);
    const stateSha256 = fingerprint(statePath);
    if ((options.mode === "controlled" || options.mode === "active") && !stateSha256) {
      throw new Error(`controller ${options.mode} mode requires a candidate state: ${statePath}`);
    }
    if (options.mode === "controlled" && options.collectionOrigin !== "controlled") {
      throw new Error("controller controlled mode requires NMG_SHADOW_COLLECTION_ORIGIN=controlled");
    }

    this.#runtime = new ControllerRuntime(statePath);
    if ((options.mode === "controlled" || options.mode === "active") && this.#runtime.trainingSteps < 1) {
      throw new Error(`controller ${options.mode} mode requires at least one verified training step`);
    }

    let activationReceiptPath: string | null = null;
    if (options.mode === "active") {
      if (!options.activationReceiptPath) {
        throw new Error("controller active mode requires NMG_CONTROLLER_ACTIVATION_RECEIPT");
      }
      activationReceiptPath = resolve(options.activationReceiptPath);
      validateControllerActivationReceipt(activationReceiptPath, statePath);
    }

    this.descriptor = {
      mode: options.mode,
      canActuate: options.mode === "controlled" || options.mode === "active",
      statePath,
      candidateSha256: stateSha256,
      featureProtocolVersion: CONTROLLER_FEATURE_PROTOCOL_VERSION,
      trainingSteps: this.#runtime.trainingSteps,
      activationReceiptPath,
    };
  }

  shadow(context: MemoryContext): ControllerShadowDecision | null {
    return this.descriptor.mode === "off" ? null : this.#runtime.shadow(context);
  }

  allocate(
    context: MemoryContext,
    minimum: ActiveGraphBudget,
    normalMaximum: ActiveGraphBudget,
    expandedMaximum: ActiveGraphBudget,
  ): ControllerBudgetDecision | null {
    return this.descriptor.canActuate
      ? this.#runtime.allocate(context, minimum, normalMaximum, expandedMaximum)
      : null;
  }

  fold(context: MemoryContext, retainedMass: number): ControllerMemoryFold | null {
    return this.descriptor.canActuate ? this.#runtime.foldMemories(context, retainedMass) : null;
  }
}

export function validateControllerActivationReceipt(
  receiptPath: string,
  candidateStatePath: string,
): ControllerActivationReceipt {
  const absoluteReceiptPath = resolve(receiptPath);
  const receipt = JSON.parse(readFileSync(absoluteReceiptPath, "utf8")) as ControllerActivationReceipt;
  if (receipt.version !== 1 || receipt.status !== "approved") {
    throw new Error("controller activation receipt is not an approved version-1 receipt");
  }
  if (
    receipt.featureProtocolVersion !== CONTROLLER_FEATURE_PROTOCOL_VERSION ||
    !receipt.approvedBy?.trim() ||
    Number.isNaN(Date.parse(receipt.approvedAt))
  ) {
    throw new Error("controller activation receipt metadata is invalid or incompatible");
  }
  const candidateSha256 = fingerprint(resolve(candidateStatePath));
  if (!candidateSha256 || receipt.candidateSha256 !== candidateSha256) {
    throw new Error("controller activation receipt does not bind the selected candidate state");
  }
  for (const [name, reference] of Object.entries(receipt.gates ?? {})) {
    validateArtifactReference(name, reference, dirname(absoluteReceiptPath));
  }
  if (!receipt.gates?.retrieval || !receipt.gates?.controller || !receipt.gates?.product) {
    throw new Error("controller activation receipt must reference all three gate artifacts");
  }
  validateArtifactReference("rollbackTarget", receipt.rollbackTarget, dirname(absoluteReceiptPath));
  return receipt;
}

function validateArtifactReference(
  name: string,
  reference: ControllerArtifactReference | undefined,
  baseDirectory: string,
): void {
  if (!reference?.path?.trim() || !/^[a-f0-9]{64}$/u.test(reference.sha256)) {
    throw new Error(`controller activation ${name} artifact reference is invalid`);
  }
  const path = resolve(baseDirectory, reference.path);
  if (fingerprint(path) !== reference.sha256) {
    throw new Error(`controller activation ${name} artifact fingerprint mismatch: ${path}`);
  }
}

function fingerprint(path: string): string | null {
  return existsSync(path) ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
}
