/** Existing per-text display ceiling, not a combined host-input budget. */
export const DEFAULT_INFORMATION_OUTPUT_CHARACTERS = 8_000;
export const TEMPORARY_INFORMATION_LABEL = "[temporary]";
/** Combined dynamic-message ceiling, including purpose envelopes. */
export const DEFAULT_CONTEXT_OUTPUT_CHARACTERS = 16_000;

export type InformationPurpose = "state" | "material" | "reasoning" | "guidance" | "diagnostic";

/** Source identities retain domain ownership; views never grant write authority. */
export type InformationSource =
  | Readonly<{
      kind: "ag";
      sessionId: string;
      taskFrameId: string;
      itemId: string;
    }>
  | Readonly<{ kind: "board"; taskId: string; entryId: string }>
  | Readonly<{ kind: "memory"; memoryId: string; activeGraphId?: string }>
  | Readonly<{ kind: "workspace"; sessionId: string; generatedAt: string }>
  | Readonly<{ kind: "event"; eventId: string; revision: number; part: "record" | "change" }>
  | Readonly<{ kind: "agent"; agentId: string }>;

/** An admitted display view, not a raw graph or an authoritative state store. */
export interface InformationView {
  /** Presentation responsibility, independent of source ownership. */
  readonly purpose?: InformationPurpose;
  readonly source?: InformationSource;
  readonly body: string;
  readonly requiredLabels?: readonly string[];
  /** Preview disclosure must not upgrade to exact source evidence. */
  readonly preview?: boolean;
}

export interface InformationOutputEntry {
  readonly source: InformationSource;
  readonly contentHash: string;
  readonly disclosure: "full" | "preview";
}

/** Reader-local acknowledgement candidate, not authentication or a ledger write. */
export interface InformationOutputReceipt {
  readonly sessionId: string;
  readonly entries: readonly InformationOutputEntry[];
}

/** Preparation says what fits, not what a host actually exposed to its model. */
export interface PreparedInformationOutput {
  readonly text: string;
  readonly views: readonly InformationView[];
  /** Source hashes are computed on first access and memoized for this snapshot. */
  readonly included: readonly InformationOutputEntry[];
  readonly omitted: readonly InformationView[];
}
