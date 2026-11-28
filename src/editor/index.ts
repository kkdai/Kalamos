import "./editor-blocks.css";
import "./tables.css";
import "./images.css";

import {
  defaultKeymap,
  history,
  historyKeymap,
  isolateHistory,
} from "@codemirror/commands";
import { languages } from "@codemirror/language-data";
import {
  Annotation,
  Compartment,
  EditorState,
  type Extension,
  StateEffect,
  type Text,
  Transaction,
} from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";
import { t } from "../i18n";
import {
  autoPairBracketsExtension,
  autoPairMarkdownExtension,
} from "./auto-pair";
import { cjkEmphasisExtension } from "./cjk-emphasis";
import { codeLineNumbersFacet } from "./code-blocks";
import { emojiExtension } from "./emoji";
import { footnoteExtension } from "./footnotes";
import { frontMatterExtension } from "./front-matter";
import { finishFrontMatterEdit } from "./front-matter-preview";
import {
  type ImageRootTooBroadHandler,
  imageDocPathField,
  imagePasteHandler,
  imageRootSettingField,
  imageRootTooBroadHandlerFacet,
  type PasteImagesHandler,
  setImageDocPathEffect,
  setImageRootSettingEffect,
} from "./images";
import {
  createFileKeymap,
  type FileCommandHandlers,
  trackKeydownExtension,
} from "./keymaps";
import {
  type RelativeLinkHandler,
  relativeLinkHandlerFacet,
} from "./live-preview";
import { createMarkdownSupport } from "./markdown-lang";
import { mathAutoNumberFacet, mathMarkdownExtension } from "./math";
import { kalamosSearchExtension, kalamosSearchKeymap } from "./search";
import { createSourceModeController } from "./source-mode";
import { focusModeExtension, typewriterModeExtension } from "./writing-modes";

const ExternalLoadAnnotation = Annotation.define<boolean>();
const SkipAutosaveAnnotation = Annotation.define<boolean>();

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
  onUserChange?: (content: string, info?: { skipAutosave?: boolean }) => void;
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

/**
 * #81: one document's editor state. The single EditorView shows one session at
 * a time (`switchSession` swaps it in with view.setState), so each tab keeps
 * its own undo history, selection and search state.
 */
export interface DocSession {
  /** The latest state (read it through the editor: the active session's lives in the view). */
  state: EditorState;
  /** Content as loaded (kept byte-for-byte until the first edit, e.g. CRLF). */
  unmodifiedContent: string;
  /** Content last written to disk; null = never matches (restored / imported). */
  savedContent: string | null;
  hasUserEditsSinceLoad: boolean;
  dirty: boolean;
}

export interface KalamosEditor {
  view: EditorView;
  getContent: () => string;
  setContent: (content: string, options?: SetContentOptions) => void;
  /** #148: replace document content as a single undoable edit (without clearing undo history). */
  replaceContentUndoable: (
    content: string,
    options?: { skipAutosave?: boolean },
  ) => void;
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
  /** #81: a new document session with the current global settings (not shown yet). */
  createSession: (content: string, options?: SetContentOptions) => DocSession;
  /** #81: the session the view is showing. */
  getSession: () => DocSession;
  /** #81: show another session; global settings (source mode, focus mode…) carry over. */
  switchSession: (session: DocSession) => void;
  getSessionContent: (session: DocSession) => string;
  getSessionState: (session: DocSession) => EditorState;
  isSessionDirty: (session: DocSession) => boolean;
  markSessionClean: (session: DocSession, savedContent: string) => void;
  markSessionDirty: (session: DocSession) => void;
  /** #145: reload a session from disk while preserving line/column cursor & scrollTop. */
  reloadSession: (session: DocSession, content: string) => void;
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
  let codeLineNumbers = Boolean(options.initialCodeLineNumbers);
  let mathAutoNumber = Boolean(options.initialMathAutoNumber);
  let focusMode = Boolean(options.initialFocusMode);
  let typewriterMode = Boolean(options.initialTypewriterMode);
  let autoPairBrackets = options.initialAutoPairBrackets ?? true;
  let autoPairMarkdown = Boolean(options.initialAutoPairMarkdown);

  let imageRootDir: string | null = null;

  // Compartment contents are shared constants so a tab state can be compared
  // with the current settings by identity (see globalSyncEffects).
  const NONE: Extension = [];
  const CRLF: Extension = EditorState.lineSeparator.of("\r\n");
  const codeLineNumbersExt = [
    codeLineNumbersFacet.of(false),
    codeLineNumbersFacet.of(true),
  ];
  const mathAutoNumberExt = [
    mathAutoNumberFacet.of(false),
    mathAutoNumberFacet.of(true),
  ];
  const flag = (on: boolean) => (on ? 1 : 0);
  const globalCompartments = (): Array<[Compartment, Extension]> => [
    [codeLineNumbersCompartment, codeLineNumbersExt[flag(codeLineNumbers)]],
    [mathAutoNumberCompartment, mathAutoNumberExt[flag(mathAutoNumber)]],
    [focusModeCompartment, focusMode ? focusModeExtension : NONE],
    [
      typewriterModeCompartment,
      typewriterMode ? typewriterModeExtension : NONE,
    ],
    [
      autoPairBracketsCompartment,
      autoPairBrackets ? autoPairBracketsExtension : NONE,
    ],
    [
      autoPairMarkdownCompartment,
      autoPairMarkdown ? autoPairMarkdownExtension : NONE,
    ],
  ];
  const lineSeparatorFor = (content: string): Extension =>
    detectLineSeparator(content) === "\r\n" ? CRLF : NONE;

  /** Extensions other modules appended to the view's state (word counter, outline…); every new tab state gets them too. */
  const appendedExtensions: Extension[] = [];

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

  const buildExtensions = (content: string): Extension => [
    EditorView.editorAttributes.of({ "data-testid": "editor" }),
    // Keep document content independent of the UI <html lang> so CJK text
    // (especially inside monospace code blocks) does not fall back to Simplified
    // Chinese or Japanese glyphs when the interface is set to English.
    EditorView.contentAttributes.of({ lang: "zh-Hant" }),
    EditorState.phrases.of({
      Completions: t("editor.codeMirror.completions"),
      "Selection deleted": t("editor.codeMirror.selectionDeleted"),
      "Control character": t("editor.codeMirror.controlCharacter"),
      "replaced match on line $": t("editor.codeMirror.replacedMatchOnLine"),
      "replaced $ matches": t("editor.codeMirror.replacedMatches"),
      "current match": t("editor.codeMirror.currentMatch"),
      "on line": t("editor.codeMirror.onLine"),
    }),
    lineSeparatorCompartment.of(lineSeparatorFor(content)),
    ...globalCompartments().map(([compartment, ext]) => compartment.of(ext)),
    EditorState.transactionExtender.of((tr) => {
      for (const effect of tr.effects) {
        if (
          effect.is(StateEffect.appendConfig) &&
          !appendedExtensions.includes(effect.value)
        ) {
          appendedExtensions.push(effect.value);
        }
      }
      return null;
    }),
    emojiExtension,
    ...(options.onOpenRelativeLink
      ? [relativeLinkHandlerFacet.of(options.onOpenRelativeLink)]
      : []),
    imageDocPathField,
    imageRootSettingField,
    ...(options.onImageRootTooBroad
      ? [imageRootTooBroadHandlerFacet.of(options.onImageRootTooBroad)]
      : []),
    ...(options.onPasteImages
      ? [imagePasteHandler(options.onPasteImages)]
      : []),
    history(),
    EditorView.lineWrapping,
    createMarkdownSupport({
      codeLanguages: languages,
      extensions: [
        mathMarkdownExtension,
        cjkEmphasisExtension,
        frontMatterExtension,
        footnoteExtension,
      ],
    }),
    sourceModeController.stateExtension(),
    kalamosSearchExtension,
    trackKeydownExtension,
    keymap.of([
      ...kalamosSearchKeymap,
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
      const skipAutosave = update.transactions.every((tr) =>
        Boolean(tr.annotation(SkipAutosaveAnnotation)),
      );
      current.hasUserEditsSinceLoad = true;
      const text = update.state.sliceDoc(0, update.state.doc.length);
      current.dirty = text !== current.savedContent;
      options.onUserChange?.(
        text,
        skipAutosave ? { skipAutosave: true } : undefined,
      );
    }),
  ];

  function newSessionRecord(
    state: EditorState,
    content: string,
    shouldBeDirty: boolean,
  ): DocSession {
    return {
      state,
      unmodifiedContent: content,
      savedContent: shouldBeDirty ? null : content,
      hasUserEditsSinceLoad: false,
      dirty: shouldBeDirty,
    };
  }

  function createSessionState(content: string): EditorState {
    let state = EditorState.create({
      doc: content,
      extensions: [buildExtensions(content), ...appendedExtensions],
    });
    if (imageRootDir !== null) {
      state = state.update({
        effects: setImageRootSettingEffect.of(imageRootDir),
      }).state;
    }
    return state;
  }

  let current: DocSession = newSessionRecord(
    EditorState.create({
      doc: initialContent,
      extensions: buildExtensions(initialContent),
    }),
    initialContent,
    false,
  );

  const view = new EditorView({
    state: current.state,
    parent: options.parent,
  });

  function getSessionState(session: DocSession): EditorState {
    return session === current ? view.state : session.state;
  }

  function getSessionContent(session: DocSession): string {
    if (!session.hasUserEditsSinceLoad) return session.unmodifiedContent;
    const state = getSessionState(session);
    return state.sliceDoc(0, state.doc.length);
  }

  function getContent(): string {
    return getSessionContent(current);
  }

  function setContent(content: string, setOptions?: SetContentOptions): void {
    const shouldBeDirty = Boolean(setOptions?.dirty);
    current.unmodifiedContent = content;
    current.savedContent = shouldBeDirty ? null : content;
    current.hasUserEditsSinceLoad = false;
    current.dirty = shouldBeDirty;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
      effects: lineSeparatorCompartment.reconfigure(lineSeparatorFor(content)),
      annotations: ExternalLoadAnnotation.of(true),
    });
  }

  function replaceContentUndoable(
    content: string,
    replaceOptions?: { skipAutosave?: boolean },
  ): void {
    const annotations: Annotation<unknown>[] = [isolateHistory.of("full")];
    if (replaceOptions?.skipAutosave) {
      annotations.push(SkipAutosaveAnnotation.of(true));
    }
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
      selection: { anchor: 0, head: 0 },
      effects: [
        lineSeparatorCompartment.reconfigure(lineSeparatorFor(content)),
        EditorView.scrollIntoView(0, { y: "start" }),
      ],
      annotations,
      userEvent: "input.restoreHistory",
    });
  }

  function createSession(
    content: string,
    setOptions?: SetContentOptions,
  ): DocSession {
    const shouldBeDirty = Boolean(setOptions?.dirty);
    return newSessionRecord(
      createSessionState(content),
      content,
      shouldBeDirty,
    );
  }

  /** Effects that bring a (background) tab state in line with the current global settings. */
  function globalSyncEffects(state: EditorState): StateEffect<unknown>[] {
    const effects: StateEffect<unknown>[] = [];
    for (const [compartment, ext] of globalCompartments()) {
      if (compartment.get(state) !== ext)
        effects.push(compartment.reconfigure(ext));
    }
    const sourceEffect = sourceModeController.syncEffect(state);
    if (sourceEffect) effects.push(sourceEffect);
    if (state.field(imageRootSettingField) !== imageRootDir) {
      effects.push(setImageRootSettingEffect.of(imageRootDir));
    }
    return effects;
  }

  function switchSession(next: DocSession): void {
    if (next === current) return;
    current.state = finishFrontMatterEdit(view.state);
    let state = next.state;
    const effects = globalSyncEffects(state);
    if (effects.length > 0) state = state.update({ effects }).state;
    next.state = state;
    current = next;
    view.setState(state);
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
        codeLineNumbersExt[flag(codeLineNumbers)],
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
        mathAutoNumberExt[flag(mathAutoNumber)],
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
      effects: focusModeCompartment.reconfigure(
        focusMode ? focusModeExtension : NONE,
      ),
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
        typewriterModeCompartment.reconfigure(
          typewriterMode ? typewriterModeExtension : NONE,
        ),
        ...(typewriterMode
          ? [
              EditorView.scrollIntoView(view.state.selection.main.head, {
                y: "center",
              }),
            ]
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
        autoPairBrackets ? autoPairBracketsExtension : NONE,
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
        autoPairMarkdown ? autoPairMarkdownExtension : NONE,
      ),
    });
    if (notify) options.onAutoPairMarkdownChange?.(autoPairMarkdown);
  }

  function toggleAutoPairMarkdown(): boolean {
    setAutoPairMarkdown(!autoPairMarkdown, true);
    return autoPairMarkdown;
  }

  function isDirty(): boolean {
    return current.dirty;
  }

  function markSessionClean(
    session: DocSession,
    justSavedContent: string,
  ): void {
    session.savedContent = justSavedContent;
    session.dirty = getSessionContent(session) !== justSavedContent;
    if (!session.dirty) {
      session.unmodifiedContent = justSavedContent;
      session.hasUserEditsSinceLoad = false;
    }
  }

  function markClean(justSavedContent: string): void {
    markSessionClean(current, justSavedContent);
  }

  function mapLineColPos(
    oldState: EditorState,
    newDoc: Text,
    pos: number,
  ): number {
    const clampedOld = Math.max(0, Math.min(pos, oldState.doc.length));
    const oldLine = oldState.doc.lineAt(clampedOld);
    const col = clampedOld - oldLine.from;
    const targetLineNum = Math.min(oldLine.number, newDoc.lines);
    const targetLine = newDoc.line(targetLineNum);
    return Math.min(targetLine.from + col, targetLine.to);
  }

  function reloadSession(session: DocSession, content: string): void {
    const oldState = getSessionState(session);
    const oldSel = oldState.selection.main;
    const lineSepEffect = lineSeparatorCompartment.reconfigure(
      lineSeparatorFor(content),
    );
    const annotations = [
      ExternalLoadAnnotation.of(true),
      Transaction.addToHistory.of(false),
    ];
    const draft = oldState.update({
      changes: { from: 0, to: oldState.doc.length, insert: content },
      effects: lineSepEffect,
      annotations,
    });
    const nextAnchor = mapLineColPos(oldState, draft.newDoc, oldSel.anchor);
    const nextHead = mapLineColPos(oldState, draft.newDoc, oldSel.head);

    session.unmodifiedContent = content;
    session.savedContent = content;
    session.hasUserEditsSinceLoad = false;
    session.dirty = false;

    if (session === current) {
      const savedScrollTop = view.scrollDOM.scrollTop;
      const savedScrollLeft = view.scrollDOM.scrollLeft;
      const effects: StateEffect<unknown>[] = [lineSepEffect];
      if (savedScrollTop > 0) {
        const topBlock = view.lineBlockAtHeight(savedScrollTop);
        const topLineNum = oldState.doc.lineAt(topBlock.from).number;
        const newTopLine = draft.newDoc.line(
          Math.min(topLineNum, draft.newDoc.lines),
        );
        const beforeCoords = view.coordsAtPos(topBlock.from);
        const scrollerTop = view.scrollDOM.getBoundingClientRect().top;
        const yMargin = beforeCoords ? beforeCoords.top - scrollerTop : 0;
        effects.push(
          EditorView.scrollIntoView(newTopLine.from, {
            y: "start",
            yMargin,
          }),
        );
      }
      view.dispatch({
        changes: { from: 0, to: oldState.doc.length, insert: content },
        selection: { anchor: nextAnchor, head: nextHead },
        effects,
        annotations,
      });
      if (savedScrollLeft > 0) {
        view.scrollDOM.scrollLeft = savedScrollLeft;
      }
    } else {
      session.state = oldState.update({
        changes: { from: 0, to: oldState.doc.length, insert: content },
        selection: { anchor: nextAnchor, head: nextHead },
        effects: lineSepEffect,
        annotations,
      }).state;
    }
  }

  function markSessionDirty(session: DocSession): void {
    session.dirty = true;
  }

  function markDirty(): void {
    markSessionDirty(current);
  }

  function setDocumentPath(path: string | null): void {
    if (view.state.field(imageDocPathField) === path) return;
    view.dispatch({ effects: setImageDocPathEffect.of(path) });
  }

  function setImageRootDir(path: string | null): void {
    imageRootDir = path;
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
    replaceContentUndoable,
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
    createSession,
    getSession: () => {
      current.state = view.state;
      return current;
    },
    switchSession,
    getSessionContent,
    getSessionState,
    isSessionDirty: (session) => session.dirty,
    markSessionClean,
    markSessionDirty,
    reloadSession,
    setDocumentPath,
    setImageRootDir,
    getImageRootDir,
    destroy,
  };
}
