import type { OutboundTextSuffixContext } from "openclaw/plugin-sdk/channel-contract";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import type { ChunkMode, ReplyPayload } from "openclaw/plugin-sdk/reply-chunking";
import {
  isReasoningReplyPayload,
  resolveTextChunksWithFallback,
  sendMediaWithLeadingCaption,
} from "openclaw/plugin-sdk/reply-payload";
import { logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
import { requireWhatsAppInboundAdmission } from "../inbound/admission.js";
import {
  listWhatsAppSendResultMessageIds,
  mergeWhatsAppAcceptedSendError,
  rememberWhatsAppAcceptedSend,
  rememberWhatsAppPartialSend,
  withWhatsAppLogicalDeliveryActivity,
  type WhatsAppSendKind,
  type WhatsAppSendResult,
} from "../inbound/send-result.js";
import type { AdmittedWebInboundMessage } from "../inbound/types.js";
import { loadWebMedia } from "../media.js";
import {
  type DeliverableWhatsAppOutboundPayload,
  normalizeWhatsAppOutboundPayload,
  normalizeWhatsAppPayloadTextPreservingIndentation,
  prepareWhatsAppOutboundMedia,
} from "../outbound-media-contract.js";
import { sendWhatsAppOutboundWithRetry } from "../outbound-retry.js";
import { buildQuotedMessageOptions, lookupInboundMessageMeta } from "../quoted-message.js";
import { newConnectionId } from "../reconnect.js";
import { formatError } from "../session.js";
import { markdownToWhatsAppChunks, markdownToWhatsAppSuffixChunks } from "../targets-runtime.js";
import { bindWhatsAppTextSuffix } from "../text-suffix.js";
import { whatsappOutboundLog } from "./loggers.js";
import { elide } from "./util.js";

export type WhatsAppReplyDeliveryResult = Awaited<ReturnType<typeof deliverWebReply>>;

export type WhatsAppReplyTransportContext = Omit<
  ReturnType<typeof createWhatsAppReplyTransportContext>,
  "senderJid" | "correlationId"
> & {
  senderJid?: string;
  correlationId?: string;
};

export function createWhatsAppReplyTransportContext(msg: AdmittedWebInboundMessage) {
  const admission = requireWhatsAppInboundAdmission(msg);
  return {
    accountId: admission.accountId,
    conversationId: admission.conversation.id,
    conversationKind: admission.conversation.kind,
    chatJid: msg.platform.chatJid,
    resolveEquivalentDirectChatJids: msg.platform.resolveEquivalentDirectChatJids,
    senderJid: msg.platform.senderJid,
    recipientJid: msg.platform.recipientJid,
    correlationId: msg.event.id,
    reply: msg.platform.reply,
    sendMedia: msg.platform.sendMedia,
  };
}

function resolveWhatsAppReceiptKind(
  results: readonly WhatsAppSendResult[],
): Parameters<typeof createMessageReceiptFromOutboundResults>[0]["kind"] {
  if (results.length > 0 && results.every((result) => result.kind === "text")) {
    return "text";
  }
  if (results.length > 0 && results.every((result) => result.kind === "media")) {
    return "media";
  }
  return "unknown";
}

function createWhatsAppReplyDeliveryReceipt(
  results: readonly WhatsAppSendResult[],
): MessageReceipt {
  const receiptResultsById = new Map<string, MessageReceiptSourceResult>();
  for (const result of results) {
    const parts = result.receipt?.parts.length
      ? result.receipt.parts
      : listWhatsAppSendResultMessageIds(result).map((platformMessageId) => ({
          platformMessageId,
          raw: undefined,
        }));
    for (const part of parts) {
      receiptResultsById.set(part.platformMessageId, {
        ...(part.raw ?? { channel: "whatsapp", messageId: part.platformMessageId }),
        meta: {
          ...part.raw?.meta,
          kind: result.kind,
          providerAccepted: result.providerAccepted,
        },
      });
    }
  }
  return createMessageReceiptFromOutboundResults({
    results: [...receiptResultsById.values()],
    kind: resolveWhatsAppReceiptKind(results),
  });
}

type WhatsAppReplyDeliveryParams = OutboundTextSuffixContext & {
  signal?: AbortSignal;
  onPlatformSendDispatch?: () => Promise<void>;
  assertDirectAdapterHandoff?: () => void;
  replyResult: ReplyPayload;
  normalizedReplyResult?: DeliverableWhatsAppOutboundPayload<ReplyPayload>;
  transport: WhatsAppReplyTransportContext;
  mediaLocalRoots?: readonly string[];
  maxMediaBytes: number;
  textLimit: number;
  chunkMode?: ChunkMode;
  replyLogger: {
    info: (obj: object, msg: string) => void;
    warn: (obj: object, msg: string) => void;
  };
  connectionId?: string;
  skipLog?: boolean;
  tableMode?: MarkdownTableMode;
  onMediaAccepted?: (mediaUrl: string) => void;
};

export async function deliverWebReply(params: WhatsAppReplyDeliveryParams) {
  return await withWhatsAppLogicalDeliveryActivity(() => deliverWebReplyInActivityScope(params));
}

async function deliverWebReplyInActivityScope(params: WhatsAppReplyDeliveryParams) {
  const { replyResult, transport, maxMediaBytes, replyLogger, connectionId, skipLog } = params;
  const conversationId = transport.conversationId;
  const isGroupConversation = transport.conversationKind === "group";
  const replyStarted = Date.now();
  const sendResults: WhatsAppSendResult[] = [];
  const acceptedMediaUrls = new Set<string>();
  const recordMediaAccepted = (mediaUrl: string) => {
    acceptedMediaUrls.add(mediaUrl);
    params.onMediaAccepted?.(mediaUrl);
  };
  const finishDelivery = () => {
    const receipt = createWhatsAppReplyDeliveryReceipt(sendResults);
    return {
      results: sendResults,
      receipt,
      providerAccepted: sendResults.some((result) => result.providerAccepted),
    };
  };
  const preserveAcceptedDeliveryError = (
    error: unknown,
    kind?: WhatsAppSendKind,
    mediaUrl?: string,
  ) => {
    const sendKind = kind ?? sendResults[0]?.kind ?? "text";
    if (isChannelPartialDeliveryError(error)) {
      const accepted = rememberWhatsAppPartialSend({
        error,
        kind: sendKind,
        results: sendResults,
      });
      if (accepted && mediaUrl) {
        recordMediaAccepted(mediaUrl);
      }
    }
    return mergeWhatsAppAcceptedSendError({
      error,
      kind: sendKind,
      results: sendResults,
    });
  };
  const rememberSendResult = (result: WhatsAppSendResult | undefined, mediaUrl?: string) => {
    if (!result) {
      return;
    }
    try {
      rememberWhatsAppAcceptedSend({
        accountId: transport.accountId,
        result,
        results: sendResults,
      });
    } catch (error: unknown) {
      if (sendResults.some((accepted) => accepted.providerAccepted)) {
        throw preserveAcceptedDeliveryError(error, result.kind);
      }
      throw error;
    } finally {
      // The owner appends the validated result before activity bookkeeping can throw.
      if (mediaUrl && sendResults.includes(result)) {
        recordMediaAccepted(mediaUrl);
      }
    }
  };
  if (isReasoningReplyPayload(replyResult)) {
    whatsappOutboundLog.debug(`Suppressed reasoning payload to ${conversationId}`);
    return finishDelivery();
  }
  const normalizedReply =
    params.normalizedReplyResult ??
    normalizeWhatsAppOutboundPayload(replyResult, {
      normalizeText: normalizeWhatsAppPayloadTextPreservingIndentation,
    });
  const text = normalizedReply.text ?? "";
  const suffix =
    transport.conversationKind === "direct"
      ? bindWhatsAppTextSuffix({
          ...params,
          accountId: transport.accountId,
          jid: transport.chatJid,
          equivalentJids: await transport.resolveEquivalentDirectChatJids?.(transport.chatJid),
        })
      : undefined;
  const formatting = suffix ? params.textFormatting : undefined;
  const textLimit = suffix
    ? Math.min(formatting?.textLimit ?? params.textLimit, 4_096)
    : params.textLimit;
  const tableMode = formatting?.tableMode ?? params.tableMode ?? "code";
  const chunkMode = formatting?.chunkMode ?? params.chunkMode ?? "length";
  const planText = (value: string) =>
    suffix &&
    params.outboundTextSuffix &&
    (params.textPreparation?.visibility === "visible" ||
      !/^(?:NO_REPLY|HEARTBEAT_OK)$/u.test(value.trim()))
      ? markdownToWhatsAppSuffixChunks({
          text: value,
          limit: textLimit,
          tableMode,
          chunkMode,
          suffix,
          runtime: params.outboundTextSuffix,
        })
      : resolveTextChunksWithFallback(
          value,
          markdownToWhatsAppChunks(value, textLimit, tableMode, chunkMode),
        );
  const textChunks = planText(text);
  const sendAuthority =
    suffix && (params.signal || params.onPlatformSendDispatch || params.assertDirectAdapterHandoff)
      ? {
          signal: params.signal,
          onPlatformSendDispatch: params.onPlatformSendDispatch,
          assertDirectAdapterHandoff: params.assertDirectAdapterHandoff,
        }
      : undefined;
  const mediaList = normalizedReply.mediaUrls ?? [];

  const getQuote = () => {
    if (!replyResult.replyToId) {
      return undefined;
    }
    // Use replyToId (not msg.event.id) so batched payloads quote the correct
    // per-message target.  Look up cached metadata for the specific
    // message being quoted — msg.payload.body may be a combined batch body.
    const cached = lookupInboundMessageMeta(
      transport.accountId,
      transport.chatJid,
      replyResult.replyToId,
    );
    return buildQuotedMessageOptions({
      messageId: replyResult.replyToId,
      remoteJid: transport.chatJid,
      fromMe: cached?.fromMe ?? false,
      participant: cached?.participant ?? (isGroupConversation ? transport.senderJid : undefined),
      messageText: cached?.body ?? "",
      media: cached?.media,
    });
  };

  const sendWithRetry = async <T>(
    fn: () => Promise<T>,
    label: string,
    kind: WhatsAppSendKind,
    mediaUrl?: string,
  ) => {
    try {
      return await sendWhatsAppOutboundWithRetry({
        send: async () => {
          params.signal?.throwIfAborted();
          if (suffix) {
            await params.onPlatformSendDispatch?.();
            params.signal?.throwIfAborted();
            params.assertDirectAdapterHandoff?.();
          }
          return fn();
        },
        onRetry: ({ attempt, maxAttempts: retryMaxAttempts, backoffMs, errorText }) => {
          logVerbose(
            `Retrying ${label} to ${conversationId} after failure (${attempt}/${retryMaxAttempts - 1}) in ${backoffMs}ms: ${errorText}`,
          );
        },
      });
    } catch (error: unknown) {
      if (
        isChannelPartialDeliveryError(error) ||
        sendResults.some((result) => result.providerAccepted)
      ) {
        throw preserveAcceptedDeliveryError(error, kind, mediaUrl);
      }
      throw error;
    }
  };

  const sendText = async (chunk: string, label: string, quote = getQuote) => {
    rememberSendResult(
      await sendWithRetry(
        () =>
          sendAuthority
            ? transport.reply(chunk, quote(), sendAuthority)
            : transport.reply(chunk, quote()),
        label,
        "text",
      ),
    );
  };

  if (mediaList.length === 0 && textChunks.length) {
    const totalChunks = textChunks.length;
    for (const [index, chunk] of textChunks.entries()) {
      const chunkStarted = Date.now();
      const quote = getQuote();
      await sendText(chunk, "text", () => quote);
      if (!skipLog) {
        const durationMs = Date.now() - chunkStarted;
        whatsappOutboundLog.debug(
          `Sent chunk ${index + 1}/${totalChunks} to ${conversationId} (${durationMs.toFixed(0)}ms)`,
        );
      }
    }
    const delivery = finishDelivery();
    const logPayload = {
      correlationId: transport.correlationId ?? newConnectionId(),
      connectionId: connectionId ?? null,
      to: conversationId,
      from: transport.recipientJid,
      text: elide(replyResult.text, 240),
      mediaUrl: null,
      mediaSizeBytes: null,
      mediaKind: null,
      durationMs: Date.now() - replyStarted,
    };
    if (delivery.providerAccepted) {
      replyLogger.info(logPayload, "auto-reply sent (text)");
    } else {
      replyLogger.warn(logPayload, "auto-reply text was not accepted by WhatsApp provider");
    }
    return delivery;
  }

  const remainingText = [...textChunks];

  const leadingCaption = remainingText.shift() || "";
  await sendMediaWithLeadingCaption({
    mediaUrls: mediaList,
    caption: leadingCaption,
    send: async ({ mediaUrl, caption }) => {
      const media = await prepareWhatsAppOutboundMedia(
        await loadWebMedia(mediaUrl, {
          maxBytes: maxMediaBytes,
          localRoots: params.mediaLocalRoots,
        }),
        mediaUrl,
      );
      if (shouldLogVerbose()) {
        logVerbose(
          `Web auto-reply media size: ${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB`,
        );
        logVerbose(`Web auto-reply media source: ${mediaUrl} (kind ${media.kind})`);
      }
      const quote = getQuote();
      const mediaContent =
        media.kind === "image"
          ? { image: media.buffer, caption }
          : media.kind === "audio"
            ? { audio: media.buffer, ptt: true }
            : media.kind === "video"
              ? { video: media.buffer, caption }
              : { document: media.buffer, fileName: media.fileName, caption };
      rememberSendResult(
        await sendWithRetry(
          () =>
            sendAuthority
              ? transport.sendMedia(
                  { ...mediaContent, mimetype: media.mimetype },
                  quote,
                  sendAuthority,
                )
              : transport.sendMedia({ ...mediaContent, mimetype: media.mimetype }, quote),
          `media:${media.kind}`,
          "media",
          mediaUrl,
        ),
        mediaUrl,
      );
      if (media.kind === "audio" && caption) {
        await sendText(caption, "media:audio-text", () => quote);
      }
      whatsappOutboundLog.info(
        `Sent media reply to ${conversationId} (${(media.buffer.length / (1024 * 1024)).toFixed(2)}MB)`,
      );
      replyLogger.info(
        {
          correlationId: transport.correlationId ?? newConnectionId(),
          connectionId: connectionId ?? null,
          to: conversationId,
          from: transport.recipientJid,
          text: caption ?? null,
          mediaUrl,
          mediaSizeBytes: media.buffer.length,
          mediaKind: media.kind,
          durationMs: Date.now() - replyStarted,
        },
        "auto-reply sent (media)",
      );
    },
    onError: async ({ error, mediaUrl, caption, isFirst }) => {
      if (acceptedMediaUrls.has(mediaUrl)) {
        // Earlier accepted uploads do not make a genuinely rejected trailing upload successful.
        throw preserveAcceptedDeliveryError(error);
      }
      whatsappOutboundLog.error(
        `Failed sending web media to ${conversationId}: ${formatError(error)}`,
      );
      replyLogger.warn({ err: error, mediaUrl }, "failed to send web media reply");
      // A failed trailing attachment needs its own warning after earlier accepted media.
      const fallbackText = isFirst
        ? [suffix ? text : (caption ?? ""), "⚠️ Media failed."].filter(Boolean).join("\n")
        : "⚠️ Media unavailable.";
      whatsappOutboundLog.warn(
        isFirst
          ? `Media skipped; sent text-only to ${conversationId}`
          : `Trailing media failed; sent warning to ${conversationId}`,
      );
      if (suffix) {
        if (isFirst) {
          remainingText.length = 0;
        }
        const warnings =
          isFirst && params.outboundTextSuffix
            ? markdownToWhatsAppSuffixChunks({
                text,
                appendPlainText: "⚠️ Media failed.",
                limit: textLimit,
                tableMode,
                chunkMode,
                suffix,
                runtime: params.outboundTextSuffix,
              })
            : planText(fallbackText);
        for (const warning of warnings) {
          await sendText(warning, isFirst ? "media:fallback-text" : "media:fallback-unavailable");
        }
      } else {
        await sendText(
          fallbackText,
          isFirst ? "media:fallback-text" : "media:fallback-unavailable",
        );
      }
    },
  });

  for (const chunk of remainingText) {
    await sendText(chunk, "media:text");
  }
  return finishDelivery();
}
