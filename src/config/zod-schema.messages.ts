import { isValidAgentId, normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { z } from "zod";
import { normalizeOptionalAccountId } from "../routing/account-id.js";

const VisibleRepliesSchema = z
  .union([z.enum(["automatic", "message_tool"]), z.boolean()])
  .overwrite((value) => {
    if (value === true) {
      return "automatic";
    }
    if (value === false) {
      return "message_tool";
    }
    return value;
  });

export const MentionPatternsPolicySchema = z.strictObject({
  mode: z.union([z.literal("allow"), z.literal("deny")]).optional(),
  allowIn: z.array(z.string()).optional(),
  denyIn: z.array(z.string()).optional(),
});

export const GroupChatSchema = z
  .strictObject({
    mentionPatterns: z.array(z.string()).optional(),
    historyLimit: z.number().int().min(0).optional(),
    unmentionedInbound: z.enum(["user_request", "room_event"]).optional(),
    visibleReplies: VisibleRepliesSchema.optional(),
  })
  .optional();

export const DmConfigSchema = z.strictObject({
  historyLimit: z.number().int().min(0).optional(),
});

const QueueModeSchema = z.union([
  z.literal("steer"),
  z.literal("followup"),
  z.literal("collect"),
  z.literal("interrupt"),
]);
const QueueModeBySurfaceSchema = z.record(z.string(), QueueModeSchema).optional();
const DebounceMsBySurfaceSchema = z.record(z.string(), z.number().int().nonnegative()).optional();

export const QueueSchema = z
  .strictObject({
    mode: QueueModeSchema.optional(),
    byChannel: QueueModeBySurfaceSchema,
    debounceMsByChannel: DebounceMsBySurfaceSchema,
    cap: z.number().int().positive().optional(),
    drop: z.union([z.literal("old"), z.literal("new"), z.literal("summarize")]).optional(),
  })
  .optional();

export const InboundDebounceSchema = z
  .strictObject({
    debounceMs: z.number().int().nonnegative().optional(),
    byChannel: DebounceMsBySurfaceSchema,
  })
  .optional();

export const NativeCommandsSettingSchema = z.union([z.boolean(), z.literal("auto")]);

export const ProviderCommandsSchema = z
  .strictObject({
    native: NativeCommandsSettingSchema.optional(),
    nativeSkills: NativeCommandsSettingSchema.optional(),
  })
  .optional();

const ResponseUsageModeSchema = z.enum(["on", "off", "tokens", "full"]);

const ExactSuffixIdentifierSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine(
    (value) => !/[\s*?\\[\]{}^$|()]/u.test(value),
    "Use an exact identifier, without wildcards, patterns or whitespace.",
  );
export const OutboundTextSuffixSchema = z
  .strictObject({
    enabled: z.boolean().default(false),
    text: z
      .string()
      .min(1)
      .refine(
        (value) =>
          value.trim().length > 0 &&
          Array.from(value).length <= 32 &&
          Buffer.byteLength(value, "utf8") <= 128 &&
          !/[\p{Cc}\p{Cf}\p{Cs}\u202A-\u202E\u2066-\u2069*_~`[\]<>#|\\]/u.test(value),
        "Use a nonblank, single-line literal suffix (at most 32 Unicode scalars / 128 UTF-8 bytes), without controls or markup.",
      )
      .refine((value) => !/[\r\n\u2028\u2029]/u.test(value), "Suffix must be single-line."),
    agentId: ExactSuffixIdentifierSchema.refine(
      isValidAgentId,
      "Use a valid agent identifier.",
    ).overwrite(normalizeAgentId),
    targets: z
      .array(
        z.strictObject({
          channel: z.enum(["whatsapp", "openclaw-weixin"]),
          accountId: ExactSuffixIdentifierSchema.refine(
            (value) => normalizeOptionalAccountId(value) !== undefined,
            "Use a valid account identifier.",
          ).overwrite((value) => normalizeOptionalAccountId(value) ?? value),
          peer: z.strictObject({ kind: z.literal("direct"), id: ExactSuffixIdentifierSchema }),
        }),
      )
      .max(32),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && value.targets.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["targets"],
        message: "An enabled suffix requires an exact direct target.",
      });
    }
    const keys = value.targets.map((target) =>
      JSON.stringify([target.channel, target.accountId, target.peer.id]),
    );
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        path: ["targets"],
        message: "Suffix targets must be unique.",
      });
    }
  });

export const MessagesSchema = z
  .strictObject({
    visibleReplies: VisibleRepliesSchema.optional(),
    responsePrefix: z.string().optional(),
    outboundTextSuffix: OutboundTextSuffixSchema.optional(),
    usageTemplate: z.union([z.string(), z.record(z.string(), z.unknown())]).optional(),
    responseUsage: z
      .union([ResponseUsageModeSchema, z.record(z.string(), ResponseUsageModeSchema)])
      .optional(),
    groupChat: GroupChatSchema,
    queue: QueueSchema,
    inbound: InboundDebounceSchema,
    ackReaction: z.string().optional(),
    ackReactionScope: z
      .enum(["group-mentions", "group-all", "direct", "all", "off", "none"])
      .optional(),
    statusReactions: z.strictObject({ enabled: z.boolean().optional() }).optional(),
  })
  .optional();

const BroadcastGroupSchema = z.strictObject({
  agents: z.array(z.string()).max(16),
  mentionGating: z.boolean().optional(),
  maxRounds: z.number().int().min(1).max(4).optional(),
  maxTurns: z.number().int().min(1).max(32).optional(),
});

export const BroadcastSchema = z
  .object({
    strategy: z.enum(["parallel", "sequential"]).optional(),
  })
  .catchall(z.union([z.array(z.string()), BroadcastGroupSchema]))
  .superRefine((broadcast, ctx) => {
    for (const [peerId, entry] of Object.entries(broadcast)) {
      if (typeof entry !== "object") {
        continue;
      }
      const qualified = /^[a-z][a-z0-9_-]*:.+$/i.test(peerId);
      if (!Array.isArray(entry) && !qualified) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [peerId],
          message: "Group options require a channel-qualified key (<channel>:<peerId>).",
        });
      } else if (Array.isArray(entry) && qualified && entry.length > 16) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [peerId],
          message: "Agent group threads support at most 16 agents.",
        });
      }
    }
  })
  .optional();
