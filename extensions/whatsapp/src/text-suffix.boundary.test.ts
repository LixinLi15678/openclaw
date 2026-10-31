import fs from "node:fs";
import type { AnyMessageContent, WAMessage } from "baileys";
import type { OutboundTextSuffixRuntimeV1 } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { setActivePluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deliverWebReply } from "./auto-reply/deliver-reply.js";
import { createWebSendApi } from "./inbound/send-api.js";
import type { ActiveWebListener } from "./inbound/types.js";
import { sendMessageWhatsApp } from "./send.js";
import { createWhatsAppSocketOperationTimeoutAdapter } from "./socket-timing.js";
import { resolveEquivalentWhatsAppDirectChatJids } from "./targets-runtime.js";

const state = vi.hoisted(() => ({
  listener: undefined as ActiveWebListener | undefined,
  media: vi.fn(),
  physical: [] as Array<{ jid: string; content: AnyMessageContent }>,
  failureAt: 0,
  onAccepted: undefined as (() => void) | undefined,
}));
vi.mock("./connection-controller-runtime-context.js", () => ({
  getWhatsAppConnectionController: () => ({ getActiveListener: () => state.listener }),
}));
vi.mock("openclaw/plugin-sdk/outbound-media", () => ({ loadOutboundMediaFromUrl: state.media }));
vi.mock("./media.js", () => ({ loadWebMedia: state.media }));
vi.mock("./image-preview.js", () => ({
  addWhatsAppImagePreviewFields: async <T>(content: T) => content,
}));
const lid = "987654321@lid";
const cfg: OpenClawConfig = {
  channels: { whatsapp: {} },
  messages: {
    outboundTextSuffix: {
      enabled: true,
      text: "🌙",
      agentId: "main",
      targets: [
        { channel: "whatsapp", accountId: "default", peer: { kind: "direct", id: "+15550001111" } },
      ],
    },
  },
};
let fixture: ReturnType<typeof createPluginRegistryFixture>;
let runtime: OutboundTextSuffixRuntimeV1;
let api: ReturnType<typeof createWebSendApi>;
const visible = () =>
  state.physical.flatMap(({ content }) =>
    "text" in content && typeof content.text === "string"
      ? [content.text]
      : "caption" in content && typeof content.caption === "string" && content.caption
        ? [content.caption]
        : [],
  );
const preparation = (agentId = "main") => ({
  suffix: runtime.capture(cfg, { kind: "agent", agentId }),
  modifiersPrepared: true,
  visibility: "visible" as const,
});

beforeEach(() => {
  fixture = createPluginRegistryFixture({}, { allowProcessHomeSessionCatalogs: false });
  setActivePluginRegistry(fixture.registry.registry);
  registerVirtualTestPlugin({
    ...fixture,
    id: "suffix-fixture",
    name: "suffix fixture",
    register(plugin) {
      const capability = plugin.runtime.channel.outboundTextSuffix;
      if (!capability) {
        throw new Error("Host lacks V1 capability");
      }
      runtime = capability;
    },
  });
});
beforeEach(() => {
  state.physical.length = 0;
  state.failureAt = 0;
  state.onAccepted = undefined;
  state.media
    .mockReset()
    .mockResolvedValue({ buffer: Buffer.from([1, 2, 3]), contentType: "image/png", kind: "image" });
  // Only synthetic mapping files are read. No fallback to an installed credentials tree.
  const read = fs.readFileSync;
  vi.spyOn(fs, "readFileSync").mockImplementation((...args: Parameters<typeof fs.readFileSync>) => {
    const file = String(args[0]);
    if (file.endsWith("lid-mapping-15550001111.json")) {
      return JSON.stringify("987654321");
    }
    if (file.endsWith("lid-mapping-987654321_reverse.json")) {
      return JSON.stringify("+15550001111");
    }
    if (file.includes("lid-mapping-")) {
      throw new Error("No synthetic mapping");
    }
    return read(...args);
  });
  const sendMessage = vi.fn(async (jid: string, content: AnyMessageContent): Promise<WAMessage> => {
    state.physical.push({ jid, content });
    if (state.failureAt === state.physical.length) {
      throw new Error("synthetic provider rejection");
    }
    state.onAccepted?.();
    return { key: { id: `accepted-${state.physical.length}`, remoteJid: jid } };
  });
  api = createWebSendApi({
    sock: createWhatsAppSocketOperationTimeoutAdapter(
      { sendMessage, sendPresenceUpdate: vi.fn() },
      30_000,
    ),
    defaultAccountId: "default",
    authDir: "/synthetic-wa-auth",
  });
  state.listener = {
    accountId: "default",
    resolveOutboundJid: api.resolveOutboundJid,
    resolveEquivalentDirectChatJids: (jid) =>
      resolveEquivalentWhatsAppDirectChatJids(jid, { authDir: "/synthetic-wa-auth" }),
    sendMessage: api.sendMessage,
    sendComposingTo: vi.fn(),
    sendPoll: vi.fn(),
    sendReaction: vi.fn(),
  };
});

afterEach(() => vi.restoreAllMocks());

async function canonical(
  text: string,
  options: {
    to?: string;
    agentId?: string;
    accountId?: string;
    cap?: number;
    mime?: string;
    onDeliveryResult?: Parameters<typeof sendMessageWhatsApp>[2]["onDeliveryResult"];
    signal?: AbortSignal;
    assertCurrent?: () => void;
    unclassified?: boolean;
    onPlatformSendDispatch?: () => Promise<void>;
  } = {},
) {
  if (options.mime) {
    state.media.mockResolvedValueOnce({
      buffer: Buffer.from([1, 2, 3]),
      contentType: options.mime,
      kind: options.mime.split("/")[0],
    });
  }
  return sendMessageWhatsApp(options.to ?? "+15550001111", text, {
    cfg,
    verbose: false,
    ...(options.mime ? { mediaUrl: "https://example.invalid/fixture" } : {}),
    accountId: options.accountId,
    textPreparation: options.unclassified
      ? { suffix: preparation(options.agentId).suffix, modifiersPrepared: true }
      : preparation(options.agentId),
    outboundTextSuffix: runtime,
    formatting: { textLimit: options.cap ?? 32, tableMode: "bullets", chunkMode: "length" },
    onDeliveryResult: options.onDeliveryResult,
    signal: options.signal,
    assertDirectAdapterHandoff: options.assertCurrent,
    onPlatformSendDispatch: options.onPlatformSendDispatch,
  });
}
async function ordinary(
  text: string,
  options: {
    agentId?: string;
    media?: boolean;
    cap?: number;
    capturedFormatting?: Parameters<typeof deliverWebReply>[0]["textFormatting"];
    signal?: AbortSignal;
    unclassified?: boolean;
    assertCurrent?: () => void;
    onPlatformSendDispatch?: () => Promise<void>;
  } = {},
) {
  return deliverWebReply({
    replyResult: {
      text,
      ...(options.media ? { mediaUrl: "https://example.invalid/image.png" } : {}),
    },
    transport: {
      accountId: "default",
      conversationId: "+15550001111",
      conversationKind: "direct",
      chatJid: lid,
      recipientJid: "synthetic-self@s.whatsapp.net",
      resolveEquivalentDirectChatJids: state.listener?.resolveEquivalentDirectChatJids,
      reply: (value, _options, authority) =>
        api.sendMessage(lid, value, undefined, undefined, authority),
      sendMedia: async (content, _options, authority) => {
        const result = await api.sendMessage(
          lid,
          "caption" in content && typeof content.caption === "string" ? content.caption : "",
          "image" in content && Buffer.isBuffer(content.image) ? content.image : undefined,
          "image/png",
          authority,
        );
        return result;
      },
    },
    textPreparation: options.unclassified
      ? { suffix: preparation(options.agentId).suffix, modifiersPrepared: true }
      : preparation(options.agentId),
    outboundTextSuffix: runtime,
    textFormatting: options.capturedFormatting,
    textLimit: options.cap ?? 32,
    tableMode: "bullets",
    chunkMode: "length",
    maxMediaBytes: 100,
    signal: options.signal,
    assertDirectAdapterHandoff: options.assertCurrent,
    onPlatformSendDispatch: options.onPlatformSendDispatch,
    replyLogger: { info: vi.fn(), warn: vi.fn() },
  });
}

describe("WhatsApp physical scoped text/caption finalization", () => {
  it.each([canonical, ordinary])(
    "retains acceptance and stops at the next physical unit when existing authority closes",
    async (send) => {
      let current = true;
      state.onAccepted = () => {
        current = false;
      };
      await expect(
        send("hello world", {
          cap: 8,
          onPlatformSendDispatch: async () => {
            await Promise.resolve();
          },
          assertCurrent: () => {
            if (!current) {
              throw new Error("fixture authority closed");
            }
          },
        }),
      ).rejects.toMatchObject({ code: "CHANNEL_PARTIAL_DELIVERY" });
      expect(visible()).toEqual(["hello 🌙"]);
    },
  );
  it.each([canonical, ordinary])(
    "preserves unclassified controls and creates no blank text",
    async (send) => {
      for (const text of ["NO_REPLY", "HEARTBEAT_OK"]) {
        state.physical.length = 0;
        await send(text, { unclassified: true });
        expect(visible()).toEqual([text]);
      }
      for (const text of [" \n\t", "\t"]) {
        state.physical.length = 0;
        await send(text);
        expect(state.physical).toEqual([]);
      }
      await send("🌙︎ 🌙️");
      expect(visible()).toEqual(["🌙"]);
      state.physical.length = 0;
      await send("****");
      expect(visible()).toEqual(["─── 🌙"]);
    },
  );

  it.each([canonical, ordinary])(
    "keeps signatures outside native formatting at the final physical send",
    async (send) => {
      await send("**hello 🌙🌙️**");
      expect(visible()).toEqual(["*hello* 🌙"]);
      expect(state.physical[0]?.jid).toBe(lid);
    },
  );
  it.each(["image/png", "video/mp4", "application/pdf", "audio/ogg"])(
    "covers caption/separate-audio text without rewriting media: %s",
    async (mime) => {
      await canonical("**caption 🌙**", { mime });
      expect(visible()).toEqual(["*caption* 🌙"]);
      const content = state.physical[0]?.content;
      expect(
        content &&
          ("image" in content
            ? content.image
            : "video" in content
              ? content.video
              : "document" in content
                ? content.document
                : "audio" in content
                  ? content.audio
                  : undefined),
      ).toEqual(Buffer.from([1, 2, 3]));
      if (mime.startsWith("audio")) {
        expect(state.physical).toHaveLength(2);
      }
    },
  );
  it("budgets every rendered chunk and preserves body data moons at cuts", async () => {
    await canonical("**" + "body🌙 NEXT ".repeat(12).trim() + "**", { cap: 24 });
    expect(visible().length).toBeGreaterThan(1);
    expect(visible().every((text) => text.length <= 24 && text.endsWith("🌙"))).toBe(true);
    expect(
      visible()
        .map((text) => text.slice(0, -3).replaceAll("*", ""))
        .join("")
        .replaceAll(" ", ""),
    ).toBe("body🌙NEXT".repeat(12));
  });
  it("matches only actual listener account and trusted PN/LID mapping", async () => {
    await canonical("hello", { agentId: "other" });
    expect(visible()).toEqual(["hello"]);
    state.physical.length = 0;
    await canonical("hello", { to: "111111111@lid" });
    expect(visible()).toEqual(["hello"]);
    state.physical.length = 0;
    await canonical("hello", { to: "12345@g.us" });
    expect(visible()).toEqual(["hello"]);
    state.physical.length = 0;
    if (state.listener) {
      state.listener.accountId = "different-account";
    }
    await canonical("hello");
    expect(visible()).toEqual(["hello"]);
  });
  it("keeps legacy/disabled control and media-only behavior without creating captions", async () => {
    await sendMessageWhatsApp("+15550001111", "NO_REPLY", { cfg, verbose: false });
    expect(visible()).toEqual(["NO_REPLY"]);
    state.physical.length = 0;
    await canonical("", { mime: "image/png" });
    expect(visible()).toEqual([]);
    expect(state.physical).toHaveLength(1);
  });
  it.each(["absent", "disabled", "unmatched"] as const)(
    "keeps the configured table rendering when the suffix policy is %s",
    async (policyState) => {
      const policy = cfg.messages?.outboundTextSuffix;
      if (!policy) {
        throw new Error("Missing synthetic suffix policy");
      }
      const localCfg: OpenClawConfig = {
        ...cfg,
        messages:
          policyState === "absent"
            ? {}
            : { outboundTextSuffix: { ...policy, enabled: policyState !== "disabled" } },
      };
      await sendMessageWhatsApp(
        "+15550001111",
        "| Name | Value |\n| --- | --- |\n| Alpha | Beta |",
        {
          cfg: localCfg,
          verbose: false,
          formatting: { textLimit: 4_000, tableMode: "bullets", chunkMode: "length" },
          ...(policyState === "absent"
            ? {}
            : {
                textPreparation: {
                  suffix: runtime.capture(localCfg, {
                    kind: "agent",
                    agentId: policyState === "unmatched" ? "other" : "main",
                  }),
                  modifiersPrepared: true,
                },
                outboundTextSuffix: runtime,
              }),
        },
      );
      expect(visible()).toEqual([
        "```\n| Name  | Value |\n| ----- | ----- |\n| Alpha | Beta  |\n```",
      ]);
    },
  );
  it("replans the selected media warning before physical send", async () => {
    state.media.mockRejectedValueOnce(new Error("synthetic media failure"));
    await ordinary("**caption 🌙**", { media: true, cap: 24 });
    expect(visible().every((text) => text.length <= 24 && text.endsWith("🌙"))).toBe(true);
    expect(visible().join(" ")).toContain("⚠️");
    expect(
      visible()
        .join(" ")
        .match(/caption/gu),
    ).toHaveLength(1);
  });
  it.each(["text", "caption", "fallback"] as const)(
    "uses the captured reply cap consistently for %s",
    async (kind) => {
      if (kind === "fallback") {
        state.media.mockRejectedValueOnce(new Error("synthetic media failure"));
      }
      await ordinary("abcdefghijklmnopqrstuvwxyz", {
        media: kind !== "text",
        cap: 4_000,
        capturedFormatting: { textLimit: 12, tableMode: "bullets", chunkMode: "length" },
      });
      expect(visible().length).toBeGreaterThan(1);
      expect(visible().every((text) => text.length <= 12 && text.endsWith(" 🌙"))).toBe(true);
      expect(
        visible()
          .map((text) => text.slice(0, -3))
          .join("")
          .replaceAll(/\s/gu, ""),
      ).toBe("abcdefghijklmnopqrstuvwxyz" + (kind === "fallback" ? "⚠️Mediafailed." : ""));
    },
  );
  it("keeps unbound ordinary replies on their existing formatter", async () => {
    await ordinary("abcdefghijklmnopqrstuvwxyz", {
      agentId: "other",
      cap: 4_000,
      capturedFormatting: { textLimit: 12, tableMode: "code", chunkMode: "newline" },
    });
    expect(visible()).toEqual(["abcdefghijklmnopqrstuvwxyz"]);
  });
  it("retains first acceptance when the observer fails or live authority closes", async () => {
    await expect(
      canonical("hello world ".repeat(10), {
        onDeliveryResult: () => {
          throw new Error("observer failure");
        },
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      deliveryResult: { visibleReplySent: true },
    });
    expect(state.physical).toHaveLength(1);
    state.physical.length = 0;
    const controller = new AbortController();
    await expect(
      canonical("hello world ".repeat(10), {
        signal: controller.signal,
        onDeliveryResult: () => controller.abort(),
      }),
    ).rejects.toMatchObject({ code: "CHANNEL_PARTIAL_DELIVERY" });
    expect(state.physical).toHaveLength(1);
  });
  it("closes retained pure capability methods and lazy planning with their runtime owner", async () => {
    const retained = runtime;
    const bound = retained.bind(preparation().suffix, {
      channel: "whatsapp",
      accountId: "default",
      peer: { kind: "direct", id: "+15550001111" },
    });
    if (!bound) {
      throw new Error("missing bound fixture policy");
    }
    const pending = retained.planPreservedMarkdownText({
      text: "hello",
      boundSuffix: bound,
      effectiveLimit: 32,
      chunkMode: "length",
      planner: "source-markdown-v1",
    });
    const replacement = createPluginRegistryFixture({}, { allowProcessHomeSessionCatalogs: false });
    setActivePluginRegistry(replacement.registry.registry);
    await expect(pending).rejects.toThrow("no longer active");
    expect(() => retained.capture(cfg, { kind: "agent", agentId: "main" })).toThrow(
      "no longer active",
    );
    expect(() =>
      retained.finalize({ state: "body", text: "hello", separator: "space" }, bound),
    ).toThrow("no longer active");
  });

  it("rejects an indivisible grapheme before I/O", async () => {
    await expect(canonical("👨‍👩‍👧‍👦", { cap: 8 })).rejects.toMatchObject({
      code: "OPENCLAW_PLATFORM_MESSAGE_NOT_DISPATCHED",
      retryable: false,
    });
    expect(state.physical).toEqual([]);
  });
});
