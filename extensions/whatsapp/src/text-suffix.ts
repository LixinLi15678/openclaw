import type {
  BoundTextSuffix,
  OutboundTextSuffixContext,
} from "openclaw/plugin-sdk/channel-contract";
import { toWhatsappJid } from "./targets-runtime.js";

/** Equivalence is supplied only by the listener's existing PN/LID mapping owner. */
export function bindWhatsAppTextSuffix(
  params: OutboundTextSuffixContext & {
    accountId?: string;
    jid?: string;
    equivalentJids?: readonly string[];
  },
): BoundTextSuffix | undefined {
  const { outboundTextSuffix: runtime, textPreparation: preparation, accountId, jid } = params;
  if (
    !runtime ||
    !preparation ||
    !accountId ||
    !jid ||
    !/^\d+(?::\d+)?@(?:s\.whatsapp\.net|hosted|lid|hosted\.lid)$/iu.test(jid)
  ) {
    return runtime && preparation ? runtime.bind(preparation.suffix) : undefined;
  }
  const snapshot = preparation.suffix;
  if (snapshot.decision === "none") {
    return undefined;
  }
  if (
    snapshot.version !== 1 ||
    snapshot.algorithm !== "literal-suffix-v1" ||
    snapshot.plannerVersion !== 1
  ) {
    return runtime.bind(snapshot);
  }
  const equivalent = new Set(params.equivalentJids ?? [jid]);
  const target = snapshot.targets.find(
    (candidate) =>
      candidate.channel === "whatsapp" &&
      candidate.accountId === accountId &&
      equivalent.has(toWhatsappJid(candidate.peer.id)),
  );
  return runtime.bind(
    snapshot,
    target
      ? { channel: "whatsapp", accountId, peer: { kind: "direct", id: target.peer.id } }
      : { channel: "whatsapp", accountId, peer: { kind: "direct", id: jid } },
  );
}
