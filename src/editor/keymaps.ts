import { type EditorState, Prec } from "@codemirror/state";
import { type Command, EditorView, type KeyBinding } from "@codemirror/view";
import type { MessageKey } from "../i18n";
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
import { expandSpanBeforeCursor } from "./live-preview";
import {
  insertCodeBlock,
  insertMathBlock,
  setHeadingLevel,
  toggleBlockquote,
} from "./paragraph-commands";
import { openInsertTableDialog } from "./table-insert-dialog";
import { convertPipeRowToTable } from "./table-ops";
import { tableKeymap } from "./table-toolbar";
import {
  handleTableEnter,
  handleTableShiftTab,
  handleTableTab,
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
  /** ED-09: Cmd+Opt+P. */
  onToggleAutoPairBrackets?: () => void | Promise<void>;
  /** ED-09: Cmd+Opt+Shift+P. */
  onToggleAutoPairMarkdown?: () => void | Promise<void>;
}

type SymmetricMarker = "**" | "*" | "`" | "~~";

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
    if (
      before2 === "**" &&
      after2 === "**" &&
      !(before3 === "***" && after3 === "***")
    ) {
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

/** #74 格式 > 刪除線. */
export function toggleStrikethrough(view: EditorView): boolean {
  return toggleSymmetricMarker(view, "~~");
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

const lastKeydownShift = new WeakMap<EditorView, boolean>();

/**
 * Records `event.shiftKey` on every keydown before CodeMirror's `keymap`
 * (`Prec.default`) runs. Needed by `unshifted()` below.
 */
export const trackKeydownExtension = Prec.highest(
  EditorView.domEventHandlers({
    keydown(event, view) {
      lastKeydownShift.set(view, event.shiftKey);
      return false;
    },
  }),
);

/**
 * Guards an unshifted single-letter CodeMirror binding (e.g. `Mod-o`) against
 * firing when Shift is held. CodeMirror's `keymap` drops `Shift-` for
 * single-character keys (`modifiers(name, event, !isChar)`), so when Caps Lock
 * is on — or synthetic events send lowercase `key: "o"` with `shiftKey: true`
 * (e.g. Playwright `Control+Shift+o` on Windows) — `Mod-o` would otherwise
 * hijack `Mod+Shift+O` before `Shift` bindings or window listeners see it.
 */
export function unshifted(cmd: Command): Command {
  return (view) => {
    if (lastKeydownShift.get(view)) return false;
    return cmd(view);
  };
}

export interface KeymapShortcutDef {
  readonly id: string;
  /** CodeMirror key syntax (e.g. "Mod-Alt-p", "Shift-Tab"). */
  readonly key: string;
  readonly labelKey: MessageKey;
  readonly category: "edit" | "search" | "view";
}

/**
 * Single source of truth for editor keymap shortcuts that are not listed in
 * `src/menu/menu-spec.json`. Used by both `createFileKeymap` and the keyboard
 * shortcuts cheatsheet (#147).
 */
export const EDITOR_EXTRA_SHORTCUTS = {
  indentList: {
    id: "editor.indentList",
    key: "Tab",
    labelKey: "shortcuts.item.indentList",
    category: "edit",
  },
  outdentList: {
    id: "editor.outdentList",
    key: "Shift-Tab",
    labelKey: "shortcuts.item.outdentList",
    category: "edit",
  },
  copyHeadingBookmark: {
    id: "editor.copyHeadingBookmark",
    key: "Mod-Shift-c",
    labelKey: "shortcuts.item.copyHeadingBookmark",
    category: "edit",
  },
  toggleAutoPairBrackets: {
    id: "editor.toggleAutoPairBrackets",
    key: "Mod-Alt-p",
    labelKey: "shortcuts.item.autoPairBrackets",
    category: "edit",
  },
  toggleAutoPairMarkdown: {
    id: "editor.toggleAutoPairMarkdown",
    key: "Mod-Alt-Shift-p",
    labelKey: "shortcuts.item.autoPairMarkdown",
    category: "edit",
  },
} as const satisfies Record<string, KeymapShortcutDef>;

export const EDITOR_EXTRA_SHORTCUT_LIST: readonly KeymapShortcutDef[] =
  Object.values(EDITOR_EXTRA_SHORTCUTS);

export function createFileKeymap(handlers: FileCommandHandlers): KeyBinding[] {
  return [
    {
      key: "Enter",
      run: (view) =>
        handleTableEnter(view) ||
        convertPipeRowToTable(view) ||
        handleListEnter(view),
    },
    {
      key: "Backspace",
      run: (view) => expandSpanBeforeCursor(view) || handleListBackspace(view),
    },
    {
      key: EDITOR_EXTRA_SHORTCUTS.indentList.key,
      run: (view) => handleTableTab(view) || indentListItem(view),
    },
    {
      key: EDITOR_EXTRA_SHORTCUTS.outdentList.key,
      run: (view) => handleTableShiftTab(view) || outdentListItem(view),
    },
    {
      key: "Mod-Alt-t",
      preventDefault: true,
      run: (view) => {
        void openInsertTableDialog(view);
        return true;
      },
    },
    // #59 B: table structure shortcuts (only act inside a table).
    ...tableKeymap,
    {
      key: "Mod-o",
      run: unshifted(() => {
        void handlers.onOpenFile();
        return true;
      }),
    },
    {
      key: "Mod-s",
      run: unshifted(() => {
        void handlers.onSaveFile();
        return true;
      }),
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
      run: unshifted(() => {
        void handlers.onNewFile();
        return true;
      }),
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
      run: unshifted((view) => toggleStrong(view)),
    },
    {
      key: "Mod-i",
      run: unshifted((view) => toggleEmphasis(view)),
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
      run: unshifted((view) => toggleLink(view)),
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
      key: EDITOR_EXTRA_SHORTCUTS.copyHeadingBookmark.key,
      preventDefault: true,
      run: (view) => copyHeadingBookmark(view) !== null,
    },
    // #74 段落 / 格式 menu shortcuts (same accelerators as src/menu/menu-spec.json).
    ...[0, 1, 2, 3, 4, 5, 6].map(
      (level): KeyBinding => ({
        key: `Mod-${level}`,
        run: unshifted((view) => setHeadingLevel(view, level)),
      }),
    ),
    { key: "Mod-Alt-c", run: unshifted((view) => insertCodeBlock(view)) },
    { key: "Mod-Alt-b", run: unshifted((view) => insertMathBlock(view)) },
    { key: "Mod-Alt-q", run: unshifted((view) => toggleBlockquote(view)) },
    {
      key: "Mod-Shift-d",
      preventDefault: true,
      run: (view) => toggleStrikethrough(view),
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
      key: EDITOR_EXTRA_SHORTCUTS.toggleAutoPairBrackets.key,
      run: unshifted(() => {
        void handlers.onToggleAutoPairBrackets?.();
        return true;
      }),
    },
    {
      key: EDITOR_EXTRA_SHORTCUTS.toggleAutoPairMarkdown.key,
      preventDefault: true,
      run: () => {
        void handlers.onToggleAutoPairMarkdown?.();
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

function isFormField(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement
  );
}

export function bindWindowShortcuts(
  target: Window | Document | HTMLElement,
  handlers: FileCommandHandlers,
  getView?: () => EditorView | null,
): () => void {
  const listener = (rawEvent: Event) => {
    const event = rawEvent as KeyboardEvent;
    if (event.defaultPrevented) return;
    const noModifiers =
      !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
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
    if (!(event.metaKey || event.ctrlKey) || (event.metaKey && event.ctrlKey))
      return;

    const editingView = isFormField(event.target)
      ? null
      : (getView?.() ?? null);

    if (
      event.altKey &&
      !event.shiftKey &&
      (event.key.toLowerCase() === "t" || event.code === "KeyT")
    ) {
      if (editingView) {
        event.preventDefault();
        void openInsertTableDialog(editingView);
      }
      return;
    }

    const key = event.key.toLowerCase();
    // ED-09 (event.code: Option changes event.key on macOS).
    if (event.altKey && event.code === "KeyP") {
      event.preventDefault();
      if (event.shiftKey) void handlers.onToggleAutoPairMarkdown?.();
      else void handlers.onToggleAutoPairBrackets?.();
      return;
    }
    if (event.altKey && !event.shiftKey) {
      if (key === "l" || event.code === "KeyL") {
        event.preventDefault();
        void handlers.onToggleCodeLineNumbers?.();
      } else if (key === "n" || event.code === "KeyN") {
        event.preventDefault();
        void handlers.onToggleMathAutoNumber?.();
      } else if (editingView && event.code === "KeyC") {
        event.preventDefault();
        insertCodeBlock(editingView);
      } else if (editingView && event.code === "KeyB") {
        event.preventDefault();
        insertMathBlock(editingView);
      } else if (editingView && event.code === "KeyQ") {
        event.preventDefault();
        toggleBlockquote(editingView);
      }
      return;
    }

    if (event.altKey) return;
    if (!event.shiftKey && editingView && /^Digit[0-6]$/.test(event.code)) {
      event.preventDefault();
      setHeadingLevel(editingView, Number(event.code.slice(5)));
    } else if (key === "o" && !event.shiftKey) {
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
      if (editingView) {
        event.preventDefault();
        toggleStrong(editingView);
      }
    } else if (key === "i" && !event.shiftKey) {
      if (editingView) {
        event.preventDefault();
        toggleEmphasis(editingView);
      }
    } else if (
      event.shiftKey &&
      (event.key === "`" || event.key === "~" || event.code === "Backquote")
    ) {
      if (editingView) {
        event.preventDefault();
        toggleInlineCode(editingView);
      }
    } else if (event.shiftKey && (event.code === "KeyD" || key === "d")) {
      if (editingView) {
        event.preventDefault();
        toggleStrikethrough(editingView);
      }
    } else if (key === "k" && !event.shiftKey) {
      if (editingView) {
        event.preventDefault();
        toggleLink(editingView);
      }
    } else if (
      event.shiftKey &&
      (event.key === "[" || event.key === "{" || event.code === "BracketLeft")
    ) {
      if (editingView) {
        event.preventDefault();
        toggleOrderedList(editingView);
      }
    } else if (
      event.shiftKey &&
      (event.key === "]" || event.key === "}" || event.code === "BracketRight")
    ) {
      if (editingView) {
        event.preventDefault();
        toggleBulletList(editingView);
      }
    } else if (key === "x" && event.shiftKey) {
      if (editingView) {
        event.preventDefault();
        toggleTaskList(editingView);
      }
    } else if (key === "c" && event.shiftKey) {
      if (editingView && copyHeadingBookmark(editingView) !== null) {
        event.preventDefault();
      }
    }
  };

  target.addEventListener("keydown", listener);
  return () => {
    target.removeEventListener("keydown", listener);
  };
}
