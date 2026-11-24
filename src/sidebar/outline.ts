import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { type EditorState, StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { t } from "../i18n";

export const OUTLINE_DEBOUNCE_MS = 150;

export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface OutlineHeading {
  level: HeadingLevel;
  text: string;
  from: number;
  to: number;
}

const HEADING_LEVEL_BY_NODE_NAME: Record<string, HeadingLevel> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
};

/**
 * Extracts ATX (#..######) and Setext (=== / ---) headings from the CodeMirror
 * Lezer Markdown syntax tree without regex scanning the document string.
 * `#` inside fenced/indented code blocks are not heading nodes in the tree and are ignored.
 */
export function extractOutlineHeadings(state: EditorState): OutlineHeading[] {
  const tree =
    ensureSyntaxTree(state, state.doc.length, 100) ?? syntaxTree(state);
  const headings: OutlineHeading[] = [];

  tree.iterate({
    enter: (nodeRef) => {
      const { name, from, to } = nodeRef;
      if (
        name === "FencedCode" ||
        name === "CodeBlock" ||
        name === "HTMLBlock" ||
        name === "CommentBlock" ||
        name === "FrontMatter"
      ) {
        return false;
      }

      const level = HEADING_LEVEL_BY_NODE_NAME[name];
      if (level === undefined) {
        return;
      }

      const syntaxNode = nodeRef.node;
      const marks = syntaxNode.getChildren("HeaderMark");
      let text = "";

      if (name.startsWith("ATXHeading")) {
        const textFrom = marks.length > 0 ? marks[0].to : from;
        const textTo = marks.length > 1 ? marks[marks.length - 1].from : to;
        text = state.sliceDoc(textFrom, Math.max(textFrom, textTo)).trim();
      } else {
        // SetextHeading1 / SetextHeading2: text precedes the underline HeaderMark
        const textTo = marks.length > 0 ? marks[0].from : to;
        text = state
          .sliceDoc(from, Math.max(from, textTo))
          .replace(/\r?\n/g, " ")
          .trim();
      }

      headings.push({
        level,
        text,
        from,
        to,
      });

      return false;
    },
  });

  return headings;
}

export function findActiveHeadingIndex(
  headings: readonly OutlineHeading[],
  cursorPos: number,
): number {
  let activeIdx = -1;
  for (let i = 0; i < headings.length; i++) {
    if (headings[i].from <= cursorPos) {
      activeIdx = i;
    } else {
      break;
    }
  }
  return activeIdx;
}

export interface CreateOutlineOptions {
  container: HTMLElement;
  view?: EditorView | null;
}

export interface OutlineView {
  attachView: (view: EditorView) => void;
  render: () => void;
  refreshNow: () => OutlineHeading[];
  updateActiveHighlight: () => void;
  getHeadings: () => OutlineHeading[];
  getActiveIndex: () => number;
  setActiveMount: (mounted: boolean) => void;
  destroy: () => void;
}

export function createOutline(options: CreateOutlineOptions): OutlineView {
  const { container } = options;
  let editorView: EditorView | null = options.view ?? null;
  let headings: OutlineHeading[] = [];
  let activeIndex = -1;
  let itemElements: HTMLElement[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let isMounted = false;
  let isDestroyed = false;

  function clearDebounce(): void {
    if (debounceTimer !== null) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
  }

  function jumpToHeading(pos: number): void {
    if (!editorView) return;
    const clamped = Math.max(0, Math.min(pos, editorView.state.doc.length));
    editorView.dispatch({
      selection: { anchor: clamped, head: clamped },
      effects: EditorView.scrollIntoView(clamped, { y: "start", yMargin: 24 }),
    });
    editorView.focus();
    updateActiveHighlight();
  }

  function render(): void {
    if (!isMounted) return;
    container.innerHTML = "";
    itemElements = [];

    if (headings.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "k-sidebar-empty";
      emptyEl.textContent = t("sidebar.outline.empty");
      container.appendChild(emptyEl);
      return;
    }

    const listEl = document.createElement("div");
    listEl.className = "k-outline-list";
    listEl.setAttribute("role", "list");

    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      const itemEl = document.createElement("div");
      itemEl.className = "k-outline-item";
      itemEl.dataset.testid = "outline-item";
      itemEl.dataset.pos = String(h.from);
      itemEl.dataset.level = String(h.level);
      itemEl.dataset.active = i === activeIndex ? "true" : "false";
      itemEl.setAttribute("role", "listitem");
      itemEl.style.paddingLeft = `${12 + (h.level - 1) * 14}px`;

      const labelEl = document.createElement("span");
      labelEl.className = "k-outline-label";
      labelEl.textContent = h.text;
      itemEl.appendChild(labelEl);

      itemEl.addEventListener("click", (e) => {
        e.stopPropagation();
        jumpToHeading(h.from);
      });

      listEl.appendChild(itemEl);
      itemElements.push(itemEl);
    }

    container.appendChild(listEl);
  }

  function updateActiveHighlight(): void {
    if (!editorView) return;
    const cursorPos = editorView.state.selection.main.head;
    const nextIdx = findActiveHeadingIndex(headings, cursorPos);
    if (nextIdx === activeIndex && itemElements.length === headings.length) {
      return;
    }
    activeIndex = nextIdx;
    if (!isMounted) return;
    for (let i = 0; i < itemElements.length; i++) {
      itemElements[i].dataset.active = i === activeIndex ? "true" : "false";
    }
  }

  function refreshNow(): OutlineHeading[] {
    clearDebounce();
    if (!editorView) {
      headings = [];
      activeIndex = -1;
      render();
      return headings;
    }
    headings = extractOutlineHeadings(editorView.state);
    activeIndex = findActiveHeadingIndex(
      headings,
      editorView.state.selection.main.head,
    );
    render();
    return headings;
  }

  function scheduleDebouncedRefresh(): void {
    clearDebounce();
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      if (!isDestroyed) {
        refreshNow();
      }
    }, OUTLINE_DEBOUNCE_MS);
  }

  function attachView(view: EditorView): void {
    editorView = view;
    refreshNow();

    const listener = EditorView.updateListener.of((update) => {
      if (isDestroyed || editorView !== update.view) return;
      if (update.docChanged) {
        scheduleDebouncedRefresh();
      } else if (update.selectionSet) {
        updateActiveHighlight();
      }
    });

    view.dispatch({
      effects: StateEffect.appendConfig.of(listener),
    });
  }

  function setActiveMount(mounted: boolean): void {
    isMounted = mounted;
    if (mounted) {
      refreshNow();
    } else {
      itemElements = [];
    }
  }

  function destroy(): void {
    isDestroyed = true;
    clearDebounce();
    itemElements = [];
  }

  if (editorView) {
    attachView(editorView);
  }

  return {
    attachView,
    render,
    refreshNow,
    updateActiveHighlight,
    getHeadings: () => [...headings],
    getActiveIndex: () => activeIndex,
    setActiveMount,
    destroy,
  };
}
