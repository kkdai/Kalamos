import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ask as askDialog,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";

export type ErrorKind =
  | "NotFound"
  | "AlreadyExists"
  | "PermissionDenied"
  | "InvalidPath"
  | "Io"
  | "Watch"
  | "Parse";

export interface AppError {
  kind: ErrorKind;
  message: string;
}

export interface PathArg {
  path: string;
}

export interface FileMeta {
  path: string;
  mtimeMs: number;
  size: number;
}

export interface RecoveryEntry {
  docId: string;
  path: string | null;
  content: string;
  savedAtMs: number;
}

export type SidebarTab = "tree" | "list" | "outline";

export interface Settings {
  theme: string;
  lastFolder: string | null;
  sidebarVisible: boolean;
  sidebarTab: SidebarTab;
  sourceMode: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  lastFolder: null,
  sidebarVisible: false,
  sidebarTab: "tree",
  sourceMode: false,
};

interface MockFileRecord {
  content: string;
  mtimeMs: number;
}

const mockFiles = new Map<string, MockFileRecord>();
const mockRecovery = new Map<string, RecoveryEntry>();
let mockSettings: Settings = { ...DEFAULT_SETTINGS };
let lastMockTimestampMs = 0;

type DialogOpenHandler = () => string | null | Promise<string | null>;
type DialogSaveHandler = (
  defaultPath?: string | null,
) => string | null | Promise<string | null>;
type DialogAskHandler = (message: string) => boolean | Promise<boolean>;
type MockSaveInterceptor = (
  path: string,
  content: string,
  defaultSave: () => Promise<FileMeta>,
) => Promise<FileMeta>;

let mockOpenDialogHandler: DialogOpenHandler | null = null;
let mockSaveDialogHandler: DialogSaveHandler | null = null;
let mockAskDialogHandler: DialogAskHandler | null = null;
let mockSaveInterceptor: MockSaveInterceptor | null = null;
const mockCloseListeners = new Set<() => void | Promise<void>>();

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__)
  );
}

function nextMockTimestampMs(): number {
  const now = Date.now();
  lastMockTimestampMs = now > lastMockTimestampMs ? now : lastMockTimestampMs + 1;
  return lastMockTimestampMs;
}

function createAppError(kind: ErrorKind, message: string): AppError {
  return { kind, message };
}

function validateDocId(docId: string): void {
  if (
    !docId ||
    !docId.trim() ||
    docId.includes("/") ||
    docId.includes("\\") ||
    docId.includes("..") ||
    docId.includes("\0")
  ) {
    throw createAppError("InvalidPath", `Invalid docId: ${docId}`);
  }
}

export function resetMockState(): void {
  mockFiles.clear();
  mockRecovery.clear();
  mockSettings = { ...DEFAULT_SETTINGS };
  lastMockTimestampMs = 0;
  mockOpenDialogHandler = null;
  mockSaveDialogHandler = null;
  mockAskDialogHandler = null;
  mockSaveInterceptor = null;
  mockCloseListeners.clear();
}

export function setMockDialogHandlers(handlers: {
  open?: DialogOpenHandler | null;
  save?: DialogSaveHandler | null;
  ask?: DialogAskHandler | null;
}): void {
  if (handlers.open !== undefined) {
    mockOpenDialogHandler = handlers.open;
  }
  if (handlers.save !== undefined) {
    mockSaveDialogHandler = handlers.save;
  }
  if (handlers.ask !== undefined) {
    mockAskDialogHandler = handlers.ask;
  }
}

export function setMockSaveInterceptor(
  interceptor: MockSaveInterceptor | null,
): void {
  mockSaveInterceptor = interceptor;
}

export function seedMockFile(path: string, content: string): void {
  mockFiles.set(path, { content, mtimeMs: nextMockTimestampMs() });
}

export function readMockFile(path: string): string | undefined {
  return mockFiles.get(path)?.content;
}

export async function openFile(path: string): Promise<string> {
  if (isTauri()) {
    return invoke<string>("open_file", { path });
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const entry = mockFiles.get(path);
  if (!entry) {
    throw createAppError("NotFound", `File not found: ${path}`);
  }
  return entry.content;
}

export async function saveFile(
  path: string,
  content: string,
): Promise<FileMeta> {
  if (isTauri()) {
    return invoke<FileMeta>("save_file", { path, content });
  }
  const defaultSave = async (): Promise<FileMeta> => {
    if (!path || !path.trim()) {
      throw createAppError("InvalidPath", "Path must not be empty");
    }
    const mtimeMs = nextMockTimestampMs();
    const size = new TextEncoder().encode(content).byteLength;
    mockFiles.set(path, { content, mtimeMs });
    return { path, mtimeMs, size };
  };
  if (mockSaveInterceptor) {
    return mockSaveInterceptor(path, content, defaultSave);
  }
  return defaultSave();
}

export async function writeRecovery(
  docId: string,
  content: string,
  path: string | null = null,
): Promise<null> {
  if (isTauri()) {
    return invoke<null>("write_recovery", { docId, path, content });
  }
  validateDocId(docId);
  const entry: RecoveryEntry = {
    docId,
    path,
    content,
    savedAtMs: nextMockTimestampMs(),
  };
  mockRecovery.set(docId, entry);
  return null;
}

export async function listRecovery(): Promise<RecoveryEntry[]> {
  if (isTauri()) {
    return invoke<RecoveryEntry[]>("list_recovery");
  }
  return Array.from(mockRecovery.values())
    .map((entry) => ({ ...entry }))
    .sort((a, b) => b.savedAtMs - a.savedAtMs);
}

export async function clearRecovery(docId: string): Promise<null> {
  if (isTauri()) {
    return invoke<null>("clear_recovery", { docId });
  }
  validateDocId(docId);
  mockRecovery.delete(docId);
  return null;
}

export async function getSettings(): Promise<Settings> {
  if (isTauri()) {
    return invoke<Settings>("get_settings");
  }
  return { ...mockSettings };
}

export async function setSettings(settings: Settings): Promise<null> {
  if (isTauri()) {
    return invoke<null>("set_settings", { settings });
  }
  mockSettings = {
    theme: settings.theme ?? DEFAULT_SETTINGS.theme,
    lastFolder: settings.lastFolder ?? DEFAULT_SETTINGS.lastFolder,
    sidebarVisible: settings.sidebarVisible ?? DEFAULT_SETTINGS.sidebarVisible,
    sidebarTab: settings.sidebarTab ?? DEFAULT_SETTINGS.sidebarTab,
    sourceMode: settings.sourceMode ?? DEFAULT_SETTINGS.sourceMode,
  };
  return null;
}

export async function pickOpenFilePath(): Promise<string | null> {
  if (isTauri()) {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    return typeof selected === "string" ? selected : null;
  }
  if (mockOpenDialogHandler) {
    return await mockOpenDialogHandler();
  }
  return null;
}

export async function pickSaveFilePath(
  defaultPath?: string | null,
): Promise<string | null> {
  if (isTauri()) {
    const selected = await saveDialog({
      defaultPath: defaultPath ?? undefined,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    return selected ?? null;
  }
  if (mockSaveDialogHandler) {
    return await mockSaveDialogHandler(defaultPath);
  }
  return null;
}

export async function askDiscardChanges(
  message = "目前未命名文件尚有未儲存的變更，確定要捨棄嗎？",
): Promise<boolean> {
  if (isTauri()) {
    return askDialog(message, { title: "Kalamos", kind: "warning" });
  }
  if (mockAskDialogHandler) {
    return await mockAskDialogHandler(message);
  }
  return true;
}

export async function onWindowCloseRequested(
  handler: () => void | Promise<void>,
): Promise<() => void> {
  if (isTauri()) {
    return getCurrentWindow().onCloseRequested(async () => {
      await handler();
    });
  }
  mockCloseListeners.add(handler);
  return () => {
    mockCloseListeners.delete(handler);
  };
}

export async function triggerMockCloseRequested(): Promise<void> {
  for (const listener of Array.from(mockCloseListeners)) {
    await listener();
  }
}
