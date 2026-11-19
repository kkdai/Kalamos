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
import { bindWindowShortcuts } from "./editor/keymaps";
import {
  jumpToHeadingSlug,
  resolveRelativeMarkdownPath,
} from "./editor/lists";
import {
  askDiscardChanges,
  clearRecovery,
  DEFAULT_SETTINGS,
  getSettings,
  listRecovery,
  onWindowCloseRequested,
  openFile,
  pickOpenFilePath,
  pickSaveFilePath,
  saveFile,
  setSettings,
  writeRecovery,
  type RecoveryEntry,
  type Settings,
} from "./ipc";
import { createSidebar, type SidebarController } from "./sidebar/sidebar";
import {
  applyThemeWithCustomCss,
  createThemeMenu,
  CUSTOM_THEME_STYLE_ID,
  type ThemeMenuController,
} from "./theme/theme-menu";

export const NAMED_AUTOSAVE_DELAY_MS = 1000;
export const UNTITLED_RECOVERY_INTERVAL_MS = 5000;

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

export interface KalamosApp {
  editor: KalamosEditor;
  sidebar: SidebarController;
  themeMenu: ThemeMenuController;
  getDocId: () => string;
  getCurrentPath: () => string | null;
  getPendingRecovery: () => RecoveryEntry | null;
  getStatusText: () => string;
  openDocument: (explicitPath?: string) => Promise<boolean>;
  openFolder: (explicitPath?: string) => Promise<boolean>;
  toggleSidebar: () => Promise<boolean>;
  saveDocument: () => Promise<boolean>;
  saveDocumentAs: (explicitPath?: string) => Promise<boolean>;
  newDocument: () => Promise<boolean>;
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
  };

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
    onPathRenamed: (from, to) => {
      if (currentPath === null) return;
      if (currentPath === from) {
        currentPath = to;
        sidebar.setActiveFile(currentPath);
        if (editor.isDirty()) {
          scheduleNamedAutosave();
        }
      } else if (currentPath.startsWith(`${from}/`)) {
        currentPath = `${to}${currentPath.slice(from.length)}`;
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
    }
  };
  window.addEventListener("keydown", onSidebarKeydown);

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
      sidebar.setActiveFile(currentPath);
      setStatus("", false);
      return true;
    } catch (err) {
      setStatus(formatErrorMessage("開檔失敗", err), true);
      return false;
    }
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
    sidebar.setActiveFile(null);
    setStatus("", false);
    return true;
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
    const settings = await getSettings().catch(() => null);
    if (settings) {
      currentSettings = { ...settings };
      applyTheme(settings.theme);
      editor.setSourceMode(Boolean(settings.sourceMode), false);
      editor.setCodeLineNumbers(Boolean(settings.codeLineNumbers), false);
      editor.setMathAutoNumber(Boolean(settings.mathAutoNumber), false);
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
  }

  function destroy(): void {
    clearAutosaveTimer();
    clearInterval(recoveryInterval);
    unbindShortcuts();
    window.removeEventListener("keydown", onSidebarKeydown);
    if (unlistenClose) {
      unlistenClose();
      unlistenClose = null;
    }
    restoreBtn?.removeEventListener("click", onRestoreClick);
    discardBtn?.removeEventListener("click", onDiscardClick);
    themeMenu.destroy();
    sidebar.destroy();
    editor.destroy();
  }

  return {
    editor,
    sidebar,
    themeMenu,
    getDocId: () => docId,
    getCurrentPath: () => currentPath,
    getPendingRecovery: () => pendingRecovery,
    getStatusText: () => statusText,
    openDocument,
    openFolder: (explicitPath?: string) => sidebar.openFolder(explicitPath),
    toggleSidebar: () => sidebar.toggleVisible(),
    saveDocument,
    saveDocumentAs,
    newDocument,
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
