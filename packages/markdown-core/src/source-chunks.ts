import { findGraphemeChunkEnd } from "@openclaw/normalization-core/grapheme";
import { parseMarkdownOwnership, type PositionedMarkdownNode } from "./reasoning-tag-parser.js";

export type SourceMarkdownBody = Readonly<{
  text: string;
  separator: "space" | "newline" | "blank-line";
  /** Original UTF-16 window; framing is synthetic and never logical signature input. */
  sourceStart: number;
  sourceEnd: number;
}>;

export class IndivisibleMarkdownSourceError extends Error {
  readonly code = "OPENCLAW_INDIVISIBLE_MARKDOWN_SOURCE";
  constructor() {
    super("Markdown source cannot fit the local text limit with its required framing and suffix");
    this.name = "IndivisibleMarkdownSourceError";
  }
}

const INLINE_WRAPPERS = new Set(["strong", "emphasis", "delete"]);
const CONTAINERS = new Set(["blockquote", "listItem", "heading"]);
const OPAQUE = new Set([
  "link",
  "linkReference",
  "image",
  "imageReference",
  "definition",
  "table",
  "thematicBreak",
]);
const bounds = (node: PositionedMarkdownNode) => ({
  start: node.position?.start?.offset ?? 0,
  end: node.position?.end?.offset ?? 0,
});
const parse = (text: string) => parseMarkdownOwnership(text, { includeStructure: true });

/** The syntax owner maps one caller-defined logical tail edit back into original source. */
export function editTerminalMarkdownText(
  text: string,
  edit: (literalTail: string) => { keepEnd: number; hadSignature: boolean },
): { text: string; signatureOnly: boolean } {
  const tree = parse(text).structure;
  const last = tree?.children?.at(-1);
  if (!last || (last.type !== "paragraph" && last.type !== "heading")) {
    return { text, signatureOnly: false };
  }
  const leaves: PositionedMarkdownNode[] = [];
  const collect = (node: PositionedMarkdownNode): boolean => {
    if (node.type === "text") {
      leaves.unshift(node);
      return true;
    }
    if (!INLINE_WRAPPERS.has(node.type ?? "")) {
      return false;
    }
    for (const child of node.children?.toReversed() ?? []) {
      if (!collect(child)) {
        return false;
      }
    }
    return true;
  };
  for (const node of last.children?.toReversed() ?? []) {
    if (!collect(node)) {
      break;
    }
  }
  const trailingWhitespace = text.match(/\s+$/u)?.[0] ?? "";
  const trailingStart = text.length - trailingWhitespace.length;
  const tail =
    leaves
      .map((node) => {
        const { start, end } = bounds(node);
        return text.slice(start, end);
      })
      .join("") + trailingWhitespace;
  const result = edit(tail);
  if (!result.hadSignature) {
    return { text, signatureOnly: false };
  }
  const removals: Array<{ start: number; end: number }> = [];
  if (trailingWhitespace && !trailingWhitespace.trim()) {
    removals.push({ start: trailingStart, end: text.length });
  }
  let logicalOffset = 0;
  for (const node of leaves) {
    const range = bounds(node);
    const keep = Math.max(0, Math.min(range.end - range.start, result.keepEnd - logicalOffset));
    if (keep < range.end - range.start) {
      removals.push({ start: range.start + keep, end: range.end });
    }
    logicalOffset += range.end - range.start;
  }
  const emptied = (node: PositionedMarkdownNode): boolean => {
    const range = bounds(node);
    if (node.type === "text") {
      return removals.some((removal) => removal.start <= range.start && removal.end >= range.end);
    }
    if (!INLINE_WRAPPERS.has(node.type ?? "") && node !== last) {
      return false;
    }
    const childrenEmpty = node.children?.map(emptied);
    if (!childrenEmpty?.length || !childrenEmpty.every(Boolean)) {
      return false;
    }
    removals.push(range);
    return true;
  };
  emptied(last);
  const merged: typeof removals = [];
  for (const range of removals.toSorted((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) {
      previous.end = Math.max(previous.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  let next = text;
  for (const range of merged.toReversed()) {
    next = next.slice(0, range.start) + next.slice(range.end);
  }
  return { text: next, signatureOnly: !next.trim() };
}

type NodeRecord = {
  node: PositionedMarkdownNode;
  ancestors: PositionedMarkdownNode[];
  start: number;
  end: number;
};
type Projection = { kind: string; styles: string; value: string };

function records(tree: PositionedMarkdownNode | undefined): NodeRecord[] {
  const output: NodeRecord[] = [];
  const visit = (node: PositionedMarkdownNode, ancestors: PositionedMarkdownNode[]) => {
    output.push({ node, ancestors, ...bounds(node) });
    for (const child of node.children ?? []) {
      visit(child, [...ancestors, node]);
    }
  };
  if (tree) {
    visit(tree, []);
  }
  return output;
}

function normalizeProjection(parts: Projection[]): Projection[] {
  const normalized: Projection[] = [];
  for (const part of parts) {
    if (!part.value) {
      continue;
    }
    const last = normalized.at(-1);
    if (last && last.kind === part.kind && last.styles === part.styles) {
      last.value += part.value;
    } else {
      normalized.push({ ...part });
    }
  }
  // Paragraph padding may acquire block ownership at a physical boundary. Its source bytes
  // remain copied, while code values (including edge spaces) are compared without trimming.
  if (normalized[0]?.kind === "text") {
    normalized[0].value = normalized[0].value.trimStart();
  }
  if (normalized.at(-1)?.kind === "text") {
    const last = normalized.at(-1);
    if (last) {
      last.value = last.value.trimEnd();
    }
  }
  return normalized.filter((part) => part.value.length > 0);
}

function projection(text: string): Projection[] {
  return normalizeProjection(
    records(parse(text).structure).flatMap(({ node, ancestors }) =>
      node.type === "text" || node.type === "inlineCode" || node.type === "code"
        ? [
            {
              kind: node.type === "text" ? "text" : node.type,
              styles: ancestors
                .filter((owner) => INLINE_WRAPPERS.has(owner.type ?? ""))
                .map((owner) => owner.type)
                .join("/"),
              value: node.value ?? "",
            },
          ]
        : [],
    ),
  );
}

function inlineCode(value: string): string {
  const runs = value.match(/`+/gu) ?? [];
  const marker = "`".repeat(Math.max(0, ...runs.map((run) => run.length)) + 1);
  const padding =
    value.startsWith("`") ||
    value.endsWith("`") ||
    (value.startsWith(" ") && value.endsWith(" ") && value.trim().length > 0)
      ? " "
      : "";
  return marker + padding + value + padding + marker;
}

/** Source-preserving, bounded Markdown planning. This module knows no suffix or route policy. */
export function planSourceMarkdownChunks(params: {
  text: string;
  chunkMode: "length" | "newline";
  /** Measures the complete caller-framed request, including its external signature. */
  fits: (body: SourceMarkdownBody) => boolean;
}): readonly SourceMarkdownBody[] {
  const { text } = params;
  if (!text.trim()) {
    return [];
  }
  const parsed = parse(text);
  const all = records(parsed.structure);
  const nodes = all.filter((record) => record.node.type !== "root");
  const projectionLeaves = nodes.filter(
    ({ node }) => node.type === "text" || node.type === "inlineCode" || node.type === "code",
  );
  const leaves = nodes.filter(
    ({ node, ancestors }) =>
      (node.type === "text" || node.type === "inlineCode" || node.type === "code") &&
      !ancestors.some((owner) => OPAQUE.has(owner.type ?? "")),
  );
  const opaque = nodes.filter(
    ({ node, ancestors }) =>
      OPAQUE.has(node.type ?? "") && !ancestors.some((owner) => OPAQUE.has(owner.type ?? "")),
  );
  const wrappers = nodes.filter(({ node }) => INLINE_WRAPPERS.has(node.type ?? ""));
  const containers = nodes.filter(({ node }) => CONTAINERS.has(node.type ?? ""));
  const codeRegions = parsed.regions;
  const codeValueOffset = (record: NodeRecord, offset: number): number => {
    if (offset <= record.start) {
      return 0;
    }
    const value = record.node.value ?? "";
    if (offset >= record.end) {
      return value.length;
    }
    const region = codeRegions.find((entry) => entry.start === record.start);
    const source = region?.source ?? region?.flowSource;
    if (!source) {
      return 0;
    }
    let mapped = source.offsets[offset - record.start] ?? value.length;
    if (record.node.type === "inlineCode") {
      mapped = source.value.slice(0, mapped).replace(/\r\n|\r|\n/gu, " ").length;
    }
    if (record.node.type === "inlineCode") {
      // CommonMark normalizes line endings and removes a single pair of padding spaces.
      const raw = source.value.replace(/\r\n|\r|\n/gu, " ");
      if (raw.startsWith(" ") && raw.endsWith(" ") && raw.trim()) {
        mapped -= 1;
      }
    }
    return Math.max(0, Math.min(value.length, mapped));
  };
  const markerParts = (record: NodeRecord) => {
    const first = record.node.children?.[0];
    const last = record.node.children?.at(-1);
    return {
      open: text.slice(record.start, first ? bounds(first).start : record.start),
      close: text.slice(last ? bounds(last).end : record.end, record.end),
    };
  };
  const contextPrefix = (record: NodeRecord): string => {
    const first = record.node.children?.[0];
    return first ? text.slice(record.start, bounds(first).start) : "";
  };
  const renderCode = (record: NodeRecord, start: number, end: number): string => {
    const value = (record.node.value ?? "").slice(
      codeValueOffset(record, start),
      codeValueOffset(record, end),
    );
    if (record.node.type === "inlineCode") {
      return inlineCode(value);
    }
    const raw = text.slice(record.start, record.end);
    const opener = raw.match(/^( {0,3})(`{3,}|~{3,})([^\r\n]*)/u);
    const prefix = record.ancestors
      .filter((owner) => owner.type === "blockquote" || owner.type === "listItem")
      .map((owner) => {
        const context = contextPrefix({ node: owner, ancestors: [], ...bounds(owner) });
        return owner.type === "listItem" ? context.replace(/[^ \t]/gu, " ") : context;
      })
      .join("");
    const region = codeRegions.find((entry) => entry.start === record.start);
    const rawValue =
      region?.flowSource?.segments
        ?.filter((segment) => segment.start < end && segment.end > start)
        .map((segment) =>
          segment.value.slice(
            Math.max(0, start - segment.start),
            Math.min(segment.value.length, end - segment.start),
          ),
        )
        .filter(Boolean)
        .join("") ?? value;
    if (!opener) {
      const indentation = raw.match(/^[ \t]+/u)?.[0] ?? "    ";
      return rawValue
        .split(/(?<=\n)/u)
        .map((line, index) => (index === 0 ? "" : prefix) + indentation + line)
        .join("");
    }
    const originalMarker = opener[2] ?? "```";
    const character = originalMarker[0] ?? "`";
    const runs = rawValue.match(new RegExp(character + "+", "gu")) ?? [];
    const marker = character.repeat(
      Math.max(originalMarker.length, ...runs.map((run) => run.length + 1)),
    );
    const ending = raw.includes("\r\n")
      ? "\r\n"
      : raw.includes("\r") && !raw.includes("\n")
        ? "\r"
        : "\n";
    if (start <= record.start && end >= record.end) {
      return raw + (/[\r\n]$/u.test(raw) ? "" : ending) + prefix + originalMarker;
    }
    const originalClosedBoundary = end >= record.end && /[\r\n]$/u.test(rawValue);
    const code = `${opener[1] ?? ""}${marker}${opener[3] ?? ""}${ending}${rawValue}${originalClosedBoundary ? "" : ending}${marker}`;
    // Container continuations use their existing indentation, never a new list marker.
    return code
      .split(/(?<=\n)/u)
      .map((line, index) => (index === 0 ? line : prefix + line))
      .join("");
  };
  const isUnclosedFence = (record: NodeRecord): boolean => {
    if (record.node.type !== "code") {
      return false;
    }
    const raw = text.slice(record.start, record.end);
    const opener = raw.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (!opener) {
      return false;
    }
    const lastLine = raw.slice(Math.max(raw.lastIndexOf("\n"), raw.lastIndexOf("\r")) + 1).trim();
    return (
      !/[\r\n]/u.test(raw) || !new RegExp(`^${opener[0]}{${opener.length},}$`, "u").test(lastLine)
    );
  };
  const render = (start: number, end: number): SourceMarkdownBody => {
    const activeStart = wrappers.filter((record) => record.start < start && start < record.end);
    const activeEnd = wrappers
      .filter((record) => record.start < end && end < record.end)
      .toReversed();
    const startContainers = containers.filter(
      (record) => record.start < start && start < record.end,
    );
    let prefix =
      startContainers.map(contextPrefix).join("") +
      activeStart.map((record) => markerParts(record).open).join("");
    let body = "";
    let cursor = start;
    for (const code of leaves.filter(
      ({ node, start: codeStart, end: codeEnd }) =>
        (node.type === "code" || node.type === "inlineCode") && codeStart < end && codeEnd > start,
    )) {
      if (start <= code.start && code.end <= end && !isUnclosedFence(code)) {
        continue;
      }
      body += text.slice(cursor, Math.max(cursor, code.start));
      body += renderCode(code, Math.max(start, code.start), Math.min(end, code.end));
      cursor = Math.min(end, code.end);
    }
    body += text.slice(cursor, end);
    const suffix = activeEnd.map((record) => markerParts(record).close).join("");
    const leading = activeStart.length ? (body.match(/^\s+/u)?.[0] ?? "") : "";
    const trailing = activeEnd.length ? (body.match(/\s+$/u)?.[0] ?? "") : "";
    if (leading || trailing) {
      prefix =
        startContainers.map(contextPrefix).join("") +
        leading +
        activeStart.map((record) => markerParts(record).open).join("");
      body = body.slice(leading.length, trailing ? -trailing.length : undefined);
    }
    const last = nodes.findLast((record) => record.start < end && record.end >= end);
    const block = nodes.some(
      (record) =>
        ["heading", "list", "blockquote", "table", "thematicBreak", "definition"].includes(
          record.node.type ?? "",
        ) &&
        record.start < end &&
        record.end >= end,
    );
    const codeBlock =
      last?.node.type === "code" ||
      leaves.some((record) => record.node.type === "code" && record.end === end);
    const literalMarkerTail =
      last?.node.type === "text" && /[*_~`]/u.test(text.slice(last.start, end));
    // A standalone signature paragraph cannot close unmatched literal delimiters or remain
    // inside a list/quote/heading/indented block. Fenced code needs only its closing newline.
    const indentedCode = leaves.some(
      (record) =>
        record.node.type === "code" &&
        record.start < end &&
        end <= record.end &&
        !/^ {0,3}(?:`{3,}|~{3,})/u.test(text.slice(record.start, record.end)),
    );
    const separator =
      block || literalMarkerTail || indentedCode ? "blank-line" : codeBlock ? "newline" : "space";
    if (prefix && !body) {
      prefix = "";
    }
    return {
      text: prefix + body + suffix + trailing,
      separator,
      sourceStart: start,
      sourceEnd: end,
    };
  };
  const whole = render(0, text.length);
  if (params.fits(whole)) {
    return Object.freeze([whole]);
  }
  // A reference depends on its document-level definition. Keep that document atomic rather
  // than change resolution or copy definitions into a new general-purpose reflow system.
  if (nodes.some(({ node }) => node.type === "linkReference" || node.type === "imageReference")) {
    throw new IndivisibleMarkdownSourceError();
  }
  const cuts = new Set<number>([0, text.length]);
  for (const record of [...leaves, ...opaque]) {
    cuts.add(record.start);
    cuts.add(record.end);
    if (opaque.includes(record)) {
      continue;
    }
    const raw = text.slice(record.start, record.end);
    if (record.node.type === "text") {
      for (let offset = 0; offset < raw.length;) {
        const lexeme = raw
          .slice(offset)
          .match(/^(?:\\[!-/:-@[-`{-~]|&(?:#[xX][\da-fA-F]+|#\d+|[a-zA-Z][\da-zA-Z]*);)/u)?.[0];
        const next = lexeme
          ? offset + lexeme.length
          : findGraphemeChunkEnd(
              raw,
              offset,
              offset + ((raw.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1),
              undefined,
              false,
            );
        // A grapheme may be longer than one code point; ask the shared boundary owner with
        // an expanding window, never force a surrogate-only progress cut.
        let boundary = next;
        for (let width = 2; boundary <= offset && offset + width <= raw.length; width += 1) {
          boundary = findGraphemeChunkEnd(raw, offset, offset + width, undefined, false);
        }
        if (boundary <= offset) {
          throw new IndivisibleMarkdownSourceError();
        }
        offset = boundary;
        cuts.add(record.start + offset);
      }
    } else {
      const value = record.node.value ?? "";
      const valueCuts = new Set<number>();
      for (let offset = 0; offset < value.length;) {
        let end = offset + 1;
        let next = 0;
        while (
          end <= value.length &&
          (next = findGraphemeChunkEnd(value, offset, end, undefined, false)) <= offset
        ) {
          end += 1;
        }
        if (next <= offset) {
          throw new IndivisibleMarkdownSourceError();
        }
        valueCuts.add(next);
        offset = next;
      }
      for (let offset = record.start + 1; offset < record.end; offset += 1) {
        const valueOffset = codeValueOffset(record, offset);
        if (valueCuts.has(valueOffset) && codeValueOffset(record, offset - 1) !== valueOffset) {
          cuts.add(offset);
        }
      }
    }
  }
  const sorted = [...cuts]
    .toSorted((a, b) => a - b)
    .filter((cut) => !opaque.some((record) => record.start < cut && cut < record.end));
  const expected = (start: number, end: number): Projection[] =>
    normalizeProjection(
      projectionLeaves.flatMap((record) => {
        if (record.start >= end || record.end <= start) {
          return [];
        }
        const from = Math.max(start, record.start);
        const to = Math.min(end, record.end);
        const styles = record.ancestors
          .filter((owner) => INLINE_WRAPPERS.has(owner.type ?? ""))
          .map((owner) => owner.type)
          .join("/");
        if (record.node.type !== "text") {
          return [
            {
              kind: record.node.type ?? "",
              styles,
              value: (record.node.value ?? "").slice(
                codeValueOffset(record, from),
                codeValueOffset(record, to),
              ),
            },
          ];
        }
        const raw = text.slice(from, to);
        const value =
          from === record.start && to === record.end
            ? (record.node.value ?? "")
            : text.slice(record.start, record.end) === record.node.value
              ? raw
              : projection(raw)
                  .map((part) => part.value)
                  .join("");
        return [{ kind: "text", styles, value }];
      }),
    );
  const output: SourceMarkdownBody[] = [];
  for (let start = 0; start < text.length;) {
    const candidates = sorted.filter((cut) => cut > start);
    const rank = (cut: number) =>
      nodes.some((record) => record.ancestors.length === 1 && record.end === cut)
        ? 3
        : text[cut - 1] === "\n"
          ? 2
          : params.chunkMode === "length" && /\s/u.test(text[cut] ?? "")
            ? 1
            : 0;
    candidates.sort((a, b) => rank(b) - rank(a) || b - a);
    let accepted: SourceMarkdownBody | undefined;
    for (const end of candidates) {
      const body = render(start, end);
      if (!body.text.trim() || !params.fits(body)) {
        continue;
      }
      const wanted = expected(start, end);
      if (wanted.length === 0 || JSON.stringify(projection(body.text)) !== JSON.stringify(wanted)) {
        continue;
      }
      accepted = body;
      break;
    }
    if (!accepted) {
      throw new IndivisibleMarkdownSourceError();
    }
    output.push(Object.freeze(accepted));
    start = accepted.sourceEnd;
  }
  return Object.freeze(output);
}
