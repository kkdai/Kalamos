import "@fontsource/source-serif-4";
import "@fontsource/noto-serif-tc";
import "@fontsource/inter";
import "@fontsource/noto-sans-tc";
import "@fontsource/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/themes/papyros.css";
import "./styles/themes/melan.css";
import "./styles/editor.css";

import { createEditor, type KalamosEditor } from "./editor";
import { pickExportFormat } from "./export/format-picker";
import { buildExportHtml } from "./export/html";
import {
  defaultExportPath,
  ensureExportExtension,
  EXPORTING_MESSAGE,
  exportedMessage,
  formatInfo,
  importedMessage,
  IMPORTING_MESSAGE,
  PANDOC_IMPORT_EXTENSIONS,
  PANDOC_MISSING_MESSAGE,
  type PandocFormat,
  prepareMarkdownForPandoc,
} from "./export/pandoc";
import {
  defaultPdfPath,
  documentTitle,
  ensurePdfExtension,
  EXPORTING_PDF_MESSAGE,
  exportedPdfMessage,
} from "./export/pdf";
import {
  insertImageMarkdown,
  isImageFilePath,
  imageExtFromMime,
  readFileAsBase64,
} from "./editor/images";
import { collectUploadTargetsInRange, uploadImagesInEditor } from "./editor/image-upload";
import { bindWindowShortcuts } from "./editor/keymaps";
import { lineColumnToRange, revealRange } from "./editor/search";
import { FOCUS_MODE_MESSAGE, TYPEWRITER_MODE_MESSAGE } from "./editor/writing-modes";
import { AUTO_PAIR_BRACKETS_MESSAGE, AUTO_PAIR_MARKDOWN_MESSAGE } from "./editor/auto-pair";
import { createWordCounter, type WordCounter } from "./editor/word-count-view";
import {
  jumpToHeadingSlug,
  resolveRelativeMarkdownPath,
} from "./editor/lists";
import {
  allowAssetDir,
  askDiscardChanges,
  isAssetDirTooBroadError,
  clearRecovery,
  DEFAULT_SETTINGS,
  exportPandoc,
  exportPdf,
  getSettings,
  importPandoc,
  pandocStatus,
  pickImportPath,
  pickSaveExportPath,
  importImage,
  importImageBytes,
  listRecovery,
  onFileDrop,
  onOpenFilesRequested,
  onWindowCloseRequested,
  openFile,
  pickOpenFilePath,
  pickOpenFolderPath,
  pickSaveFilePath,
  pickSavePdfPath,
  saveFile,
  setSettings,
  takePendingOpenFiles,
  UPLOADER_NOT_CONFIGURED_MESSAGE,
  uploadImages,
  writeRecovery,
  type OpenFilesRequest,
  type RecoveryEntry,
  type Settings,
} from "./ipc";
import { isImportablePath } from "./export/pandoc";
import { isMarkdownFilePath, shortcutLabel } from "./platform";
import { createSidebar, type SidebarController } from "./sidebar/sidebar";
import {
  applyThemeWithCustomCss,
  createThemeMenu,
  CUSTOM_THEME_STYLE_ID,
  type ThemeMenuController,
} from "./theme/theme-menu";

export const NAMED_AUTOSAVE_DELAY_MS = 1000;
export const UNTITLED_RECOVERY_INTERVAL_MS = 5000;
export const SAVE_BEFORE_IMAGE_MESSAGE = "請先儲存文件，才能插入圖片";

export function applyTheme(theme: string): void {
  if (typeof document === "undefined") return;
  if (theme && theme.startsWith("custom:")) {
    void applyThemeWithCustomCss(theme);
    return;
  }
  const existingCustomStyle = document.getElementById(CUSTOM_THEME_STYLE_ID);
  if (existingCustomStyle) {
    existingCustomStyle.remove();
  }
  document.documentElement.removeAttribute("data-custom-theme");
  if (!theme || theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.setAttribute("data-theme", theme);
  }
}

function generateDocId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `doc-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function formatErrorMessage(prefix: string, err: unknown): string {
  if (err && typeof err === "object" && "message" in err) {
    return `${prefix}：${String((err as { message: unknown }).message)}`;
  }
  if (err instanceof Error) {
    return `${prefix}：${err.message}`;
  }
  return `${prefix}：${String(err)}`;
}

function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/** #67: status line after the OS handed over files Kalamos did not (all) open. */
export function openWithStatusMessage(
  openedPath: string | null,
  extraCount: number,
  rejected: string[],
): string {
  const parts: string[] = [];
  if (openedPath !== null && extraCount > 0) {
    parts.push(
      `已開啟 ${baseName(openedPath)}；另有 ${extraCount} 個檔案未開啟（Kalamos 一次開啟一個檔案）`,
    );
  }
  if (rejected.length > 0) {
    parts.push(`無法開啟：${rejected.join("、")}（只支援一般的 Markdown 檔案）`);
  }
  return parts.join("；");
}

export const IMAGE_ROOT_STATUS_PREFIX = "圖片根目錄：";
export const IMAGE_ROOT_CLEARED_MESSAGE = "已清除圖片根目錄";
export const IMAGE_ROOT_TOO_BROAD_PREFIX = "圖片根目錄範圍過大：";

export interface KalamosApp {
  editor: KalamosEditor;
  sidebar: SidebarController;
  themeMenu: ThemeMenuController;
  wordCounter: WordCounter;
  getDocId: () => string;
  getCurrentPath: () => string | null;
  getPendingRecovery: () => RecoveryEntry | null;
  getStatusText: () => string;
  openDocument: (explicitPath?: string) => Promise<boolean>;
  /** #67: open what Finder / Dock / `open -a` handed over (first file; the rest are reported). */
  openRequestedFiles: (req: OpenFilesRequest) => Promise<boolean>;
  openFolder: (explicitPath?: string) => Promise<boolean>;
  toggleSidebar: () => Promise<boolean>;
  saveDocument: () => Promise<boolean>;
  saveDocumentAs: (explicitPath?: string) => Promise<boolean>;
  newDocument: () => Promise<boolean>;
  /** IM-04: pick the image root folder (Cmd+Opt+R); false when cancelled. */
  pickImageRootDir: () => Promise<boolean>;
  /** IM-05: upload the local images under the cursor (or all of them) and use the URLs (Cmd+Opt+U). */
  uploadDocumentImages: () => Promise<boolean>;
  /** IM-04: set (path) or clear (null, Cmd+Opt+Shift+R) the image root folder. */
  setImageRootDir: (path: string | null) => Promise<void>;
  getImageRootDir: () => string | null;
  /** EX-02: export via Pandoc (Cmd+Opt+E); asks for the format / path when omitted. */
  exportDocumentAs: (format?: PandocFormat, explicitPath?: string) => Promise<boolean>;
  isExportingPandoc: () => boolean;
  /** EX-03: import a DOCX / ODT / EPUB / LaTeX / HTML / MediaWiki file as a new untitled document (Cmd+Opt+I). */
  importDocument: (explicitPath?: string) => Promise<boolean>;
  /** EX-01: export the current document to PDF (Cmd+Shift+E). */
  exportDocumentPdf: (explicitPath?: string) => Promise<boolean>;
  isExportingPdf: () => boolean;
  dropImageFiles: (
    paths: string[],
    position?: { x: number; y: number },
  ) => Promise<boolean>;
  insertPastedImages: (files: File[], pos: number) => Promise<boolean>;
  restoreRecovery: () => Promise<boolean>;
  discardRecovery: () => Promise<boolean>;
  flushBeforeClose: () => Promise<void>;
  init: () => Promise<void>;
  destroy: () => void;
}

export function createKalamosApp(root: Document | HTMLElement = document): KalamosApp {
  const editorContainer =
    root.querySelector<HTMLElement>("#editor-container") ??
    (root instanceof HTMLElement ? root : document.body);
  let sidebarEl = root.querySelector<HTMLElement>("#sidebar");
  if (!sidebarEl) {
    sidebarEl = document.createElement("aside");
    sidebarEl.id = "sidebar";
    sidebarEl.dataset.testid = "sidebar";
    sidebarEl.dataset.visible = "false";
    editorContainer.parentElement?.insertBefore(sidebarEl, editorContainer);
  }
  const recoveryBanner = root.querySelector<HTMLElement>("#recovery-banner");
  const restoreBtn = root.querySelector<HTMLButtonElement>("#recovery-restore-btn");
  const discardBtn = root.querySelector<HTMLButtonElement>("#recovery-discard-btn");
  const statusEl = root.querySelector<HTMLElement>("#status");

  let docId = generateDocId();
  let currentPath: string | null = null;
  let pendingRecovery: RecoveryEntry | null = null;
  let autosaveTimer: ReturnType<typeof setTimeout> | null = null;
  let unlistenClose: (() => void) | null = null;
  let statusText = "";
  let currentSettings: Settings = { ...DEFAULT_SETTINGS };

  function setStatus(message: string, isError = false): void {
    statusText = message;
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.dataset.error = isError && message.length > 0 ? "true" : "false";
    }
  }

  let syncedDocPath: string | null = null;
  function syncDocumentPath(): void {
    if (syncedDocPath === currentPath) return;
    syncedDocPath = currentPath;
    editor.setDocumentPath(currentPath);
    if (currentPath !== null) {
      void allowAssetDir(currentPath).catch(() => null);
    }
  }

  function clearAutosaveTimer(): void {
    if (autosaveTimer !== null) {
      clearTimeout(autosaveTimer);
      autosaveTimer = null;
    }
  }

  function setRecoveryBannerVisible(visible: boolean): void {
    if (recoveryBanner) {
      recoveryBanner.dataset.visible = visible ? "true" : "false";
    }
  }

  async function persistFileToPath(
    targetPath: string,
    targetDocId: string,
    contentToSave: string,
  ): Promise<boolean> {
    try {
      await saveFile(targetPath, contentToSave);
      setStatus("", false);
      if (docId === targetDocId) {
        currentPath = targetPath;
        syncDocumentPath();
        editor.markClean(contentToSave);
        await clearRecovery(targetDocId).catch(() => null);
        if (editor.isDirty() && currentPath !== null) {
          scheduleNamedAutosave();
        }
      }
      return true;
    } catch (err) {
      if (docId === targetDocId) {
        editor.markDirty();
      }
      setStatus(formatErrorMessage("存檔失敗", err), true);
      const latestContent =
        docId === targetDocId ? editor.getContent() : contentToSave;
      await writeRecovery(targetDocId, latestContent, targetPath).catch(() => null);
      return false;
    }
  }

  function scheduleNamedAutosave(): void {
    clearAutosaveTimer();
    if (currentPath === null) return;
    const targetPath = currentPath;
    const targetDocId = docId;
    autosaveTimer = setTimeout(() => {
      autosaveTimer = null;
      if (currentPath === targetPath && docId === targetDocId && editor.isDirty()) {
        const contentToSave = editor.getContent();
        void persistFileToPath(targetPath, targetDocId, contentToSave);
      }
    }, NAMED_AUTOSAVE_DELAY_MS);
  }

  async function prepareBeforeSwitchDocument(): Promise<boolean> {
    if (!editor.isDirty()) {
      return true;
    }
    if (currentPath !== null) {
      clearAutosaveTimer();
      return persistFileToPath(currentPath, docId, editor.getContent());
    }
    const confirmed = await askDiscardChanges();
    if (!confirmed) {
      return false;
    }
    await clearRecovery(docId).catch(() => null);
    return true;
  }

  async function persistEditorSettingPatch(
    patch: Partial<Settings>,
  ): Promise<void> {
    currentSettings = {
      ...currentSettings,
      theme: themeMenu.getCurrentTheme(),
      sidebarVisible: sidebar.isVisible(),
      sidebarTab: sidebar.getTab(),
      lastFolder: sidebar.getCurrentFolder() ?? currentSettings.lastFolder,
      sourceMode: editor.isSourceMode(),
      codeLineNumbers: editor.isCodeLineNumbers(),
      mathAutoNumber: editor.isMathAutoNumber(),
      imageRootDir: editor.getImageRootDir(),
      focusMode: editor.isFocusMode(),
      typewriterMode: editor.isTypewriterMode(),
      autoPairBrackets: editor.isAutoPairBrackets(),
      autoPairMarkdown: editor.isAutoPairMarkdown(),
      ...patch,
    };
    await setSettings(currentSettings).catch(() => null);
  }

  const handlers = {
    onOpenFile: async () => {
      await openDocument();
    },
    onSaveFile: async () => {
      await saveDocument();
    },
    onSaveFileAs: async () => {
      await saveDocumentAs();
    },
    onNewFile: async () => {
      await newDocument();
    },
  };

  const editor = createEditor({
    parent: editorContainer,
    initialContent: "",
    handlers,
    onUserChange: () => {
      if (currentPath !== null) {
        scheduleNamedAutosave();
      }
    },
    onSourceModeChange: (sourceMode) => {
      void persistEditorSettingPatch({ sourceMode });
    },
    onCodeLineNumbersChange: (codeLineNumbers) => {
      void persistEditorSettingPatch({ codeLineNumbers });
    },
    onMathAutoNumberChange: (mathAutoNumber) => {
      void persistEditorSettingPatch({ mathAutoNumber });
    },
    onFocusModeChange: (focusMode) => {
      setStatus(FOCUS_MODE_MESSAGE(focusMode), false);
      void persistEditorSettingPatch({ focusMode });
    },
    onTypewriterModeChange: (typewriterMode) => {
      setStatus(TYPEWRITER_MODE_MESSAGE(typewriterMode), false);
      void persistEditorSettingPatch({ typewriterMode });
    },
    onAutoPairBracketsChange: (autoPairBrackets) => {
      setStatus(AUTO_PAIR_BRACKETS_MESSAGE(autoPairBrackets), false);
      void persistEditorSettingPatch({ autoPairBrackets });
    },
    onAutoPairMarkdownChange: (autoPairMarkdown) => {
      setStatus(AUTO_PAIR_MARKDOWN_MESSAGE(autoPairMarkdown), false);
      void persistEditorSettingPatch({ autoPairMarkdown });
    },
    onOpenRelativeLink: async (relativePath, slug, view) => {
      if (currentPath === null) {
        setStatus("請先儲存目前文件，才能開啟相對路徑連結", true);
        return;
      }
      const targetPath = resolveRelativeMarkdownPath(currentPath, relativePath);
      const opened = await openDocument(targetPath);
      if (opened && slug) {
        jumpToHeadingSlug(view, slug);
      }
    },
    onPasteImages: async (files, view) => {
      await insertPastedImages(files, view.state.selection.main.head);
    },
    onImageRootTooBroad: (root) => {
      setStatus(`${IMAGE_ROOT_TOO_BROAD_PREFIX}${root}`, true);
    },
  });

  const windowHandlers = {
    ...handlers,
    onToggleSourceMode: () => {
      editor.toggleSourceMode();
    },
    onToggleCodeLineNumbers: () => {
      editor.toggleCodeLineNumbers();
    },
    onToggleMathAutoNumber: () => {
      editor.toggleMathAutoNumber();
    },
    onToggleFocusMode: () => {
      editor.toggleFocusMode();
    },
    onToggleTypewriterMode: () => {
      editor.toggleTypewriterMode();
    },
    onToggleAutoPairBrackets: () => {
      editor.toggleAutoPairBrackets();
    },
    onToggleAutoPairMarkdown: () => {
      editor.toggleAutoPairMarkdown();
    },
  };

  const wordCounter = createWordCounter({
    view: editor.view,
    parent:
      root.querySelector<HTMLElement>("#statusbar") ??
      statusEl?.parentElement ??
      editorContainer.parentElement ??
      document.body,
  });

  const unbindShortcuts = bindWindowShortcuts(
    window,
    windowHandlers,
    () => editor.view,
  );

  const sidebar = createSidebar({
    element: sidebarEl,
    editorView: editor.view,
    onSelectFile: async (path) => {
      await openDocument(path);
    },
    onOpenSearchHit: async (hit) => {
      // #73 B: the current document is not reopened (no unsaved prompt).
      if (currentPath !== hit.path && !(await openDocument(hit.path))) return;
      const range = lineColumnToRange(editor.view.state, hit.line, hit.column, hit.length);
      revealRange(editor.view, range.from, range.to);
    },
    onPathRenamed: (from, to) => {
      if (currentPath === null) return;
      if (currentPath === from) {
        currentPath = to;
        syncDocumentPath();
        sidebar.setActiveFile(currentPath);
        if (editor.isDirty()) {
          scheduleNamedAutosave();
        }
      } else if (currentPath.startsWith(`${from}/`)) {
        currentPath = `${to}${currentPath.slice(from.length)}`;
        syncDocumentPath();
        sidebar.setActiveFile(currentPath);
        if (editor.isDirty()) {
          scheduleNamedAutosave();
        }
      }
    },
    onPathTrashed: (trashedPath) => {
      if (currentPath === null) return;
      if (
        currentPath === trashedPath ||
        currentPath.startsWith(`${trashedPath}/`)
      ) {
        clearAutosaveTimer();
        currentPath = null;
        syncDocumentPath();
        editor.markDirty();
        sidebar.setActiveFile(null);
        setStatus("檔案已移到垃圾桶，內容保留為未命名文件", false);
      }
    },
    onError: (prefix, err) => {
      setStatus(formatErrorMessage(prefix, err), true);
    },
  });

  const themeMenu = createThemeMenu({
    parent: editorContainer.parentElement ?? document.body,
    onThemeChange: (themeId) => {
      currentSettings = {
        ...currentSettings,
        theme: themeId,
      };
    },
    onError: (prefix, err) => {
      setStatus(formatErrorMessage(prefix, err), true);
    },
  });

  // Top-left floating quick controls (toggle sidebar + open Markdown file)
  // so users can open files with the mouse as well as Ctrl+O / Cmd+O.
  const navWidgetEl = document.createElement("div");
  navWidgetEl.className = "k-sidebar-toggle-widget";

  const sidebarToggleBtn = document.createElement("button");
  sidebarToggleBtn.type = "button";
  sidebarToggleBtn.className = "k-theme-btn";
  sidebarToggleBtn.dataset.testid = "sidebar-toggle-button";
  sidebarToggleBtn.title = shortcutLabel("切換側欄 (Cmd+Shift+L)");
  sidebarToggleBtn.setAttribute("aria-label", "切換側欄");
  sidebarToggleBtn.innerHTML = `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 4v16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  sidebarToggleBtn.addEventListener("click", () => {
    void sidebar.toggleVisible();
  });

  const openFileQuickBtn = document.createElement("button");
  openFileQuickBtn.type = "button";
  openFileQuickBtn.className = "k-theme-btn";
  openFileQuickBtn.dataset.testid = "open-file-button";
  openFileQuickBtn.title = shortcutLabel("開啟檔案 (Cmd+O)");
  openFileQuickBtn.setAttribute("aria-label", "開啟檔案");
  openFileQuickBtn.innerHTML = `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 3v6h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  openFileQuickBtn.addEventListener("click", () => {
    void openDocument();
  });

  navWidgetEl.append(sidebarToggleBtn, openFileQuickBtn);
  (editorContainer.parentElement ?? document.body).appendChild(navWidgetEl);

  const onSidebarKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (!(event.metaKey || event.ctrlKey) || !event.shiftKey || event.altKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "l") {
      event.preventDefault();
      void sidebar.toggleVisible();
    } else if (key === "o") {
      event.preventDefault();
      void sidebar.openFolder();
    } else if (key === "t") {
      event.preventDefault();
      void themeMenu.cycleTheme();
    } else if (key === "e" || event.code === "KeyE") {
      event.preventDefault();
      void exportDocumentPdf();
    } else if (key === "f" || event.code === "KeyF") {
      // #73 B: folder search.
      event.preventDefault();
      void sidebar.openSearch();
    }
  };
  window.addEventListener("keydown", onSidebarKeydown);

  async function setImageRootDir(path: string | null): Promise<void> {
    const normalized = path && path.trim() ? path.trim() : null;
    editor.setImageRootDir(normalized);
    setStatus(normalized ? `${IMAGE_ROOT_STATUS_PREFIX}${normalized}` : IMAGE_ROOT_CLEARED_MESSAGE, false);
    await persistEditorSettingPatch({ imageRootDir: normalized });
    if (!normalized) return;
    try {
      await allowAssetDir(normalized);
    } catch (err) {
      // Kept as the setting (images show their fallback), but say why.
      if (isAssetDirTooBroadError(err)) {
        setStatus(`${IMAGE_ROOT_TOO_BROAD_PREFIX}${normalized}`, true);
      }
    }
  }

  async function pickImageRootDir(): Promise<boolean> {
    let picked: string | null;
    try {
      picked = await pickOpenFolderPath();
    } catch (err) {
      setStatus(formatErrorMessage("設定圖片根目錄失敗", err), true);
      return false;
    }
    if (!picked) return false;
    await setImageRootDir(picked);
    return true;
  }

  // IM-04: Cmd+Opt+R picks the image root folder, Cmd+Opt+Shift+R clears it.
  // event.code is used because Option changes event.key on macOS.
  const onImageRootKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (!(event.metaKey || event.ctrlKey) || !event.altKey) return;
    if (event.code !== "KeyR" && event.key.toLowerCase() !== "r") return;
    event.preventDefault();
    if (event.shiftKey) {
      void setImageRootDir(null);
    } else {
      void pickImageRootDir();
    }
  };
  window.addEventListener("keydown", onImageRootKeydown);

  async function isPandocAvailable(): Promise<boolean> {
    const status = await pandocStatus().catch(() => null);
    if (status?.available) return true;
    setStatus(PANDOC_MISSING_MESSAGE, true);
    return false;
  }

  function pandocErrorMessage(prefix: string, err: unknown): string {
    const e = err as { kind?: unknown; message?: unknown } | null;
    if (e?.kind === "NotFound" && e.message === PANDOC_MISSING_MESSAGE) {
      return PANDOC_MISSING_MESSAGE;
    }
    return formatErrorMessage(prefix, err);
  }

  let exportingPandoc = false;

  async function exportDocumentAs(
    format?: PandocFormat,
    explicitPath?: string,
  ): Promise<boolean> {
    if (exportingPandoc) return false;
    exportingPandoc = true;
    try {
      if (!(await isPandocAvailable())) return false;
      const chosen = format ?? (await pickExportFormat());
      if (!chosen) return false;
      const info = formatInfo(chosen);
      const docPath = currentPath;
      let outPath: string | null;
      try {
        outPath =
          explicitPath ??
          (await pickSaveExportPath(defaultExportPath(docPath, chosen), info.label, info.ext));
      } catch (err) {
        setStatus(formatErrorMessage("匯出失敗", err), true);
        return false;
      }
      if (!outPath) return false;
      outPath = ensureExportExtension(outPath, chosen);
      setStatus(EXPORTING_MESSAGE, false);
      try {
        const prepared = prepareMarkdownForPandoc(
          editor.getContent(),
          docPath,
          editor.getImageRootDir(),
        );
        const meta = await exportPandoc({
          docPath,
          markdown: prepared.markdown,
          format: chosen,
          outPath,
          imageRoot: prepared.imageRoot,
          toc: prepared.toc,
        });
        setStatus(exportedMessage(chosen, meta.path), false);
        return true;
      } catch (err) {
        setStatus(pandocErrorMessage("匯出失敗", err), true);
        return false;
      }
    } finally {
      exportingPandoc = false;
    }
  }

  let importing = false;

  async function importDocument(explicitPath?: string): Promise<boolean> {
    if (importing) return false;
    importing = true;
    try {
      if (!(await isPandocAvailable())) return false;
      let source: string | null;
      try {
        source = explicitPath ?? (await pickImportPath(PANDOC_IMPORT_EXTENSIONS));
      } catch (err) {
        setStatus(formatErrorMessage("匯入失敗", err), true);
        return false;
      }
      if (!source) return false;
      setStatus(IMPORTING_MESSAGE, false);
      let markdown: string;
      try {
        const result = await importPandoc(source);
        markdown = result.markdown;
        if (result.mediaDir) {
          await allowAssetDir(result.mediaDir).catch(() => null);
        }
      } catch (err) {
        setStatus(pandocErrorMessage("匯入失敗", err), true);
        return false;
      }
      // Convert first, then switch: a failed import leaves the current document alone.
      if (!(await prepareBeforeSwitchDocument())) {
        setStatus("", false);
        return false;
      }
      clearAutosaveTimer();
      currentPath = null;
      docId = generateDocId();
      editor.setContent(markdown, { dirty: true });
      syncDocumentPath();
      sidebar.setActiveFile(null);
      setStatus(importedMessage(source), false);
      return true;
    } finally {
      importing = false;
    }
  }

  // EX-02 / EX-03: Cmd+Opt+E export via Pandoc, Cmd+Opt+I import.
  // event.code is used because Option changes event.key on macOS.
  const onPandocKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey) return;
    if (event.code === "KeyE") {
      event.preventDefault();
      void exportDocumentAs();
    } else if (event.code === "KeyI") {
      event.preventDefault();
      void importDocument();
    } else if (event.code === "KeyU") {
      // IM-05: Cmd+Opt+U uploads images to the configured image host.
      event.preventDefault();
      void uploadDocumentImages();
    }
  };
  window.addEventListener("keydown", onPandocKeydown);

  const recoveryInterval = setInterval(() => {
    if (currentPath === null && editor.isDirty()) {
      const content = editor.getContent();
      if (content.length > 0) {
        void writeRecovery(docId, content, null).catch((err) => {
          setStatus(formatErrorMessage("寫入救回檔失敗", err), true);
        });
      }
    }
  }, UNTITLED_RECOVERY_INTERVAL_MS);

  async function insertImportedImages(
    pos: number,
    importers: Array<(docPath: string) => Promise<string>>,
  ): Promise<boolean> {
    const docPath = currentPath;
    if (docPath === null) {
      setStatus(SAVE_BEFORE_IMAGE_MESSAGE, true);
      return false;
    }
    const relativePaths: string[] = [];
    let lastError: unknown = null;
    for (const run of importers) {
      try {
        relativePaths.push(await run(docPath));
      } catch (err) {
        lastError = err;
      }
    }
    if (relativePaths.length === 0) {
      if (lastError !== null) {
        setStatus(formatErrorMessage("插入圖片失敗", lastError), true);
      }
      return false;
    }
    if (currentPath !== docPath) return false;
    const { view } = editor;
    const anchor = Math.min(pos, view.state.doc.length);
    const lengthBefore = view.state.doc.length;
    insertImageMarkdown(view, anchor, relativePaths);
    if (lastError !== null) {
      setStatus(formatErrorMessage("部分圖片插入失敗", lastError), true);
    } else {
      setStatus("", false);
    }
    const settings = await refreshUploadSettings();
    if (settings.uploadOnInsert && lastError === null && currentPath === docPath) {
      const insertedTo = anchor + (view.state.doc.length - lengthBefore);
      await runImageUpload(collectUploadTargetsInRange(view.state, anchor, insertedTo));
    }
    return true;
  }

  /** Upload settings are read from disk each time (settings.json may have been edited). */
  async function refreshUploadSettings(): Promise<Settings> {
    const fresh = await getSettings().catch(() => null);
    if (fresh) {
      currentSettings = {
        ...currentSettings,
        uploadCommand: fresh.uploadCommand ?? null,
        uploadArgs: fresh.uploadArgs ?? [],
        uploadOnInsert: Boolean(fresh.uploadOnInsert),
      };
    }
    return currentSettings;
  }

  let uploadingImages = false;

  async function runImageUpload(targets?: Parameters<typeof uploadImagesInEditor>[0]["targets"]): Promise<boolean> {
    if (uploadingImages) return false;
    uploadingImages = true;
    try {
      const settings = await refreshUploadSettings();
      const result = await uploadImagesInEditor({
        view: editor.view,
        uploader: settings.uploadCommand,
        upload: uploadImages,
        setStatus,
        targets,
        notConfiguredMessage: UPLOADER_NOT_CONFIGURED_MESSAGE,
      });
      return result.error === null && result.replaced > 0;
    } finally {
      uploadingImages = false;
    }
  }

  async function uploadDocumentImages(): Promise<boolean> {
    return runImageUpload();
  }

  async function dropImageFiles(
    paths: string[],
    position?: { x: number; y: number },
  ): Promise<boolean> {
    const imagePaths = paths.filter((p) => isImageFilePath(p));
    if (imagePaths.length === 0) return false;
    const { view } = editor;
    let pos: number | null = null;
    if (position) {
      try {
        pos = view.posAtCoords(position);
      } catch {
        pos = null;
      }
    }
    if (pos === null) pos = view.state.selection.main.head;
    return insertImportedImages(
      pos,
      imagePaths.map(
        (sourcePath) => async (docPath: string) =>
          (await importImage(docPath, sourcePath)).relativePath,
      ),
    );
  }

  async function insertPastedImages(files: File[], pos: number): Promise<boolean> {
    return insertImportedImages(
      pos,
      files.map((file) => async (docPath: string) => {
        const ext = imageExtFromMime(file.type) ?? "png";
        const bytes = await readFileAsBase64(file);
        return (await importImageBytes(docPath, bytes, ext)).relativePath;
      }),
    );
  }

  let unlistenFileDrop: (() => void) | null = null;
  let unlistenOpenFiles: (() => void) | null = null;
  let destroyed = false;

  async function openDocument(explicitPath?: string): Promise<boolean> {
    if (!(await prepareBeforeSwitchDocument())) {
      return false;
    }
    let selectedPath: string | null = null;
    try {
      selectedPath = explicitPath ?? (await pickOpenFilePath());
    } catch (err) {
      setStatus(formatErrorMessage("開檔失敗", err), true);
      return false;
    }
    if (!selectedPath) return false;
    try {
      const content = await openFile(selectedPath);
      clearAutosaveTimer();
      currentPath = selectedPath;
      docId = generateDocId();
      editor.setContent(content, { dirty: false });
      syncDocumentPath();
      sidebar.setActiveFile(currentPath);
      setStatus("", false);
      return true;
    } catch (err) {
      setStatus(formatErrorMessage("開檔失敗", err), true);
      return false;
    }
  }

  // Requests are handled one at a time so a second Finder open waits for the
  // unsaved-changes prompt of the first instead of racing it.
  let openRequestChain: Promise<unknown> = Promise.resolve();

  function openRequestedFiles(req: OpenFilesRequest): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const paths = req.paths ?? [];
      const rejected = req.rejected ?? [];
      if (paths.length === 0) {
        if (rejected.length > 0) {
          setStatus(openWithStatusMessage(null, 0, rejected), true);
        }
        return false;
      }
      const opened = await openDocument(paths[0]);
      if (opened) {
        const message = openWithStatusMessage(paths[0], paths.length - 1, rejected);
        if (message) setStatus(message, rejected.length > 0);
      }
      return opened;
    };
    const result = openRequestChain.then(run, run);
    openRequestChain = result.catch(() => null);
    return result;
  }

  async function saveDocument(): Promise<boolean> {
    clearAutosaveTimer();
    if (currentPath === null) {
      return saveDocumentAs();
    }
    const contentToSave = editor.getContent();
    return persistFileToPath(currentPath, docId, contentToSave);
  }

  async function saveDocumentAs(explicitPath?: string): Promise<boolean> {
    clearAutosaveTimer();
    let selectedPath: string | null = null;
    try {
      selectedPath = explicitPath ?? (await pickSaveFilePath(currentPath));
    } catch (err) {
      setStatus(formatErrorMessage("存檔失敗", err), true);
      return false;
    }
    if (!selectedPath) return false;
    const contentToSave = editor.getContent();
    return persistFileToPath(selectedPath, docId, contentToSave);
  }

  async function newDocument(): Promise<boolean> {
    if (!(await prepareBeforeSwitchDocument())) {
      return false;
    }
    clearAutosaveTimer();
    currentPath = null;
    docId = generateDocId();
    editor.setContent("", { dirty: false });
    syncDocumentPath();
    sidebar.setActiveFile(null);
    setStatus("", false);
    return true;
  }

  let exportingPdf = false;

  async function exportDocumentPdf(explicitPath?: string): Promise<boolean> {
    if (exportingPdf) return false;
    exportingPdf = true;
    try {
      const docPath = currentPath;
      let outPath: string | null = null;
      try {
        outPath = explicitPath ?? (await pickSavePdfPath(defaultPdfPath(docPath)));
      } catch (err) {
        setStatus(formatErrorMessage("匯出 PDF 失敗", err), true);
        return false;
      }
      if (!outPath) return false;
      outPath = ensurePdfExtension(outPath);
      setStatus(EXPORTING_PDF_MESSAGE, false);
      try {
        const { html, headings } = await buildExportHtml(editor.getContent(), {
          title: documentTitle(docPath),
          docPath,
          mathAutoNumber: editor.isMathAutoNumber(),
          imageRootDir: editor.getImageRootDir(),
        });
        const meta = await exportPdf(html, outPath, headings);
        setStatus(exportedPdfMessage(meta.path), false);
        return true;
      } catch (err) {
        setStatus(formatErrorMessage("匯出 PDF 失敗", err), true);
        return false;
      }
    } finally {
      exportingPdf = false;
    }
  }

  async function restoreRecovery(): Promise<boolean> {
    if (!pendingRecovery) return false;
    const entry = pendingRecovery;
    pendingRecovery = null;
    setRecoveryBannerVisible(false);
    clearAutosaveTimer();
    docId = entry.docId;
    currentPath = entry.path;
    editor.setContent(entry.content, { dirty: true });
    syncDocumentPath();
    await clearRecovery(entry.docId).catch(() => null);
    if (currentPath !== null) {
      scheduleNamedAutosave();
    }
    return true;
  }

  async function discardRecovery(): Promise<boolean> {
    if (!pendingRecovery) return false;
    const entry = pendingRecovery;
    pendingRecovery = null;
    setRecoveryBannerVisible(false);
    await clearRecovery(entry.docId).catch(() => null);
    return true;
  }

  async function flushBeforeClose(): Promise<void> {
    clearAutosaveTimer();
    if (!editor.isDirty()) return;
    if (currentPath !== null) {
      await persistFileToPath(currentPath, docId, editor.getContent());
    } else {
      const content = editor.getContent();
      if (content.length > 0) {
        await writeRecovery(docId, content, null).catch(() => null);
      }
    }
  }

  const onRestoreClick = () => {
    void restoreRecovery();
  };
  const onDiscardClick = () => {
    void discardRecovery();
  };

  restoreBtn?.addEventListener("click", onRestoreClick);
  discardBtn?.addEventListener("click", onDiscardClick);

  async function init(): Promise<void> {
    unlistenClose = await onWindowCloseRequested(async () => {
      await flushBeforeClose();
    });
    const unlistenDrop = await onFileDrop(async ({ paths, position }) => {
      const imagePaths = paths.filter((p) => isImageFilePath(p));
      if (imagePaths.length > 0) {
        await dropImageFiles(imagePaths, position);
        return;
      }
      const mdPaths = paths.filter((p) => isMarkdownFilePath(p));
      if (mdPaths.length > 0) {
        const rejected = paths
          .filter((p) => !isMarkdownFilePath(p))
          .map((p) => baseName(p));
        await openRequestedFiles({ paths: mdPaths, rejected });
        return;
      }
      const importable = paths.find((p) => isImportablePath(p));
      if (importable) {
        await importDocument(importable);
      }
    }).catch(() => null);
    if (destroyed) {
      unlistenDrop?.();
    } else {
      unlistenFileDrop = unlistenDrop;
    }
    const settings = await getSettings().catch(() => null);
    if (settings) {
      currentSettings = { ...settings };
      applyTheme(settings.theme);
      editor.setSourceMode(Boolean(settings.sourceMode), false);
      editor.setCodeLineNumbers(Boolean(settings.codeLineNumbers), false);
      editor.setMathAutoNumber(Boolean(settings.mathAutoNumber), false);
      editor.setImageRootDir(settings.imageRootDir ?? null);
      editor.setFocusMode(Boolean(settings.focusMode), false);
      editor.setTypewriterMode(Boolean(settings.typewriterMode), false);
      editor.setAutoPairBrackets(settings.autoPairBrackets ?? true, false);
      editor.setAutoPairMarkdown(Boolean(settings.autoPairMarkdown), false);
    }
    await themeMenu.init();
    await sidebar.init();
    const entries = await listRecovery().catch(() => []);
    if (entries.length > 0) {
      pendingRecovery = entries[0];
      setRecoveryBannerVisible(true);
    } else {
      pendingRecovery = null;
      setRecoveryBannerVisible(false);
    }
    // #67: listen first, then take what the OS queued before we were ready —
    // the Rust side switches from queueing to emitting inside that call.
    const unlistenOpen = await onOpenFilesRequested(async (req) => {
      await openRequestedFiles(req);
    }).catch(() => null);
    if (destroyed) {
      unlistenOpen?.();
      return;
    }
    unlistenOpenFiles = unlistenOpen;
    const pendingOpen = await takePendingOpenFiles().catch(() => null);
    if (pendingOpen && !destroyed) {
      await openRequestedFiles(pendingOpen);
    }
  }

  function destroy(): void {
    destroyed = true;
    clearAutosaveTimer();
    unlistenFileDrop?.();
    unlistenFileDrop = null;
    unlistenOpenFiles?.();
    unlistenOpenFiles = null;
    clearInterval(recoveryInterval);
    unbindShortcuts();
    window.removeEventListener("keydown", onSidebarKeydown);
    window.removeEventListener("keydown", onImageRootKeydown);
    window.removeEventListener("keydown", onPandocKeydown);
    if (unlistenClose) {
      unlistenClose();
      unlistenClose = null;
    }
    restoreBtn?.removeEventListener("click", onRestoreClick);
    discardBtn?.removeEventListener("click", onDiscardClick);
    navWidgetEl.remove();
    themeMenu.destroy();
    wordCounter.destroy();
    sidebar.destroy();
    editor.destroy();
  }

  return {
    editor,
    sidebar,
    themeMenu,
    wordCounter,
    getDocId: () => docId,
    getCurrentPath: () => currentPath,
    getPendingRecovery: () => pendingRecovery,
    getStatusText: () => statusText,
    openDocument,
    openRequestedFiles,
    openFolder: (explicitPath?: string) => sidebar.openFolder(explicitPath),
    toggleSidebar: () => sidebar.toggleVisible(),
    saveDocument,
    saveDocumentAs,
    newDocument,
    pickImageRootDir,
    uploadDocumentImages,
    setImageRootDir,
    getImageRootDir: () => editor.getImageRootDir(),
    exportDocumentAs,
    isExportingPandoc: () => exportingPandoc,
    importDocument,
    exportDocumentPdf,
    isExportingPdf: () => exportingPdf,
    dropImageFiles,
    insertPastedImages,
    restoreRecovery,
    discardRecovery,
    flushBeforeClose,
    init,
    destroy,
  };
}

let activeApp: KalamosApp | null = null;

if (typeof document !== "undefined" && document.querySelector("#editor-container")) {
  activeApp = createKalamosApp(document);
  void activeApp.init();
}

export function getActiveApp(): KalamosApp | null {
  return activeApp;
}
