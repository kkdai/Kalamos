import type { EditorState } from "@codemirror/state";
import type { EditorView, KeyBinding } from "@codemirror/view";
import {
  copyHeadingBookmark,
  handleListBackspace,
  handleListEnter,
  indentListItem,
  outdentListItem,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
} from "./lists";
import {
  handleTableEnter,
  handleTableShiftTab,
  handleTableTab,
  insertDefaultTable,
} from "./tables";

export interface FileCommandHandlers {
  onOpenFile: () => void | Promise<void>;
  onSaveFile: () => void | Promise<void>;
  onSaveFileAs: () => void | Promise<void>;
  onNewFile: () => void | Promise<void>;
  onToggleSourceMode?: () => void | Promise<void>;
  onToggleCodeLineNumbers?: () => void | Promise<void>;
  onToggleMathAutoNumber?: () => void | Promise<void>;
  onToggleFocusMode?: () => void | Promise<void>;
  onToggleTypewriterMode?: () => void | Promise<void>;
}

type SymmetricMarker = "**" | "*" | "`";

function isWrappedInsideSelection(
  text: string,
  marker: SymmetricMarker,
): boolean {
  const len = marker.length;
  if (text.length < len * 2) return false;
  if (!text.startsWith(marker) || !text.endsWith(marker)) return false;
  if (marker === "*") {
    const startsDouble = text.startsWith("**") && !text.startsWith("***");
    const endsDouble = text.endsWith("**") && !text.endsWith("***");
    if (startsDouble || endsDouble) return false;
  }
  return true;
}

function isWrappedOutsideSelection(
  state: EditorState,
  from: number,
  to: number,
  marker: SymmetricMarker,
): boolean {
  const len = marker.length;
  if (from < len || to + len > state.doc.length) return false;
  const before = state.sliceDoc(from - len, from);
  const after = state.sliceDoc(to, to + len);
  if (before !== marker || after !== marker) return false;

  if (marker === "*") {
    const before2 = from >= 2 ? state.sliceDoc(from - 2, from) : "";
    const after2 = to + 2 <= state.doc.length ? state.sliceDoc(to, to + 2) : "";
    const before3 = from >= 3 ? state.sliceDoc(from - 3, from) : "";
    const after3 = to + 3 <= state.doc.length ? state.sliceDoc(to, to + 3) : "";
    if (before2 === "**" && after2 === "**" && !(before3 === "***" && after3 === "***")) {
      return false;
    }
  }
  return true;
}

export function toggleSymmetricMarker(
  view: EditorView,
  marker: SymmetricMarker,
): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;
  const len = marker.length;

  if (from === to) {
    if (isWrappedOutsideSelection(state, from, to, marker)) {
      view.dispatch({
        changes: { from: from - len, to: to + len, insert: "" },
        selection: { anchor: from - len, head: from - len },
      });
      return true;
    }
    view.dispatch({
      changes: { from, to, insert: `${marker}${marker}` },
      selection: { anchor: from + len, head: from + len },
    });
    return true;
  }

  const selected = state.sliceDoc(from, to);

  if (isWrappedInsideSelection(selected, marker)) {
    const unwrapped = selected.slice(len, selected.length - len);
    view.dispatch({
      changes: { from, to, insert: unwrapped },
      selection: { anchor: from, head: from + unwrapped.length },
    });
    return true;
  }

  if (isWrappedOutsideSelection(state, from, to, marker)) {
    view.dispatch({
      changes: { from: from - len, to: to + len, insert: selected },
      selection: { anchor: from - len, head: to - len },
    });
    return true;
  }

  view.dispatch({
    changes: { from, to, insert: `${marker}${selected}${marker}` },
    selection: { anchor: from + len, head: to + len },
  });
  return true;
}

export function toggleStrong(view: EditorView): boolean {
  return toggleSymmetricMarker(view, "**");
}

export function toggleEmphasis(view: EditorView): boolean {
  return toggleSymmetricMarker(view, "*");
}

export function toggleInlineCode(view: EditorView): boolean {
  return toggleSymmetricMarker(view, "`");
}

export function toggleLink(view: EditorView): boolean {
  const { state } = view;
  const { from, to } = state.selection.main;

  if (from === to) {
    if (
      from >= 1 &&
      to + 3 <= state.doc.length &&
      state.sliceDoc(from - 1, from) === "[" &&
      state.sliceDoc(to, to + 3) === "]()"
    ) {
      view.dispatch({
        changes: { from: from - 1, to: to + 3, insert: "" },
        selection: { anchor: from - 1, head: from - 1 },
      });
      return true;
    }
    view.dispatch({
      changes: { from, to, insert: "[]()" },
      selection: { anchor: from + 1, head: from + 1 },
    });
    return true;
  }

  const selected = state.sliceDoc(from, to);
  const fullLinkMatch = /^\[([\s\S]*)\]\(([^)]*)\)$/.exec(selected);
  if (fullLinkMatch) {
    const innerText = fullLinkMatch[1];
    view.dispatch({
      changes: { from, to, insert: innerText },
      selection: { anchor: from, head: from + innerText.length },
    });
    return true;
  }

  const beforeChar = from >= 1 ? state.sliceDoc(from - 1, from) : "";
  const afterSlice = state.sliceDoc(to, Math.min(state.doc.length, to + 500));
  const afterMatch = /^\]\([^)]*\)/.exec(afterSlice);
  if (beforeChar === "[" && afterMatch) {
    view.dispatch({
      changes: {
        from: from - 1,
        to: to + afterMatch[0].length,
        insert: selected,
      },
      selection: { anchor: from - 1, head: to - 1 },
    });
    return true;
  }

  view.dispatch({
    changes: { from, to, insert: `[${selected}]()` },
    selection: { anchor: from + 1, head: to + 1 },
  });
  return true;
}

export function createFileKeymap(handlers: FileCommandHandlers): KeyBinding[] {
  return [
    {
      key: "Enter",
      run: (view) => handleTableEnter(view) || handleListEnter(view),
    },
    {
      key: "Backspace",
      run: (view) => handleListBackspace(view),
    },
    {
      key: "Tab",
      run: (view) => handleTableTab(view) || indentListItem(view),
    },
    {
      key: "Shift-Tab",
      run: (view) => handleTableShiftTab(view) || outdentListItem(view),
    },
    {
      key: "Mod-Alt-t",
      preventDefault: true,
      run: (view) => insertDefaultTable(view),
    },
    {
      key: "Mod-o",
      preventDefault: true,
      run: () => {
        void handlers.onOpenFile();
        return true;
      },
    },
    {
      key: "Mod-s",
      preventDefault: true,
      run: () => {
        void handlers.onSaveFile();
        return true;
      },
    },
    {
      key: "Mod-Shift-s",
      preventDefault: true,
      run: () => {
        void handlers.onSaveFileAs();
        return true;
      },
    },
    {
      key: "Mod-n",
      preventDefault: true,
      run: () => {
        void handlers.onNewFile();
        return true;
      },
    },
    {
      key: "Mod-/",
      preventDefault: true,
      run: () => {
        void handlers.onToggleSourceMode?.();
        return true;
      },
    },
    {
      key: "Mod-b",
      preventDefault: true,
      run: (view) => toggleStrong(view),
    },
    {
      key: "Mod-i",
      preventDefault: true,
      run: (view) => toggleEmphasis(view),
    },
    {
      key: "Mod-Shift-`",
      preventDefault: true,
      run: (view) => toggleInlineCode(view),
    },
    {
      key: "Mod-~",
      preventDefault: true,
      run: (view) => toggleInlineCode(view),
    },
    {
      key: "Mod-k",
      preventDefault: true,
      run: (view) => toggleLink(view),
    },
    {
      key: "Mod-Shift-[",
      preventDefault: true,
      run: (view) => toggleOrderedList(view),
    },
    {
      key: "Mod-{",
      preventDefault: true,
      run: (view) => toggleOrderedList(view),
    },
    {
      key: "Mod-Shift-]",
      preventDefault: true,
      run: (view) => toggleBulletList(view),
    },
    {
      key: "Mod-}",
      preventDefault: true,
      run: (view) => toggleBulletList(view),
    },
    {
      key: "Mod-Shift-x",
      preventDefault: true,
      run: (view) => toggleTaskList(view),
    },
    {
      key: "Mod-Shift-c",
      preventDefault: true,
      run: (view) => copyHeadingBookmark(view) !== null,
    },
    {
      key: "Mod-Alt-l",
      preventDefault: true,
      run: () => {
        void handlers.onToggleCodeLineNumbers?.();
        return true;
      },
    },
    {
      key: "Mod-Alt-n",
      preventDefault: true,
      run: () => {
        void handlers.onToggleMathAutoNumber?.();
        return true;
      },
    },
    {
      key: "F8",
      preventDefault: true,
      run: () => {
        void handlers.onToggleFocusMode?.();
        return true;
      },
    },
    {
      key: "F9",
      preventDefault: true,
      run: () => {
        void handlers.onToggleTypewriterMode?.();
        return true;
      },
    },
  ];
}

export function bindWindowShortcuts(
  target: Window | Document | HTMLElement,
  handlers: FileCommandHandlers,
  getView?: () => EditorView | null,
): () => void {
  const listener = (rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.defaultPrevented) return;
    const noModifiers = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
    if (noModifiers && event.key === "F8") {
      event.preventDefault();
      void handlers.onToggleFocusMode?.();
      return;
    }
    if (noModifiers && event.key === "F9") {
      event.preventDefault();
      void handlers.onToggleTypewriterMode?.();
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) return;

    if (
      event.altKey &&
      !event.shiftKey &&
      (event.key.toLowerCase() === "t" || event.code === "KeyT")
    ) {
      const view = getView?.();
      if (view) {
        event.preventDefault();
        insertDefaultTable(view);
      }
      return;
    }

    const key = event.key.toLowerCase();
    if (event.altKey && !event.shiftKey) {
      if (key === "l" || event.code === "KeyL") {
        event.preventDefault();
        void handlers.onToggleCodeLineNumbers?.();
      } else if (key === "n" || event.code === "KeyN") {
        event.preventDefault();
        void handlers.onToggleMathAutoNumber?.();
      }
      return;
    }

    if (event.altKey) return;
    if (key === "o" && !event.shiftKey) {
      event.preventDefault();
      void handlers.onOpenFile();
    } else if (key === "s" && !event.shiftKey) {
      event.preventDefault();
      void handlers.onSaveFile();
    } else if (key === "s" && event.shiftKey) {
      event.preventDefault();
      void handlers.onSaveFileAs();
    } else if (key === "n" && !event.shiftKey) {
      event.preventDefault();
      void handlers.onNewFile();
    } else if (key === "/" && !event.shiftKey) {
      event.preventDefault();
      void handlers.onToggleSourceMode?.();
    } else if (key === "b" && !event.shiftKey) {
      const view = getView?.();
      if (view) {
        event.preventDefault();
        toggleStrong(view);
      }
    } else if (key === "i" && !event.shiftKey) {
      const view = getView?.();
      if (view) {
        event.preventDefault();
        toggleEmphasis(view);
      }
    } else if (
      event.shiftKey &&
      (event.key === "`" || event.key === "~" || event.code === "Backquote")
    ) {
      const view = getView?.();
      if (view) {
        event.preventDefault();
        toggleInlineCode(view);
      }
    } else if (key === "k" && !event.shiftKey) {
      const view = getView?.();
      if (view) {
        event.preventDefault();
        toggleLink(view);
      }
    } else if (
      event.shiftKey &&
      (event.key === "[" || event.key === "{" || event.code === "BracketLeft")
    ) {
      const view = getView?.();
      if (view) {
        event.preventDefault();
        toggleOrderedList(view);
      }
    } else if (
      event.shiftKey &&
      (event.key === "]" || event.key === "}" || event.code === "BracketRight")
    ) {
      const view = getView?.();
      if (view) {
        event.preventDefault();
        toggleBulletList(view);
      }
    } else if (key === "x" && event.shiftKey) {
      const view = getView?.();
      if (view) {
        event.preventDefault();
        toggleTaskList(view);
      }
    } else if (key === "c" && event.shiftKey) {
      const view = getView?.();
      if (view && copyHeadingBookmark(view) !== null) {
        event.preventDefault();
      }
    }
  };

  target.addEventListener("keydown", listener);
  return () => {
    target.removeEventListener("keydown", listener);
  };
}
