import "@fontsource/source-serif-4";
import "@fontsource/noto-serif-tc";
import "@fontsource/inter";
import "@fontsource/noto-sans-tc";
import "@fontsource/jetbrains-mono";
import "./styles/tokens.css";
import "./styles/themes/papyros.css";
import "./styles/themes/melan.css";
import "./styles/themes/nyx.css";
import "./styles/editor.css";

import type { StateEffect } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { createEditor, type DocSession, type KalamosEditor } from "./editor";
import {
  AUTO_PAIR_BRACKETS_MESSAGE,
  AUTO_PAIR_MARKDOWN_MESSAGE,
} from "./editor/auto-pair";
import {
  collectUploadTargetsInRange,
  uploadImagesInEditor,
} from "./editor/image-upload";
import {
  imageExtFromMime,
  insertImageMarkdown,
  isImageFilePath,
  readFileAsBase64,
} from "./editor/images";
import {
  bindWindowShortcuts,
  toggleEmphasis,
  toggleInlineCode,
  toggleLink,
  toggleStrikethrough,
  toggleStrong,
} from "./editor/keymaps";
import {
  jumpToHeadingSlug,
  resolveRelativeMarkdownPath,
  toggleBulletList,
  toggleOrderedList,
  toggleTaskList,
} from "./editor/lists";
import {
  insertCodeBlock,
  insertMathBlock,
  setHeadingLevel,
  toggleBlockquote,
} from "./editor/paragraph-commands";
import {
  findNextMatch,
  findPreviousMatch,
  lineColumnToRange,
  openFind,
  revealRange,
} from "./editor/search";
import { openInsertTableDialog } from "./editor/table-insert-dialog";
import { createWordCounter, type WordCounter } from "./editor/word-count-view";
import {
  FOCUS_MODE_MESSAGE,
  TYPEWRITER_MODE_MESSAGE,
} from "./editor/writing-modes";
import { pickExportFormat } from "./export/format-picker";
import { buildExportHtml } from "./export/html";
import {
  defaultExportPath,
  ensureExportExtension,
  exportedMessage,
  exportingMessage,
  formatInfo,
  importedMessage,
  importingMessage,
  isImportablePath,
  PANDOC_IMPORT_EXTENSIONS,
  type PandocFormat,
  pandocErrorMessage,
  pandocMissingMessage,
  prepareMarkdownForPandoc,
} from "./export/pandoc";
import {
  defaultPdfPath,
  documentTitle,
  ensurePdfExtension,
  exportedPdfMessage,
  exportingPdfMessage,
  pdfErrorMessage,
} from "./export/pdf";
import {
  buildRichTextHtml,
  copyRichTextErrorMessage,
  extractRichTextSource,
  formatCopyRichTextStatus,
} from "./export/rich-text";
import { sha256Hex } from "./external-changes/content-hash";
import { createExternalChangeBanner } from "./external-changes/external-change-banner";
import {
  applySaveFileResult,
  canAutosave,
  createExternalChangeState,
  type DiskSnapshot,
  type ExternalChangeState,
  type ExternalChangeStatus,
  evaluateDiskCheck,
  isPathAffectedByFsEvent,
  needsAttentionBeforeClose,
} from "./external-changes/external-change-state";
import {
  createHistoryModal,
  type HistoryModalController,
} from "./history/history-modal";
import { DEFAULT_UI_LOCALE, getUiLocale, initUiLocale, t } from "./i18n";
import {
  allowAssetDir,
  askSaveChanges,
  checkForUpdate,
  clearAllHistory,
  clearRecovery,
  DEFAULT_SETTINGS,
  exportPandoc,
  exportPdf,
  type FileSnapshot,
  formatErrorMessage,
  getActiveUiLocale,
  getHistoryStats,
  getSettings,
  importImage,
  importImageBytes,
  importPandoc,
  isAssetDirTooBroadError,
  listHistory,
  listMarkdownPaths,
  listRecovery,
  type MenuSyncState,
  type OpenFilesRequest,
  onFileDrop,
  onFsChanged,
  onMenuAction,
  onOpenFilesChanged,
  onOpenFilesRequested,
  onWindowCloseRequested,
  openFileSnapshot,
  openThemesDir,
  pandocStatus,
  pickImportPath,
  pickOpenFilePath,
  pickOpenFolderPath,
  pickSaveExportPath,
  pickSaveFilePath,
  pickSavePdfPath,
  quitApp,
  type RecoveryEntry,
  readHistoryVersion,
  restartApp,
  type Settings,
  saveChangesLabels,
  saveFileChecked,
  setSettings,
  setUiLocale,
  setWebviewZoom,
  setWindowTitle,
  statFileSnapshot,
  syncMenuState,
  takePendingOpenFiles,
  uploadImages,
  watchOpenFiles,
  writeClipboardHtml,
  writeRecovery,
} from "./ipc";
import {
  createMenuDispatcher,
  type MenuCommand,
  type MenuDispatcher,
} from "./menu/menu-dispatch";
import { IS_WINDOWS, shortcutLabel, toNativePath } from "./platform";
import {
  clampContentWidth,
  clampFontSize,
  clampHistoryMaxTotalMb,
  clampHistoryMaxVersions,
  createPreferences,
  type PreferencesController,
  type PreferencesPatch,
} from "./preferences/preferences";
import {
  createQuickOpen,
  type QuickOpenController,
} from "./quick-open/quick-open";
import {
  addRecentFile,
  recentMenuEntries,
  removeRecentFile,
  renameRecentFiles,
  sanitizeRecentFiles,
} from "./quick-open/recent-files";
import { createSidebar, type SidebarController } from "./sidebar/sidebar";
import { createTabBar, type TabBar } from "./tabs/tab-bar";
import {
  activeIndexAfterClose,
  baseNameOf,
  cycleIndex,
  isMarkdownPath,
  moveItem,
  nextUntitledNumber,
  type OpenMode,
  resolveOpenTarget,
  tabLabels,
  unsavedChangesMessage,
} from "./tabs/tab-model";
import {
  applySystemDarkTheme,
  applyThemeWithCustomCss,
  CUSTOM_THEME_STYLE_ID,
  createThemeMenu,
  normalizeSystemDarkTheme,
  type ThemeMenuController,
} from "./theme/theme-menu";
import { createUpdater, type UpdaterController } from "./updater/updater";

export const NAMED_AUTOSAVE_DELAY_MS = 1000;
export const UNTITLED_RECOVERY_INTERVAL_MS = 5000;
export const STARTUP_UPDATE_CHECK_DELAY_MS = 3000;

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
  if (
    typeof crypto !== "undefined" &&
    typeof crypto.randomUUID === "function"
  ) {
    return crypto.randomUUID();
  }
  return `doc-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/** #67: status line for unsupported files received from the OS. */
export function openWithStatusMessage(rejected: string[]): string {
  return rejected.length > 0
    ? t("app.openWithRejected", {
        files: rejected.join(t("app.pathSeparator")),
      })
    : "";
}

export const ZOOM_LEVELS = [
  0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3,
];

export const WHEEL_ZOOM_THRESHOLD_PX = 100;
export const WHEEL_DELTA_LINE_PX = 40;
export const WHEEL_DELTA_PAGE_PX = 800;
export const WHEEL_ZOOM_RESET_MS = 300;

export function normalizeWheelDeltaY(event: WheelEvent): number {
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
    return event.deltaY * WHEEL_DELTA_LINE_PX;
  }
  if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
    return event.deltaY * WHEEL_DELTA_PAGE_PX;
  }
  return event.deltaY;
}

/** #74 檢視 > 放大 / 縮小: the next zoom level in `direction` (+1 / -1). */
export function nextZoomLevel(current: number, direction: 1 | -1): number {
  if (direction > 0) {
    return (
      ZOOM_LEVELS.find((z) => z > current + 1e-6) ??
      ZOOM_LEVELS[ZOOM_LEVELS.length - 1]
    );
  }
  const smaller = ZOOM_LEVELS.filter((z) => z < current - 1e-6);
  return smaller.length > 0 ? smaller[smaller.length - 1] : ZOOM_LEVELS[0];
}

/** #81: one open document. The single EditorView shows the active tab's `doc`. */
export interface DocumentTab {
  id: string;
  /** Recovery file id. */
  docId: string;
  /** null = untitled. */
  path: string | null;
  /** 「未命名 n」 while untitled. */
  untitledNumber: number;
  /** EditorState + saved content + dirty flag. */
  doc: DocSession;
  scrollTop: number;
  scrollSnapshot: StateEffect<unknown> | null;
  autosaveTimer: ReturnType<typeof setTimeout> | null;
  /** #145: external modification / deletion state and disk baseline snapshot. */
  external: ExternalChangeState;
  saving: boolean;
  recheckAfterSave: boolean;
  checkingDisk: boolean;
  recheckPending: boolean;
}

export interface TabInfo {
  id: string;
  label: string;
  path: string | null;
  docId: string;
  dirty: boolean;
  active: boolean;
  externalStatus: ExternalChangeStatus;
}

export interface KalamosApp {
  editor: KalamosEditor;
  tabBar: TabBar;
  /** #81: open tabs in display order. */
  getTabs: () => TabInfo[];
  getActiveTabId: () => string;
  /** #81: Cmd+T / Cmd+N / ＋ — a new blank untitled tab. */
  newTab: () => boolean;
  /** #81: Cmd+W — false when cancelled at the unsaved prompt. */
  closeTab: (id?: string) => Promise<boolean>;
  activateTab: (id: string) => boolean;
  /** #81: Ctrl+Tab / Ctrl+Shift+Tab. */
  cycleTab: (delta: 1 | -1) => boolean;
  moveTab: (id: string, toIndex: number) => boolean;
  /** #74: Cmd+, preferences modal. */
  preferences: PreferencesController;
  /** #148: local version history browser modal. */
  historyModal: HistoryModalController;
  /** #148: open the version history browser for the active tab. */
  openVersionHistory: () => Promise<void>;
  /** #91: in-app auto-updater modal & background check controller. */
  updater: UpdaterController;
  /** #91: check for app updates (manual shows up-to-date/error feedback). */
  checkForUpdates: (options?: { manual?: boolean }) => Promise<void>;
  /** #104: Cmd+P Quick Open overlay. */
  quickOpen: QuickOpenController;
  /** #104: recently opened / saved files (newest first, up to 20). */
  getRecentFiles: () => string[];
  /** #104: clear recently opened files list. */
  clearRecentFiles: () => Promise<void>;
  /** #74: native menu action dispatcher (menu-action events land here). */
  menu: MenuDispatcher;
  getZoom: () => number;
  sidebar: SidebarController;
  themeMenu: ThemeMenuController;
  wordCounter: WordCounter;
  getDocId: () => string;
  getCurrentPath: () => string | null;
  getPendingRecovery: () => RecoveryEntry | null;
  getStatusText: () => string;
  /** Cmd+O: a new tab, or the tab the file is already open in, or the blank one. */
  openDocument: (explicitPath?: string) => Promise<boolean>;
  /** #81 B: open `path` per the tab rules ("tab" / "current" = sidebar click / "newTab" = Cmd+click). */
  openPath: (path: string, mode: OpenMode) => Promise<boolean>;
  /** #81 B: red button / ⌘Q — settles every tab's unsaved changes; false = stay open. */
  requestCloseWindow: () => Promise<boolean>;
  /** #81 B: ⌘Q. */
  quit: () => Promise<boolean>;
  /** #67 / #81 B: open what Finder / Dock / `open -a` handed over, each file in its own tab. */
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
  exportDocumentAs: (
    format?: PandocFormat,
    explicitPath?: string,
  ) => Promise<boolean>;
  isExportingPandoc: () => boolean;
  /** EX-03: import a DOCX / ODT / EPUB / LaTeX / HTML / MediaWiki file as a new untitled document (Cmd+Opt+I). */
  importDocument: (explicitPath?: string) => Promise<boolean>;
  /** EX-01: export the current document to PDF (Cmd+Shift+E). */
  exportDocumentPdf: (explicitPath?: string) => Promise<boolean>;
  isExportingPdf: () => boolean;
  /** #144: copy selection or whole document as rich text / HTML (Cmd+Opt+Shift+C). */
  copyRichText: () => Promise<boolean>;
  isCopyingRichText: () => boolean;
  dropImageFiles: (
    paths: string[],
    position?: { x: number; y: number },
  ) => Promise<boolean>;
  insertPastedImages: (files: File[], pos: number) => Promise<boolean>;
  restoreRecovery: () => Promise<boolean>;
  discardRecovery: () => Promise<boolean>;
  /** #145: check all open named tabs against their on-disk state. */
  checkExternalChanges: () => Promise<void>;
  flushBeforeClose: () => Promise<void>;
  init: () => Promise<void>;
  destroy: () => void;
}

export interface CreateKalamosAppOptions {
  /** Override whether the Windows-only top-left quick controls are shown (defaults to `IS_WINDOWS`). */
  showQuickButtons?: boolean;
  /** Override the background update check delay after startup (defaults to `STARTUP_UPDATE_CHECK_DELAY_MS`). */
  startupUpdateCheckDelayMs?: number;
}

export function createKalamosApp(
  root: Document | HTMLElement = document,
  options?: CreateKalamosAppOptions,
): KalamosApp {
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
  editorContainer.setAttribute("aria-label", t("app.editor"));
  sidebarEl.setAttribute("aria-label", t("app.sidebar"));
  const recoveryBanner = root.querySelector<HTMLElement>("#recovery-banner");
  const recoveryMessage = root.querySelector<HTMLElement>("#recovery-message");
  if (recoveryMessage) recoveryMessage.textContent = t("app.recoveryMessage");
  const restoreBtn = root.querySelector<HTMLButtonElement>(
    "#recovery-restore-btn",
  );
  const discardBtn = root.querySelector<HTMLButtonElement>(
    "#recovery-discard-btn",
  );
  if (restoreBtn) restoreBtn.textContent = t("app.restore");
  if (discardBtn) discardBtn.textContent = t("app.discard");
  const statusEl = root.querySelector<HTMLElement>("#status");

  let pendingRecovery: RecoveryEntry | null = null;
  let unlistenClose: (() => void) | null = null;
  let unlistenQuickOpenFs: (() => void) | null = null;
  let unlistenOpenFilesChanged: (() => void) | null = null;
  let watchedOpenFilesSignature = "";
  let statusText = "";
  let currentSettings: Settings = { ...DEFAULT_SETTINGS, recentFiles: [] };
  let recentFiles: string[] = [];
  let cachedFolderRoot: string | null = null;
  let cachedFolderPaths: string[] = [];
  let cachedFolderTruncated = false;
  let quickOpenCacheSeq = 0;

  function setStatus(message: string, isError = false): void {
    statusText = message;
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.dataset.error = isError && message.length > 0 ? "true" : "false";
    }
  }

  // Image paths, asset scope and the front-matter image root follow the active tab.
  let syncedDocPath: string | null = null;
  function syncDocumentPath(): void {
    const path = active.path;
    editor.setDocumentPath(path);
    if (syncedDocPath === path) return;
    syncedDocPath = path;
    if (path !== null) {
      void allowAssetDir(path).catch(() => null);
    }
  }

  function clearAutosaveTimer(tab: DocumentTab = active): void {
    if (tab.autosaveTimer !== null) {
      clearTimeout(tab.autosaveTimer);
      tab.autosaveTimer = null;
    }
  }

  function setRecoveryBannerVisible(visible: boolean): void {
    if (recoveryBanner) {
      recoveryBanner.dataset.visible = visible ? "true" : "false";
    }
  }

  async function persistFileToPath(
    targetPath: string,
    tab: DocumentTab,
    contentToSave: string,
    saveOptions?: { force?: boolean; isAutosave?: boolean },
  ): Promise<boolean> {
    const force = Boolean(saveOptions?.force);
    const isAutosave = Boolean(saveOptions?.isAutosave);
    const expectedHash =
      !force && tab.path === targetPath
        ? (tab.external.baseline?.hash ?? null)
        : null;
    tab.saving = true;
    try {
      const previousPath = tab.path;
      const result = await saveFileChecked(
        targetPath,
        contentToSave,
        expectedHash,
        { isAutosave },
      );
      const outcome = applySaveFileResult(tab.external, result);
      if (outcome.kind === "conflict" || outcome.kind === "missing") {
        if (tabs.includes(tab)) {
          tab.external = outcome.nextState;
          clearAutosaveTimer(tab);
          renderTabs();
          if (tab === active) renderExternalBanner();
        }
        return false;
      }
      setStatus("", false);
      if (tabs.includes(tab)) {
        tab.path = targetPath;
        tab.external = outcome.nextState;
        editor.markSessionClean(tab.doc, contentToSave);
        if (tab === active) {
          syncDocumentPath();
          renderExternalBanner();
        }
        renderTabs();
        syncWatchedOpenFiles();
        await clearRecovery(tab.docId).catch(() => null);
        if (
          tabs.includes(tab) &&
          editor.isSessionDirty(tab.doc) &&
          tab.path !== null &&
          canAutosave(tab.external)
        ) {
          scheduleNamedAutosave(tab);
        }
      }
      if (previousPath !== targetPath) {
        recordRecentFile(targetPath);
        if (
          cachedFolderRoot &&
          targetPath.startsWith(
            cachedFolderRoot === "/" ? "/" : `${cachedFolderRoot}/`,
          ) &&
          !cachedFolderPaths.includes(targetPath)
        ) {
          void refreshQuickOpenFolderCache(cachedFolderRoot);
        }
      }
      return true;
    } catch (err) {
      const open = tabs.includes(tab);
      if (open) {
        editor.markSessionDirty(tab.doc);
        renderTabs();
      }
      setStatus(formatErrorMessage(t("app.saveFailed"), err), true);
      const latestContent = open
        ? editor.getSessionContent(tab.doc)
        : contentToSave;
      await writeRecovery(tab.docId, latestContent, targetPath).catch(
        () => null,
      );
      return false;
    } finally {
      tab.saving = false;
      if (tab.recheckAfterSave) {
        tab.recheckAfterSave = false;
        if (!destroyed && tabs.includes(tab)) {
          void checkTabExternalChange(tab);
        }
      }
    }
  }

  /** #81: every tab keeps its own autosave timer, so a tab switched away from still saves. */
  function scheduleNamedAutosave(tab: DocumentTab = active): void {
    clearAutosaveTimer(tab);
    if (tab.path === null) return;
    // #145: pause autosave while a tab has an unresolved external conflict or missing file.
    if (!canAutosave(tab.external)) return;
    // #74 preference: autosave off = only explicit saves (and switching / closing) write the file.
    if (currentSettings.autoSave === false) return;
    const targetPath = tab.path;
    tab.autosaveTimer = setTimeout(() => {
      tab.autosaveTimer = null;
      if (
        tabs.includes(tab) &&
        tab.path === targetPath &&
        canAutosave(tab.external) &&
        editor.isSessionDirty(tab.doc)
      ) {
        void persistFileToPath(
          targetPath,
          tab,
          editor.getSessionContent(tab.doc),
          { isAutosave: true },
        );
      }
    }, NAMED_AUTOSAVE_DELAY_MS);
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
      recentFiles: [...recentFiles],
      ...patch,
    };
    scheduleMenuSync();
    await setSettings(currentSettings).catch(() => null);
  }

  async function applyRecentFiles(
    next: string[],
    persist = true,
  ): Promise<void> {
    recentFiles = sanitizeRecentFiles(next);
    currentSettings = { ...currentSettings, recentFiles: [...recentFiles] };
    quickOpen.setRecentFiles(recentFiles);
    scheduleMenuSync();
    if (persist) {
      const existing = await getSettings().catch(() => null);
      await setSettings({
        ...(existing ?? currentSettings),
        recentFiles: [...recentFiles],
      }).catch(() => null);
    }
  }

  function recordRecentFile(path: string): void {
    const next = addRecentFile(recentFiles, path);
    if (
      next.length === recentFiles.length &&
      next.every((p, i) => p === recentFiles[i])
    ) {
      return;
    }
    void applyRecentFiles(next, true);
  }

  async function clearRecentFiles(): Promise<void> {
    await applyRecentFiles([], true);
  }

  async function refreshQuickOpenFolderCache(
    folder: string | null,
  ): Promise<void> {
    const seq = ++quickOpenCacheSeq;
    if (!folder) {
      cachedFolderRoot = null;
      cachedFolderPaths = [];
      cachedFolderTruncated = false;
      quickOpen.setFolderPaths(null, [], false);
      return;
    }
    try {
      const result = await listMarkdownPaths(folder);
      if (destroyed || seq !== quickOpenCacheSeq) return;
      cachedFolderRoot = folder;
      cachedFolderPaths = result.paths;
      cachedFolderTruncated = result.truncated;
      quickOpen.setFolderPaths(folder, result.paths, result.truncated);
    } catch {
      if (destroyed || seq !== quickOpenCacheSeq) return;
      cachedFolderRoot = folder;
      cachedFolderPaths = [];
      cachedFolderTruncated = false;
      quickOpen.setFolderPaths(folder, [], false);
    }
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
    onUserChange: (_content, info) => {
      if (
        active.path !== null &&
        !info?.skipAutosave &&
        canAutosave(active.external)
      ) {
        scheduleNamedAutosave(active);
      }
      renderTabs();
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
      if (active.path === null) {
        setStatus(t("app.saveBeforeRelativeLink"), true);
        return;
      }
      const targetPath = resolveRelativeMarkdownPath(active.path, relativePath);
      // Like a click in the sidebar: this tab, or a new one when it has unsaved changes.
      const opened = await openPath(targetPath, "current");
      if (opened && slug) {
        jumpToHeadingSlug(view, slug);
      }
    },
    onPasteImages: async (files, view) => {
      await insertPastedImages(files, view.state.selection.main.head);
    },
    onImageRootTooBroad: (root) => {
      setStatus(t("app.imageRootTooBroad", { path: toNativePath(root) }), true);
    },
  });

  // ---- #81: document tabs ----

  let tabSeq = 0;
  function makeTab(
    doc: DocSession,
    path: string | null,
    docId = generateDocId(),
    baseline: DiskSnapshot | null = null,
  ): DocumentTab {
    return {
      id: `tab-${++tabSeq}`,
      docId,
      path,
      untitledNumber:
        path === null ? nextUntitledNumber(untitledNumbersInUse()) : 0,
      doc,
      scrollTop: 0,
      scrollSnapshot: null,
      autosaveTimer: null,
      external: createExternalChangeState(baseline),
      saving: false,
      recheckAfterSave: false,
      checkingDisk: false,
      recheckPending: false,
    };
  }

  const tabs: DocumentTab[] = [];
  function untitledNumbersInUse(): number[] {
    return tabs.filter((t) => t.path === null).map((t) => t.untitledNumber);
  }

  let active: DocumentTab = makeTab(editor.getSession(), null);
  tabs.push(active);

  const tabBar = createTabBar({
    parent: editorContainer.parentElement ?? document.body,
    before: editorContainer.parentElement ? editorContainer : null,
    onSelect: (id) => {
      activateTab(id);
    },
    onClose: (id) => {
      void closeTab(id);
    },
    onNew: () => {
      newTab();
    },
    onReorder: (id, toIndex) => {
      moveTab(id, toIndex);
    },
  });

  // ---- #145: external file modification / deletion banner & watcher ----

  const externalBanner = createExternalChangeBanner({
    parent: editorContainer.parentElement ?? document.body,
    before: editorContainer.parentElement ? editorContainer : null,
    onKeepMine: async () => {
      const tab = active;
      if (tab.path === null || tab.external.status !== "conflict") return;
      const saved = await persistFileToPath(
        tab.path,
        tab,
        editor.getSessionContent(tab.doc),
        { force: true },
      );
      if (saved && tab === active) {
        setStatus(t("externalChange.keptMine"), false);
      }
    },
    onLoadDisk: async () => {
      const tab = active;
      const targetPath = tab.path;
      if (targetPath === null) return;
      try {
        const snap = await openFileSnapshot(targetPath);
        if (destroyed || !tabs.includes(tab) || tab.path !== targetPath) return;
        await reloadTabFromDisk(tab, snap, tab === active);
      } catch (err) {
        const kind = (err as { kind?: string } | null)?.kind;
        if (kind === "NotFound") {
          if (tabs.includes(tab) && tab.path === targetPath) {
            tab.external = {
              status: "missing",
              baseline: tab.external.baseline,
              diskSnapshot: null,
            };
            clearAutosaveTimer(tab);
            renderTabs();
            if (tab === active) renderExternalBanner();
          }
          return;
        }
        setStatus(formatErrorMessage(t("app.openFailed"), err), true);
      }
    },
    onSaveAs: async () => {
      await saveDocumentAs();
    },
    onRecreate: async () => {
      const tab = active;
      if (tab.path === null || tab.external.status !== "missing") return;
      const saved = await persistFileToPath(
        tab.path,
        tab,
        editor.getSessionContent(tab.doc),
        { force: true },
      );
      if (saved && tab === active) {
        setStatus(t("externalChange.recreated"), false);
      }
    },
  });

  function renderExternalBanner(): void {
    if (active.path === null || active.external.status === "synced") {
      externalBanner.render({ kind: "hidden" });
      return;
    }
    externalBanner.render({
      kind: active.external.status,
      fileName: baseNameOf(active.path),
    });
  }

  function syncWatchedOpenFiles(): void {
    if (destroyed) return;
    const unique = Array.from(
      new Set(
        tabs.map((tab) => tab.path).filter((p): p is string => p !== null),
      ),
    ).sort();
    const sig = JSON.stringify(unique);
    if (sig === watchedOpenFilesSignature) return;
    watchedOpenFilesSignature = sig;
    void watchOpenFiles(unique).catch(() => null);
  }

  async function reloadTabFromDisk(
    tab: DocumentTab,
    snap: FileSnapshot,
    notifyStatus: boolean,
  ): Promise<void> {
    clearAutosaveTimer(tab);
    tab.external = createExternalChangeState({
      hash: snap.hash,
      mtimeMs: snap.mtimeMs,
      size: snap.size,
    });
    if (tab !== active) {
      tab.scrollSnapshot = null;
    }
    editor.reloadSession(tab.doc, snap.content);
    await clearRecovery(tab.docId).catch(() => null);
    renderTabs();
    if (tab === active) {
      renderExternalBanner();
      sidebar.outline.refreshNow();
      wordCounter.flush();
      if (notifyStatus) {
        setStatus(t("externalChange.reloaded"), false);
      }
    }
  }

  async function checkTabExternalChange(tab: DocumentTab): Promise<void> {
    if (destroyed || !tabs.includes(tab) || tab.path === null) return;
    if (tab.saving) {
      tab.recheckAfterSave = true;
      return;
    }
    if (tab.checkingDisk) {
      tab.recheckPending = true;
      return;
    }
    tab.checkingDisk = true;
    try {
      const targetPath = tab.path;
      const disk = await statFileSnapshot(targetPath).catch(() => null);
      if (
        !disk ||
        destroyed ||
        !tabs.includes(tab) ||
        tab.path !== targetPath ||
        tab.saving
      ) {
        return;
      }
      const localDirty = editor.isSessionDirty(tab.doc);
      const localContent = editor.getSessionContent(tab.doc);
      const decision = evaluateDiskCheck({
        state: tab.external,
        localDirty,
        localContentHash: sha256Hex(localContent),
        disk,
      });

      if (decision.kind === "noop") {
        tab.external = decision.nextState;
        return;
      }
      if (decision.kind === "resolved") {
        tab.external = decision.nextState;
        if (decision.markClean) {
          editor.markSessionClean(tab.doc, localContent);
        } else if (
          editor.isSessionDirty(tab.doc) &&
          canAutosave(tab.external)
        ) {
          scheduleNamedAutosave(tab);
        }
        renderTabs();
        if (tab === active) renderExternalBanner();
        return;
      }
      if (decision.kind === "conflict" || decision.kind === "missing") {
        tab.external = decision.nextState;
        clearAutosaveTimer(tab);
        renderTabs();
        if (tab === active) renderExternalBanner();
        return;
      }
      if (decision.kind === "autoReload") {
        let snap: FileSnapshot;
        try {
          snap = await openFileSnapshot(targetPath);
        } catch (err) {
          const kind = (err as { kind?: string } | null)?.kind;
          if (
            kind === "NotFound" &&
            !destroyed &&
            tabs.includes(tab) &&
            tab.path === targetPath
          ) {
            tab.external = {
              status: "missing",
              baseline: tab.external.baseline,
              diskSnapshot: null,
            };
            clearAutosaveTimer(tab);
            renderTabs();
            if (tab === active) renderExternalBanner();
          }
          return;
        }
        if (
          destroyed ||
          !tabs.includes(tab) ||
          tab.path !== targetPath ||
          tab.saving
        ) {
          return;
        }
        // Guard against user typing while openFileSnapshot was in flight.
        if (editor.isSessionDirty(tab.doc)) {
          tab.external = {
            status: "conflict",
            baseline: tab.external.baseline,
            diskSnapshot: {
              hash: snap.hash,
              mtimeMs: snap.mtimeMs,
              size: snap.size,
            },
          };
          clearAutosaveTimer(tab);
          renderTabs();
          if (tab === active) renderExternalBanner();
          return;
        }
        await reloadTabFromDisk(tab, snap, tab === active);
      }
    } finally {
      tab.checkingDisk = false;
      if (tab.recheckPending) {
        tab.recheckPending = false;
        if (!destroyed && tabs.includes(tab)) {
          void checkTabExternalChange(tab);
        }
      }
    }
  }

  async function checkExternalChangesForPaths(
    changedPaths: readonly string[],
  ): Promise<void> {
    if (destroyed || changedPaths.length === 0) return;
    const targets = tabs.filter((tab) =>
      isPathAffectedByFsEvent(tab.path, changedPaths, IS_WINDOWS),
    );
    await Promise.all(targets.map((tab) => checkTabExternalChange(tab)));
  }

  async function checkAllOpenTabsExternalChanges(): Promise<void> {
    if (destroyed) return;
    const targets = tabs.filter((tab) => tab.path !== null);
    await Promise.all(targets.map((tab) => checkTabExternalChange(tab)));
  }

  const onWindowFocusCheck = () => {
    void checkAllOpenTabsExternalChanges();
  };
  const onVisibilityCheck = () => {
    if (!document.hidden) {
      void checkAllOpenTabsExternalChanges();
    }
  };

  let lastWindowTitle = "";
  function currentLabels(): Map<string, string> {
    return tabLabels(tabs);
  }

  function renderTabs(): void {
    const labels = currentLabels();
    tabBar.render(
      tabs.map((tab) => {
        const baseTitle = tab.path
          ? toNativePath(tab.path)
          : (labels.get(tab.id) ?? "");
        const title =
          tab.external.status === "conflict"
            ? `${baseTitle} — ${t("externalChange.tabBadgeConflict")}`
            : tab.external.status === "missing"
              ? `${baseTitle} — ${t("externalChange.tabBadgeMissing")}`
              : baseTitle;
        return {
          id: tab.id,
          label: labels.get(tab.id) ?? "",
          title,
          dirty: editor.isSessionDirty(tab.doc),
          active: tab === active,
          externalStatus: tab.external.status,
        };
      }),
    );
    const title = labels.get(active.id) ?? "Kalamos";
    if (title !== lastWindowTitle) {
      lastWindowTitle = title;
      void setWindowTitle(title).catch(() => null);
    }
  }

  function findTab(id: string | undefined): DocumentTab | undefined {
    return id === undefined ? active : tabs.find((t) => t.id === id);
  }

  /** Shows `target` in the editor; everything that follows the current document updates with it. */
  function showTab(target: DocumentTab): void {
    const { view } = editor;
    if (target !== active && tabs.includes(active)) {
      active.scrollTop = view.scrollDOM.scrollTop;
      active.scrollSnapshot = view.scrollSnapshot();
    }
    editor.switchSession(target.doc);
    active = target;
    syncDocumentPath();
    view.scrollDOM.scrollTop = target.scrollTop;
    if (target.scrollSnapshot)
      view.dispatch({ effects: target.scrollSnapshot });
    sidebar.setActiveFile(target.path);
    sidebar.outline.refreshNow();
    wordCounter.flush();
    renderTabs();
    renderExternalBanner();
    scheduleMenuSync();
    if (
      !preferences.isOpen() &&
      !quickOpen.isOpen() &&
      !updater.isOpen() &&
      !historyModal.isOpen()
    )
      view.focus();
  }

  function activateTab(id: string): boolean {
    const tab = findTab(id);
    if (!tab) return false;
    if (tab !== active) showTab(tab);
    return true;
  }

  function newTab(): boolean {
    const tab = makeTab(editor.createSession(""), null);
    tabs.push(tab);
    showTab(tab);
    setStatus("", false);
    return true;
  }

  /** Puts a different document in the active tab's place (open / import / restore in place). */
  function replaceActiveTab(next: DocumentTab): void {
    clearAutosaveTimer(active);
    const index = tabs.indexOf(active);
    tabs[index] = next;
    if (next.path === null) {
      // The replaced tab's number is free again.
      next.untitledNumber = nextUntitledNumber(
        tabs
          .filter((t) => t !== next && t.path === null)
          .map((t) => t.untitledNumber),
      );
    }
    showTab(next);
    syncWatchedOpenFiles();
  }

  /** Shows a newly made tab: in place of a blank untitled active tab, else as a new tab. */
  function placeNewTab(tab: DocumentTab): void {
    if (isPristine(active)) {
      replaceActiveTab(tab);
    } else {
      tabs.push(tab);
      showTab(tab);
    }
  }

  function isPristine(tab: DocumentTab): boolean {
    return (
      tab.path === null &&
      !editor.isSessionDirty(tab.doc) &&
      editor.getSessionContent(tab.doc).length === 0
    );
  }

  function cycleTab(delta: 1 | -1): boolean {
    if (tabs.length < 2) return false;
    showTab(tabs[cycleIndex(tabs.indexOf(active), tabs.length, delta)]);
    return true;
  }

  function moveTab(id: string, toIndex: number): boolean {
    const from = tabs.findIndex((t) => t.id === id);
    if (from < 0) return false;
    const reordered = moveItem(tabs, from, toIndex);
    tabs.splice(0, tabs.length, ...reordered);
    renderTabs();
    return true;
  }

  /** Unsaved changes in a tab about to close: true = go ahead and close it. */
  async function settleBeforeClose(tab: DocumentTab): Promise<boolean> {
    const localDirty = editor.isSessionDirty(tab.doc);
    if (!needsAttentionBeforeClose(tab.external, localDirty)) return true;
    // Autosave is on: a synced named file is simply written, as when switching documents.
    if (
      tab.path !== null &&
      currentSettings.autoSave !== false &&
      canAutosave(tab.external)
    ) {
      clearAutosaveTimer(tab);
      const saved = await persistFileToPath(
        tab.path,
        tab,
        editor.getSessionContent(tab.doc),
      );
      if (!saved && tab !== active && tabs.includes(tab)) showTab(tab);
      return saved;
    }
    // Show the tab being asked about.
    if (tab !== active) showTab(tab);
    const label = currentLabels().get(tab.id) ?? "";
    const choice = await askSaveChanges(t("app.confirmCloseTab", { label }));
    if (choice === "cancel" || !tabs.includes(tab)) return false;
    if (choice === "discard") {
      clearAutosaveTimer(tab);
      await clearRecovery(tab.docId).catch(() => null);
      return true;
    }
    if (tab.path !== null && tab.external.status !== "missing") {
      clearAutosaveTimer(tab);
      return persistFileToPath(
        tab.path,
        tab,
        editor.getSessionContent(tab.doc),
      );
    }
    if (tab !== active) showTab(tab);
    return saveDocumentAs();
  }

  let closing = false;
  async function closeTab(id?: string): Promise<boolean> {
    if (closing) return false;
    const tab = findTab(id);
    if (!tab) return false;
    closing = true;
    try {
      if (!(await settleBeforeClose(tab))) return false;
      const index = tabs.indexOf(tab);
      if (index < 0) return true;
      clearAutosaveTimer(tab);
      if (tabs.length === 1) {
        // The last tab: the window stays, with a blank untitled tab.
        tabs.splice(0, 1);
        const blank = makeTab(editor.createSession(""), null);
        tabs.push(blank);
        showTab(blank);
      } else {
        const activeIndex = tabs.indexOf(active);
        const count = tabs.length;
        tabs.splice(index, 1);
        if (tab === active) {
          showTab(tabs[activeIndexAfterClose(index, activeIndex, count)]);
        } else {
          renderTabs();
        }
      }
      setStatus("", false);
      syncWatchedOpenFiles();
      return true;
    } finally {
      closing = false;
    }
  }

  // Cmd+T new tab, Cmd+W close tab, Ctrl+Tab / Ctrl+Shift+Tab next / previous tab.
  const onTabKeydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      preferences.isOpen() ||
      quickOpen.isOpen() ||
      updater.isOpen() ||
      historyModal.isOpen()
    )
      return;
    if (
      event.key === "Tab" &&
      event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      event.preventDefault();
      cycleTab(event.shiftKey ? -1 : 1);
      return;
    }
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
      return;
    if (event.metaKey && event.ctrlKey) return;
    if (event.code === "KeyT" || event.key.toLowerCase() === "t") {
      event.preventDefault();
      newTab();
    } else if (event.code === "KeyW" || event.key.toLowerCase() === "w") {
      event.preventDefault();
      void closeTab();
    }
  };
  window.addEventListener("keydown", onTabKeydown);

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

  const quickOpen = createQuickOpen({
    parent: editorContainer.parentElement ?? document.body,
    onOpenFile: (path, mode) => openPath(path, mode),
    onRestoreFocus: (prev) => {
      if (
        prev &&
        prev.isConnected &&
        prev.classList.contains("k-table-cell-content") &&
        editor.view.contentDOM.contains(prev)
      ) {
        prev.focus();
      } else {
        editor.view.focus();
      }
    },
  });

  const unbindShortcuts = bindWindowShortcuts(window, windowHandlers, () =>
    preferences.isOpen() ||
    quickOpen.isOpen() ||
    updater.isOpen() ||
    historyModal.isOpen()
      ? null
      : editor.view,
  );

  const sidebar = createSidebar({
    element: sidebarEl,
    editorView: editor.view,
    onSelectFile: async (path, selectOptions) => {
      // #81 B: click = this tab (a new one when it has unsaved changes); Cmd+click = a new tab.
      await openPath(path, selectOptions?.newTab ? "newTab" : "current");
    },
    onOpenSearchHit: async (hit) => {
      // #73 B / #81 B: an open document is switched to, never reopened.
      if (!(await openPath(hit.path, "tab"))) return;
      const range = lineColumnToRange(
        editor.view.state,
        hit.line,
        hit.column,
        hit.length,
      );
      revealRange(editor.view, range.from, range.to);
    },
    onPathRenamed: (from, to) => {
      // Every open tab follows the rename, so a background autosave never recreates the old path.
      for (const tab of tabs) {
        if (tab.path === null) continue;
        let renamed: string | null = null;
        if (tab.path === from) renamed = to;
        else if (tab.path.startsWith(`${from}/`))
          renamed = `${to}${tab.path.slice(from.length)}`;
        if (renamed === null) continue;
        tab.path = renamed;
        if (tab === active) {
          syncDocumentPath();
          sidebar.setActiveFile(tab.path);
        }
        if (editor.isSessionDirty(tab.doc)) {
          scheduleNamedAutosave(tab);
        }
      }
      const renamedRecent = renameRecentFiles(recentFiles, from, to);
      if (
        renamedRecent.length !== recentFiles.length ||
        renamedRecent.some((p, i) => p !== recentFiles[i])
      ) {
        void applyRecentFiles(renamedRecent, true);
      }
      renderTabs();
      syncWatchedOpenFiles();
    },
    onPathTrashed: (trashedPath) => {
      for (const tab of tabs) {
        if (tab.path === null) continue;
        if (tab.path !== trashedPath && !tab.path.startsWith(`${trashedPath}/`))
          continue;
        clearAutosaveTimer(tab);
        tab.path = null;
        tab.external = createExternalChangeState(null);
        tab.untitledNumber = nextUntitledNumber(untitledNumbersInUse());
        editor.markSessionDirty(tab.doc);
        if (tab === active) {
          syncDocumentPath();
          renderExternalBanner();
          sidebar.setActiveFile(null);
          setStatus(
            t(IS_WINDOWS ? "app.fileTrashedWindows" : "app.fileTrashed"),
            false,
          );
        }
      }
      const prunedRecent = removeRecentFile(recentFiles, trashedPath);
      if (prunedRecent.length !== recentFiles.length) {
        void applyRecentFiles(prunedRecent, true);
      }
      renderTabs();
      syncWatchedOpenFiles();
    },
    onError: (prefix, err) => {
      setStatus(formatErrorMessage(prefix, err), true);
    },
    onLayoutChange: () => scheduleMenuSync(),
    onFolderChange: (folder) => {
      void refreshQuickOpenFolderCache(folder);
    },
    onFolderMutated: (folder) => {
      void refreshQuickOpenFolderCache(folder);
    },
  });

  const themeMenu = createThemeMenu({
    parent: editorContainer.parentElement ?? document.body,
    onThemeChange: (themeId) => {
      currentSettings = {
        ...currentSettings,
        theme: themeId,
      };
      scheduleMenuSync();
    },
    onError: (prefix, err) => {
      setStatus(formatErrorMessage(prefix, err), true);
    },
  });

  // ---- #74: layout preferences, zoom, preferences modal, native menu ----

  function applyLayoutSettings(): void {
    if (typeof document === "undefined") return;
    const style = document.documentElement.style;
    style.setProperty(
      "--k-font-size",
      `${clampFontSize(currentSettings.fontSize ?? 17)}px`,
    );
    style.setProperty(
      "--k-max-width",
      `${clampContentWidth(currentSettings.contentWidth ?? 720)}px`,
    );
    editor.view.requestMeasure();
  }

  let zoom = 1;
  let wheelZoomDelta = 0;
  let lastZoomWheelAt = Number.NEGATIVE_INFINITY;
  function setZoom(next: number): void {
    zoom = next;
    wheelZoomDelta = 0;
    void setWebviewZoom(next).catch(() => null);
    setStatus(t("app.zoom", { percent: Math.round(next * 100) }), false);
  }

  // #107: Both macOS and Windows intentionally use Ctrl (never Cmd on macOS)
  // for wheel zoom. On macOS, trackpad pinch emits WebKit gesture* events
  // rather than synthetic ctrl+wheel, so pinch is unaffected here. On Windows,
  // precision touchpad pinch synthesizes dense, small-delta ctrl+wheel events
  // in Chromium/WebView2 (and trackpads / high-resolution mice emit many small
  // wheel events per gesture), so we normalize deltaMode to pixels and
  // accumulate until WHEEL_ZOOM_THRESHOLD_PX (~1 notched mouse wheel click)
  // before stepping one zoom level.
  function onZoomWheel(event: Event): void {
    if (
      !(event instanceof WheelEvent) ||
      !event.cancelable ||
      event.defaultPrevented ||
      !event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey ||
      event.deltaY === 0
    ) {
      return;
    }
    event.preventDefault();

    const now = Date.now();
    if (now - lastZoomWheelAt >= WHEEL_ZOOM_RESET_MS) {
      wheelZoomDelta = 0;
    }
    lastZoomWheelAt = now;

    const delta = normalizeWheelDeltaY(event);
    if (
      wheelZoomDelta !== 0 &&
      Math.sign(delta) !== Math.sign(wheelZoomDelta)
    ) {
      wheelZoomDelta = 0;
    }
    wheelZoomDelta += delta;

    if (Math.abs(wheelZoomDelta) < WHEEL_ZOOM_THRESHOLD_PX) {
      return;
    }
    const direction: 1 | -1 = wheelZoomDelta < 0 ? 1 : -1;
    wheelZoomDelta = 0;
    const next = nextZoomLevel(zoom, direction);
    if (next !== zoom) setZoom(next);
  }
  root.addEventListener("wheel", onZoomWheel, { passive: false });

  const preferences = createPreferences({
    getValues: () => ({
      uiLocale: currentSettings.uiLocale ?? getUiLocale(),
      startupBehavior: currentSettings.startupBehavior ?? "restoreFolder",
      autoSave: currentSettings.autoSave ?? true,
      autoCheckUpdates: currentSettings.autoCheckUpdates ?? true,
      historyEnabled: currentSettings.historyEnabled ?? true,
      historyMaxVersions: clampHistoryMaxVersions(
        currentSettings.historyMaxVersions ?? 50,
      ),
      historyMaxTotalMb: clampHistoryMaxTotalMb(
        currentSettings.historyMaxTotalMb ?? 200,
      ),
      fontSize: clampFontSize(currentSettings.fontSize ?? 17),
      contentWidth: clampContentWidth(currentSettings.contentWidth ?? 720),
      autoPairBrackets: editor.isAutoPairBrackets(),
      autoPairMarkdown: editor.isAutoPairMarkdown(),
      codeLineNumbers: editor.isCodeLineNumbers(),
      mathAutoNumber: editor.isMathAutoNumber(),
      theme: themeMenu.getCurrentTheme(),
      systemDarkTheme: normalizeSystemDarkTheme(
        currentSettings.systemDarkTheme,
      ),
      imageRootDir: editor.getImageRootDir(),
      uploadOnInsert: Boolean(currentSettings.uploadOnInsert),
      uploadCommand: currentSettings.uploadCommand ?? null,
      uploadArgs: currentSettings.uploadArgs ?? [],
    }),
    getThemes: () =>
      themeMenu
        .getAvailableOptions()
        .map((o) => ({ id: o.id, label: o.label })),
    refresh: async () => {
      await themeMenu.refreshThemes();
      await refreshUploadSettings();
      scheduleMenuSync();
    },
    applyChange: applyPreferencesChange,
    saveUiLocale: async (locale) => {
      await setUiLocale(locale);
      currentSettings = { ...currentSettings, uiLocale: locale };
    },
    restartApp: restartAfterLanguageChange,
    pickImageRootDir: () => pickImageRootDir(),
    clearImageRootDir: () => setImageRootDir(null),
    openThemesDir: async () => {
      try {
        await openThemesDir();
      } catch (err) {
        setStatus(
          formatErrorMessage(t("app.openThemeFolderFailed"), err),
          true,
        );
      }
    },
    getHistoryStats: () => getHistoryStats(),
    clearAllHistory: () => clearAllHistory(),
  });

  const historyModal = createHistoryModal({
    getCurrentDocument: () => ({
      path: active.path,
      label: currentLabels().get(active.id) ?? "",
      content: editor.getContent(),
    }),
    isHistoryEnabled: () => currentSettings.historyEnabled !== false,
    listVersions: (path) => listHistory(path),
    readVersion: (path, versionId) => readHistoryVersion(path, versionId),
    restoreContent: (content) => {
      clearAutosaveTimer(active);
      editor.replaceContentUndoable(content, { skipAutosave: true });
      sidebar.outline.refreshNow();
      wordCounter.flush();
      renderTabs();
      setStatus(shortcutLabel(t("app.historyRestored")), false);
      editor.view.focus();
    },
    onRestoreFocus: () => {
      editor.view.focus();
    },
  });

  const updater = createUpdater({
    checkForUpdate,
    prepareForRestart: async () => {
      if (!(await requestCloseWindow())) return false;
      for (const tab of tabs) clearAutosaveTimer(tab);
      return true;
    },
    restartApp,
    restoreRecoveryAfterFailedInstall: restoreDirtyRecoveries,
  });

  async function applyPreferencesChange(
    patch: PreferencesPatch,
  ): Promise<void> {
    if (patch.theme !== undefined)
      await themeMenu.selectTheme(patch.theme, true);
    if (patch.autoPairBrackets !== undefined)
      editor.setAutoPairBrackets(patch.autoPairBrackets, true);
    if (patch.autoPairMarkdown !== undefined)
      editor.setAutoPairMarkdown(patch.autoPairMarkdown, true);
    if (patch.codeLineNumbers !== undefined)
      editor.setCodeLineNumbers(patch.codeLineNumbers, true);
    if (patch.mathAutoNumber !== undefined)
      editor.setMathAutoNumber(patch.mathAutoNumber, true);
    const plain: Partial<Settings> = {};
    if (patch.systemDarkTheme !== undefined)
      plain.systemDarkTheme = normalizeSystemDarkTheme(patch.systemDarkTheme);
    if (patch.startupBehavior !== undefined)
      plain.startupBehavior = patch.startupBehavior;
    if (patch.autoSave !== undefined) plain.autoSave = patch.autoSave;
    if (patch.autoCheckUpdates !== undefined)
      plain.autoCheckUpdates = patch.autoCheckUpdates;
    if (patch.historyEnabled !== undefined)
      plain.historyEnabled = patch.historyEnabled;
    if (patch.historyMaxVersions !== undefined)
      plain.historyMaxVersions = clampHistoryMaxVersions(
        patch.historyMaxVersions,
      );
    if (patch.historyMaxTotalMb !== undefined)
      plain.historyMaxTotalMb = clampHistoryMaxTotalMb(patch.historyMaxTotalMb);
    if (patch.fontSize !== undefined)
      plain.fontSize = clampFontSize(patch.fontSize);
    if (patch.contentWidth !== undefined)
      plain.contentWidth = clampContentWidth(patch.contentWidth);
    if (patch.uploadOnInsert !== undefined)
      plain.uploadOnInsert = patch.uploadOnInsert;
    if (Object.keys(plain).length > 0) {
      currentSettings = { ...currentSettings, ...plain };
      if (plain.systemDarkTheme !== undefined)
        applySystemDarkTheme(plain.systemDarkTheme);
      if (plain.fontSize !== undefined || plain.contentWidth !== undefined)
        applyLayoutSettings();
      for (const tab of tabs) {
        if (plain.autoSave === true && editor.isSessionDirty(tab.doc))
          scheduleNamedAutosave(tab);
        if (plain.autoSave === false) clearAutosaveTimer(tab);
      }
      await persistEditorSettingPatch(plain);
    }
  }

  function computeMenuState(): MenuSyncState {
    const sidebarVisible = sidebar.isVisible();
    return {
      checks: {
        "view.sourceMode": editor.isSourceMode(),
        "view.sidebar": sidebarVisible,
        "view.outline": sidebarVisible && sidebar.getTab() === "outline",
        "view.focusMode": editor.isFocusMode(),
        "view.typewriterMode": editor.isTypewriterMode(),
        "view.codeLineNumbers": editor.isCodeLineNumbers(),
        "view.mathAutoNumber": editor.isMathAutoNumber(),
      },
      theme: themeMenu.getCurrentTheme(),
      themes: themeMenu
        .getAvailableOptions()
        .map((o) => ({ id: o.id, label: o.label })),
      recentFiles: recentMenuEntries(recentFiles),
    };
  }

  let lastMenuStateJson = "";
  let menuSyncTimer: ReturnType<typeof setTimeout> | null = null;
  /** Coalesces state changes into one sync_menu_state call; `force` resends unchanged state. */
  function scheduleMenuSync(force = false): void {
    if (force) lastMenuStateJson = "";
    if (menuSyncTimer !== null) return;
    menuSyncTimer = setTimeout(() => {
      menuSyncTimer = null;
      if (destroyed) return;
      preferences.sync();
      const state = computeMenuState();
      const json = JSON.stringify(state);
      if (json === lastMenuStateJson) return;
      lastMenuStateJson = json;
      void syncMenuState(state).catch(() => null);
    }, 0);
  }

  /** Editing command: runs on the editor and gives it focus unless focus is already inside (e.g. a table cell). */
  const onEditor =
    (run: (view: EditorView) => unknown): MenuCommand =>
    () => {
      const { view } = editor;
      const result = run(view);
      if (!view.dom.contains(document.activeElement)) view.focus();
      return result;
    };

  async function toggleOutline(): Promise<void> {
    if (sidebar.isVisible() && sidebar.getTab() === "outline") {
      await sidebar.setVisible(false);
      return;
    }
    await sidebar.setTab("outline");
    if (!sidebar.isVisible()) await sidebar.setVisible(true);
  }

  // Same handlers as the keyboard shortcuts (keymaps.ts / the keydown listeners below).
  const menuCommands: Record<string, MenuCommand> = {
    "app.checkForUpdates": () => {
      quickOpen.close(false);
      return updater.checkForUpdates({ manual: true });
    },
    "app.preferences": () => {
      quickOpen.close(false);
      return preferences.open();
    },
    "file.new": () => newDocument(),
    "file.newTab": () => newTab(),
    "file.closeTab": () => closeTab(),
    "window.nextTab": () => cycleTab(1),
    "window.previousTab": () => cycleTab(-1),
    "app.quit": () => quit(),
    "file.open": () => openDocument(),
    "file.quickOpen": () => {
      if (!preferences.isOpen()) quickOpen.toggle();
    },
    "file.openRecent": (path) => (path ? openPath(path, "tab") : false),
    "file.clearRecent": () => clearRecentFiles(),
    "file.openFolder": () => sidebar.openFolder(),
    "file.save": () => saveDocument(),
    "file.saveAs": () => saveDocumentAs(),
    "file.versionHistory": () => {
      quickOpen.close(false);
      preferences.close();
      return historyModal.open();
    },
    "file.exportPdf": () => exportDocumentPdf(),
    "file.exportPandoc": () => exportDocumentAs(),
    "file.import": () => importDocument(),
    "edit.copyRichText": () => copyRichText(),
    "edit.find": () => openFind(editor.view),
    "edit.replace": () => openFind(editor.view, { replace: true }),
    "edit.findNext": () => findNextMatch(editor.view),
    "edit.findPrevious": () => findPreviousMatch(editor.view),
    "edit.findInFolder": () => sidebar.openSearch(),
    "para.heading1": onEditor((v) => setHeadingLevel(v, 1)),
    "para.heading2": onEditor((v) => setHeadingLevel(v, 2)),
    "para.heading3": onEditor((v) => setHeadingLevel(v, 3)),
    "para.heading4": onEditor((v) => setHeadingLevel(v, 4)),
    "para.heading5": onEditor((v) => setHeadingLevel(v, 5)),
    "para.heading6": onEditor((v) => setHeadingLevel(v, 6)),
    "para.paragraph": onEditor((v) => setHeadingLevel(v, 0)),
    "para.orderedList": onEditor(toggleOrderedList),
    "para.bulletList": onEditor(toggleBulletList),
    "para.taskList": onEditor(toggleTaskList),
    "para.table": () => openInsertTableDialog(editor.view),
    "para.codeBlock": onEditor(insertCodeBlock),
    "para.mathBlock": onEditor(insertMathBlock),
    "para.quote": onEditor(toggleBlockquote),
    "fmt.bold": onEditor(toggleStrong),
    "fmt.italic": onEditor(toggleEmphasis),
    "fmt.code": onEditor(toggleInlineCode),
    "fmt.strike": onEditor(toggleStrikethrough),
    "fmt.link": onEditor(toggleLink),
    "view.sourceMode": () => windowHandlers.onToggleSourceMode(),
    "view.sidebar": () => sidebar.toggleVisible(),
    "view.outline": () => toggleOutline(),
    "view.focusMode": () => windowHandlers.onToggleFocusMode(),
    "view.typewriterMode": () => windowHandlers.onToggleTypewriterMode(),
    "view.codeLineNumbers": () => windowHandlers.onToggleCodeLineNumbers(),
    "view.mathAutoNumber": () => windowHandlers.onToggleMathAutoNumber(),
    "view.cycleTheme": () => themeMenu.cycleTheme(),
    "view.setTheme": (themeId) =>
      themeId ? themeMenu.selectTheme(themeId, true) : false,
    "view.actualSize": () => setZoom(1),
    "view.zoomIn": () => setZoom(nextZoomLevel(zoom, 1)),
    "view.zoomOut": () => setZoom(nextZoomLevel(zoom, -1)),
  };

  const menu = createMenuDispatcher({
    commands: menuCommands,
    target: window,
    // While preferences or Quick Open is open, editing commands would act on the hidden document.
    canRun: (action) =>
      !(
        (preferences.isOpen() ||
          quickOpen.isOpen() ||
          updater.isOpen() ||
          historyModal.isOpen()) &&
        /^(edit|para|fmt)\./.test(action)
      ),
    afterRun: () => scheduleMenuSync(true),
  });

  // #104: Cmd+P / Ctrl+P toggles Quick Open (also offered by 檔案 > 快速開啟…).
  const onQuickOpenKeydown = (event: KeyboardEvent) => {
    if (
      event.defaultPrevented ||
      preferences.isOpen() ||
      updater.isOpen() ||
      historyModal.isOpen()
    )
      return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
      return;
    if (event.metaKey && event.ctrlKey) return;
    if (event.code !== "KeyP" && event.key.toLowerCase() !== "p") return;
    event.preventDefault();
    quickOpen.toggle();
  };
  window.addEventListener("keydown", onQuickOpenKeydown);

  // Cmd+, opens the preferences (also offered by the native menu; see menu-dispatch.ts).
  const onPreferencesKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey)
      return;
    if (event.code !== "Comma" && event.key !== ",") return;
    event.preventDefault();
    quickOpen.close(false);
    historyModal.close();
    void preferences.open();
  };
  window.addEventListener("keydown", onPreferencesKeydown);

  // Windows-only top-left floating quick controls (toggle sidebar + open Markdown file).
  // Kept on Windows alongside the native menu bar; macOS does not show these.
  let navWidgetEl: HTMLDivElement | null = null;
  if (options?.showQuickButtons ?? IS_WINDOWS) {
    navWidgetEl = document.createElement("div");
    navWidgetEl.className = "k-sidebar-toggle-widget";

    const sidebarToggleBtn = document.createElement("button");
    sidebarToggleBtn.type = "button";
    sidebarToggleBtn.className = "k-theme-btn";
    sidebarToggleBtn.dataset.testid = "sidebar-toggle-button";
    sidebarToggleBtn.title = shortcutLabel(t("app.toggleSidebarShortcut"));
    sidebarToggleBtn.setAttribute("aria-label", t("app.toggleSidebar"));
    sidebarToggleBtn.innerHTML = `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M9 4v16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    sidebarToggleBtn.addEventListener("click", () => {
      void sidebar.toggleVisible();
    });

    const openFileQuickBtn = document.createElement("button");
    openFileQuickBtn.type = "button";
    openFileQuickBtn.className = "k-theme-btn";
    openFileQuickBtn.dataset.testid = "open-file-button";
    openFileQuickBtn.title = shortcutLabel(t("app.openFileShortcut"));
    openFileQuickBtn.setAttribute("aria-label", t("app.openFile"));
    openFileQuickBtn.innerHTML = `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M14 3v6h6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    openFileQuickBtn.addEventListener("click", () => {
      void openDocument();
    });

    navWidgetEl.append(sidebarToggleBtn, openFileQuickBtn);
    (editorContainer.parentElement ?? document.body).appendChild(navWidgetEl);
  }

  // #89: fallback keydown handlers for menu accelerators (also deduplicated by
  // menu-dispatch.ts on macOS and Windows so a press never runs twice).
  const onMenuShortcutKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    // Windows Alt+F4: settle unsaved changes across all tabs before closing.
    if (
      IS_WINDOWS &&
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.shiftKey &&
      (event.key === "F4" || event.code === "F4")
    ) {
      event.preventDefault();
      void quit();
      return;
    }
    const mod =
      (event.metaKey || event.ctrlKey) && !(event.metaKey && event.ctrlKey);
    if (!mod) return;
    if (
      !event.altKey &&
      !event.shiftKey &&
      (event.code === "KeyQ" || event.key.toLowerCase() === "q")
    ) {
      event.preventDefault();
      void quit();
      return;
    }
    if (!event.altKey && event.shiftKey) {
      if (event.code === "Digit1") {
        event.preventDefault();
        void toggleOutline();
        return;
      }
      if (event.code === "Digit0") {
        event.preventDefault();
        setZoom(1);
        return;
      }
      if (event.code === "Equal") {
        event.preventDefault();
        setZoom(nextZoomLevel(zoom, 1));
        return;
      }
      if (event.code === "Minus") {
        event.preventDefault();
        setZoom(nextZoomLevel(zoom, -1));
        return;
      }
    }
    if (
      preferences.isOpen() ||
      quickOpen.isOpen() ||
      updater.isOpen() ||
      historyModal.isOpen()
    )
      return;
    if (event.altKey && event.shiftKey && event.code === "KeyC") {
      event.preventDefault();
      void copyRichText();
      return;
    }
    if (event.code === "KeyF" && !event.shiftKey) {
      event.preventDefault();
      openFind(editor.view, { replace: event.altKey });
    } else if (event.code === "KeyG" && !event.altKey) {
      event.preventDefault();
      if (event.shiftKey) findPreviousMatch(editor.view);
      else findNextMatch(editor.view);
    }
  };
  window.addEventListener("keydown", onMenuShortcutKeydown);

  const onSidebarKeydown = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    if (
      !(event.metaKey || event.ctrlKey) ||
      (event.metaKey && event.ctrlKey) ||
      !event.shiftKey ||
      event.altKey
    ) {
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
    setStatus(
      normalized
        ? t("app.imageRoot", { path: toNativePath(normalized) })
        : t("app.imageRootCleared"),
      false,
    );
    await persistEditorSettingPatch({ imageRootDir: normalized });
    if (!normalized) return;
    try {
      await allowAssetDir(normalized);
    } catch (err) {
      // Kept as the setting (images show their fallback), but say why.
      if (isAssetDirTooBroadError(err)) {
        setStatus(
          t("app.imageRootTooBroad", { path: toNativePath(normalized) }),
          true,
        );
      }
    }
  }

  async function pickImageRootDir(): Promise<boolean> {
    let picked: string | null;
    try {
      picked = await pickOpenFolderPath();
    } catch (err) {
      setStatus(formatErrorMessage(t("app.setImageRootFailed"), err), true);
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
    setStatus(pandocMissingMessage(), true);
    return false;
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
      const docPath = active.path;
      let outPath: string | null;
      try {
        outPath =
          explicitPath ??
          (await pickSaveExportPath(
            defaultExportPath(docPath, chosen),
            info.label,
            info.ext,
          ));
      } catch (err) {
        setStatus(pandocErrorMessage("export", err), true);
        return false;
      }
      if (!outPath) return false;
      outPath = ensureExportExtension(outPath, chosen);
      setStatus(exportingMessage(), false);
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
        setStatus(pandocErrorMessage("export", err), true);
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
        source =
          explicitPath ?? (await pickImportPath(PANDOC_IMPORT_EXTENSIONS));
      } catch (err) {
        setStatus(pandocErrorMessage("import", err), true);
        return false;
      }
      if (!source) return false;
      setStatus(importingMessage(), false);
      let markdown: string;
      try {
        const result = await importPandoc(source);
        markdown = result.markdown;
        if (result.mediaDir) {
          await allowAssetDir(result.mediaDir).catch(() => null);
        }
      } catch (err) {
        setStatus(pandocErrorMessage("import", err), true);
        return false;
      }
      // #81 B: a new untitled tab (or the blank one).
      placeNewTab(
        makeTab(editor.createSession(markdown, { dirty: true }), null),
      );
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
    if (!(event.metaKey || event.ctrlKey) || !event.altKey || event.shiftKey)
      return;
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

  // #81: every untitled tab with changes has its own recovery file (its docId), not just the active one.
  const recoveryInterval = setInterval(() => {
    for (const tab of tabs) {
      if (tab.path !== null || !editor.isSessionDirty(tab.doc)) continue;
      const content = editor.getSessionContent(tab.doc);
      if (content.length > 0) {
        void writeRecovery(tab.docId, content, null).catch((err) => {
          setStatus(
            formatErrorMessage(t("app.writeRecoveryFailed"), err),
            true,
          );
        });
      }
    }
  }, UNTITLED_RECOVERY_INTERVAL_MS);

  async function insertImportedImages(
    pos: number,
    importers: Array<(docPath: string) => Promise<string>>,
  ): Promise<boolean> {
    const targetTab = active;
    const docPath = targetTab.path;
    if (docPath === null) {
      setStatus(t("app.saveBeforeImage"), true);
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
        setStatus(
          formatErrorMessage(t("app.insertImageFailed"), lastError),
          true,
        );
      }
      return false;
    }
    if (active !== targetTab || active.path !== docPath) return false;
    const { view } = editor;
    const anchor = Math.min(pos, view.state.doc.length);
    const lengthBefore = view.state.doc.length;
    insertImageMarkdown(view, anchor, relativePaths);
    if (lastError !== null) {
      setStatus(
        formatErrorMessage(t("app.insertSomeImagesFailed"), lastError),
        true,
      );
    } else {
      setStatus("", false);
    }
    const settings = await refreshUploadSettings();
    if (
      settings.uploadOnInsert &&
      lastError === null &&
      active === targetTab &&
      active.path === docPath
    ) {
      const insertedTo = anchor + (view.state.doc.length - lengthBefore);
      await runImageUpload(
        collectUploadTargetsInRange(view.state, anchor, insertedTo),
      );
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

  async function runImageUpload(
    targets?: Parameters<typeof uploadImagesInEditor>[0]["targets"],
  ): Promise<boolean> {
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
        notConfiguredMessage: t("errors.upload.notConfigured"),
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

  async function insertPastedImages(
    files: File[],
    pos: number,
  ): Promise<boolean> {
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
  let unlistenMenu: (() => void) | null = null;
  let startupUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;

  function openTabStates() {
    return tabs.map((t) => ({
      id: t.id,
      path: t.path,
      dirty: editor.isSessionDirty(t.doc),
      pristine: isPristine(t),
    }));
  }

  /**
   * #81 B: opens `path` per the tab rules (see resolveOpenTarget): an open file
   * is switched to, a blank untitled tab is reused, otherwise `mode` decides.
   * Nothing is ever replaced while it has unsaved changes, so there is no prompt.
   */
  async function openPath(path: string, mode: OpenMode): Promise<boolean> {
    const already = resolveOpenTarget(openTabStates(), active.id, path, mode);
    if (already.kind === "existing") {
      activateTab(already.id);
      recordRecentFile(path);
      setStatus("", false);
      return true;
    }
    let snapshot: FileSnapshot;
    try {
      snapshot = await openFileSnapshot(path);
    } catch (err) {
      const kind = (err as { kind?: string } | null)?.kind;
      if (kind === "NotFound") {
        const wasRecent = recentFiles.includes(path);
        if (wasRecent) {
          void applyRecentFiles(removeRecentFile(recentFiles, path), true);
        }
        if (cachedFolderRoot && cachedFolderPaths.includes(path)) {
          cachedFolderPaths = cachedFolderPaths.filter((p) => p !== path);
          quickOpen.setFolderPaths(
            cachedFolderRoot,
            cachedFolderPaths,
            cachedFolderTruncated,
          );
        }
        if (wasRecent) {
          setStatus(
            t("app.recentFileMissing", { path: toNativePath(path) }),
            true,
          );
          return false;
        }
      }
      setStatus(formatErrorMessage(t("app.openFailed"), err), true);
      return false;
    }
    // The tabs may have changed while the file was read.
    const target = resolveOpenTarget(openTabStates(), active.id, path, mode);
    if (target.kind === "existing") {
      activateTab(target.id);
    } else {
      const tab = makeTab(
        editor.createSession(snapshot.content),
        path,
        undefined,
        {
          hash: snapshot.hash,
          mtimeMs: snapshot.mtimeMs,
          size: snapshot.size,
        },
      );
      if (target.kind === "replace") {
        replaceActiveTab(tab);
      } else {
        tabs.push(tab);
        showTab(tab);
        syncWatchedOpenFiles();
      }
    }
    recordRecentFile(path);
    setStatus("", false);
    return true;
  }

  /** Cmd+O (asks for the file when `explicitPath` is omitted): a new tab, or the open / blank one. */
  async function openDocument(explicitPath?: string): Promise<boolean> {
    let selectedPath: string | null = null;
    try {
      selectedPath = explicitPath ?? (await pickOpenFilePath());
    } catch (err) {
      setStatus(formatErrorMessage(t("app.openFailed"), err), true);
      return false;
    }
    if (!selectedPath) return false;
    return openPath(selectedPath, "tab");
  }

  // Requests are handled one at a time, in order, so the tabs come out in the order given.
  let openRequestChain: Promise<unknown> = Promise.resolve();

  function openRequestedFiles(req: OpenFilesRequest): Promise<boolean> {
    const run = async (): Promise<boolean> => {
      const paths = req.paths ?? [];
      const rejected = req.rejected ?? [];
      // #81 B: every file gets its own tab (Finder can hand over several at once).
      let opened = false;
      for (const path of paths) {
        if (await openPath(path, "tab")) opened = true;
      }
      if (rejected.length > 0) {
        setStatus(openWithStatusMessage(rejected), true);
      }
      return opened;
    };
    const result = openRequestChain.then(run, run);
    openRequestChain = result.catch(() => null);
    return result;
  }

  async function saveDocument(): Promise<boolean> {
    const tab = active;
    clearAutosaveTimer(tab);
    if (tab.path === null || tab.external.status === "missing") {
      return saveDocumentAs();
    }
    return persistFileToPath(tab.path, tab, editor.getSessionContent(tab.doc));
  }

  async function saveDocumentAs(explicitPath?: string): Promise<boolean> {
    const tab = active;
    clearAutosaveTimer(tab);
    let selectedPath: string | null = null;
    try {
      selectedPath = explicitPath ?? (await pickSaveFilePath(tab.path));
    } catch (err) {
      setStatus(formatErrorMessage(t("app.saveFailed"), err), true);
      return false;
    }
    if (!selectedPath) return false;
    return persistFileToPath(
      selectedPath,
      tab,
      editor.getSessionContent(tab.doc),
      { force: true },
    );
  }

  /** #81: Cmd+N opens a new tab instead of replacing the current document. */
  async function newDocument(): Promise<boolean> {
    return newTab();
  }

  let copyingRichText = false;

  async function copyRichText(): Promise<boolean> {
    if (copyingRichText) return false;
    copyingRichText = true;
    try {
      const source = extractRichTextSource(editor.view.state);
      if (source.markdown.trim().length === 0) {
        setStatus(t("export.copyRichText.empty"), false);
        return false;
      }
      setStatus(t("export.copyRichText.copying"), false);
      const settings = await refreshUploadSettings();
      const result = await buildRichTextHtml(source.markdown, {
        docPath: active.path,
        mathAutoNumber: editor.isMathAutoNumber(),
        imageRootDir: editor.getImageRootDir(),
        frontMatterImageRoot: source.frontMatterImageRoot,
        uploadCommand: settings.uploadCommand,
        uploadImages,
      });
      await writeClipboardHtml(result.html, result.plainText);
      setStatus(formatCopyRichTextStatus(source.scope, result.images), false);
      return true;
    } catch (err) {
      setStatus(copyRichTextErrorMessage(err), true);
      return false;
    } finally {
      copyingRichText = false;
    }
  }

  let exportingPdf = false;

  async function exportDocumentPdf(explicitPath?: string): Promise<boolean> {
    if (exportingPdf) return false;
    exportingPdf = true;
    try {
      const docPath = active.path;
      let outPath: string | null = null;
      try {
        outPath =
          explicitPath ?? (await pickSavePdfPath(defaultPdfPath(docPath)));
      } catch (err) {
        setStatus(pdfErrorMessage(err), true);
        return false;
      }
      if (!outPath) return false;
      outPath = ensurePdfExtension(outPath);
      setStatus(exportingPdfMessage(), false);
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
        setStatus(pdfErrorMessage(err), true);
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
    const restored = makeTab(
      editor.createSession(entry.content, { dirty: true }),
      entry.path,
      entry.docId,
    );
    // A blank untitled tab is reused; otherwise the restored text gets its own tab.
    placeNewTab(restored);
    syncWatchedOpenFiles();
    await clearRecovery(entry.docId).catch(() => null);
    if (restored.path !== null && tabs.includes(restored)) {
      scheduleNamedAutosave(restored);
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

  /** Window closing: every tab's changes are written (named files) or kept for recovery (untitled). */
  async function flushBeforeClose(): Promise<void> {
    for (const tab of [...tabs]) {
      clearAutosaveTimer(tab);
      if (!editor.isSessionDirty(tab.doc)) continue;
      const content = editor.getSessionContent(tab.doc);
      if (tab.path !== null && canAutosave(tab.external)) {
        await persistFileToPath(tab.path, tab, content);
      } else if (tab.path !== null || content.length > 0) {
        await writeRecovery(tab.docId, content, tab.path).catch(() => null);
      }
    }
  }

  /**
   * #81 B: the window is closing (red button) or the app quits (⌘Q). Named
   * files are written when autosave is on (as when closing a tab); every other
   * tab with changes — background ones included — is listed in one prompt:
   * 全部儲存 / 不儲存 / 取消. Resolves to whether closing may go ahead.
   */
  let closingWindow = false;
  async function requestCloseWindow(): Promise<boolean> {
    if (closingWindow) return false;
    closingWindow = true;
    try {
      if (currentSettings.autoSave !== false) {
        for (const tab of [...tabs]) {
          if (
            tab.path === null ||
            !editor.isSessionDirty(tab.doc) ||
            !canAutosave(tab.external)
          ) {
            continue;
          }
          clearAutosaveTimer(tab);
          await persistFileToPath(
            tab.path,
            tab,
            editor.getSessionContent(tab.doc),
          );
        }
      }
      const unsaved = tabs.filter((tab) =>
        needsAttentionBeforeClose(tab.external, editor.isSessionDirty(tab.doc)),
      );
      if (unsaved.length === 0) return true;
      const labels = currentLabels();
      const choice = await askSaveChanges(
        unsavedChangesMessage(unsaved.map((tab) => labels.get(tab.id) ?? "")),
        saveChangesLabels(true),
      );
      if (choice === "cancel") return false;
      if (choice === "discard") {
        for (const tab of unsaved) {
          clearAutosaveTimer(tab);
          await clearRecovery(tab.docId).catch(() => null);
        }
        return true;
      }
      for (const tab of unsaved) {
        if (
          !tabs.includes(tab) ||
          !needsAttentionBeforeClose(
            tab.external,
            editor.isSessionDirty(tab.doc),
          )
        ) {
          continue;
        }
        clearAutosaveTimer(tab);
        let saved: boolean;
        if (tab.path !== null && tab.external.status !== "missing") {
          saved = await persistFileToPath(
            tab.path,
            tab,
            editor.getSessionContent(tab.doc),
          );
          if (!saved && tabs.includes(tab)) showTab(tab);
        } else {
          // Show the untitled / missing tab its save dialog is for.
          showTab(tab);
          saved = await saveDocumentAs();
        }
        // A cancelled save dialog or a failed write keeps the window open.
        if (!saved) return false;
      }
      return true;
    } finally {
      closingWindow = false;
    }
  }

  /** ⌘Q / 結束 Kalamos. */
  async function quit(): Promise<boolean> {
    if (!(await requestCloseWindow())) return false;
    for (const tab of tabs) clearAutosaveTimer(tab);
    await quitApp().catch(() => null);
    return true;
  }

  async function restoreDirtyRecoveries(): Promise<void> {
    // Restart/install failed while the app is still running: restore recovery copies
    // for any still-dirty tabs whose recovery files were cleared on "Don't Save".
    for (const tab of tabs) {
      if (!editor.isSessionDirty(tab.doc)) continue;
      const content = editor.getSessionContent(tab.doc);
      if (tab.path !== null || content.length > 0) {
        await writeRecovery(tab.docId, content, tab.path).catch(() => null);
      }
    }
  }

  async function restartAfterLanguageChange(): Promise<void> {
    if (!(await requestCloseWindow())) return;
    for (const tab of tabs) clearAutosaveTimer(tab);
    try {
      await restartApp();
    } catch (err) {
      await restoreDirtyRecoveries();
      throw err;
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
      const close = await requestCloseWindow();
      if (close) for (const tab of tabs) clearAutosaveTimer(tab);
      return close;
    });
    const unlistenDrop = await onFileDrop(async ({ paths, position }) => {
      // Images go into the current document first; dropped Markdown files then open in tabs;
      // otherwise an importable file (DOCX/ODT/EPUB/…) imports via Pandoc into a new tab.
      const imagePaths = paths.filter((p) => isImageFilePath(p));
      if (imagePaths.length > 0) {
        await dropImageFiles(imagePaths, position);
      }
      const mdPaths = paths.filter((p) => isMarkdownPath(p));
      for (const path of mdPaths) {
        await openPath(path, "tab");
      }
      if (imagePaths.length === 0 && mdPaths.length === 0) {
        const importable = paths.find((p) => isImportablePath(p));
        if (importable) {
          await importDocument(importable);
        }
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
      applySystemDarkTheme(settings.systemDarkTheme);
      applyTheme(settings.theme);
      editor.setSourceMode(Boolean(settings.sourceMode), false);
      editor.setCodeLineNumbers(Boolean(settings.codeLineNumbers), false);
      editor.setMathAutoNumber(Boolean(settings.mathAutoNumber), false);
      editor.setImageRootDir(settings.imageRootDir ?? null);
      editor.setFocusMode(Boolean(settings.focusMode), false);
      editor.setTypewriterMode(Boolean(settings.typewriterMode), false);
      editor.setAutoPairBrackets(settings.autoPairBrackets ?? true, false);
      editor.setAutoPairMarkdown(Boolean(settings.autoPairMarkdown), false);
      recentFiles = sanitizeRecentFiles(settings.recentFiles);
      quickOpen.setRecentFiles(recentFiles);
    } else {
      applySystemDarkTheme(currentSettings.systemDarkTheme);
    }
    applyLayoutSettings();
    renderTabs();
    await themeMenu.init();
    const unlistenFs = await onFsChanged(async (payload) => {
      const folder = sidebar.getCurrentFolder();
      if (folder) {
        await refreshQuickOpenFolderCache(folder);
      }
      await checkExternalChangesForPaths(payload.paths);
    }).catch(() => null);
    if (destroyed) {
      unlistenFs?.();
    } else {
      unlistenQuickOpenFs = unlistenFs;
    }
    const unlistenOpenChanged = await onOpenFilesChanged(async (payload) => {
      await checkExternalChangesForPaths(payload.paths);
    }).catch(() => null);
    if (destroyed) {
      unlistenOpenChanged?.();
    } else {
      unlistenOpenFilesChanged = unlistenOpenChanged;
      window.addEventListener("focus", onWindowFocusCheck);
      document.addEventListener("visibilitychange", onVisibilityCheck);
      syncWatchedOpenFiles();
    }
    await sidebar.init({
      restoreFolder: settings?.startupBehavior !== "blank",
    });
    const unlistenMenuAction = await onMenuAction(({ action, arg }) => {
      menu.dispatch(action, arg ?? null);
    }).catch(() => null);
    if (destroyed) {
      unlistenMenuAction?.();
    } else {
      unlistenMenu = unlistenMenuAction;
      scheduleMenuSync(true);
    }
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
    if (!destroyed && currentSettings.autoCheckUpdates !== false) {
      const delayMs =
        options?.startupUpdateCheckDelayMs ?? STARTUP_UPDATE_CHECK_DELAY_MS;
      startupUpdateTimer = setTimeout(() => {
        startupUpdateTimer = null;
        if (!destroyed && currentSettings.autoCheckUpdates !== false) {
          void updater.checkForUpdates({ manual: false });
        }
      }, delayMs);
    }
  }

  function destroy(): void {
    destroyed = true;
    if (startupUpdateTimer !== null) {
      clearTimeout(startupUpdateTimer);
      startupUpdateTimer = null;
    }
    updater.destroy();
    for (const tab of tabs) clearAutosaveTimer(tab);
    window.removeEventListener("keydown", onTabKeydown);
    tabBar.destroy();
    unlistenFileDrop?.();
    unlistenFileDrop = null;
    unlistenOpenFiles?.();
    unlistenOpenFiles = null;
    unlistenMenu?.();
    unlistenMenu = null;
    unlistenQuickOpenFs?.();
    unlistenQuickOpenFs = null;
    unlistenOpenFilesChanged?.();
    unlistenOpenFilesChanged = null;
    window.removeEventListener("focus", onWindowFocusCheck);
    document.removeEventListener("visibilitychange", onVisibilityCheck);
    externalBanner.destroy();
    void watchOpenFiles([]).catch(() => null);
    if (menuSyncTimer !== null) clearTimeout(menuSyncTimer);
    menu.destroy();
    quickOpen.destroy();
    historyModal.destroy();
    preferences.destroy();
    window.removeEventListener("keydown", onQuickOpenKeydown);
    window.removeEventListener("keydown", onPreferencesKeydown);
    window.removeEventListener("keydown", onMenuShortcutKeydown);
    root.removeEventListener("wheel", onZoomWheel);
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
    navWidgetEl?.remove();
    themeMenu.destroy();
    wordCounter.destroy();
    sidebar.destroy();
    editor.destroy();
  }

  return {
    editor,
    tabBar,
    getTabs: () => {
      const labels = currentLabels();
      return tabs.map((tab) => ({
        id: tab.id,
        label: labels.get(tab.id) ?? "",
        path: tab.path,
        docId: tab.docId,
        dirty: editor.isSessionDirty(tab.doc),
        active: tab === active,
        externalStatus: tab.external.status,
      }));
    },
    getActiveTabId: () => active.id,
    newTab,
    closeTab,
    activateTab,
    cycleTab,
    moveTab,
    preferences,
    historyModal,
    openVersionHistory: () => historyModal.open(),
    updater,
    checkForUpdates: (opts) => updater.checkForUpdates(opts),
    quickOpen,
    getRecentFiles: () => [...recentFiles],
    clearRecentFiles,
    menu,
    getZoom: () => zoom,
    sidebar,
    themeMenu,
    wordCounter,
    getDocId: () => active.docId,
    getCurrentPath: () => active.path,
    getPendingRecovery: () => pendingRecovery,
    getStatusText: () => statusText,
    openDocument,
    openPath,
    requestCloseWindow,
    quit,
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
    copyRichText,
    isCopyingRichText: () => copyingRichText,
    dropImageFiles,
    insertPastedImages,
    restoreRecovery,
    discardRecovery,
    checkExternalChanges: checkAllOpenTabsExternalChanges,
    flushBeforeClose,
    init,
    destroy,
  };
}

let activeApp: KalamosApp | null = null;

if (
  typeof document !== "undefined" &&
  document.querySelector("#editor-container")
) {
  void startApp(document);
}

async function startApp(doc: Document): Promise<void> {
  const locale = await getActiveUiLocale().catch(() => DEFAULT_UI_LOCALE);
  await initUiLocale(locale);
  doc.documentElement.lang = locale;
  activeApp = createKalamosApp(doc);
  await activeApp.init();
}

export function getActiveApp(): KalamosApp | null {
  return activeApp;
}
