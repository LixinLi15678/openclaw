import { describe, expect, it } from "vitest";
import {
  parseMarkdownOwnership,
  type PositionedMarkdownNode,
} from "../../../packages/markdown-core/src/reasoning-tag-parser.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { OutboundTextSuffixSchema } from "../../config/zod-schema.messages.js";
import {
  bindTextSuffix,
  captureTextSuffix,
  finalizeVisibleText,
  outboundTextSuffixRuntime,
} from "./text-suffix.js";
import type { BoundTextSuffix } from "./text-suffix.types.js";

const route = {
  channel: "openclaw-weixin" as const,
  accountId: "fixture-account",
  peer: { kind: "direct" as const, id: "CasePeer@im.wechat" },
};
const cfg: OpenClawConfig = {
  messages: {
    outboundTextSuffix: { enabled: true, text: "🌙", agentId: "main", targets: [route] },
  },
};
const suffix: BoundTextSuffix = {
  text: "🌙",
  algorithm: "literal-suffix-v1",
  utf16Units: 2,
  utf8Bytes: 4,
};
const plan = (text: string, effectiveLimit = 4_000) =>
  outboundTextSuffixRuntime.planPreservedMarkdownText({
    text,
    effectiveLimit,
    boundSuffix: suffix,
    chunkMode: "length",
    planner: "source-markdown-v1",
  });

function codeValues(text: string): string {
  const values: string[] = [];
  const walk = (node: PositionedMarkdownNode | undefined) => {
    if (node?.type === "code" || node?.type === "inlineCode") {
      values.push(node.value ?? "");
    }
    for (const child of node?.children ?? []) {
      walk(child);
    }
  };
  walk(parseMarkdownOwnership(text, { includeStructure: true }).structure);
  return values.join("");
}

describe("scoped outgoing text suffix", () => {
  it("defaults to disabled and rejects unsupported captured revisions before planning", () => {
    const disabled = OutboundTextSuffixSchema.parse({
      text: "🌙",
      agentId: "main",
      targets: [],
    });
    expect(disabled.enabled).toBe(false);
    expect(
      captureTextSuffix(
        { messages: { outboundTextSuffix: disabled } },
        { kind: "agent", agentId: "main" },
      ).decision,
    ).toBe("none");
    const future = JSON.parse(
      '{"version":1,"decision":"scoped","authorAgentId":"main","text":"🌙","targets":[],"algorithm":"future","plannerVersion":2}',
    );
    expect(() => bindTextSuffix(future, route)).toThrow("Unsupported captured");
  });

  it("requires admitted author and every exact actual route field; captures independent policy values", () => {
    expect(bindTextSuffix(undefined, route)).toBeUndefined();
    expect(
      bindTextSuffix(captureTextSuffix({}, { kind: "agent", agentId: "main" }), route),
    ).toBeUndefined();
    for (const author of [
      undefined,
      { kind: "system" as const },
      { kind: "agent" as const, agentId: "other" },
    ]) {
      expect(bindTextSuffix(captureTextSuffix(cfg, author), route)).toBeUndefined();
    }
    const captured = captureTextSuffix(cfg, { kind: "agent", agentId: "main" });
    for (const actual of [
      undefined,
      { ...route, accountId: "other" },
      { ...route, channel: "whatsapp" },
      { ...route, peer: { ...route.peer, id: "casepeer@im.wechat" } },
    ]) {
      expect(bindTextSuffix(captured, actual)).toBeUndefined();
    }
    expect(bindTextSuffix(structuredClone(captured), route)).toEqual(suffix);
  });
  it("is idempotent on explicit finalized values and preserves an interior chunk-ending moon", async () => {
    const unit = finalizeVisibleText({ state: "body", text: "body🌙", separator: "space" }, suffix);
    expect(unit.text).toBe("body🌙 🌙");
    expect(finalizeVisibleText(unit, suffix)).toBe(unit);
    expect((await plan("body🌙 NEXT", 10)).map((chunk) => chunk.text)).toEqual([
      "body🌙 🌙",
      " NEXT 🌙",
    ]);
  });
  it.each([
    ["hello", "hello 🌙"],
    ["hello 🌙🌙️  \n", "hello 🌙"],
    ["🌙︎ 🌙️", "🌙"],
    ["**hello 🌙**", "**hello** 🌙"],
    ["hello **🌙**", "hello 🌙"],
    ["hello ***🌙***", "hello 🌙"],
    ["***hello 🌙***", "***hello*** 🌙"],
    ["****", "****\n\n🌙"],
    [
      "[label][id]\n\n[id]: https://example.invalid",
      "[label][id]\n\n[id]: https://example.invalid\n\n🌙",
    ],
    ["~~hello 🌙️~~", "~~hello~~ 🌙"],
    ["`data🌙`", "`data🌙` 🌙"],
    ["```js\ndata🌙\n```", "```js\ndata🌙\n```\n🌙"],
    ["```js\ndata🌙", "```js\ndata🌙\n```\n🌙"],
    ["  indented", "  indented 🌙"],
    ["# Heading 🌙", "# Heading\n\n🌙"],
    ["[data🌙](https://example.invalid)", "[data🌙](https://example.invalid) 🌙"],
    ["**hello** &amp; \\*data*", "**hello** &amp; \\*data*\n\n🌙"],
  ])("normalizes the logical tail and preserves source: %s", async (text, expected) => {
    expect((await plan(text)).map((unit) => unit.text)).toEqual([expected]);
  });
  it("preserves default parser grammar while opting into double-tilde ownership", () => {
    expect(parseMarkdownOwnership("~~x~~").textSpans).toEqual([]);
    expect(
      parseMarkdownOwnership("~~x~~", { includeStructure: true }).structure?.children?.[0]
        ?.children?.[0]?.type,
    ).toBe("delete");
    expect(
      parseMarkdownOwnership("~x~", { includeStructure: true }).structure?.children?.[0]
        ?.children?.[0]?.type,
    ).toBe("text");
  });
  it.each([
    ["closed LF", "```js\na🌙\n```", "```js\na🌙\n```\n🌙"],
    ["open LF", "```js\na🌙", "```js\na🌙\n```\n🌙"],
    ["closed CRLF", "```js\r\na🌙\r\n```", "```js\r\na🌙\r\n```\n🌙"],
    ["open CRLF", "```js\r\na🌙", "```js\r\na🌙\r\n```\n🌙"],
    ["closed CR", "```js\ra🌙\r```", "```js\ra🌙\r```\n🌙"],
    ["open CR", "```js\ra🌙", "```js\ra🌙\r```\n🌙"],
  ])("keeps the signature outside the %s fence", async (_name, text, expected) => {
    const units = await plan(text);
    expect(units.map((unit) => unit.text)).toEqual([expected]);
    expect(codeValues(units[0]?.text ?? "")).toBe("a🌙");
  });
  it("seals full-size plans, preserves styled body/code values and keeps signature outside syntax", async () => {
    for (const original of [
      "**" + "abc🌙 xyz ".repeat(15).trim() + "**",
      "***" + "abc def ".repeat(12).trim() + "***",
      "~~" + "abc def ".repeat(12).trim() + "~~",
      "```js\n" + "a🌙 `  b ".repeat(15) + "\n```",
      "`` " + "a`🌙 b ".repeat(12) + " ``",
      "    " + "a🌙 b ".repeat(12),
      "> ```js\n> " + "a🌙 b ".repeat(12) + "\n> ```",
      "~~~ js  info\r\n" + "a🌙 b\r\n".repeat(10) + "~~~",
    ]) {
      const units = await plan(original, 36);
      expect(units.length).toBeGreaterThan(1);
      const originalCode = codeValues(original);
      const parsedUnits = units.map((unit) =>
        parseMarkdownOwnership(unit.text, { includeStructure: true }),
      );
      for (const [index, unit] of units.entries()) {
        expect(unit.text.length).toBeLessThanOrEqual(36);
        expect(unit.text.endsWith("🌙")).toBe(true);
        const last = parsedUnits[index]?.structure?.children?.at(-1)?.children?.at(-1);
        expect(last?.type).toBe("text");
        expect(last?.value?.endsWith("🌙")).toBe(true);
      }
      if (originalCode) {
        expect(units.map((unit) => codeValues(unit.text)).join("")).toBe(originalCode);
      }
    }
  });
  it("rejects indivisible data before returning any plan and never creates overflow signatures", async () => {
    expect(await plan(" \n\t")).toEqual([]);
    expect((await plan("a", 4)).map((unit) => unit.text)).toEqual(["a 🌙"]);
    await expect(plan("a", 3)).rejects.toMatchObject({
      code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
      retryable: false,
    });
    await expect(
      plan("[label](https://example.invalid/" + "x".repeat(80) + ")", 20),
    ).rejects.toMatchObject({ retryable: false });
    await expect(
      plan("[ref][id]\n\n[id]: https://example.invalid/" + "x".repeat(80), 20),
    ).rejects.toMatchObject({ retryable: false });
    await expect(plan("👨‍👩‍👧‍👦", 10)).rejects.toMatchObject({ retryable: false });
  });
  it("rejects pattern scopes, malformed signatures, duplicate targets and missing enabled scope", () => {
    const valid = cfg.messages?.outboundTextSuffix;
    expect(OutboundTextSuffixSchema.safeParse(valid).success).toBe(true);
    for (const patch of [
      { targets: [] },
      { text: "*moon*" },
      { text: "\n🌙" },
      { text: "\u202E🌙" },
      { text: "\ud800" },
      { text: "x".repeat(33) },
      { targets: [route, route] },
      { targets: [{ ...route, accountId: "*" }] },
      { targets: [{ ...route, peer: { kind: "group", id: "group" } }] },
    ]) {
      expect(OutboundTextSuffixSchema.safeParse({ ...valid, ...patch }).success).toBe(false);
    }
  });
});
