export type PositionedMarkdownNode = {
  type?: string;
  value?: string;
  lang?: string | null;
  meta?: string | null;
  position?: {
    start?: { offset?: number; line?: number };
    end?: { offset?: number; line?: number };
  };
  children?: PositionedMarkdownNode[];
};

export type MarkdownIndentedSource = {
  /** Opt-in physical source lexemes; container/indent syntax is excluded by the parser. */
  segments?: Array<{ start: number; end: number; value: string }>;
  value: string;
  offsets: number[];
  /** Source framing before the first content token, including its owning containers. */
  context: string;
  ownerStart: number;
  nested: boolean;
};

export type MarkdownOwnershipOptions = {
  includeSource?: boolean;
  includeIndentedSource?: boolean;
  includeText?: boolean;
  syntax?: "commonmark" | "gfm";
  /** Opt-in positioned source planner grammar; existing reasoning callers keep their grammar. */
  includeStructure?: boolean;
};
