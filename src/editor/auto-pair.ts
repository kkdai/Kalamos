/**
 * ED-09 auto-pairing (issue #18).
 *
 * - Brackets / quotes (setting `autoPairBrackets`, default on): CodeMirror's
 *   `closeBrackets()` configured through language data for `( [ { " '` and
 *   the full-width pairs 「」 『』 （） 【】 《》 “” ‘’. Typing the closer over an
 *   auto-inserted closer skips it; Backspace inside an empty pair deletes
 *   both; `'` right after a letter is an apostrophe (`don't`) and is not paired.
 * - Markdown symbols (setting `autoPairMarkdown`, default off): `*` `_` `` ` ``
 *   `~` with a small handler of our own, because Markdown needs different
 *   rules than quotes (`*|*` + `*` → `**|**` for bold, no pairing for a list
 *   marker at the start of a line, nothing inside code / math, intraword `_`).
 *
 * Neither runs during IME composition: composed text (often how CJK users
 * type 「) is inserted exactly as committed, never duplicated.
 */

import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { SyntaxNode } from "@lezer/common";
import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  type Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { mapPosClamped } from "./positions";

export const AUTO_PAIR_BRACKETS_MESSAGE = (on: boolean): string => `自動配對括號：${on ? "開" : "關"}`;
export const AUTO_PAIR_MARKDOWN_MESSAGE = (on: boolean): string =>
  `自動配對 Markdown 符號：${on ? "開" : "關"}`;

/** Openers handed to `closeBrackets` (closers: next code point / ASCII table). */
export const AUTO_PAIR_BRACKETS = [
  "(",
  "[",
  "{",
  '"',
  "'",
  "「",
  "『",
  "（",
  "【",
  "《",
  "“",
  "‘",
];

/** Pair only when the next character is whitespace, end of line or one of these. */
const CLOSE_BEFORE = ")]}:;>,.!?」』）】》”’，。、！？：；";

const bracketsLanguageData = EditorState.languageData.of(() => [
  { closeBrackets: { brackets: AUTO_PAIR_BRACKETS, before: CLOSE_BEFORE } },
]);

/** Brackets / quotes pairing (setting `autoPairBrackets`). */
export const autoPairBracketsExtension: Extension = [
  Prec.highest(bracketsLanguageData),
  closeBrackets(),
  Prec.high(keymap.of(closeBracketsKeymap)),
];

// ---------------------------------------------------------------------------
// Markdown symbols
// ---------------------------------------------------------------------------

export const MARKDOWN_PAIR_SYMBOLS = ["*", "_", "`", "~"] as const;

/** Positions of closers we inserted (mapped through edits). */
const addCloserEffect = StateEffect.define<number[]>();
/** Cursor position right after an empty auto pair (`*|*`), else null. */
const setEmptyPairEffect = StateEffect.define<number | null>();

interface MarkdownPairState {
  closers: readonly number[];
  emptyPairAt: number | null;
}

export const markdownPairField = StateField.define<MarkdownPairState>({
  create: () => ({ closers: [], emptyPairAt: null }),
  update(value, tr: Transaction) {
    let closers = value.closers;
    let emptyPairAt = value.emptyPairAt;
    if (tr.docChanged) {
      // Callers also check that the symbol is still there before trusting a closer.
      closers = closers.map((p) => mapPosClamped(tr.changes, p, 1));
      emptyPairAt = null;
    } else if (tr.selection) {
      emptyPairAt = null;
    }
    // Forget closers on other lines once the cursor moves away (like closeBrackets).
    if (tr.selection || tr.docChanged) {
      const line = tr.state.doc.lineAt(tr.state.selection.main.head);
      closers = closers.filter((p) => p >= line.from && p <= line.to);
    }
    for (const e of tr.effects) {
      if (e.is(addCloserEffect)) closers = [...closers, ...e.value];
      if (e.is(setEmptyPairEffect)) emptyPairAt = e.value;
    }
    if (closers === value.closers && emptyPairAt === value.emptyPairAt) return value;
    return { closers, emptyPairAt };
  },
});

const CODE_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "InlineMath",
  "BlockMath",
  "HTMLBlock",
  "HTMLTag",
  "URL",
  "Autolink",
  "FrontMatter",
]);

function insideCode(state: EditorState, pos: number): boolean {
  for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, -1); node; node = node.parent) {
    if (CODE_NODES.has(node.name)) return true;
  }
  return false;
}

function isWordChar(state: EditorState, pos: number, ch: string): boolean {
  return ch !== "" && state.charCategorizer(pos)(ch) === 0 /* CharCategory.Word */;
}

/**
 * Transaction for typing a Markdown pair symbol, or null to let the default
 * input happen. Exported for tests.
 */
export function markdownPairTransaction(state: EditorState, symbol: string): Transaction | null {
  if (!(MARKDOWN_PAIR_SYMBOLS as readonly string[]).includes(symbol)) return null;
  const sel = state.selection;
  if (sel.ranges.length !== 1) return null;
  const range = sel.main;
  const field = state.field(markdownPairField, false);
  if (!field) return null;

  // Wrap a selection: *selected*.
  if (!range.empty) {
    if (state.doc.lineAt(range.from).number !== state.doc.lineAt(range.to).number) return null;
    if (insideCode(state, range.from) && symbol !== "`") return null;
    return state.update({
      changes: [
        { from: range.from, insert: symbol },
        { from: range.to, insert: symbol },
      ],
      selection: EditorSelection.range(range.anchor + 1, range.head + 1),
      userEvent: "input.type",
      scrollIntoView: true,
    });
  }

  const pos = range.head;
  const line = state.doc.lineAt(pos);
  const prev = pos > line.from ? state.sliceDoc(pos - 1, pos) : "";
  const next = pos < line.to ? state.sliceDoc(pos, pos + 1) : "";
  const closerHere = field.closers.includes(pos);

  // `*|*` + `*` → `**|**` (bold, strikethrough `~~`, code ``…``).
  if (field.emptyPairAt === pos && prev === symbol && next === symbol && closerHere) {
    return state.update({
      changes: { from: pos, insert: symbol + symbol },
      selection: EditorSelection.cursor(pos + 1),
      effects: [addCloserEffect.of([pos + 1]), setEmptyPairEffect.of(pos + 1)],
      userEvent: "input.type",
      scrollIntoView: true,
    });
  }
  // Typing the closer over our own closer skips it.
  if (next === symbol && closerHere) {
    return state.update({
      selection: EditorSelection.cursor(pos + 1),
      userEvent: "input.type",
      scrollIntoView: true,
    });
  }
  if (insideCode(state, pos)) return null;
  // List markers / horizontal rules at the start of a line: `* item`, `***`.
  if (state.sliceDoc(line.from, pos).trim() === "" && symbol !== "`") return null;
  // Intraword (`snake_case`, `2*3`) or before a word: no pairing.
  if (isWordChar(state, pos, prev) || isWordChar(state, pos, next)) return null;
  if (next !== "" && !/\s/.test(next) && !CLOSE_BEFORE.includes(next)) return null;

  return state.update({
    changes: { from: pos, insert: symbol + symbol },
    selection: EditorSelection.cursor(pos + 1),
    effects: [addCloserEffect.of([pos + 1]), setEmptyPairEffect.of(pos + 1)],
    userEvent: "input.type",
    scrollIntoView: true,
  });
}

/** Backspace inside an empty auto pair (`*|*`) deletes both. Exported for tests. */
export function deleteMarkdownPair(view: EditorView): boolean {
  const state = view.state;
  const field = state.field(markdownPairField, false);
  if (!field || state.selection.ranges.length !== 1) return false;
  const range = state.selection.main;
  if (!range.empty) return false;
  const pos = range.head;
  const prev = state.sliceDoc(pos - 1, pos);
  const next = state.sliceDoc(pos, pos + 1);
  if (
    prev !== next ||
    !(MARKDOWN_PAIR_SYMBOLS as readonly string[]).includes(prev) ||
    !field.closers.includes(pos)
  ) {
    return false;
  }
  view.dispatch({
    changes: { from: pos - 1, to: pos + 1 },
    selection: EditorSelection.cursor(pos - 1),
    userEvent: "delete.backward",
    scrollIntoView: true,
  });
  return true;
}

const markdownPairInputHandler = EditorView.inputHandler.of((view, from, to, text) => {
  if (view.composing || view.compositionStarted || view.state.readOnly) return false;
  if (text.length !== 1) return false;
  const sel = view.state.selection.main;
  if (from !== sel.from || to !== sel.to) return false;
  const tr = markdownPairTransaction(view.state, text);
  if (!tr) return false;
  view.dispatch(tr);
  return true;
});

/** Markdown `* _ \` ~` pairing (setting `autoPairMarkdown`). */
export const autoPairMarkdownExtension: Extension = [
  markdownPairField,
  markdownPairInputHandler,
  Prec.high(keymap.of([{ key: "Backspace", run: deleteMarkdownPair }])),
];
