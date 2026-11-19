import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { createFileKeymap, type FileCommandHandlers } from "./keymaps";
import { createSourceModeController } from "./source-mode";

const ExternalLoadAnnotation = Annotation.define<boolean>();

export interface KalamosTestApi {
  getDoc: () => string;
  setCursor: (pos: number) => void;
  isSourceMode: () => boolean;
}

declare global {
  interface Window {
    __kalamos?: KalamosTestApi;
  }
}

export interface CreateEditorOptions {
  parent: HTMLElement;
  initialContent?: string;
  initialSourceMode?: boolean;
  handlers: FileCommandHandlers;
  onUserChange?: (content: string) => void;
  onSourceModeChange?: (sourceMode: boolean) => void;
}

export interface SetContentOptions {
  dirty?: boolean;
}

export interface KalamosEditor {
  view: EditorView;
  getContent: () => string;
  setContent: (content: string, options?: SetContentOptions) => void;
  setCursor: (pos: number) => void;
  isSourceMode: () => boolean;
  setSourceMode: (enabled: boolean, notify?: boolean) => void;
  toggleSourceMode: () => boolean;
  isDirty: () => boolean;
  markClean: (savedContent: string) => void;
  markDirty: () => void;
  destroy: () => void;
}

export function detectLineSeparator(content: string): "\r\n" | "\n" {
  const hasCrlf = content.includes("\r\n");
  if (!hasCrlf) return "\n";
  const withoutCrlf = content.replace(/\r\n/g, "");
  return withoutCrlf.includes("\n") ? "\n" : "\r\n";
}

export function createEditor(options: CreateEditorOptions): KalamosEditor {
  const lineSeparatorCompartment = new Compartment();
  const initialContent = options.initialContent ?? "";
  let unmodifiedContent = initialContent;
  let savedContent: string | null = initialContent;
  let hasUserEditsSinceLoad = false;
  let dirty = false;

  const initialSep = detectLineSeparator(initialContent);

  const sourceModeController = createSourceModeController({
    initialSourceMode: options.initialSourceMode,
    onSourceModeChange: options.onSourceModeChange,
  });

  const combinedHandlers: FileCommandHandlers = {
    ...options.handlers,
    onToggleSourceMode: async () => {
      toggleSourceMode();
      await options.handlers.onToggleSourceMode?.();
    },
  };

  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      EditorView.editorAttributes.of({ "data-testid": "editor" }),
      lineSeparatorCompartment.of(
        initialSep === "\r\n" ? EditorState.lineSeparator.of("\r\n") : [],
      ),
      history(),
      EditorView.lineWrapping,
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
      }),
      sourceModeController.extension,
      keymap.of([
        ...createFileKeymap(combinedHandlers),
        ...defaultKeymap,
        ...historyKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        const isExternal = update.transactions.some((tr) =>
          Boolean(tr.annotation(ExternalLoadAnnotation)),
        );
        if (isExternal) return;
        hasUserEditsSinceLoad = true;
        const current = update.state.sliceDoc(0, update.state.doc.length);
        dirty = current !== savedContent;
        options.onUserChange?.(current);
      }),
    ],
  });

  const view = new EditorView({
    state,
    parent: options.parent,
  });

  function getContent(): string {
    if (!hasUserEditsSinceLoad) {
      return unmodifiedContent;
    }
    return view.state.sliceDoc(0, view.state.doc.length);
  }

  function setContent(content: string, setOptions?: SetContentOptions): void {
    const shouldBeDirty = Boolean(setOptions?.dirty);
    unmodifiedContent = content;
    savedContent = shouldBeDirty ? null : content;
    hasUserEditsSinceLoad = false;
    dirty = shouldBeDirty;
    const sep = detectLineSeparator(content);
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
      effects: lineSeparatorCompartment.reconfigure(
        sep === "\r\n" ? EditorState.lineSeparator.of("\r\n") : [],
      ),
      annotations: ExternalLoadAnnotation.of(true),
    });
  }

  function setCursor(pos: number): void {
    const clamped = Math.max(0, Math.min(pos, view.state.doc.length));
    view.dispatch({
      selection: { anchor: clamped, head: clamped },
    });
  }

  function isSourceMode(): boolean {
    return sourceModeController.isSourceMode();
  }

  function setSourceMode(enabled: boolean, notify = false): void {
    sourceModeController.setSourceMode(view, enabled, notify);
  }

  function toggleSourceMode(): boolean {
    return sourceModeController.toggleSourceMode(view);
  }

  function isDirty(): boolean {
    return dirty;
  }

  function markClean(justSavedContent: string): void {
    savedContent = justSavedContent;
    const current = getContent();
    dirty = current !== savedContent;
    if (!dirty) {
      unmodifiedContent = justSavedContent;
      hasUserEditsSinceLoad = false;
    }
  }

  function markDirty(): void {
    dirty = true;
  }

  function destroy(): void {
    view.destroy();
  }

  if (typeof window !== "undefined") {
    window.__kalamos = {
      getDoc: () => getContent(),
      setCursor: (pos: number) => setCursor(pos),
      isSourceMode: () => isSourceMode(),
    };
  }

  return {
    view,
    getContent,
    setContent,
    setCursor,
    isSourceMode,
    setSourceMode,
    toggleSourceMode,
    isDirty,
    markClean,
    markDirty,
    destroy,
  };
}
