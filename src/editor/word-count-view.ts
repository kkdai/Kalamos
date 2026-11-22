/**
 * NV-03 status-bar word counter: `1,234 字`, or `選取 56 / 1,234 字` while
 * text is selected; clicking it opens a popover with words / chars /
 * chars-no-spaces / lines / reading time (of the selection when there is one).
 *
 * Whole-document counts are debounced; small selections are counted at once;
 * nothing is counted while an IME composition is in progress.
 */
import "./word-count.css";

import { StateEffect } from "@codemirror/state";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import {
  countDocument,
  countSelection,
  selectionSize,
  type TextStats,
} from "./word-count";

export const DOC_COUNT_DEBOUNCE_MS = 250;
/** Selections up to this many characters are counted synchronously. */
export const IMMEDIATE_SELECTION_LIMIT = 20_000;

export interface WordCounterOptions {
  view: EditorView;
  /** Element the counter is appended to (the status bar). */
  parent: HTMLElement;
}

export interface WordCounter {
  element: HTMLElement;
  getDocumentStats: () => TextStats;
  getSelectionStats: () => TextStats | null;
  /** Run pending (debounced) counts now. */
  flush: () => void;
  isPopoverOpen: () => boolean;
  togglePopover: (open?: boolean) => void;
  destroy: () => void;
}

const fmt = (n: number): string => n.toLocaleString("en-US");

export function counterLabel(
  doc: TextStats,
  selection: TextStats | null,
): string {
  return selection
    ? `選取 ${fmt(selection.words)} / ${fmt(doc.words)} 字`
    : `${fmt(doc.words)} 字`;
}

export function statsRows(stats: TextStats): Array<[string, string]> {
  return [
    ["字數", fmt(stats.words)],
    ["字元", fmt(stats.chars)],
    ["字元（不含空白）", fmt(stats.charsNoSpaces)],
    ["行數", fmt(stats.lines)],
    [
      "閱讀時間",
      stats.readingMinutes > 0 ? `約 ${fmt(stats.readingMinutes)} 分鐘` : "—",
    ],
  ];
}

export function createWordCounter(options: WordCounterOptions): WordCounter {
  const { view, parent } = options;
  const wrap = document.createElement("div");
  wrap.className = "k-word-count";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "k-word-count-button";
  button.dataset.testid = "word-count";
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");

  const popover = document.createElement("div");
  popover.className = "k-word-count-popover";
  popover.dataset.testid = "word-count-popover";
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-label", "字數統計");
  popover.hidden = true;

  wrap.append(button, popover);
  parent.appendChild(wrap);

  let docStats = countDocument(view.state);
  let selStats = countSelection(view.state);
  let docTimer: ReturnType<typeof setTimeout> | null = null;
  let selTimer: ReturnType<typeof setTimeout> | null = null;
  let composing = false;
  let pendingAfterComposition = false;
  let destroyed = false;

  function render(): void {
    button.textContent = counterLabel(docStats, selStats);
    button.dataset.selection = selStats ? "true" : "false";
    if (popover.hidden) return;
    const stats = selStats ?? docStats;
    popover.replaceChildren();
    const title = document.createElement("div");
    title.className = "k-word-count-title";
    title.textContent = selStats ? "選取範圍" : "全文";
    const dl = document.createElement("dl");
    for (const [label, value] of statsRows(stats)) {
      const dt = document.createElement("dt");
      dt.textContent = label;
      const dd = document.createElement("dd");
      dd.textContent = value;
      dl.append(dt, dd);
    }
    popover.append(title, dl);
  }

  function countDocNow(): void {
    if (docTimer !== null) clearTimeout(docTimer);
    docTimer = null;
    if (destroyed) return;
    docStats = countDocument(view.state);
    render();
  }

  function countSelectionNow(): void {
    if (selTimer !== null) clearTimeout(selTimer);
    selTimer = null;
    if (destroyed) return;
    selStats = countSelection(view.state);
    render();
  }

  function scheduleDoc(): void {
    if (docTimer !== null) clearTimeout(docTimer);
    docTimer = setTimeout(countDocNow, DOC_COUNT_DEBOUNCE_MS);
  }

  function scheduleSelection(): void {
    if (selectionSize(view.state) <= IMMEDIATE_SELECTION_LIMIT) {
      countSelectionNow();
      return;
    }
    if (selTimer !== null) clearTimeout(selTimer);
    selTimer = setTimeout(countSelectionNow, DOC_COUNT_DEBOUNCE_MS);
  }

  function onUpdate(update: ViewUpdate): void {
    if (destroyed) return;
    if (composing || update.view.composing) {
      if (update.docChanged || update.selectionSet)
        pendingAfterComposition = true;
      return;
    }
    if (update.docChanged) scheduleDoc();
    if (update.docChanged || update.selectionSet) scheduleSelection();
  }

  const onCompositionStart = (): void => {
    composing = true;
  };
  const onCompositionEnd = (): void => {
    composing = false;
    if (pendingAfterComposition) {
      pendingAfterComposition = false;
      scheduleDoc();
      scheduleSelection();
    }
  };
  view.contentDOM.addEventListener("compositionstart", onCompositionStart);
  view.contentDOM.addEventListener("compositionend", onCompositionEnd);

  view.dispatch({
    effects: StateEffect.appendConfig.of(
      EditorView.updateListener.of(onUpdate),
    ),
  });

  function togglePopover(open?: boolean): void {
    const next = open ?? popover.hidden;
    popover.hidden = !next;
    button.setAttribute("aria-expanded", next ? "true" : "false");
    if (next) {
      countDocNow();
      countSelectionNow();
    }
    render();
  }

  const onButtonClick = (event: MouseEvent): void => {
    event.preventDefault();
    togglePopover();
  };
  // Keep the editor selection when clicking the counter.
  const onButtonMouseDown = (event: MouseEvent): void => event.preventDefault();
  const onDocumentMouseDown = (event: MouseEvent): void => {
    if (popover.hidden) return;
    if (event.target instanceof Node && wrap.contains(event.target)) return;
    togglePopover(false);
  };
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && !popover.hidden) togglePopover(false);
  };
  button.addEventListener("click", onButtonClick);
  button.addEventListener("mousedown", onButtonMouseDown);
  document.addEventListener("mousedown", onDocumentMouseDown);
  document.addEventListener("keydown", onKeyDown);

  render();

  return {
    element: wrap,
    getDocumentStats: () => docStats,
    getSelectionStats: () => selStats,
    flush: () => {
      countDocNow();
      countSelectionNow();
    },
    isPopoverOpen: () => !popover.hidden,
    togglePopover,
    destroy: () => {
      destroyed = true;
      if (docTimer !== null) clearTimeout(docTimer);
      if (selTimer !== null) clearTimeout(selTimer);
      view.contentDOM.removeEventListener(
        "compositionstart",
        onCompositionStart,
      );
      view.contentDOM.removeEventListener("compositionend", onCompositionEnd);
      button.removeEventListener("click", onButtonClick);
      button.removeEventListener("mousedown", onButtonMouseDown);
      document.removeEventListener("mousedown", onDocumentMouseDown);
      document.removeEventListener("keydown", onKeyDown);
      wrap.remove();
    },
  };
}
