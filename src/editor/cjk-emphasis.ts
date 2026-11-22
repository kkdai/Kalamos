/**
 * CJK-friendly emphasis flanking (issue #22, PRD ED-03).
 *
 * CommonMark's left/right-flanking rules treat full-width punctuation like
 * ASCII punctuation, so `中文**「粗體」**中文` and `中文**粗體。**中文` are not
 * emphasis: the delimiter's inner side is punctuation while its outer side is
 * a letter-like CJK character. Following the CommonMark CJK proposal /
 * markdown-it-cjk-friendly, a CJK character on the *outer* side of a `*` run
 * is treated like whitespace / punctuation, so such runs still flank:
 *
 *   left-flanking  = !sAfter  && (!pAfter  || sBefore || pBefore || cjkBefore)
 *   right-flanking = !sBefore && (!pBefore || sAfter  || pAfter  || cjkAfter)
 *
 * Only `*` runs are relaxed. `_` stays strict: intraword `_` between CJK
 * characters (snake_case identifiers, file names like `報告_v2_最終`) would
 * otherwise become frequent false positives, and there is no rule that
 * separates those from intended emphasis cleanly. ASCII text is unaffected
 * (the relaxation only fires when a neighbour is CJK). This is parse/render
 * only — the document text is never changed.
 *
 * Note: GitHub and other strict CommonMark renderers will still show these
 * cases as literal `**`.
 */

import {
  type DelimiterType,
  parser as defaultParser,
  type InlineContext,
  type InlineParser,
  type MarkdownConfig,
} from "@lezer/markdown";

/** Same punctuation class @lezer/markdown uses (Unicode P + S). */
const PUNCTUATION = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s|^$/;

/**
 * Han, Hiragana, Katakana, Hangul, Bopomofo, CJK symbols & punctuation
 * (U+3000–U+303F), CJK compatibility / radicals, and half/full-width forms
 * (U+FF00–U+FFEF).
 */
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}⺀-⿟　-〿㆐-ㇿ㈀-㏿︰-﹏＀-￯]/u;

export function isCjkChar(ch: string): boolean {
  return ch !== "" && CJK.test(ch);
}

type InlineParseFn = InlineParser["parse"];

interface ParserInternals {
  inlineParsers?: Array<InlineParseFn | undefined>;
  inlineNames?: string[];
}

/**
 * The built-in asterisk delimiter type. `resolveMarkers` recognises emphasis
 * by identity, so we must reuse lezer's own object; we capture it by running
 * the built-in Emphasis parser once against a stub context.
 */
function captureAsteriskType(): DelimiterType | null {
  const internals = defaultParser as unknown as ParserInternals;
  const index = internals.inlineNames?.indexOf("Emphasis") ?? -1;
  const builtin = index >= 0 ? internals.inlineParsers?.[index] : undefined;
  if (!builtin) return null;
  const text = "a*b";
  let captured: DelimiterType | null = null;
  const stub = {
    char: (pos: number) =>
      pos >= 0 && pos < text.length ? text.charCodeAt(pos) : -1,
    slice: (from: number, to: number) =>
      text.slice(Math.max(0, from), Math.max(0, to)),
    append: (elt: { type?: DelimiterType }) => {
      captured = elt.type ?? null;
      return 0;
    },
  };
  try {
    builtin(stub as unknown as InlineContext, 42, 1);
  } catch {
    return null;
  }
  return captured;
}

const EMPHASIS_ASTERISK = captureAsteriskType();

/** The character (code point) ending right before `pos`. */
function charBefore(cx: InlineContext, pos: number): string {
  if (pos <= cx.offset) return "";
  const ch = cx.slice(pos - 1, pos);
  const code = ch.charCodeAt(0);
  if (code >= 0xdc00 && code <= 0xdfff && pos - 2 >= cx.offset) {
    return cx.slice(pos - 2, pos);
  }
  return ch;
}

/** The character (code point) starting at `pos`. */
function charAt(cx: InlineContext, pos: number): string {
  if (pos >= cx.end) return "";
  const ch = cx.slice(pos, pos + 1);
  const code = ch.charCodeAt(0);
  if (code >= 0xd800 && code <= 0xdbff && pos + 1 < cx.end) {
    return cx.slice(pos, pos + 2);
  }
  return ch;
}

export interface FlankingInfo {
  canOpen: boolean;
  canClose: boolean;
}

/** Relaxed flanking for a `*` run with `before` / `after` neighbours ("" = line edge). */
export function cjkAsteriskFlanking(
  before: string,
  after: string,
): FlankingInfo {
  const pBefore = PUNCTUATION.test(before);
  const pAfter = PUNCTUATION.test(after);
  const sBefore = WHITESPACE.test(before);
  const sAfter = WHITESPACE.test(after);
  const cjkBefore = isCjkChar(before);
  const cjkAfter = isCjkChar(after);
  const leftFlanking = !sAfter && (!pAfter || sBefore || pBefore || cjkBefore);
  const rightFlanking = !sBefore && (!pBefore || sAfter || pAfter || cjkAfter);
  return { canOpen: leftFlanking, canClose: rightFlanking };
}

export const cjkEmphasisExtension: MarkdownConfig = {
  parseInline: [
    {
      name: "CJKEmphasis",
      before: "Emphasis",
      parse(cx, next, start) {
        if (next !== 42 /* '*' */ || !EMPHASIS_ASTERISK) return -1;
        let pos = start + 1;
        while (cx.char(pos) === 42) pos++;
        const before = charBefore(cx, start);
        const after = charAt(cx, pos);
        // Without a CJK neighbour the standard rule applies unchanged.
        if (!isCjkChar(before) && !isCjkChar(after)) return -1;
        const { canOpen, canClose } = cjkAsteriskFlanking(before, after);
        return cx.addDelimiter(
          EMPHASIS_ASTERISK,
          start,
          pos,
          canOpen,
          canClose,
        );
      },
    },
  ],
};
