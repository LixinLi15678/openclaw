import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Admitted execution identity, never display metadata or model-supplied send arguments. */
export type OutboundTextAuthor = { kind: "agent"; agentId: string } | { kind: "system" };

export type DirectTextRoute = Readonly<{
  channel: string;
  accountId: string;
  peer: Readonly<{ kind: "direct"; id: string }>;
}>;

export type CapturedTextSuffix =
  | Readonly<{ version: 1; decision: "none" }>
  | Readonly<{
      version: 1;
      decision: "scoped";
      authorAgentId: string;
      text: string;
      targets: readonly DirectTextRoute[];
      algorithm: "literal-suffix-v1";
      plannerVersion: 1;
    }>;

export type OutboundTextPreparation = Readonly<{
  suffix: CapturedTextSuffix;
  modifiersPrepared: boolean;
  /** The producer already classified this as visible content (including structured literal text). */
  visibility?: "visible";
}>;

export type BoundTextSuffix = Readonly<{
  text: string;
  algorithm: "literal-suffix-v1";
  utf16Units: number;
  utf8Bytes: number;
}>;

export type FinalizedVisibleText = Readonly<{
  state: "finalized";
  text: string;
  suffixText: string;
  algorithm: "literal-suffix-v1";
}>;

export type PhysicalVisibleText =
  | Readonly<{ state: "body"; text: string; separator: "space" | "newline" | "blank-line" }>
  | Readonly<{ state: "signature-only" }>
  | FinalizedVisibleText;

/** Optional V1 host capability. Planning is async solely to keep the positioned parser lazy. */
export type OutboundTextSuffixRuntimeV1 = Readonly<{
  version: 1;
  capture: (cfg: OpenClawConfig, author?: OutboundTextAuthor) => CapturedTextSuffix;
  bind: (
    snapshot: CapturedTextSuffix | undefined,
    route?: DirectTextRoute,
  ) => BoundTextSuffix | undefined;
  normalizeTerminalSignature: (
    eligibleTail: string,
    suffix: BoundTextSuffix,
  ) => Readonly<{ keepEnd: number; hadSignature: boolean }>;
  finalize: (unit: PhysicalVisibleText, suffix: BoundTextSuffix) => FinalizedVisibleText;
  planPreservedMarkdownText: (params: {
    text: string;
    boundSuffix: BoundTextSuffix;
    effectiveLimit: number;
    chunkMode: "length" | "newline";
    planner: "source-markdown-v1";
  }) => Promise<readonly FinalizedVisibleText[]>;
}>;

export type OutboundTextSuffixContext = Readonly<{
  textPreparation?: OutboundTextPreparation;
  textFormatting?: import("./formatting.js").OutboundDeliveryFormattingOptions;
  outboundTextSuffix?: OutboundTextSuffixRuntimeV1;
}>;
