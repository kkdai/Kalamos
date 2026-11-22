/**
 * ED-08 emoji autocomplete (issue #17).
 *
 * Typing `:` + at least two of `[a-z0-9_+-]` at a word boundary shows GitHub
 * gemoji candidates (emoji + `:name:`); accepting inserts the Unicode emoji in
 * place of `:name` (Typora behaviour). Typing a complete known `:name:` also
 * converts it. Nothing happens inside code, math, URLs, HTML or front matter,
 * after a letter / digit (`12:30`, `http:`), or while an IME is composing.
 *
 * The gemoji data (MIT) is bundled offline and loaded lazily as its own chunk
 * the first time a shortcode is typed.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import {
  EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { mapPosClamped } from "./positions";

export interface EmojiEntry {
  name: string;
  emoji: string;
  description: string;
}

export interface EmojiIndex {
  entries: readonly EmojiEntry[];
  byName: ReadonlyMap<string, string>;
}

export const MAX_EMOJI_OPTIONS = 50;
/** `:` + shortcode characters typed so far (at least two). */
const TRIGGER = /:[A-Za-z0-9_+-]{2,}$/;
const SHORTCODE_CHARS = /^[a-z0-9_+-]+$/;

let indexPromise: Promise<EmojiIndex> | null = null;
let loadedIndex: EmojiIndex | null = null;

export function buildEmojiIndex(
  data: ReadonlyArray<{
    emoji: string;
    names: readonly string[];
    description: string;
  }>,
): EmojiIndex {
  const entries: EmojiEntry[] = [];
  const byName = new Map<string, string>();
  for (const item of data) {
    for (const name of item.names) {
      if (byName.has(name)) continue;
      byName.set(name, item.emoji);
      entries.push({ name, emoji: item.emoji, description: item.description });
    }
  }
  return { entries, byName };
}

/** Loads gemoji (separate chunk) once. */
export function loadEmojiIndex(): Promise<EmojiIndex> {
  if (!indexPromise) {
    indexPromise = import("gemoji").then((m) => {
      loadedIndex = buildEmojiIndex(m.gemoji);
      return loadedIndex;
    });
    indexPromise.catch(() => {
      indexPromise = null;
    });
  }
  return indexPromise;
}

/** The index if it has been loaded already (no loading triggered). */
export function getLoadedEmojiIndex(): EmojiIndex | null {
  return loadedIndex;
}

/**
 * Candidates for `query` (without colons): names starting with it first, then
 * names containing it; shorter names first within each group.
 */
export function searchEmoji(
  index: EmojiIndex,
  query: string,
  limit = MAX_EMOJI_OPTIONS,
): EmojiEntry[] {
  const q = query.toLowerCase();
  if (!q) return [];
  const prefix: EmojiEntry[] = [];
  const substring: EmojiEntry[] = [];
  for (const entry of index.entries) {
    const at = entry.name.indexOf(q);
    if (at === 0) prefix.push(entry);
    else if (at > 0) substring.push(entry);
  }
  const byLength = (a: EmojiEntry, b: EmojiEntry): number =>
    a.name.length - b.name.length ||
    (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  prefix.sort(byLength);
  substring.sort(byLength);
  return [...prefix, ...substring].slice(0, limit);
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

const EXCLUDED_NODES = new Set([
  "InlineCode",
  "FencedCode",
  "CodeBlock",
  "CodeText",
  "InlineMath",
  "BlockMath",
  "URL",
  "Autolink",
  "HTMLBlock",
  "HTMLTag",
  "FrontMatter",
  "LinkReference",
  "Comment",
  "CommentBlock",
]);

/** True when a shortcode starting at `colonPos` must not be completed / converted. */
export function isExcludedEmojiContext(
  state: EditorState,
  colonPos: number,
): boolean {
  // `12:30`, `http:`, `a:b` — the colon must not follow a letter / digit.
  const before = state.sliceDoc(Math.max(0, colonPos - 2), colonPos);
  const prevChar = before ? (Array.from(before).pop() ?? "") : "";
  if (prevChar && /[\p{L}\p{N}_]/u.test(prevChar)) return true;
  // An inline code span still being typed (`` `code :sm ``) is not a node
  // yet: an odd number of backticks before the colon on this line means code.
  const line = state.doc.lineAt(colonPos);
  const ticks =
    state.sliceDoc(line.from, colonPos).replace(/\\`/g, "").match(/`+/g) ?? [];
  if (ticks.length % 2 === 1) return true;
  // Same for a `$$` display-math block still being typed: an odd number of
  // `$$`-only lines above (looking back a bounded number of lines).
  let fences = 0;
  for (let n = line.number - 1; n >= 1 && n >= line.number - 500; n--) {
    if (state.doc.line(n).text.trim() === "$$") fences++;
  }
  if (fences % 2 === 1) return true;
  // Front matter (also while it is still being typed): line 1 is `---` and no
  // closing `---` / `...` line comes before this one.
  if (
    line.number > 1 &&
    line.number <= 200 &&
    state.doc.line(1).text.trim() === "---"
  ) {
    let closed = false;
    for (let n = 2; n < line.number; n++) {
      const t = state.doc.line(n).text.trim();
      if (t === "---" || t === "...") {
        closed = true;
        break;
      }
    }
    if (!closed) return true;
  }
  const tree = syntaxTree(state);
  for (const side of [1, -1] as const) {
    for (
      let node: SyntaxNode | null = tree.resolveInner(colonPos, side);
      node;
      node = node.parent
    ) {
      if (EXCLUDED_NODES.has(node.name)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Completion source
// ---------------------------------------------------------------------------

interface EmojiCompletion extends Completion {
  emoji: string;
}

export async function emojiCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> {
  if (context.view?.composing || context.view?.compositionStarted) return null;
  const match = context.matchBefore(TRIGGER);
  if (!match) return null;
  if (isExcludedEmojiContext(context.state, match.from)) return null;
  const index = await loadEmojiIndex();
  if (context.aborted) return null;
  const query = match.text.slice(1);
  const options: EmojiCompletion[] = searchEmoji(index, query).map((entry) => ({
    label: `:${entry.name}:`,
    detail: entry.description,
    apply: entry.emoji,
    type: "emoji",
    emoji: entry.emoji,
  }));
  if (options.length === 0) return null;
  return { from: match.from, to: context.pos, options, filter: false };
}

// ---------------------------------------------------------------------------
// `:name:` → emoji when the closing colon is typed
// ---------------------------------------------------------------------------

/** The emoji `:name` + a typed `:` at `pos` converts to, or null. Exported for tests. */
export function shortcodeBefore(
  state: EditorState,
  pos: number,
  index: EmojiIndex,
): { from: number; emoji: string } | null {
  const line = state.doc.lineAt(pos);
  const text = state.sliceDoc(Math.max(line.from, pos - 80), pos);
  const m = /:([A-Za-z0-9_+-]+)$/.exec(text);
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (!SHORTCODE_CHARS.test(name)) return null;
  const emoji = index.byName.get(name);
  if (!emoji) return null;
  const from = pos - m[0].length;
  if (isExcludedEmojiContext(state, from)) return null;
  return { from, emoji };
}

/**
 * `:name:` typed before the data finished loading (first use): remembered
 * (mapped through later edits) and converted once the data is there.
 */
const addPendingShortcode = StateEffect.define<{ from: number; to: number }>();
const clearPendingShortcodes = StateEffect.define<null>();

const pendingShortcodes = StateField.define<
  ReadonlyArray<{ from: number; to: number }>
>({
  create: () => [],
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.length > 0) {
      next = next.map((r) => ({
        from: mapPosClamped(tr.changes, r.from, 1),
        to: mapPosClamped(tr.changes, r.to, -1),
      }));
    }
    for (const e of tr.effects) {
      if (e.is(addPendingShortcode)) next = [...next, e.value];
      if (e.is(clearPendingShortcodes)) next = [];
    }
    return next;
  },
});

const pendingShortcodePlugin = ViewPlugin.fromClass(
  class {
    private waiting = false;
    constructor(readonly view: EditorView) {}
    update(): void {
      if (this.waiting || this.view.state.field(pendingShortcodes).length === 0)
        return;
      this.waiting = true;
      void loadEmojiIndex()
        .then((index) => this.flush(index))
        .catch(() => null)
        .finally(() => {
          this.waiting = false;
        });
    }
    flush(index: EmojiIndex): void {
      const state = this.view.state;
      const pending = state.field(pendingShortcodes, false);
      if (!pending || pending.length === 0) return;
      const changes: Array<{ from: number; to: number; insert: string }> = [];
      for (const r of pending) {
        if (r.to <= r.from || r.to > state.doc.length) continue;
        const m = /^:([a-z0-9_+-]+):$/i.exec(state.sliceDoc(r.from, r.to));
        const emoji = m ? index.byName.get(m[1].toLowerCase()) : undefined;
        if (!emoji || isExcludedEmojiContext(state, r.from)) continue;
        if (changes.some((c) => c.from < r.to && r.from < c.to)) continue;
        changes.push({ from: r.from, to: r.to, insert: emoji });
      }
      try {
        this.view.dispatch({
          changes: changes.sort((a, b) => a.from - b.from),
          effects: clearPendingShortcodes.of(null),
          userEvent: "input.type",
        });
      } catch {
        // view destroyed meanwhile
      }
    }
  },
);

const shortcodeInputHandler = EditorView.inputHandler.of(
  (view, from, to, text) => {
    if (
      text !== ":" ||
      view.composing ||
      view.compositionStarted ||
      view.state.readOnly
    )
      return false;
    const sel = view.state.selection;
    if (
      sel.ranges.length !== 1 ||
      from !== sel.main.from ||
      to !== sel.main.to ||
      from !== to
    ) {
      return false;
    }
    const index = getLoadedEmojiIndex();
    if (!index) {
      // First use: insert the colon now, convert when the data has loaded.
      const m = /:([A-Za-z0-9_+-]+)$/.exec(
        view.state.sliceDoc(Math.max(0, from - 80), from),
      );
      if (!m || isExcludedEmojiContext(view.state, from - m[0].length))
        return false;
      view.dispatch({
        changes: { from, insert: ":" },
        selection: { anchor: from + 1 },
        effects: addPendingShortcode.of({
          from: from - m[0].length,
          to: from + 1,
        }),
        userEvent: "input.type",
        scrollIntoView: true,
      });
      return true;
    }
    const hit = shortcodeBefore(view.state, from, index);
    if (!hit) return false;
    view.dispatch({
      changes: { from: hit.from, to: from, insert: hit.emoji },
      selection: { anchor: hit.from + hit.emoji.length },
      userEvent: "input.type",
      scrollIntoView: true,
    });
    return true;
  },
);

const emojiLanguageData = EditorState.languageData.of(() => [
  { autocomplete: emojiCompletionSource },
]);

/** Popup themed with the Kalamos palette (--k-* variables). */
const completionTheme = EditorView.theme({
  ".cm-tooltip.cm-tooltip-autocomplete": {
    backgroundColor: "var(--k-surface)",
    color: "var(--k-text)",
    border: "1px solid var(--k-divider)",
    borderRadius: "8px",
    boxShadow: "0 6px 18px rgba(0, 0, 0, 0.14)",
    padding: "4px",
    fontFamily: "var(--k-font-ui, var(--k-font-body))",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    maxHeight: "16em",
    fontFamily: "inherit",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li": {
    padding: "3px 8px",
    borderRadius: "5px",
    lineHeight: "1.5",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul > li[aria-selected]": {
    backgroundColor: "color-mix(in srgb, var(--k-accent) 22%, transparent)",
    color: "var(--k-text)",
  },
  ".cm-completionLabel": {
    fontFamily: "var(--k-font-mono)",
    fontSize: "0.92em",
  },
  ".cm-completionDetail": {
    color: "var(--k-text-muted)",
    fontStyle: "normal",
    marginLeft: "0.8em",
    fontSize: "0.85em",
  },
  ".cm-completionMatchedText": {
    textDecoration: "none",
    color: "var(--k-link)",
  },
  ".k-emoji-option": {
    display: "inline-block",
    width: "1.6em",
    marginRight: "0.35em",
    fontSize: "1.1em",
    textAlign: "center",
  },
});

export const emojiExtension: Extension = [
  emojiLanguageData,
  pendingShortcodes,
  pendingShortcodePlugin,
  Prec.high(shortcodeInputHandler),
  autocompletion({
    icons: false,
    maxRenderedOptions: MAX_EMOJI_OPTIONS,
    addToOptions: [
      {
        position: 20,
        render: (completion) => {
          const emoji = (completion as Partial<EmojiCompletion>).emoji;
          if (!emoji) return null;
          const span = document.createElement("span");
          span.className = "k-emoji-option";
          span.dataset.testid = "emoji-option";
          span.textContent = emoji;
          return span;
        },
      },
    ],
  }),
  completionTheme,
];
