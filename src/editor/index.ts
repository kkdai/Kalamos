import "./editor-blocks.css";
import "./tables.css";
import "./images.css";

import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import { Annotation, Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import { codeLineNumbersFacet } from "./code-blocks";
import {
  imageDocPathField,
  imagePasteHandler,
  imageRootSettingField,
  type ImageRootTooBroadHandler,
  imageRootTooBroadHandlerFacet,
  type PasteImagesHandler,
  setImageDocPathEffect,
  setImageRootSettingEffect,
} from "./images";
import { createFileKeymap, type FileCommandHandlers } from "./keymaps";
import {
  type RelativeLinkHandler,
  relativeLinkHandlerFacet,
} from "./live-preview";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { mathAutoNumberFacet, mathMarkdownExtension } from "./math";
import { createSourceModeController } from "./source-mode";
import { focusModeExtension, typewriterModeExtension } from "./writing-modes";
import { autoPairBracketsExtension, autoPairMarkdownExtension } from "./auto-pair";
import { emojiExtension } from "./emoji";

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
  initialCodeLineNumbers?: boolean;
  initialMathAutoNumber?: boolean;
  initialFocusMode?: boolean;
  initialTypewriterMode?: boolean;
  /** ED-09 (default true). */
  initialAutoPairBrackets?: boolean;
  /** ED-09 (default false). */
  initialAutoPairMarkdown?: boolean;
  handlers: FileCommandHandlers;
  onUserChange?: (content: string) => void;
  onSourceModeChange?: (sourceMode: boolean) => void;
  onCodeLineNumbersChange?: (enabled: boolean) => void;
  onMathAutoNumberChange?: (enabled: boolean) => void;
  onFocusModeChange?: (enabled: boolean) => void;
  onTypewriterModeChange?: (enabled: boolean) => void;
  onAutoPairBracketsChange?: (enabled: boolean) => void;
  onAutoPairMarkdownChange?: (enabled: boolean) => void;
  onOpenRelativeLink?: RelativeLinkHandler;
  onPasteImages?: PasteImagesHandler;
  /** IM-04: the image root (setting or front matter) was refused as too broad. */
  onImageRootTooBroad?: ImageRootTooBroadHandler;
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
  isCodeLineNumbers: () => boolean;
  setCodeLineNumbers: (enabled: boolean, notify?: boolean) => void;
  toggleCodeLineNumbers: () => boolean;
  isMathAutoNumber: () => boolean;
  setMathAutoNumber: (enabled: boolean, notify?: boolean) => void;
  toggleMathAutoNumber: () => boolean;
  /** WM-01 Ataraxia focus mode. */
  isFocusMode: () => boolean;
  setFocusMode: (enabled: boolean, notify?: boolean) => void;
  toggleFocusMode: () => boolean;
  /** WM-02 Stichos typewriter mode. */
  isTypewriterMode: () => boolean;
  setTypewriterMode: (enabled: boolean, notify?: boolean) => void;
  toggleTypewriterMode: () => boolean;
  /** ED-09 auto-pair brackets / quotes. */
  isAutoPairBrackets: () => boolean;
  setAutoPairBrackets: (enabled: boolean, notify?: boolean) => void;
  toggleAutoPairBrackets: () => boolean;
  /** ED-09 auto-pair Markdown * _ ` ~. */
  isAutoPairMarkdown: () => boolean;
  setAutoPairMarkdown: (enabled: boolean, notify?: boolean) => void;
  toggleAutoPairMarkdown: () => boolean;
  isDirty: () => boolean;
  markClean: (savedContent: string) => void;
  markDirty: () => void;
  /** Path of the current document (null = untitled); used to resolve relative image paths. */
  setDocumentPath: (path: string | null) => void;
  /** IM-04: image root folder setting (null = none). */
  setImageRootDir: (path: string | null) => void;
  getImageRootDir: () => string | null;
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
  const codeLineNumbersCompartment = new Compartment();
  const mathAutoNumberCompartment = new Compartment();
  const focusModeCompartment = new Compartment();
  const typewriterModeCompartment = new Compartment();
  const autoPairBracketsCompartment = new Compartment();
  const autoPairMarkdownCompartment = new Compartment();
  const initialContent = options.initialContent ?? "";
  let unmodifiedContent = initialContent;
  let savedContent: string | null = initialContent;
  let hasUserEditsSinceLoad = false;
  let dirty = false;
  let codeLineNumbers = Boolean(options.initialCodeLineNumbers);
  let mathAutoNumber = Boolean(options.initialMathAutoNumber);
  let focusMode = Boolean(options.initialFocusMode);
  let typewriterMode = Boolean(options.initialTypewriterMode);
  let autoPairBrackets = options.initialAutoPairBrackets ?? true;
  let autoPairMarkdown = Boolean(options.initialAutoPairMarkdown);

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
    onToggleCodeLineNumbers: async () => {
      toggleCodeLineNumbers();
      await options.handlers.onToggleCodeLineNumbers?.();
    },
    onToggleMathAutoNumber: async () => {
      toggleMathAutoNumber();
      await options.handlers.onToggleMathAutoNumber?.();
    },
    onToggleFocusMode: async () => {
      toggleFocusMode();
      await options.handlers.onToggleFocusMode?.();
    },
    onToggleTypewriterMode: async () => {
      toggleTypewriterMode();
      await options.handlers.onToggleTypewriterMode?.();
    },
    onToggleAutoPairBrackets: async () => {
      toggleAutoPairBrackets();
      await options.handlers.onToggleAutoPairBrackets?.();
    },
    onToggleAutoPairMarkdown: async () => {
      toggleAutoPairMarkdown();
      await options.handlers.onToggleAutoPairMarkdown?.();
    },
  };

  const state = EditorState.create({
    doc: initialContent,
    extensions: [
      EditorView.editorAttributes.of({ "data-testid": "editor" }),
      lineSeparatorCompartment.of(
        initialSep === "\r\n" ? EditorState.lineSeparator.of("\r\n") : [],
      ),
      codeLineNumbersCompartment.of(codeLineNumbersFacet.of(codeLineNumbers)),
      mathAutoNumberCompartment.of(mathAutoNumberFacet.of(mathAutoNumber)),
      focusModeCompartment.of(focusMode ? focusModeExtension : []),
      typewriterModeCompartment.of(typewriterMode ? typewriterModeExtension : []),
      autoPairBracketsCompartment.of(autoPairBrackets ? autoPairBracketsExtension : []),
      autoPairMarkdownCompartment.of(autoPairMarkdown ? autoPairMarkdownExtension : []),
      emojiExtension,
      ...(options.onOpenRelativeLink
        ? [relativeLinkHandlerFacet.of(options.onOpenRelativeLink)]
        : []),
      imageDocPathField,
      imageRootSettingField,
      ...(options.onImageRootTooBroad
        ? [imageRootTooBroadHandlerFacet.of(options.onImageRootTooBroad)]
        : []),
      ...(options.onPasteImages ? [imagePasteHandler(options.onPasteImages)] : []),
      history(),
      EditorView.lineWrapping,
      markdown({
        base: markdownLanguage,
        codeLanguages: languages,
        addKeymap: false,
        // Only emoji completion (ED-08); no HTML tag suggestions for `<di…`.
        completeHTMLTags: false,
        extensions: [mathMarkdownExtension, cjkEmphasisExtension, frontMatterExtension, footnoteExtension],
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

  function isCodeLineNumbers(): boolean {
    return codeLineNumbers;
  }

  function setCodeLineNumbers(enabled: boolean, notify = false): void {
    codeLineNumbers = enabled;
    view.dispatch({
      effects: codeLineNumbersCompartment.reconfigure(
        codeLineNumbersFacet.of(codeLineNumbers),
      ),
    });
    if (notify) {
      options.onCodeLineNumbersChange?.(codeLineNumbers);
    }
  }

  function toggleCodeLineNumbers(): boolean {
    setCodeLineNumbers(!codeLineNumbers, true);
    return codeLineNumbers;
  }

  function isMathAutoNumber(): boolean {
    return mathAutoNumber;
  }

  function setMathAutoNumber(enabled: boolean, notify = false): void {
    mathAutoNumber = enabled;
    view.dispatch({
      effects: mathAutoNumberCompartment.reconfigure(
        mathAutoNumberFacet.of(mathAutoNumber),
      ),
    });
    if (notify) {
      options.onMathAutoNumberChange?.(mathAutoNumber);
    }
  }

  function toggleMathAutoNumber(): boolean {
    setMathAutoNumber(!mathAutoNumber, true);
    return mathAutoNumber;
  }

  function isFocusMode(): boolean {
    return focusMode;
  }

  function setFocusMode(enabled: boolean, notify = false): void {
    focusMode = enabled;
    view.dispatch({
      effects: focusModeCompartment.reconfigure(focusMode ? focusModeExtension : []),
    });
    if (notify) {
      options.onFocusModeChange?.(focusMode);
    }
  }

  function toggleFocusMode(): boolean {
    setFocusMode(!focusMode, true);
    return focusMode;
  }

  function isTypewriterMode(): boolean {
    return typewriterMode;
  }

  function setTypewriterMode(enabled: boolean, notify = false): void {
    typewriterMode = enabled;
    view.dispatch({
      effects: [
        typewriterModeCompartment.reconfigure(typewriterMode ? typewriterModeExtension : []),
        ...(typewriterMode
          ? [EditorView.scrollIntoView(view.state.selection.main.head, { y: "center" })]
          : []),
      ],
    });
    if (notify) {
      options.onTypewriterModeChange?.(typewriterMode);
    }
  }

  function toggleTypewriterMode(): boolean {
    setTypewriterMode(!typewriterMode, true);
    return typewriterMode;
  }

  function isAutoPairBrackets(): boolean {
    return autoPairBrackets;
  }

  function setAutoPairBrackets(enabled: boolean, notify = false): void {
    autoPairBrackets = enabled;
    view.dispatch({
      effects: autoPairBracketsCompartment.reconfigure(
        autoPairBrackets ? autoPairBracketsExtension : [],
      ),
    });
    if (notify) options.onAutoPairBracketsChange?.(autoPairBrackets);
  }

  function toggleAutoPairBrackets(): boolean {
    setAutoPairBrackets(!autoPairBrackets, true);
    return autoPairBrackets;
  }

  function isAutoPairMarkdown(): boolean {
    return autoPairMarkdown;
  }

  function setAutoPairMarkdown(enabled: boolean, notify = false): void {
    autoPairMarkdown = enabled;
    view.dispatch({
      effects: autoPairMarkdownCompartment.reconfigure(
        autoPairMarkdown ? autoPairMarkdownExtension : [],
      ),
    });
    if (notify) options.onAutoPairMarkdownChange?.(autoPairMarkdown);
  }

  function toggleAutoPairMarkdown(): boolean {
    setAutoPairMarkdown(!autoPairMarkdown, true);
    return autoPairMarkdown;
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

  function setDocumentPath(path: string | null): void {
    if (view.state.field(imageDocPathField) === path) return;
    view.dispatch({ effects: setImageDocPathEffect.of(path) });
  }

  function setImageRootDir(path: string | null): void {
    if (view.state.field(imageRootSettingField) === path) return;
    view.dispatch({ effects: setImageRootSettingEffect.of(path) });
  }

  function getImageRootDir(): string | null {
    return view.state.field(imageRootSettingField);
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
    isCodeLineNumbers,
    setCodeLineNumbers,
    toggleCodeLineNumbers,
    isMathAutoNumber,
    setMathAutoNumber,
    toggleMathAutoNumber,
    isFocusMode,
    setFocusMode,
    toggleFocusMode,
    isTypewriterMode,
    setTypewriterMode,
    toggleTypewriterMode,
    isAutoPairBrackets,
    setAutoPairBrackets,
    toggleAutoPairBrackets,
    isAutoPairMarkdown,
    setAutoPairMarkdown,
    toggleAutoPairMarkdown,
    isDirty,
    markClean,
    markDirty,
    setDocumentPath,
    setImageRootDir,
    getImageRootDir,
    destroy,
  };
}
