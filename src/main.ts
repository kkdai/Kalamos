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

export const NAMED_AUTOSAVE_DELAY_MS = 1000;
export const UNTITLED_RECOVERY_INTERVAL_MS = 5000;

export function applyTheme(theme: string): void {
  if (typeof document === "undefined") return;
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
  getDocId: () => string;
  getCurrentPath: () => string | null;
  getPendingRecovery: () => RecoveryEntry | null;
  getStatusText: () => string;
  openDocument: (explicitPath?: string) => Promise<boolean>;
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

  async function persistSourceMode(sourceMode: boolean): Promise<void> {
    currentSettings = { ...currentSettings, sourceMode };
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
      void persistSourceMode(sourceMode);
    },
  });

  const windowHandlers = {
    ...handlers,
    onToggleSourceMode: () => {
      editor.toggleSourceMode();
    },
  };

  const unbindShortcuts = bindWindowShortcuts(
    window,
    windowHandlers,
    () => editor.view,
  );

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
    }
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
    if (unlistenClose) {
      unlistenClose();
      unlistenClose = null;
    }
    restoreBtn?.removeEventListener("click", onRestoreClick);
    discardBtn?.removeEventListener("click", onDiscardClick);
    editor.destroy();
  }

  return {
    editor,
    getDocId: () => docId,
    getCurrentPath: () => currentPath,
    getPendingRecovery: () => pendingRecovery,
    getStatusText: () => statusText,
    openDocument,
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
