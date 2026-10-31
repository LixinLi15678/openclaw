import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { setActivePluginRegistry } from "../../plugins/runtime.js";
import { createOutboundTestPlugin, createTestRegistry } from "../../test-utils/channel-plugins.js";
import { runMessageAction } from "./message-action-runner.js";
import type { OutboundTextPreparation } from "./text-suffix.types.js";

vi.mock("../../tts/tts.runtime.js", () => ({
  maybeApplyTtsToPayload: async (params: { payload: unknown }) => params.payload,
}));

afterEach(() => setActivePluginRegistry(createTestRegistry([])));

describe("message-tool suffix author admission", () => {
  it.each(["main", "other", undefined])(
    "freezes explicit author %s before session inference or model arguments",
    async (agentId) => {
      let preparation: OutboundTextPreparation | undefined;
      setActivePluginRegistry(
        createTestRegistry([
          {
            pluginId: "testchat",
            source: "test",
            plugin: createOutboundTestPlugin({
              id: "testchat",
              outbound: {
                deliveryMode: "direct",
                outboundTextSuffix: "suffix-v1",
                sendText: async (ctx) => {
                  preparation = ctx.textPreparation;
                  return { channel: "testchat", messageId: "accepted-fixture" };
                },
              },
            }),
          },
        ]),
      );
      const cfg: OpenClawConfig = {
        agents: { ownership: "explicit", entries: { main: {}, other: {} } },
        channels: { testchat: { enabled: true } },
        messages: {
          outboundTextSuffix: {
            enabled: true,
            text: "🌙",
            agentId: "main",
            targets: [
              {
                channel: "whatsapp",
                accountId: "fixture-account",
                peer: { kind: "direct", id: "+15550001111" },
              },
            ],
          },
        },
      };
      await runMessageAction({
        cfg,
        agentId,
        sessionKey: `agent:${agentId ?? "main"}:testchat:channel:fixture-peer`,
        action: "send",
        params: {
          channel: "testchat",
          target: "channel:fixture-peer",
          message: "fixture text",
          agentId: "main",
        },
        dryRun: false,
      });
      expect(preparation?.suffix.decision).toBe(agentId === "main" ? "scoped" : "none");
      expect(preparation?.visibility).toBe("visible");
    },
  );
});
