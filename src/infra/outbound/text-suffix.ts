import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import type {
  BoundTextSuffix,
  CapturedTextSuffix,
  DirectTextRoute,
  FinalizedVisibleText,
  OutboundTextAuthor,
  OutboundTextSuffixRuntimeV1,
  PhysicalVisibleText,
} from "./text-suffix.types.js";

export type TextSuffixCoverageReason =
  | "policy_disabled"
  | "unknown_author"
  | "unknown_route"
  | "scope_mismatch"
  | "unsupported_channel"
  | "legacy_prepared"
  | "unsupported_revision";

// Only reason codes are retained: no bodies, account ids, peers or credential-bearing errors.
const coverage = new Map<TextSuffixCoverageReason, number>();
export function recordTextSuffixCoverage(reason: TextSuffixCoverageReason): void {
  coverage.set(reason, (coverage.get(reason) ?? 0) + 1);
}
export function getTextSuffixCoverage(): Readonly<
  Partial<Record<TextSuffixCoverageReason, number>>
> {
  return Object.fromEntries(coverage);
}

export function captureTextSuffix(
  cfg: OpenClawConfig,
  author?: OutboundTextAuthor,
): CapturedTextSuffix {
  const policy = cfg.messages?.outboundTextSuffix;
  if (!policy?.enabled) {
    recordTextSuffixCoverage("policy_disabled");
    return { version: 1, decision: "none" };
  }
  if (author?.kind !== "agent" || !author.agentId) {
    recordTextSuffixCoverage("unknown_author");
    return { version: 1, decision: "none" };
  }
  if (author.agentId !== policy.agentId) {
    recordTextSuffixCoverage("scope_mismatch");
    return { version: 1, decision: "none" };
  }
  return {
    version: 1,
    decision: "scoped",
    authorAgentId: author.agentId,
    text: policy.text,
    targets: policy.targets.map((target) => ({
      channel: target.channel,
      accountId: target.accountId,
      peer: { kind: target.peer.kind, id: target.peer.id },
    })),
    algorithm: "literal-suffix-v1",
    plannerVersion: 1,
  };
}

export function bindTextSuffix(
  snapshot: CapturedTextSuffix | undefined,
  route?: DirectTextRoute,
): BoundTextSuffix | undefined {
  if (!snapshot) {
    recordTextSuffixCoverage("legacy_prepared");
    return undefined;
  }
  if (snapshot.decision === "none") {
    return undefined;
  }
  if (
    snapshot.version !== 1 ||
    snapshot.algorithm !== "literal-suffix-v1" ||
    snapshot.plannerVersion !== 1
  ) {
    recordTextSuffixCoverage("unsupported_revision");
    throw new PlatformMessageNotDispatchedError(
      "Unsupported captured outbound text suffix revision",
      {
        cause: undefined,
        retryable: false,
      },
    );
  }
  if (!route) {
    recordTextSuffixCoverage("unknown_route");
    return undefined;
  }
  if (
    !snapshot.targets.some(
      (target) =>
        target.channel === route.channel &&
        target.accountId === route.accountId &&
        target.peer.kind === route.peer.kind &&
        target.peer.id === route.peer.id,
    )
  ) {
    recordTextSuffixCoverage("scope_mismatch");
    return undefined;
  }
  return {
    text: snapshot.text,
    algorithm: snapshot.algorithm,
    utf16Units: snapshot.text.length,
    utf8Bytes: Buffer.byteLength(snapshot.text, "utf8"),
  };
}

/** Called only on a formatter-owned logical prose tail, never a physical fragment. */
export function normalizeTerminalSignature(eligibleTail: string, suffix: BoundTextSuffix) {
  let end = eligibleTail.length;
  let hadSignature = false;
  while (end > 0) {
    const beforeWhitespace = end;
    while (end > 0 && /\s/u.test(eligibleTail[end - 1] ?? "")) {
      end -= 1;
    }
    let signatureEnd = end;
    if (eligibleTail[end - 1] === "\uFE0E" || eligibleTail[end - 1] === "\uFE0F") {
      signatureEnd -= 1;
    }
    if (
      signatureEnd >= suffix.text.length &&
      eligibleTail.slice(signatureEnd - suffix.text.length, signatureEnd) === suffix.text
    ) {
      end = signatureEnd - suffix.text.length;
      hadSignature = true;
      continue;
    }
    if (!hadSignature) {
      end = beforeWhitespace;
    }
    break;
  }
  return { keepEnd: end, hadSignature };
}

export function finalizeVisibleText(
  unit: PhysicalVisibleText,
  suffix: BoundTextSuffix,
): FinalizedVisibleText {
  if (unit.state === "finalized") {
    if (unit.suffixText !== suffix.text || unit.algorithm !== suffix.algorithm) {
      throw new PlatformMessageNotDispatchedError(
        "Outbound text was finalized under a different policy",
        { cause: undefined, retryable: false },
      );
    }
    return unit;
  }
  if (unit.state === "body" && !unit.text.trim()) {
    throw new PlatformMessageNotDispatchedError("Cannot finalize an empty outbound text body", {
      cause: undefined,
      retryable: false,
    });
  }
  const separator =
    unit.state === "body"
      ? { space: " ", newline: "\n", "blank-line": "\n\n" }[unit.separator]
      : "";
  return Object.freeze({
    state: "finalized",
    text: unit.state === "body" ? unit.text + separator + suffix.text : suffix.text,
    suffixText: suffix.text,
    algorithm: suffix.algorithm,
  });
}

export const outboundTextSuffixRuntime: OutboundTextSuffixRuntimeV1 = Object.freeze({
  version: 1,
  capture: captureTextSuffix,
  bind: bindTextSuffix,
  normalizeTerminalSignature,
  finalize: finalizeVisibleText,
  async planPreservedMarkdownText(params) {
    const { planPreservedMarkdownText } = await import("./text-suffix-markdown.js");
    return planPreservedMarkdownText(params);
  },
});
