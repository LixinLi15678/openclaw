import {
  editTerminalMarkdownText,
  planSourceMarkdownChunks,
} from "../../../packages/markdown-core/src/source-chunks.js";
import { PlatformMessageNotDispatchedError } from "./deliver-types.js";
import { finalizeVisibleText, normalizeTerminalSignature } from "./text-suffix.js";
import type { OutboundTextSuffixRuntimeV1 } from "./text-suffix.types.js";

export function planPreservedMarkdownText(
  params: Parameters<OutboundTextSuffixRuntimeV1["planPreservedMarkdownText"]>[0],
) {
  try {
    if (
      params.planner !== "source-markdown-v1" ||
      !Number.isSafeInteger(params.effectiveLimit) ||
      params.effectiveLimit <= 0
    ) {
      throw new Error("Unsupported outbound text planner or invalid local limit");
    }
    if (!params.text.trim()) {
      return [];
    }
    const normalized = editTerminalMarkdownText(params.text, (tail) =>
      normalizeTerminalSignature(tail, params.boundSuffix),
    );
    if (normalized.signatureOnly) {
      const finalized = finalizeVisibleText({ state: "signature-only" }, params.boundSuffix);
      if (finalized.text.length > params.effectiveLimit) {
        throw new Error("Suffix exceeds local text limit");
      }
      return Object.freeze([finalized]);
    }
    const bodies = planSourceMarkdownChunks({
      text: normalized.text,
      chunkMode: params.chunkMode,
      fits: (body) =>
        finalizeVisibleText(
          { state: "body", text: body.text, separator: body.separator },
          params.boundSuffix,
        ).text.length <= params.effectiveLimit,
    });
    return Object.freeze(
      bodies.map((body) =>
        finalizeVisibleText(
          { state: "body", text: body.text, separator: body.separator },
          params.boundSuffix,
        ),
      ),
    );
  } catch (cause) {
    throw new PlatformMessageNotDispatchedError(
      "Outbound Markdown text cannot be prepared within the local text limit",
      { cause, retryable: false },
    );
  }
}
