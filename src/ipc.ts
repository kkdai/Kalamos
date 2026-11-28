import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { writeHtml as writeClipboardHtmlPlugin } from "@tauri-apps/plugin-clipboard-manager";
import {
  ask as askDialog,
  message as messageDialog,
  open as openDialog,
  save as saveDialog,
} from "@tauri-apps/plugin-dialog";
import { check as checkUpdater } from "@tauri-apps/plugin-updater";
import { sha256Hex } from "./external-changes/content-hash";
import {
  defaultUiLocaleForTag,
  hasMessageKey,
  normalizeUiLocale,
  parseUiLocale,
  t,
  type UiLocale,
} from "./i18n";
import {
  IS_WINDOWS,
  isAbsolutePath,
  isMarkdownFilePath,
  MARKDOWN_EXTENSIONS as MARKDOWN_EXT_LIST,
  toNativePath,
  toSlashPath,
} from "./platform";

function normalizeTreeNode(node: TreeNode): TreeNode {
  return {
    ...node,
    path: toSlashPath(node.path),
    children: node.children?.map(normalizeTreeNode),
  };
}

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
  messageKey?: string;
  messageArgs?: Record<string, string | number>;
}

export function appErrorDetail(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) {
    const appError = error as Partial<AppError>;
    const message = String(error.message);
    if (appError.messageKey && hasMessageKey(appError.messageKey)) {
      return t(appError.messageKey, appError.messageArgs);
    }
    return message;
  }
  return String(error);
}

export function formatErrorMessage(prefix: string, error: unknown): string {
  return t("dialog.errorWithDetail", { prefix, detail: appErrorDetail(error) });
}

export interface PathArg {
  path: string;
}

export interface FileMeta {
  path: string;
  mtimeMs: number;
  size: number;
}

/** #145: file content along with its disk metadata and SHA-256 content hash. */
export interface FileSnapshot {
  path: string;
  content: string;
  mtimeMs: number;
  size: number;
  hash: string;
}

/** #145: current disk state of a named file without transferring content. */
export type FileDiskState =
  | {
      status: "exists";
      path: string;
      mtimeMs: number;
      size: number;
      hash: string;
    }
  | {
      status: "missing";
      path: string;
    };

/** #145: result of a conflict-checked save (pre-save defense against external overwrites). */
export type SaveFileResult =
  | {
      status: "saved";
      path: string;
      mtimeMs: number;
      size: number;
      hash: string;
    }
  | {
      status: "conflict";
      path: string;
      mtimeMs: number;
      size: number;
      diskHash: string;
    }
  | {
      status: "missing";
      path: string;
    };

export interface OpenFilesChangedPayload {
  paths: string[];
}

export type TreeNodeKind = "dir" | "file";

export interface TreeNode {
  name: string;
  path: string;
  kind: TreeNodeKind;
  children?: TreeNode[];
}

export interface FileEntry {
  path: string;
  name: string;
  mtimeMs: number;
  excerpt: string;
}

/** #104: lightweight path listing for Quick Open (Rust `list_markdown_paths`). */
export interface MarkdownPathsResult {
  paths: string[];
  truncated: boolean;
}

export const MAX_QUICK_OPEN_PATHS = 20_000;

export interface FsChangedPayload {
  root: string;
  paths: string[];
}

export interface ThemeInfo {
  id: string;
  name: string;
  builtin: boolean;
}

export interface RecoveryEntry {
  docId: string;
  path: string | null;
  content: string;
  savedAtMs: number;
}

export type SidebarTab = "tree" | "list" | "outline" | "search";

/** #137: built-in dark theme used when theme === "system" and OS is dark. */
export type SystemDarkTheme = "melan" | "nyx";

export interface Settings {
  uiLocale?: UiLocale;
  theme: string;
  /** #137: built-in dark theme used when theme === "system" and OS is dark. */
  systemDarkTheme?: SystemDarkTheme;
  lastFolder: string | null;
  sidebarVisible: boolean;
  sidebarTab: SidebarTab;
  sourceMode: boolean;
  codeLineNumbers?: boolean;
  mathAutoNumber?: boolean;
  /** IM-04: folder that `/`-rooted image paths resolve against. */
  imageRootDir?: string | null;
  /** WM-01 Ataraxia focus mode (F8). */
  focusMode?: boolean;
  /** WM-02 Stichos typewriter mode (F9). */
  typewriterMode?: boolean;
  /** IM-05: image upload program (absolute path or a name in PATH); null = not configured. */
  uploadCommand?: string | null;
  /** IM-05: fixed arguments placed before the image paths. */
  uploadArgs?: string[];
  /** IM-05: upload pasted / dropped images right after importing them. */
  uploadOnInsert?: boolean;
  /** ED-09: auto-close brackets / quotes (default on). */
  autoPairBrackets?: boolean;
  /** ED-09: auto-close Markdown * _ ` ~ (default off). */
  autoPairMarkdown?: boolean;
  /** #74: reopen the last folder on launch, or start blank. */
  startupBehavior?: StartupBehavior;
  /** #74: autosave named documents (default on). */
  autoSave?: boolean;
  /** #91: automatically check for app updates in the background on startup (default on). */
  autoCheckUpdates?: boolean;
  /** #74: editor font size in px. */
  fontSize?: number;
  /** #74: content column width in px (--k-max-width). */
  contentWidth?: number;
  /** #104: recently opened / saved file paths (newest first, up to 20). */
  recentFiles?: string[];
  /** #148: keep local version history snapshots on save (default on). */
  historyEnabled?: boolean;
  /** #148: maximum snapshots kept per file (default 50). */
  historyMaxVersions?: number;
  /** #148: maximum total local history size in MB across all files (default 200). */
  historyMaxTotalMb?: number;
}

export type StartupBehavior = "restoreFolder" | "blank";

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  systemDarkTheme: "melan",
  lastFolder: null,
  sidebarVisible: false,
  sidebarTab: "tree",
  sourceMode: false,
  codeLineNumbers: false,
  mathAutoNumber: false,
  imageRootDir: null,
  focusMode: false,
  typewriterMode: false,
  uploadCommand: null,
  uploadArgs: [],
  uploadOnInsert: false,
  autoPairBrackets: true,
  autoPairMarkdown: false,
  startupBehavior: "restoreFolder",
  autoSave: true,
  autoCheckUpdates: true,
  fontSize: 17,
  contentWidth: 720,
  recentFiles: [],
  historyEnabled: true,
  historyMaxVersions: 50,
  historyMaxTotalMb: 200,
};

export const MAX_EXCERPT_CHARS = 120;

interface MockFileRecord {
  content: string;
  mtimeMs: number;
}

const mockFiles = new Map<string, MockFileRecord>();
const mockDirs = new Set<string>();
const mockRecovery = new Map<string, RecoveryEntry>();
const mockCustomThemes = new Map<string, string>();
let mockSettings: Settings = { ...DEFAULT_SETTINGS, recentFiles: [] };
let mockActiveUiLocale: UiLocale | undefined;
let mockSystemLocale: string | null = "zh-TW";
let mockSettingsWriteError: Error | null = null;
let mockRestartError: Error | null = null;
let mockWatchedFolder: string | null = null;
let mockWatchedOpenFiles: string[] = [];
let mockListMarkdownPathsCalls = 0;
const mockAssetFiles = new Set<string>();
const mockAllowedAssetDirs = new Set<string>();
const mockAllowedAssetFiles = new Set<string>();
let lastMockTimestampMs = 0;

type DialogOpenHandler = () => string | null | Promise<string | null>;
type DialogSaveHandler = (
  defaultPath?: string | null,
) => string | null | Promise<string | null>;
type DialogAskHandler = (message: string) => boolean | Promise<boolean>;
/** #81: answer of the 儲存 / 不儲存 / 取消 prompt. */
export type SaveChangesChoice = "save" | "discard" | "cancel";
type DialogSaveChangesHandler = (
  message: string,
) => SaveChangesChoice | Promise<SaveChangesChoice>;
type DialogPromptHandler = (
  message: string,
  defaultValue?: string,
) => string | null | Promise<string | null>;
type MockSaveInterceptor = (
  path: string,
  content: string,
  defaultSave: () => Promise<FileMeta>,
) => Promise<FileMeta>;
type FsChangedListener = (payload: FsChangedPayload) => void | Promise<void>;
type OpenFilesChangedListener = (
  payload: OpenFilesChangedPayload,
) => void | Promise<void>;

let mockOpenDialogHandler: DialogOpenHandler | null = null;
let mockOpenFolderDialogHandler: DialogOpenHandler | null = null;
let mockSaveDialogHandler: DialogSaveHandler | null = null;
let mockAskDialogHandler: DialogAskHandler | null = null;
let mockSaveChangesDialogHandler: DialogSaveChangesHandler | null = null;
const mockSaveChangesPrompts: string[] = [];
let mockWindowTitle = "Kalamos";
let mockPromptDialogHandler: DialogPromptHandler | null = null;
let mockSaveInterceptor: MockSaveInterceptor | null = null;
const mockCloseListeners = new Set<
  () => boolean | void | Promise<boolean | void>
>();
const mockFsChangedListeners = new Set<FsChangedListener>();
const mockOpenFilesChangedListeners = new Set<OpenFilesChangedListener>();

export function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    Boolean((window as unknown as Record<string, unknown>).__TAURI_INTERNALS__)
  );
}

function nextMockTimestampMs(): number {
  const now = Date.now();
  lastMockTimestampMs =
    now > lastMockTimestampMs ? now : lastMockTimestampMs + 1;
  return lastMockTimestampMs;
}

function createAppError(
  kind: ErrorKind,
  message: string,
  messageKey?: string,
  messageArgs?: AppError["messageArgs"],
): AppError {
  return messageKey
    ? { kind, message, messageKey, messageArgs }
    : { kind, message };
}

function normalizePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

function registerAncestorDirs(
  fileOrDirPath: string,
  includeSelf = false,
): void {
  const norm = normalizePath(fileOrDirPath);
  if (!norm) return;
  const isAbsolute = norm.startsWith("/");
  const parts = norm.split("/").filter((p) => p.length > 0);
  const end = includeSelf ? parts.length : parts.length - 1;
  let current = "";
  for (let i = 0; i < end; i++) {
    const part = parts[i];
    current = current ? `${current}/${part}` : isAbsolute ? `/${part}` : part;
    mockDirs.add(current);
  }
}

export function isIgnoredName(name: string): boolean {
  return name.startsWith(".") || name === ".git" || name === "node_modules";
}

export function isMarkdownName(name: string): boolean {
  return isMarkdownFilePath(name);
}

export function extractExcerpt(content: string): string {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length > 0) {
      return Array.from(trimmed).slice(0, MAX_EXCERPT_CHARS).join("");
    }
  }
  return "";
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

function seedDemoFolder(): void {
  seedMockDir("/demo");
  seedMockDir("/demo/guides");
  seedMockFile(
    "/demo/welcome.md",
    [
      "# Kalamos 歡迎使用指南",
      "",
      "Write, and it appears. 落筆即成文 —— 在莎草紙（Papyros）與墨（Melan）之間專注書寫中英混排技術文章。",
      "",
      "## 二級標題：即時預覽 WYSIWYM",
      "",
      "游標離開段落後自動隱藏 Markdown 符號，支援 **粗體**、*斜體*、`code` 與 [超連結](https://typora.io)。",
      "",
      "### 三級標題：檔案管理與側欄",
      "",
      "使用 Cmd+Shift+L 切換側欄，在檔案樹與檔案列表之間自由切換。",
      "",
      "#### 四級標題：大綱與導覽",
      "",
      "##### 五級標題：自動儲存與異常救回",
      "",
      "###### 六級標題：標準 GFM 無損存檔",
    ].join("\n"),
  );
  seedMockFile(
    "/demo/notes.md",
    [
      "# 技術筆記 Architecture Notes",
      "",
      "Kalamos 採用 Tauri 2 + TypeScript + CodeMirror 6，確保本地檔案讀寫快速且逐 byte 無損。",
    ].join("\n"),
  );
  seedMockFile(
    "/demo/guides/shortcuts.md",
    [
      "# 快捷鍵一覽 Keyboard Shortcuts",
      "",
      "- Cmd+O：開啟檔案 / Cmd+Shift+O：開啟資料夾",
      "- Cmd+S：儲存檔案 / Cmd+Shift+L：切換側欄",
    ].join("\n"),
  );
}

function seedDefaultCustomThemes(): void {
  mockCustomThemes.set(
    "night",
    [
      "/* Demo Custom Theme: night */",
      ":root[data-custom-theme] {",
      "  color-scheme: dark;",
      "  --k-bg: #141820;",
      "  --k-surface: #1c222d;",
      "  --k-text: #dce3ee;",
      "  --k-text-muted: #8b96a8;",
      "  --k-accent: #7aa2f7;",
      "  --k-link: #e0af68;",
      "  --k-divider: #2b3344;",
      "}",
    ].join("\n"),
  );
}

export function resetMockState(): void {
  mockFiles.clear();
  mockDirs.clear();
  mockRecovery.clear();
  mockCustomThemes.clear();
  mockSettings = { ...DEFAULT_SETTINGS, recentFiles: [] };
  mockActiveUiLocale = undefined;
  mockSystemLocale = "zh-TW";
  mockSettingsWriteError = null;
  mockRestartError = null;
  mockWatchedFolder = null;
  mockWatchedOpenFiles = [];
  mockListMarkdownPathsCalls = 0;
  lastMockTimestampMs = 0;
  mockOpenDialogHandler = null;
  mockOpenFolderDialogHandler = null;
  mockSaveDialogHandler = null;
  mockAskDialogHandler = null;
  mockSaveChangesDialogHandler = null;
  mockSaveChangesPrompts.length = 0;
  mockWindowTitle = "Kalamos";
  mockPromptDialogHandler = null;
  mockSaveInterceptor = null;
  mockCloseListeners.clear();
  mockQuitCount = 0;
  mockRestartCount = 0;
  mockFsChangedListeners.clear();
  mockOpenFilesChangedListeners.clear();
  mockAssetFiles.clear();
  mockAllowedAssetDirs.clear();
  mockAllowedAssetFiles.clear();
  mockFileDropListeners.clear();
  mockOpenFilesListeners.clear();
  mockOpenFilesReady = false;
  mockPendingOpenFiles = { paths: [], rejected: [] };
  mockPdfExports.length = 0;
  mockExportPdfHandler = null;
  mockUploadHandler = null;
  mockUploadCalls.length = 0;
  mockPandocStatus = { ...DEFAULT_MOCK_PANDOC_STATUS };
  mockPandocExports.length = 0;
  mockPandocExportHandler = null;
  mockPandocImportHandler = null;
  mockUpdateHandler = null;
  mockUpdateCheckCount = 0;
  mockImageDataUris.clear();
  mockLastClipboardHtml = null;
  mockClipboardHtmlHandler = null;
  mockHistory.clear();
  mockHistoryThrottleMs = DEFAULT_MOCK_HISTORY_THROTTLE_MS;
  seedDemoFolder();
  seedDefaultCustomThemes();
}

export function setMockDialogHandlers(handlers: {
  open?: DialogOpenHandler | null;
  openFolder?: DialogOpenHandler | null;
  save?: DialogSaveHandler | null;
  ask?: DialogAskHandler | null;
  prompt?: DialogPromptHandler | null;
  saveChanges?: DialogSaveChangesHandler | null;
}): void {
  if (handlers.saveChanges !== undefined) {
    mockSaveChangesDialogHandler = handlers.saveChanges;
  }
  if (handlers.open !== undefined) {
    mockOpenDialogHandler = handlers.open;
  }
  if (handlers.openFolder !== undefined) {
    mockOpenFolderDialogHandler = handlers.openFolder;
  }
  if (handlers.save !== undefined) {
    mockSaveDialogHandler = handlers.save;
  }
  if (handlers.ask !== undefined) {
    mockAskDialogHandler = handlers.ask;
  }
  if (handlers.prompt !== undefined) {
    mockPromptDialogHandler = handlers.prompt;
  }
}

export function setMockSaveInterceptor(
  interceptor: MockSaveInterceptor | null,
): void {
  mockSaveInterceptor = interceptor;
}

export function seedMockDir(path: string): void {
  const norm = normalizePath(path);
  if (!norm) return;
  registerAncestorDirs(norm, true);
}

export function seedMockFile(
  path: string,
  content: string,
  mtimeMs?: number,
): void {
  const norm = normalizePath(path);
  if (!norm) return;
  registerAncestorDirs(norm, false);
  mockFiles.set(norm, {
    content,
    mtimeMs: mtimeMs ?? nextMockTimestampMs(),
  });
}

export function readMockFile(path: string): string | undefined {
  return mockFiles.get(normalizePath(path))?.content;
}

export function deleteMockFile(path: string): boolean {
  return mockFiles.delete(normalizePath(path));
}

export function getMockWatchedFolder(): string | null {
  return mockWatchedFolder;
}

export function getMockWatchedOpenFiles(): string[] {
  return [...mockWatchedOpenFiles];
}

export function seedMockCustomTheme(stem: string, css: string): void {
  const trimmed = stem.trim();
  if (!trimmed) return;
  mockCustomThemes.set(trimmed, css);
}

// Preload /demo folder and default custom themes when module initializes
seedDemoFolder();
seedDefaultCustomThemes();

export async function openFile(path: string): Promise<string> {
  if (isTauri()) {
    return invoke<string>("open_file", { path });
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const norm = normalizePath(path);
  const entry = mockFiles.get(norm);
  if (!entry) {
    throw createAppError("NotFound", `File not found: ${path}`);
  }
  return entry.content;
}

export async function openFileSnapshot(path: string): Promise<FileSnapshot> {
  if (isTauri()) {
    const snap = await invoke<FileSnapshot>("open_file_snapshot", { path });
    return { ...snap, path: toSlashPath(snap.path) };
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const norm = normalizePath(path);
  const entry = mockFiles.get(norm);
  if (!entry) {
    throw createAppError("NotFound", `File not found: ${path}`);
  }
  const size = new TextEncoder().encode(entry.content).byteLength;
  return {
    path: norm,
    content: entry.content,
    mtimeMs: entry.mtimeMs,
    size,
    hash: sha256Hex(entry.content),
  };
}

export async function statFileSnapshot(path: string): Promise<FileDiskState> {
  if (isTauri()) {
    const state = await invoke<FileDiskState>("stat_file_snapshot", { path });
    return { ...state, path: toSlashPath(state.path) };
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const norm = normalizePath(path);
  const entry = mockFiles.get(norm);
  if (!entry) {
    return { status: "missing", path: norm };
  }
  const size = new TextEncoder().encode(entry.content).byteLength;
  return {
    status: "exists",
    path: norm,
    mtimeMs: entry.mtimeMs,
    size,
    hash: sha256Hex(entry.content),
  };
}

export interface SaveFileOptions {
  isAutosave?: boolean;
}

export async function saveFile(
  path: string,
  content: string,
  options?: SaveFileOptions,
): Promise<FileMeta> {
  if (isTauri()) {
    const meta = await invoke<FileMeta>("save_file", {
      path,
      content,
      isAutosave: Boolean(options?.isAutosave),
    });
    return { ...meta, path: toSlashPath(meta.path) };
  }
  const defaultSave = async (): Promise<FileMeta> => {
    if (!path || !path.trim()) {
      throw createAppError("InvalidPath", "Path must not be empty");
    }
    const norm = normalizePath(path);
    if (mockDirs.has(norm)) {
      throw createAppError(
        "InvalidPath",
        `Target path is a directory: ${path}`,
      );
    }
    const mtimeMs = nextMockTimestampMs();
    const previous = mockFiles.get(norm);
    if (previous) {
      maybeSnapshotMockHistory(
        norm,
        previous.content,
        content,
        Boolean(options?.isAutosave),
        mtimeMs,
      );
    }
    const size = new TextEncoder().encode(content).byteLength;
    registerAncestorDirs(norm, false);
    mockFiles.set(norm, { content, mtimeMs });
    return { path: norm, mtimeMs, size };
  };
  if (mockSaveInterceptor) {
    return mockSaveInterceptor(path, content, defaultSave);
  }
  return defaultSave();
}

export async function saveFileChecked(
  path: string,
  content: string,
  expectedHash?: string | null,
  options?: SaveFileOptions,
): Promise<SaveFileResult> {
  if (isTauri()) {
    const res = await invoke<SaveFileResult>("save_file_checked", {
      path,
      content,
      expectedHash: expectedHash ?? null,
      isAutosave: Boolean(options?.isAutosave),
    });
    return { ...res, path: toSlashPath(res.path) };
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const norm = normalizePath(path);
  if (mockDirs.has(norm)) {
    throw createAppError("InvalidPath", `Target path is a directory: ${path}`);
  }
  if (expectedHash !== undefined && expectedHash !== null) {
    const existing = mockFiles.get(norm);
    if (!existing) {
      return { status: "missing", path: norm };
    }
    const diskHash = sha256Hex(existing.content);
    if (diskHash !== expectedHash) {
      const size = new TextEncoder().encode(existing.content).byteLength;
      return {
        status: "conflict",
        path: norm,
        mtimeMs: existing.mtimeMs,
        size,
        diskHash,
      };
    }
  }
  const meta = await saveFile(path, content, options);
  return {
    status: "saved",
    path: meta.path,
    mtimeMs: meta.mtimeMs,
    size: meta.size,
    hash: sha256Hex(content),
  };
}

function assertValidMockDir(path: string): string {
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const norm = normalizePath(path);
  if (mockFiles.has(norm)) {
    throw createAppError("InvalidPath", `Path is not a directory: ${path}`);
  }
  const prefix = norm === "/" ? "/" : `${norm}/`;
  const hasDescendant =
    mockDirs.has(norm) ||
    Array.from(mockFiles.keys()).some((k) => k.startsWith(prefix)) ||
    Array.from(mockDirs).some((d) => d.startsWith(prefix));
  if (!hasDescendant) {
    throw createAppError("NotFound", `Directory not found: ${path}`);
  }
  mockDirs.add(norm);
  return norm;
}

function compareNamesCaseInsensitive(a: string, b: string): number {
  const aLower = a.toLowerCase();
  const bLower = b.toLowerCase();
  if (aLower < bLower) return -1;
  if (aLower > bLower) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function buildMockTree(dirPath: string): TreeNode {
  const name =
    dirPath === "/"
      ? "/"
      : dirPath.slice(dirPath.lastIndexOf("/") + 1) || dirPath;
  const prefix = dirPath === "/" ? "/" : `${dirPath}/`;

  const childDirNames = new Set<string>();
  const childFileNames = new Set<string>();

  for (const d of mockDirs) {
    if (!d.startsWith(prefix) || d === dirPath) continue;
    const rest = d.slice(prefix.length);
    const slashIdx = rest.indexOf("/");
    const firstSeg = slashIdx === -1 ? rest : rest.slice(0, slashIdx);
    if (firstSeg && !isIgnoredName(firstSeg)) {
      childDirNames.add(firstSeg);
    }
  }

  for (const f of mockFiles.keys()) {
    if (!f.startsWith(prefix)) continue;
    const rest = f.slice(prefix.length);
    const slashIdx = rest.indexOf("/");
    if (slashIdx === -1) {
      if (rest && !isIgnoredName(rest) && isMarkdownName(rest)) {
        childFileNames.add(rest);
      }
    } else {
      const firstSeg = rest.slice(0, slashIdx);
      if (firstSeg && !isIgnoredName(firstSeg)) {
        childDirNames.add(firstSeg);
      }
    }
  }

  const children: TreeNode[] = [];

  for (const dirName of childDirNames) {
    const childPath = dirPath === "/" ? `/${dirName}` : `${dirPath}/${dirName}`;
    children.push(buildMockTree(childPath));
  }

  for (const fileName of childFileNames) {
    const childPath =
      dirPath === "/" ? `/${fileName}` : `${dirPath}/${fileName}`;
    children.push({
      name: fileName,
      path: childPath,
      kind: "file",
    });
  }

  children.sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "dir" ? -1 : 1;
    }
    return compareNamesCaseInsensitive(a.name, b.name);
  });

  return {
    name,
    path: dirPath,
    kind: "dir",
    children,
  };
}

export async function readTree(path: string): Promise<TreeNode> {
  if (isTauri()) {
    return normalizeTreeNode(await invoke<TreeNode>("read_tree", { path }));
  }
  const norm = assertValidMockDir(path);
  return buildMockTree(norm);
}

export async function listFiles(path: string): Promise<FileEntry[]> {
  if (isTauri()) {
    const entries = await invoke<FileEntry[]>("list_files", { path });
    return entries.map((e) => ({ ...e, path: toSlashPath(e.path) }));
  }
  const norm = assertValidMockDir(path);
  const prefix = norm === "/" ? "/" : `${norm}/`;
  const entries: FileEntry[] = [];

  for (const [filePath, record] of mockFiles.entries()) {
    if (!filePath.startsWith(prefix)) continue;
    const relative = filePath.slice(prefix.length);
    const segments = relative.split("/");
    if (segments.some((seg) => isIgnoredName(seg))) {
      continue;
    }
    const fileName = segments[segments.length - 1];
    if (!fileName || !isMarkdownName(fileName)) {
      continue;
    }
    entries.push({
      path: filePath,
      name: fileName,
      mtimeMs: record.mtimeMs,
      excerpt: extractExcerpt(record.content),
    });
  }

  entries.sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    const byName = compareNamesCaseInsensitive(a.name, b.name);
    if (byName !== 0) return byName;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  return entries;
}

/** #104: lightweight list of Markdown file paths under `root` (Rust: list_markdown_paths). */
export async function listMarkdownPaths(
  root: string,
): Promise<MarkdownPathsResult> {
  if (isTauri()) {
    const res = await invoke<MarkdownPathsResult>("list_markdown_paths", {
      root,
    });
    return {
      paths: res.paths.map((p) => toSlashPath(p)),
      truncated: res.truncated,
    };
  }
  mockListMarkdownPathsCalls += 1;
  const norm = assertValidMockDir(root);
  const prefix = norm === "/" ? "/" : `${norm}/`;
  const all = [...mockFiles.keys()]
    .filter((p) => {
      if (!p.startsWith(prefix)) return false;
      const segs = p.slice(prefix.length).split("/");
      return !segs.some(isIgnoredName) && isMarkdownName(segs[segs.length - 1]);
    })
    .sort((a, b) => {
      const sa = a.slice(prefix.length).split("/");
      const sb = b.slice(prefix.length).split("/");
      for (let i = 0; ; i++) {
        const aFile = i === sa.length - 1;
        const bFile = i === sb.length - 1;
        if (aFile !== bFile) return aFile ? -1 : 1;
        if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
        if (aFile) return 0;
      }
    });
  const truncated = all.length > MAX_QUICK_OPEN_PATHS;
  return {
    paths: truncated ? all.slice(0, MAX_QUICK_OPEN_PATHS) : all,
    truncated,
  };
}

export function getMockListMarkdownPathsCallCount(): number {
  return mockListMarkdownPathsCalls;
}

export function resetMockListMarkdownPathsCallCount(): void {
  mockListMarkdownPathsCalls = 0;
}

// ---------------------------------------------------------------------------
// #73 B: folder search
// ---------------------------------------------------------------------------

export interface FolderSearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

export interface FolderSearchHit {
  path: string;
  /** 1-based. */
  line: number;
  /** 1-based, in UTF-16 code units. */
  column: number;
  /** UTF-16 code units. */
  length: number;
  snippet: string;
  snippetMatchStart: number;
  snippetMatchEnd: number;
}

export interface FolderSearchResults {
  hits: FolderSearchHit[];
  truncated: boolean;
  filesSearched: number;
}

export const FOLDER_SEARCH_MAX_RESULTS = 1000;
const SNIPPET_MAX_CHARS = 160;
const SNIPPET_CONTEXT_CHARS = 40;

/** Same snippet rules as src-tauri/src/search.rs (cut on code points). */
export function makeSearchSnippet(
  line: string,
  start: number,
  end: number,
): { snippet: string; matchStart: number; matchEnd: number } {
  const chars = Array.from(line);
  const total = chars.length;
  const hitFrom = Array.from(line.slice(0, start)).length;
  const hitTo = hitFrom + Array.from(line.slice(start, end)).length;
  let from =
    total <= SNIPPET_MAX_CHARS
      ? 0
      : Math.max(0, hitFrom - SNIPPET_CONTEXT_CHARS);
  let to = Math.min(total, from + SNIPPET_MAX_CHARS);
  if (to - from < SNIPPET_MAX_CHARS) from = Math.max(0, to - SNIPPET_MAX_CHARS);
  const ws = (c: string) => /\s/u.test(c);
  while (from < hitFrom && ws(chars[from])) from++;
  while (to > hitTo && to > from && ws(chars[to - 1])) to--;
  const hitEnd = Math.min(hitTo, to);
  const prefix = chars.slice(0, from).some((c) => !ws(c)) ? "…" : "";
  const suffix = chars.slice(to).some((c) => !ws(c)) ? "…" : "";
  const before = chars.slice(from, hitFrom).join("");
  const hit = chars.slice(hitFrom, hitEnd).join("");
  const after = chars.slice(hitEnd, to).join("");
  const matchStart = prefix.length + before.length;
  return {
    snippet: prefix + before + hit + after + suffix,
    matchStart,
    matchEnd: matchStart + hit.length,
  };
}

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}_]/u.test(c);
}

function lastChar(s: string): string | undefined {
  const arr = Array.from(s);
  return arr[arr.length - 1];
}

function buildMockMatcher(query: string, opts: FolderSearchOptions): RegExp {
  const source = opts.regex
    ? query
    : query.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const flags = opts.caseSensitive ? "g" : "gi";
  try {
    return new RegExp(source, `${flags}u`);
  } catch {
    try {
      return new RegExp(source, flags);
    } catch (err) {
      throw createAppError(
        "Parse",
        `Invalid regular expression: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

function mockSearchInFolder(
  root: string,
  query: string,
  opts: FolderSearchOptions,
): FolderSearchResults {
  const norm = assertValidMockDir(root);
  const result: FolderSearchResults = {
    hits: [],
    truncated: false,
    filesSearched: 0,
  };
  if (!query) return result;
  const matcher = buildMockMatcher(query, opts);
  const prefix = norm === "/" ? "/" : `${norm}/`;
  // Files of a folder before its sub-folders, each sorted by name (as Rust).
  const paths = [...mockFiles.keys()]
    .filter((p) => {
      if (!p.startsWith(prefix)) return false;
      const segs = p.slice(prefix.length).split("/");
      return !segs.some(isIgnoredName) && isMarkdownName(segs[segs.length - 1]);
    })
    .sort((a, b) => {
      const sa = a.slice(prefix.length).split("/");
      const sb = b.slice(prefix.length).split("/");
      for (let i = 0; ; i++) {
        const aFile = i === sa.length - 1;
        const bFile = i === sb.length - 1;
        if (aFile !== bFile) return aFile ? -1 : 1;
        if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
        if (aFile) return 0;
      }
    });
  for (const path of paths) {
    result.filesSearched++;
    const lines = mockFiles.get(path)!.content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].endsWith("\r") ? lines[i].slice(0, -1) : lines[i];
      matcher.lastIndex = 0;
      for (let m = matcher.exec(line); m; m = matcher.exec(line)) {
        if (m[0] === "") {
          matcher.lastIndex++;
          continue;
        }
        const start = m.index;
        const end = start + m[0].length;
        if (opts.wholeWord) {
          const left =
            isWordChar(lastChar(line.slice(0, start))) &&
            isWordChar(Array.from(m[0])[0]);
          const right =
            isWordChar(lastChar(m[0])) &&
            isWordChar(Array.from(line.slice(end))[0]);
          if (left || right) continue;
        }
        if (result.hits.length >= FOLDER_SEARCH_MAX_RESULTS) {
          result.truncated = true;
          return result;
        }
        const { snippet, matchStart, matchEnd } = makeSearchSnippet(
          line,
          start,
          end,
        );
        result.hits.push({
          path,
          line: i + 1,
          column: start + 1,
          length: m[0].length,
          snippet,
          snippetMatchStart: matchStart,
          snippetMatchEnd: matchEnd,
        });
      }
    }
  }
  return result;
}

/** #73 B: search the Markdown files under `root` (Rust: search_in_folder). */
export async function searchInFolder(
  root: string,
  query: string,
  opts: FolderSearchOptions,
): Promise<FolderSearchResults> {
  if (isTauri()) {
    const res = await invoke<FolderSearchResults>("search_in_folder", {
      root,
      query,
      caseSensitive: opts.caseSensitive,
      wholeWord: opts.wholeWord,
      regex: opts.regex,
    });
    return {
      ...res,
      hits: res.hits.map((h) => ({ ...h, path: toSlashPath(h.path) })),
    };
  }
  return mockSearchInFolder(root, query, opts);
}

export async function watchFolder(path: string): Promise<null> {
  if (isTauri()) {
    return invoke<null>("watch_folder", { path });
  }
  const norm = assertValidMockDir(path);
  mockWatchedFolder = norm;
  return null;
}

export async function watchOpenFiles(paths: string[]): Promise<null> {
  if (isTauri()) {
    return invoke<null>("watch_open_files", { paths });
  }
  mockWatchedOpenFiles = paths
    .map((p) => normalizePath(p))
    .filter((p) => p.length > 0);
  return null;
}

export async function createFile(path: string): Promise<FileMeta> {
  if (isTauri()) {
    const meta = await invoke<FileMeta>("create_file", { path });
    return { ...meta, path: toSlashPath(meta.path) };
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const norm = normalizePath(path);
  if (mockFiles.has(norm) || mockDirs.has(norm)) {
    throw createAppError("AlreadyExists", `File already exists: ${path}`);
  }
  registerAncestorDirs(norm, false);
  const mtimeMs = nextMockTimestampMs();
  mockFiles.set(norm, { content: "", mtimeMs });
  return { path: norm, mtimeMs, size: 0 };
}

export async function renamePath(from: string, to: string): Promise<null> {
  if (isTauri()) {
    return invoke<null>("rename_path", { from, to });
  }
  if (!from || !from.trim() || !to || !to.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const normFrom = normalizePath(from);
  const normTo = normalizePath(to);

  const isFile = mockFiles.has(normFrom);
  const isDir = mockDirs.has(normFrom);
  if (!isFile && !isDir) {
    throw createAppError("NotFound", `Source path does not exist: ${from}`);
  }
  if (normFrom !== normTo && (mockFiles.has(normTo) || mockDirs.has(normTo))) {
    throw createAppError("AlreadyExists", `Destination already exists: ${to}`);
  }

  if (isFile) {
    const record = mockFiles.get(normFrom)!;
    mockFiles.delete(normFrom);
    registerAncestorDirs(normTo, false);
    mockFiles.set(normTo, {
      content: record.content,
      mtimeMs: nextMockTimestampMs(),
    });
    return null;
  }

  // Rename directory and all nested dirs & files
  const prefix = `${normFrom}/`;
  const dirsToMove = Array.from(mockDirs).filter(
    (d) => d === normFrom || d.startsWith(prefix),
  );
  for (const d of dirsToMove) {
    mockDirs.delete(d);
  }
  for (const d of dirsToMove) {
    const relocated =
      d === normFrom ? normTo : `${normTo}${d.slice(normFrom.length)}`;
    registerAncestorDirs(relocated, true);
  }

  const filesToMove = Array.from(mockFiles.entries()).filter(([f]) =>
    f.startsWith(prefix),
  );
  for (const [f] of filesToMove) {
    mockFiles.delete(f);
  }
  for (const [f, rec] of filesToMove) {
    const relocated = `${normTo}${f.slice(normFrom.length)}`;
    registerAncestorDirs(relocated, false);
    mockFiles.set(relocated, rec);
  }

  return null;
}

export async function trashPath(path: string): Promise<null> {
  if (isTauri()) {
    return invoke<null>("trash_path", { path });
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const norm = normalizePath(path);
  const isFile = mockFiles.has(norm);
  const isDir = mockDirs.has(norm);
  if (!isFile && !isDir) {
    throw createAppError("NotFound", `Path does not exist: ${path}`);
  }

  if (isFile) {
    mockFiles.delete(norm);
    return null;
  }

  const prefix = `${norm}/`;
  for (const d of Array.from(mockDirs)) {
    if (d === norm || d.startsWith(prefix)) {
      mockDirs.delete(d);
    }
  }
  for (const f of Array.from(mockFiles.keys())) {
    if (f.startsWith(prefix)) {
      mockFiles.delete(f);
    }
  }
  return null;
}

export async function onFsChanged(
  listener: FsChangedListener,
): Promise<() => void> {
  if (isTauri()) {
    return listen<FsChangedPayload>("fs-changed", (event) => {
      void listener({
        root: toSlashPath(event.payload.root),
        paths: event.payload.paths.map((p) => toSlashPath(p)),
      });
    });
  }
  mockFsChangedListeners.add(listener);
  return () => {
    mockFsChangedListeners.delete(listener);
  };
}

export async function triggerMockFsChanged(
  payload?: Partial<FsChangedPayload> | string,
): Promise<void> {
  const defaultRoot = mockWatchedFolder ?? "/demo";
  const resolved: FsChangedPayload =
    typeof payload === "string"
      ? { root: mockWatchedFolder ?? payload, paths: [payload] }
      : {
          root: payload?.root ?? defaultRoot,
          paths: payload?.paths ?? [payload?.root ?? defaultRoot],
        };
  for (const listener of Array.from(mockFsChangedListeners)) {
    await listener(resolved);
  }
}

export async function onOpenFilesChanged(
  listener: OpenFilesChangedListener,
): Promise<() => void> {
  if (isTauri()) {
    return listen<OpenFilesChangedPayload>("open-files-changed", (event) => {
      void listener({
        paths: event.payload.paths.map((p) => toSlashPath(p)),
      });
    });
  }
  mockOpenFilesChangedListeners.add(listener);
  return () => {
    mockOpenFilesChangedListeners.delete(listener);
  };
}

export async function triggerMockOpenFilesChanged(
  paths: string[],
): Promise<void> {
  const payload: OpenFilesChangedPayload = {
    paths: paths.map((p) => normalizePath(p)).filter((p) => p.length > 0),
  };
  if (payload.paths.length === 0) return;
  for (const listener of Array.from(mockOpenFilesChangedListeners)) {
    await listener(payload);
  }
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
    const list = await invoke<RecoveryEntry[]>("list_recovery");
    return list.map((e) => ({ ...e, path: toSlashPath(e.path) }));
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

export async function getActiveUiLocale(): Promise<UiLocale> {
  if (isTauri()) {
    return normalizeUiLocale(await invoke<UiLocale>("get_active_ui_locale"));
  }
  mockActiveUiLocale ??=
    parseUiLocale(mockSettings.uiLocale) ??
    defaultUiLocaleForTag(mockSystemLocale);
  return mockActiveUiLocale;
}

export async function setUiLocale(locale: UiLocale): Promise<void> {
  if (isTauri()) {
    await invoke("set_ui_locale", { locale });
    return;
  }
  if (mockSettingsWriteError) throw mockSettingsWriteError;
  mockSettings = { ...mockSettings, uiLocale: locale };
}

export async function getSettings(): Promise<Settings> {
  if (isTauri()) {
    const s = await invoke<Settings>("get_settings");
    const uiLocale = parseUiLocale(s.uiLocale);
    return {
      ...s,
      systemDarkTheme: s.systemDarkTheme === "nyx" ? "nyx" : "melan",
      ...(uiLocale ? { uiLocale } : { uiLocale: undefined }),
      lastFolder: toSlashPath(s.lastFolder),
      imageRootDir: toSlashPath(s.imageRootDir),
      recentFiles: (s.recentFiles ?? []).map((p) => toSlashPath(p)),
    };
  }
  const uiLocale = parseUiLocale(mockSettings.uiLocale);
  const out: Settings = {
    ...mockSettings,
    systemDarkTheme: mockSettings.systemDarkTheme === "nyx" ? "nyx" : "melan",
    recentFiles: [...(mockSettings.recentFiles ?? [])],
  };
  if (uiLocale) out.uiLocale = uiLocale;
  else delete out.uiLocale;
  return out;
}

export async function setSettings(settings: Settings): Promise<null> {
  if (isTauri()) {
    return invoke<null>("set_settings", { settings });
  }
  if (mockSettingsWriteError) throw mockSettingsWriteError;
  const uiLocale = parseUiLocale(mockSettings.uiLocale);
  mockSettings = {
    ...(uiLocale ? { uiLocale } : {}),
    theme: settings.theme ?? DEFAULT_SETTINGS.theme,
    systemDarkTheme:
      settings.systemDarkTheme === "nyx"
        ? "nyx"
        : settings.systemDarkTheme === "melan"
          ? "melan"
          : (mockSettings.systemDarkTheme ?? DEFAULT_SETTINGS.systemDarkTheme),
    lastFolder: settings.lastFolder ?? DEFAULT_SETTINGS.lastFolder,
    sidebarVisible: settings.sidebarVisible ?? DEFAULT_SETTINGS.sidebarVisible,
    sidebarTab: settings.sidebarTab ?? DEFAULT_SETTINGS.sidebarTab,
    sourceMode: settings.sourceMode ?? DEFAULT_SETTINGS.sourceMode,
    codeLineNumbers:
      settings.codeLineNumbers ?? DEFAULT_SETTINGS.codeLineNumbers,
    mathAutoNumber: settings.mathAutoNumber ?? DEFAULT_SETTINGS.mathAutoNumber,
    imageRootDir: settings.imageRootDir ?? DEFAULT_SETTINGS.imageRootDir,
    focusMode: settings.focusMode ?? DEFAULT_SETTINGS.focusMode,
    typewriterMode: settings.typewriterMode ?? DEFAULT_SETTINGS.typewriterMode,
    // Like Rust set_settings: the upload command / args are only ever read from
    // the settings file, never written by the app (IM-05 defence in depth).
    uploadCommand: mockSettings.uploadCommand ?? DEFAULT_SETTINGS.uploadCommand,
    uploadArgs: [
      ...(mockSettings.uploadArgs ?? DEFAULT_SETTINGS.uploadArgs ?? []),
    ],
    uploadOnInsert: settings.uploadOnInsert ?? DEFAULT_SETTINGS.uploadOnInsert,
    autoPairBrackets:
      settings.autoPairBrackets ?? DEFAULT_SETTINGS.autoPairBrackets,
    autoPairMarkdown:
      settings.autoPairMarkdown ?? DEFAULT_SETTINGS.autoPairMarkdown,
    startupBehavior:
      settings.startupBehavior ?? DEFAULT_SETTINGS.startupBehavior,
    autoSave: settings.autoSave ?? DEFAULT_SETTINGS.autoSave,
    autoCheckUpdates:
      settings.autoCheckUpdates ?? DEFAULT_SETTINGS.autoCheckUpdates,
    fontSize: settings.fontSize ?? DEFAULT_SETTINGS.fontSize,
    contentWidth: settings.contentWidth ?? DEFAULT_SETTINGS.contentWidth,
    recentFiles: [
      ...(settings.recentFiles ?? DEFAULT_SETTINGS.recentFiles ?? []),
    ],
    historyEnabled: settings.historyEnabled ?? DEFAULT_SETTINGS.historyEnabled,
    historyMaxVersions:
      settings.historyMaxVersions ?? DEFAULT_SETTINGS.historyMaxVersions,
    historyMaxTotalMb:
      settings.historyMaxTotalMb ?? DEFAULT_SETTINGS.historyMaxTotalMb,
  };
  return null;
}

/** Test hook: replace the mock settings file wholesale (e.g. an old settings.json). */
export function seedMockSettings(settings: Partial<Settings>): void {
  mockSettings = { ...(settings as Settings) };
}

export function setMockSettingsWriteError(error: Error | null): void {
  mockSettingsWriteError = error;
}

export function setMockSystemLocale(tag: string | null): void {
  mockSystemLocale = tag;
  mockActiveUiLocale = undefined;
}

export function setMockRestartError(error: Error | null): void {
  mockRestartError = error;
}

function isValidThemeStem(stem: string): boolean {
  return (
    stem.length > 0 &&
    stem === stem.trim() &&
    !stem.startsWith(".") &&
    !stem.includes("/") &&
    !stem.includes("\\") &&
    !stem.includes("..") &&
    !stem.includes("\0") &&
    !stem.includes(":")
  );
}

export async function listThemes(): Promise<ThemeInfo[]> {
  if (isTauri()) {
    return invoke<ThemeInfo[]>("list_themes");
  }
  const builtins: ThemeInfo[] = [
    { id: "papyros", name: "Papyros", builtin: true },
    { id: "melan", name: "Melan", builtin: true },
    { id: "nyx", name: "Nyx", builtin: true },
  ];
  const customs: ThemeInfo[] = Array.from(mockCustomThemes.keys())
    .filter((stem) => isValidThemeStem(stem))
    .sort((a, b) => compareNamesCaseInsensitive(a, b))
    .map((stem) => ({
      id: `custom:${stem}`,
      name: stem,
      builtin: false,
    }));
  return [...builtins, ...customs];
}

export async function readThemeCss(id: string): Promise<string> {
  if (isTauri()) {
    return invoke<string>("read_theme_css", { id });
  }
  if (!id || !id.startsWith("custom:")) {
    throw createAppError(
      "InvalidPath",
      `Theme id must start with 'custom:': ${id}`,
    );
  }
  const stem = id.slice("custom:".length);
  if (!isValidThemeStem(stem)) {
    throw createAppError("InvalidPath", `Invalid custom theme id: ${id}`);
  }
  const css = mockCustomThemes.get(stem);
  if (css === undefined) {
    throw createAppError("NotFound", `Custom theme not found: ${id}`);
  }
  return css;
}

export async function pickOpenFilePath(): Promise<string | null> {
  if (isTauri()) {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Markdown", extensions: [...MARKDOWN_EXT_LIST] }],
    });
    return typeof selected === "string" ? toSlashPath(selected) : null;
  }
  if (mockOpenDialogHandler) {
    return await mockOpenDialogHandler();
  }
  return null;
}

export async function pickOpenFolderPath(): Promise<string | null> {
  if (isTauri()) {
    const selected = await openDialog({
      multiple: false,
      directory: true,
    });
    return typeof selected === "string" ? toSlashPath(selected) : null;
  }
  if (mockOpenFolderDialogHandler) {
    return await mockOpenFolderDialogHandler();
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
      defaultPath: toNativePath(defaultPath) ?? undefined,
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    return toSlashPath(selected ?? null);
  }
  if (mockSaveDialogHandler) {
    return await mockSaveDialogHandler(defaultPath);
  }
  return null;
}

export async function askDiscardChanges(
  message = t("dialog.discardUntitled"),
): Promise<boolean> {
  if (isTauri()) {
    return askDialog(message, { title: "Kalamos", kind: "warning" });
  }
  if (mockAskDialogHandler) {
    return await mockAskDialogHandler(message);
  }
  return true;
}

export interface SaveChangesLabels {
  yes: string;
  no: string;
  cancel: string;
}

export function saveChangesLabels(saveAll = false): SaveChangesLabels {
  return {
    yes: t(saveAll ? "dialog.saveAll" : "dialog.save"),
    no: t("dialog.dontSave"),
    cancel: t("dialog.cancel"),
  };
}

/** #81: 儲存 / 不儲存 / 取消 before closing a tab (or the window) with unsaved changes. */
export async function askSaveChanges(
  message: string,
  labels: SaveChangesLabels = saveChangesLabels(),
): Promise<SaveChangesChoice> {
  if (isTauri()) {
    const result = await messageDialog(message, {
      title: "Kalamos",
      kind: "warning",
      buttons: { ...labels },
    });
    // The plugin answers with the button key ("Yes") or, on some platforms, its label.
    if (result === "Yes" || result === labels.yes) return "save";
    if (result === "No" || result === labels.no) return "discard";
    return "cancel";
  }
  mockSaveChangesPrompts.push(message);
  if (mockSaveChangesDialogHandler) {
    return await mockSaveChangesDialogHandler(message);
  }
  return "discard";
}

export function getMockSaveChangesPrompts(): string[] {
  return [...mockSaveChangesPrompts];
}

/** #81: the window title follows the active tab. */
export async function setWindowTitle(title: string): Promise<void> {
  if (typeof document !== "undefined") document.title = title;
  if (isTauri()) {
    await getCurrentWindow().setTitle(title);
    return;
  }
  mockWindowTitle = title;
}

export function getMockWindowTitle(): string {
  return mockWindowTitle;
}

export function hasMockPromptHandler(): boolean {
  return mockPromptDialogHandler !== null;
}

export async function promptMockInput(
  message: string,
  defaultValue?: string,
): Promise<string | null> {
  if (mockPromptDialogHandler) {
    return await mockPromptDialogHandler(message, defaultValue);
  }
  return null;
}

/** The handler returns false to keep the window open (#81 B: 取消 at the unsaved prompt). */
export type WindowCloseHandler = () => boolean | void | Promise<boolean | void>;

export async function onWindowCloseRequested(
  handler: WindowCloseHandler,
): Promise<() => void> {
  if (isTauri()) {
    return getCurrentWindow().onCloseRequested(async (event) => {
      if ((await handler()) === false) event.preventDefault();
    });
  }
  mockCloseListeners.add(handler);
  return () => {
    mockCloseListeners.delete(handler);
  };
}

/** Resolves to whether the window would close (no listener kept it open). */
export async function triggerMockCloseRequested(): Promise<boolean> {
  let close = true;
  for (const listener of Array.from(mockCloseListeners)) {
    if ((await listener()) === false) close = false;
  }
  return close;
}

let mockQuitCount = 0;
let mockRestartCount = 0;

/** #81 B: exit the app (⌘Q), once the frontend has settled unsaved changes. */
export async function quitApp(): Promise<void> {
  if (isTauri()) {
    await invoke("quit_app");
    return;
  }
  mockQuitCount++;
}

export function getMockQuitCount(): number {
  return mockQuitCount;
}

export async function restartApp(): Promise<void> {
  if (isTauri()) {
    await invoke("restart_app");
    return;
  }
  if (mockRestartError) throw mockRestartError;
  mockRestartCount++;
}

export function getMockRestartCount(): number {
  return mockRestartCount;
}

// ---------------------------------------------------------------------------
// Images (IM-01 / IM-02)
// ---------------------------------------------------------------------------

export interface ImportedImage {
  relativePath: string;
}

export const IMPORTABLE_IMAGE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
] as const;

export interface FileDropPayload {
  paths: string[];
  /** CSS pixel position relative to the webview viewport (absent: insert at the cursor). */
  position?: { x: number; y: number };
}

type FileDropListener = (payload: FileDropPayload) => void | Promise<void>;
const mockFileDropListeners = new Set<FileDropListener>();

function dirnameOf(path: string): string {
  const norm = normalizePath(path);
  const idx = norm.lastIndexOf("/");
  if (idx <= 0) return idx === 0 ? "/" : "";
  return norm.slice(0, idx);
}

function encodeMarkdownPath(name: string): string {
  return name.replace(
    /[% ()<>]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function mockImportUnique(
  docPath: string,
  stem: string,
  ext: string,
): ImportedImage {
  const dir = dirnameOf(docPath);
  if (!dir) {
    throw createAppError(
      "InvalidPath",
      `Cannot resolve document folder: ${docPath}`,
    );
  }
  const assetsDir = `${dir === "/" ? "" : dir}/assets`;
  for (let n = 0; n < 10000; n++) {
    const name = n === 0 ? `${stem}.${ext}` : `${stem}-${n}.${ext}`;
    const full = `${assetsDir}/${name}`;
    if (mockAssetFiles.has(full) || mockFiles.has(full)) continue;
    mockAssetFiles.add(full);
    mockDirs.add(assetsDir);
    return { relativePath: `assets/${encodeMarkdownPath(name)}` };
  }
  throw createAppError("AlreadyExists", `Too many files named ${stem}.${ext}`);
}

function mockValidateImageExt(ext: string): string {
  const lower = ext.trim().replace(/^\./, "").toLowerCase();
  if (!(IMPORTABLE_IMAGE_EXTS as readonly string[]).includes(lower)) {
    throw createAppError("InvalidPath", `Unsupported image type: .${lower}`);
  }
  return lower;
}

/** Copy an image into `<doc folder>/assets/` and return its Markdown relative path. */
export async function importImage(
  docPath: string,
  sourcePath: string,
): Promise<ImportedImage> {
  if (isTauri()) {
    return invoke<ImportedImage>("import_image", { docPath, sourcePath });
  }
  if (!docPath || !docPath.trim()) {
    throw createAppError(
      "InvalidPath",
      "Document must be saved before importing images",
    );
  }
  const fileName = normalizePath(sourcePath).split("/").pop() ?? "";
  const dot = fileName.lastIndexOf(".");
  if (dot <= 0) {
    throw createAppError("InvalidPath", `Unsupported image type: ${fileName}`);
  }
  const ext = mockValidateImageExt(fileName.slice(dot + 1));
  return mockImportUnique(docPath, fileName.slice(0, dot), ext);
}

/** Store clipboard image bytes (base64) as `assets/pasted-YYYYMMDD-HHMMSS.<ext>`. */
export async function importImageBytes(
  docPath: string,
  bytes: string,
  ext: string,
): Promise<ImportedImage> {
  if (isTauri()) {
    return invoke<ImportedImage>("import_image_bytes", { docPath, bytes, ext });
  }
  if (!docPath || !docPath.trim()) {
    throw createAppError(
      "InvalidPath",
      "Document must be saved before importing images",
    );
  }
  const lower = mockValidateImageExt(ext);
  if (!bytes) {
    throw createAppError("Parse", "Empty image data");
  }
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return mockImportUnique(docPath, `pasted-${stamp}`, lower);
}

/** Allow a folder (or a file's folder) in the asset protocol scope. */
/** Message prefix of the Rust `allow_asset_dir` "too broad" rejection. */
export const ASSET_DIR_TOO_BROAD_MESSAGE = "Image root folder is too broad";
/** Home folder used by the in-memory mock for the "too broad" check. */
export const MOCK_HOME_DIR = "/Users/kalamos";

/** True when `allowAssetDir` refused a folder for being `/` or home / an ancestor of home. */
export function isAssetDirTooBroadError(err: unknown): boolean {
  const e = err as Partial<AppError> | null;
  return (
    !!e &&
    e.kind === "InvalidPath" &&
    typeof e.message === "string" &&
    e.message.startsWith(ASSET_DIR_TOO_BROAD_MESSAGE)
  );
}

export async function allowAssetDir(path: string): Promise<null> {
  if (isTauri()) {
    return invoke<null>("allow_asset_dir", { path });
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const norm = normalizePath(path);
  // Like the Rust command: a file path allows its parent folder.
  if (mockFiles.has(norm)) {
    mockAllowedAssetDirs.add(dirnameOf(norm));
    return null;
  }
  // Like the Rust command: refuse `/` and the home folder or any ancestor of it.
  if (
    norm === "/" ||
    MOCK_HOME_DIR === norm ||
    MOCK_HOME_DIR.startsWith(`${norm}/`)
  ) {
    throw createAppError(
      "InvalidPath",
      `${ASSET_DIR_TOO_BROAD_MESSAGE}: ${path}`,
    );
  }
  mockAllowedAssetDirs.add(norm);
  return null;
}

/** Image types the asset scope may expose one file at a time (matches Rust `DISPLAY_IMAGE_EXTS`). */
export const DISPLAY_IMAGE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "avif",
  "tiff",
  "tif",
  "heic",
];

/**
 * #69: allow exactly one image file (not its folder) in the asset protocol
 * scope, e.g. `../images/pic.png` outside the document folder. The backend
 * resolves symlinks and refuses folders, missing files and non-images.
 */
export async function allowAssetFile(path: string): Promise<null> {
  if (isTauri()) {
    return invoke<null>("allow_asset_file", { path: toNativePath(path) });
  }
  if (!path || !path.trim() || !isAbsolutePath(path)) {
    throw createAppError("InvalidPath", `Image path must be absolute: ${path}`);
  }
  const norm = normalizePath(path);
  if (mockDirs.has(norm)) {
    throw createAppError("InvalidPath", `Not a file: ${path}`);
  }
  const name = norm.slice(norm.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
  if (!DISPLAY_IMAGE_EXTS.includes(ext)) {
    throw createAppError("InvalidPath", `Not an image file: ${path}`);
  }
  mockAllowedAssetFiles.add(norm);
  return null;
}

export function getMockAllowedAssetFiles(): string[] {
  return Array.from(mockAllowedAssetFiles);
}

export function getMockAllowedAssetDirs(): string[] {
  return Array.from(mockAllowedAssetDirs);
}

export function getMockAssetFiles(): string[] {
  return Array.from(mockAssetFiles);
}

/** URL that loads a local file in the WebView (asset protocol under Tauri). */
export function localFileUrl(path: string): string {
  if (isTauri()) {
    return convertFileSrc(toNativePath(path));
  }
  return `asset://localhost/${encodeURIComponent(path)}`;
}

/** Listen for files dropped onto the window (Tauri drag & drop gives real paths). */
export async function onFileDrop(
  listener: FileDropListener,
): Promise<() => void> {
  if (isTauri()) {
    return getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const ratio =
        typeof window !== "undefined" && window.devicePixelRatio > 0
          ? window.devicePixelRatio
          : 1;
      void listener({
        paths: event.payload.paths.map((p) => toSlashPath(p)),
        position: {
          x: event.payload.position.x / ratio,
          y: event.payload.position.y / ratio,
        },
      });
    });
  }
  mockFileDropListeners.add(listener);
  return () => {
    mockFileDropListeners.delete(listener);
  };
}

export async function triggerMockFileDrop(
  payload: FileDropPayload,
): Promise<void> {
  for (const listener of Array.from(mockFileDropListeners)) {
    await listener(payload);
  }
}

// ---------------------------------------------------------------------------
// Open with Kalamos (#67): files handed over by Finder / Dock / `open -a`
// ---------------------------------------------------------------------------

/** Mirrors `open_with::OpenFilesRequest`: paths are already filtered and canonical. */
export interface OpenFilesRequest {
  paths: string[];
  /** Names of what the OS handed over but Kalamos refused (not a Markdown regular file). */
  rejected: string[];
}

export const OPEN_FILES_EVENT = "kalamos://open-files";

type OpenFilesListener = (req: OpenFilesRequest) => void | Promise<void>;
const mockOpenFilesListeners = new Set<OpenFilesListener>();
let mockOpenFilesReady = false;
let mockPendingOpenFiles: OpenFilesRequest = { paths: [], rejected: [] };

/** Listen for open requests that arrive after the frontend is ready. */
export async function onOpenFilesRequested(
  listener: OpenFilesListener,
): Promise<() => void> {
  if (isTauri()) {
    return listen<OpenFilesRequest>(OPEN_FILES_EVENT, (event) => {
      void listener({
        paths: event.payload.paths.map((p) => toSlashPath(p)),
        rejected: event.payload.rejected,
      });
    });
  }
  mockOpenFilesListeners.add(listener);
  return () => {
    mockOpenFilesListeners.delete(listener);
  };
}

/** Mark the frontend ready and take what the OS queued before it was (cold launch). */
export async function takePendingOpenFiles(): Promise<OpenFilesRequest> {
  if (isTauri()) {
    const req = await invoke<OpenFilesRequest>("take_pending_open_files");
    return {
      paths: req.paths.map((p) => toSlashPath(p)),
      rejected: req.rejected,
    };
  }
  mockOpenFilesReady = true;
  const taken = mockPendingOpenFiles;
  mockPendingOpenFiles = { paths: [], rejected: [] };
  return taken;
}

/**
 * Mock stand-in for `RunEvent::Opened`: queued until `takePendingOpenFiles`
 * runs (cold launch), delivered to listeners afterwards (app already running).
 */
export async function triggerMockOpenFiles(
  req: Partial<OpenFilesRequest>,
): Promise<void> {
  const full: OpenFilesRequest = {
    paths: [...(req.paths ?? [])],
    rejected: [...(req.rejected ?? [])],
  };
  if (full.paths.length === 0 && full.rejected.length === 0) return;
  if (!mockOpenFilesReady) {
    mockPendingOpenFiles.paths.push(...full.paths);
    mockPendingOpenFiles.rejected.push(...full.rejected);
    return;
  }
  for (const listener of Array.from(mockOpenFilesListeners)) {
    await listener(full);
  }
}

// ---------------------------------------------------------------------------
// PDF export (EX-01)
// ---------------------------------------------------------------------------

export interface PdfHeading {
  level: number;
  text: string;
  id: string;
}

export interface MockPdfExport {
  outPath: string;
  html: string;
  headings: PdfHeading[];
}

const mockPdfExports: MockPdfExport[] = [];
type MockExportPdfHandler = (
  job: MockPdfExport,
) => FileMeta | Promise<FileMeta>;
let mockExportPdfHandler: MockExportPdfHandler | null = null;

/** Save dialog for the exported PDF (`defaultPath` = suggested file path or name). */
export async function pickSavePdfPath(
  defaultPath: string,
): Promise<string | null> {
  if (isTauri()) {
    const selected = await saveDialog({
      defaultPath: toNativePath(defaultPath),
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    return toSlashPath(selected ?? null);
  }
  if (mockSaveDialogHandler) {
    return await mockSaveDialogHandler(defaultPath);
  }
  return null;
}

/** Render `html` to an A4 PDF at `outPath` with bookmarks built from `headings`. */
export async function exportPdf(
  html: string,
  outPath: string,
  headings: PdfHeading[],
): Promise<FileMeta> {
  if (isTauri()) {
    const meta = await invoke<FileMeta>("export_pdf", {
      html,
      outPath,
      headings,
    });
    return { ...meta, path: toSlashPath(meta.path) };
  }
  if (!outPath || !outPath.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const job: MockPdfExport = {
    outPath: normalizePath(outPath),
    html,
    headings,
  };
  if (mockExportPdfHandler) {
    return mockExportPdfHandler(job);
  }
  mockPdfExports.push(job);
  return {
    path: job.outPath,
    mtimeMs: nextMockTimestampMs(),
    size: new TextEncoder().encode(html).byteLength,
  };
}

export function getMockPdfExports(): MockPdfExport[] {
  return mockPdfExports.slice();
}

export function setMockExportPdfHandler(
  handler: MockExportPdfHandler | null,
): void {
  mockExportPdfHandler = handler;
}

// ---------------------------------------------------------------------------
// EX-02 / EX-03: Pandoc export / import (#16)
// ---------------------------------------------------------------------------

export interface PandocStatus {
  available: boolean;
  path: string | null;
  version: string | null;
}

export interface PandocExportRequest {
  docPath: string | null;
  markdown: string;
  format: string;
  outPath: string;
  imageRoot?: string | null;
  toc?: boolean;
}

export interface PandocImportResult {
  markdown: string;
  /** Folder embedded images were extracted to (absolute paths in `markdown`). */
  mediaDir: string | null;
}

const DEFAULT_MOCK_PANDOC_STATUS: PandocStatus = {
  available: true,
  path: "/opt/homebrew/bin/pandoc",
  version: "3.1.11 (mock)",
};
let mockPandocStatus: PandocStatus = { ...DEFAULT_MOCK_PANDOC_STATUS };
const mockPandocExports: PandocExportRequest[] = [];
type MockPandocExportHandler = (
  req: PandocExportRequest,
) => FileMeta | Promise<FileMeta>;
type MockPandocImportHandler = (
  path: string,
) => PandocImportResult | Promise<PandocImportResult>;
let mockPandocExportHandler: MockPandocExportHandler | null = null;
let mockPandocImportHandler: MockPandocImportHandler | null = null;

const PANDOC_FORMATS_MOCK = ["docx", "odt", "latex", "mediawiki", "epub"];
const PANDOC_IMPORT_EXTS_MOCK = [
  "docx",
  "odt",
  "epub",
  "tex",
  "latex",
  "html",
  "htm",
  "wiki",
  "mediawiki",
];
const PANDOC_MISSING = "找不到 Pandoc：請先安裝（brew install pandoc）";
const PANDOC_TOO_OLD_FOR_IMPORT = "Pandoc 版本過舊，匯入需要 2.15 以上";

/** Like Rust `supports_sandbox`: imports need pandoc ≥ 2.15 (`--sandbox`). */
function mockSupportsSandbox(version: string | null): boolean {
  const m = /^(?:pandoc\s+)?(\d+)(?:\.(\d+))?/.exec((version ?? "").trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2] ?? 0);
  return major > 2 || (major === 2 && minor >= 15);
}

/** Canned Markdown the mock returns for an import. */
export const MOCK_PANDOC_IMPORT_MARKDOWN =
  "# 匯入的標題\n\n## 第二層\n\n### 第三層\n\n- 項目一\n- 項目二\n\n| a | b |\n| - | - |\n| 1 | 2 |\n";

/** Whether pandoc is installed (`recheck` forces a new lookup). */
export async function pandocStatus(recheck = false): Promise<PandocStatus> {
  if (isTauri()) {
    return invoke<PandocStatus>("pandoc_status", { recheck });
  }
  return { ...mockPandocStatus };
}

/** Convert `markdown` with pandoc to `format`, written atomically to `outPath`. */
export async function exportPandoc(
  req: PandocExportRequest,
): Promise<FileMeta> {
  if (isTauri()) {
    const meta = await invoke<FileMeta>("export_pandoc", {
      docPath: req.docPath,
      markdown: req.markdown,
      format: req.format,
      outPath: req.outPath,
      imageRoot: req.imageRoot ?? null,
      toc: Boolean(req.toc),
    });
    return { ...meta, path: toSlashPath(meta.path) };
  }
  if (!mockPandocStatus.available)
    throw createAppError(
      "NotFound",
      PANDOC_MISSING,
      IS_WINDOWS ? "export.pandoc.missingWindows" : "export.pandoc.missingMac",
    );
  if (!req.outPath || !req.outPath.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  if (!PANDOC_FORMATS_MOCK.includes(req.format)) {
    throw createAppError("InvalidPath", `不支援的匯出格式：${req.format}`);
  }
  const job: PandocExportRequest = {
    ...req,
    outPath: normalizePath(req.outPath),
  };
  if (mockPandocExportHandler) return mockPandocExportHandler(job);
  mockPandocExports.push(job);
  return {
    path: job.outPath,
    mtimeMs: nextMockTimestampMs(),
    size: new TextEncoder().encode(req.markdown).byteLength,
  };
}

/** Convert a DOCX / ODT / EPUB / LaTeX / HTML / MediaWiki file to Markdown. */
export async function importPandoc(path: string): Promise<PandocImportResult> {
  if (isTauri()) {
    const res = await invoke<PandocImportResult>("import_pandoc", { path });
    return { ...res, mediaDir: toSlashPath(res.mediaDir) };
  }
  if (!path || !path.trim())
    throw createAppError("InvalidPath", "Path must not be empty");
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!path.includes(".") || !PANDOC_IMPORT_EXTS_MOCK.includes(ext)) {
    throw createAppError("InvalidPath", `不支援匯入的檔案類型：.${ext}`);
  }
  if (!mockPandocStatus.available)
    throw createAppError(
      "NotFound",
      PANDOC_MISSING,
      IS_WINDOWS ? "export.pandoc.missingWindows" : "export.pandoc.missingMac",
    );
  if (!mockSupportsSandbox(mockPandocStatus.version)) {
    throw createAppError(
      "Io",
      PANDOC_TOO_OLD_FOR_IMPORT,
      "errors.pandoc.tooOldForImport",
    );
  }
  if (mockPandocImportHandler)
    return mockPandocImportHandler(normalizePath(path));
  return { markdown: MOCK_PANDOC_IMPORT_MARKDOWN, mediaDir: null };
}

/** Save dialog for an export (`defaultPath` = suggested path, `ext` = format extension). */
export async function pickSaveExportPath(
  defaultPath: string,
  label: string,
  ext: string,
): Promise<string | null> {
  if (isTauri()) {
    const selected = await saveDialog({
      defaultPath: toNativePath(defaultPath),
      filters: [{ name: label, extensions: [ext] }],
    });
    return toSlashPath(selected ?? null);
  }
  if (mockSaveDialogHandler) return await mockSaveDialogHandler(defaultPath);
  return null;
}

/** Open dialog for a file to import. */
export async function pickImportPath(
  extensions: string[],
): Promise<string | null> {
  if (isTauri()) {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: t("dialog.importableFiles"), extensions }],
    });
    return typeof selected === "string" ? toSlashPath(selected) : null;
  }
  if (mockOpenDialogHandler) return await mockOpenDialogHandler();
  return null;
}

export function setMockPandocAvailable(available: boolean): void {
  mockPandocStatus = available
    ? { ...DEFAULT_MOCK_PANDOC_STATUS }
    : { available: false, path: null, version: null };
}

/** Pretend a specific pandoc version is installed (e.g. "2.14.2" to test the import refusal). */
export function setMockPandocVersion(version: string | null): void {
  mockPandocStatus = { ...DEFAULT_MOCK_PANDOC_STATUS, version };
}

export function getMockPandocExports(): PandocExportRequest[] {
  return mockPandocExports.slice();
}

export function setMockPandocExportHandler(
  handler: MockPandocExportHandler | null,
): void {
  mockPandocExportHandler = handler;
}

export function setMockPandocImportHandler(
  handler: MockPandocImportHandler | null,
): void {
  mockPandocImportHandler = handler;
}

// ---------------------------------------------------------------------------
// Image upload (IM-05)
// ---------------------------------------------------------------------------

export const UPLOADER_NOT_CONFIGURED_MESSAGE =
  "尚未設定圖床上傳指令（見 docs/image-upload.md）";

export interface UploadResult {
  /** One URL per path, same order. */
  urls: string[];
}

type MockUploadHandler = (
  paths: string[],
) => UploadResult | Promise<UploadResult>;
let mockUploadHandler: MockUploadHandler | null = null;
const mockUploadCalls: string[][] = [];

/** Upload local images with the uploader configured in settings (uploadCommand / uploadArgs). */
export async function uploadImages(paths: string[]): Promise<UploadResult> {
  if (isTauri()) {
    return invoke<UploadResult>("upload_images", { paths });
  }
  mockUploadCalls.push([...paths]);
  if (mockUploadHandler) return mockUploadHandler(paths);
  if (!mockSettings.uploadCommand || !mockSettings.uploadCommand.trim()) {
    throw createAppError(
      "NotFound",
      UPLOADER_NOT_CONFIGURED_MESSAGE,
      "errors.upload.notConfigured",
    );
  }
  return {
    urls: paths.map((p) => {
      const name = normalizePath(p).split("/").pop() ?? "image";
      return `https://mock-images.kalamos.test/${encodeURIComponent(name)}`;
    }),
  };
}

/** Mock stand-in for the user editing `uploadCommand` / `uploadArgs` in settings.json. */
export function seedMockUploadSettings(
  uploadCommand: string | null,
  uploadArgs: string[] = [],
): void {
  mockSettings = {
    ...mockSettings,
    uploadCommand,
    uploadArgs: [...uploadArgs],
  };
}

export function setMockUploadHandler(handler: MockUploadHandler | null): void {
  mockUploadHandler = handler;
}

export function getMockUploadCalls(): string[][] {
  return mockUploadCalls.map((c) => [...c]);
}

// ---------------------------------------------------------------------------
// #74: native menu bar + preferences.

export const MENU_ACTION_EVENT = "menu-action";

export interface MenuActionPayload {
  action: string;
  arg?: string | null;
}

export interface RecentMenuEntry {
  path: string;
  label: string;
}

export interface MenuSyncState {
  checks: Record<string, boolean>;
  theme: string;
  themes: Array<{ id: string; label: string }>;
  recentFiles?: RecentMenuEntry[];
}

type MenuActionListener = (payload: MenuActionPayload) => void | Promise<void>;
const mockMenuActionListeners = new Set<MenuActionListener>();
let mockMenuState: MenuSyncState | null = null;
let mockZoom = 1;
let mockThemesDirOpened = 0;

/** A native menu item was chosen (Rust emits `menu-action`). */
export async function onMenuAction(
  listener: MenuActionListener,
): Promise<() => void> {
  if (isTauri()) {
    return listen<MenuActionPayload>(MENU_ACTION_EVENT, (event) => {
      void listener(event.payload);
    });
  }
  mockMenuActionListeners.add(listener);
  return () => {
    mockMenuActionListeners.delete(listener);
  };
}

/** Test hook: act as if a native menu item had been chosen. */
export async function emitMockMenuAction(
  action: string,
  arg: string | null = null,
): Promise<void> {
  for (const listener of Array.from(mockMenuActionListeners)) {
    await listener({ action, arg });
  }
}

/** Updates the check marks of the native menu. */
export async function syncMenuState(state: MenuSyncState): Promise<null> {
  if (isTauri()) {
    return invoke<null>("sync_menu_state", { state });
  }
  mockMenuState = JSON.parse(JSON.stringify(state)) as MenuSyncState;
  return null;
}

export function getMockMenuState(): MenuSyncState | null {
  return mockMenuState;
}

/** 檢視 > 實際大小 / 放大 / 縮小. */
export async function setWebviewZoom(factor: number): Promise<void> {
  if (isTauri()) {
    await getCurrentWebview().setZoom(factor);
    return;
  }
  mockZoom = factor;
}

export function getMockZoom(): number {
  return mockZoom;
}

/** Shows the custom CSS theme folder in Finder; resolves with its path. */
export async function openThemesDir(): Promise<string> {
  if (isTauri()) {
    return toSlashPath(await invoke<string>("open_themes_dir"));
  }
  mockThemesDirOpened += 1;
  return "/mock/app-data/themes";
}

export function getMockThemesDirOpenCount(): number {
  return mockThemesDirOpened;
}

// ---------------------------------------------------------------------------
// #91: in-app auto-updater (tauri-plugin-updater)
// ---------------------------------------------------------------------------

export type UpdateDownloadEvent =
  | { event: "Started"; data: { contentLength?: number } }
  | { event: "Progress"; data: { chunkLength: number } }
  | { event: "Finished" };

export interface AvailableUpdate {
  version: string;
  currentVersion: string;
  date?: string;
  body?: string;
  download: (onEvent?: (event: UpdateDownloadEvent) => void) => Promise<void>;
  install: () => Promise<void>;
  close: () => Promise<void>;
}

type MockUpdateHandler = () =>
  | AvailableUpdate
  | null
  | Promise<AvailableUpdate | null>;

let mockUpdateHandler: MockUpdateHandler | null = null;
let mockUpdateCheckCount = 0;

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (isTauri()) {
    const update = await checkUpdater();
    if (!update) return null;
    return {
      version: update.version,
      currentVersion: update.currentVersion,
      date: update.date,
      body: update.body,
      download: (onEvent) => update.download(onEvent),
      install: () => update.install(),
      close: () => update.close(),
    };
  }
  mockUpdateCheckCount += 1;
  if (mockUpdateHandler) {
    return await mockUpdateHandler();
  }
  return null;
}

export function setMockUpdateHandler(handler: MockUpdateHandler | null): void {
  mockUpdateHandler = handler;
}

export function getMockUpdateCheckCount(): number {
  return mockUpdateCheckCount;
}

// ---------------------------------------------------------------------------
// #144: Copy as Rich Text / HTML (clipboard HTML + local image data URI)
// ---------------------------------------------------------------------------

export const MAX_IMAGE_DATA_URI_BYTES = 2 * 1024 * 1024;

export interface ImageDataUriResult {
  status: "ok" | "tooLarge";
  dataUri: string | null;
  size: number;
}

export interface ClipboardHtmlPayload {
  html: string;
  plainText: string;
}

type MockClipboardHtmlHandler = (
  payload: ClipboardHtmlPayload,
) => void | Promise<void>;

const mockImageDataUris = new Map<string, { dataUri: string; size: number }>();
let mockLastClipboardHtml: ClipboardHtmlPayload | null = null;
let mockClipboardHtmlHandler: MockClipboardHtmlHandler | null = null;

/** Seed a mock local image for `readImageDataUri` in non-Tauri environments. */
export function seedMockImageDataUri(
  path: string,
  dataUri: string,
  size?: number,
): void {
  const norm = normalizePath(path);
  if (!norm) return;
  const approxSize = size ?? new TextEncoder().encode(dataUri).byteLength;
  mockImageDataUris.set(norm, { dataUri, size: approxSize });
}

/** Read a local image file as a `data:` URI if within `maxBytes` (<= 2 MB). */
export async function readImageDataUri(
  path: string,
  maxBytes: number = MAX_IMAGE_DATA_URI_BYTES,
): Promise<ImageDataUriResult> {
  if (isTauri()) {
    return invoke<ImageDataUriResult>("read_image_data_uri", {
      path: toNativePath(path),
      maxBytes,
    });
  }
  const norm = normalizePath(path);
  const entry = mockImageDataUris.get(norm);
  if (!entry) {
    throw createAppError("NotFound", `Image not found: ${path}`);
  }
  const effectiveMax = Math.min(maxBytes, MAX_IMAGE_DATA_URI_BYTES);
  if (entry.size > effectiveMax) {
    return { status: "tooLarge", dataUri: null, size: entry.size };
  }
  return { status: "ok", dataUri: entry.dataUri, size: entry.size };
}

/**
 * Write both `text/html` and `text/plain` to the system clipboard.
 * - Tauri desktop: uses `@tauri-apps/plugin-clipboard-manager` (`writeHtml`),
 *   which works reliably from native menu events and after async rendering on
 *   both macOS WKWebView and Windows WebView2 (proper CF_HTML + CF_UNICODETEXT).
 * - Browser / test environment: writes via `navigator.clipboard.write(ClipboardItem)`
 *   when available and records the payload in the mock state.
 */
export async function writeClipboardHtml(
  html: string,
  plainText: string,
): Promise<void> {
  if (isTauri()) {
    await writeClipboardHtmlPlugin(html, plainText);
    return;
  }
  const payload: ClipboardHtmlPayload = { html, plainText };
  if (mockClipboardHtmlHandler) {
    await mockClipboardHtmlHandler(payload);
    mockLastClipboardHtml = payload;
    return;
  }
  mockLastClipboardHtml = payload;
  if (
    typeof navigator !== "undefined" &&
    navigator.clipboard &&
    typeof navigator.clipboard.write === "function" &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plainText], { type: "text/plain" }),
        }),
      ]);
    } catch {
      // Browser environments without clipboard-write permission still keep mockLastClipboardHtml.
    }
  }
}

export function getMockClipboardHtml(): ClipboardHtmlPayload | null {
  return mockLastClipboardHtml ? { ...mockLastClipboardHtml } : null;
}

export function setMockClipboardHtmlHandler(
  handler: MockClipboardHtmlHandler | null,
): void {
  mockClipboardHtmlHandler = handler;
}

// ---------------------------------------------------------------------------
// #148: Local Version History
// ---------------------------------------------------------------------------

export interface HistoryVersion {
  id: string;
  savedAtMs: number;
  size: number;
}

export interface HistoryStats {
  totalBytes: number;
  totalVersions: number;
  fileCount: number;
}

interface MockHistoryRecord extends HistoryVersion {
  content: string;
}

const DEFAULT_MOCK_HISTORY_THROTTLE_MS = 5 * 60 * 1000;
const mockHistory = new Map<string, MockHistoryRecord[]>();
let mockHistoryThrottleMs = DEFAULT_MOCK_HISTORY_THROTTLE_MS;

function enforceMockHistoryLimits(): void {
  const maxMb = Math.min(
    2048,
    Math.max(
      10,
      Math.round(
        mockSettings.historyMaxTotalMb ??
          DEFAULT_SETTINGS.historyMaxTotalMb ??
          200,
      ),
    ),
  );
  const maxBytes = maxMb * 1024 * 1024;
  let totalBytes = 0;
  const all: Array<{ path: string; rec: MockHistoryRecord }> = [];
  for (const [p, list] of mockHistory.entries()) {
    for (const rec of list) {
      totalBytes += rec.size;
      all.push({ path: p, rec });
    }
  }
  if (totalBytes <= maxBytes) return;
  all.sort((a, b) => a.rec.savedAtMs - b.rec.savedAtMs);
  for (const item of all) {
    if (totalBytes <= maxBytes) break;
    const list = mockHistory.get(item.path);
    if (!list) continue;
    const idx = list.findIndex((r) => r.id === item.rec.id);
    if (idx >= 0) {
      list.splice(idx, 1);
      totalBytes = Math.max(0, totalBytes - item.rec.size);
      if (list.length === 0) mockHistory.delete(item.path);
    }
  }
}

function maybeSnapshotMockHistory(
  normPath: string,
  oldContent: string,
  newContent: string,
  isAutosave: boolean,
  nowMs: number,
): void {
  if (mockSettings.historyEnabled === false) return;
  if (oldContent === newContent) return;
  const list = mockHistory.get(normPath) ?? [];
  const latest = list[0];
  if (latest) {
    if (latest.content === oldContent) return;
    if (isAutosave && nowMs - latest.savedAtMs < mockHistoryThrottleMs) return;
  }
  const savedAtMs =
    latest && nowMs <= latest.savedAtMs ? latest.savedAtMs + 1 : nowMs;
  const size = new TextEncoder().encode(oldContent).byteLength;
  const record: MockHistoryRecord = {
    id: String(savedAtMs),
    savedAtMs,
    size,
    content: oldContent,
  };
  const maxVersions = Math.min(
    500,
    Math.max(
      1,
      Math.round(
        mockSettings.historyMaxVersions ??
          DEFAULT_SETTINGS.historyMaxVersions ??
          50,
      ),
    ),
  );
  const next = [record, ...list].slice(0, maxVersions);
  mockHistory.set(normPath, next);
  enforceMockHistoryLimits();
}

export async function listHistory(path: string): Promise<HistoryVersion[]> {
  if (isTauri()) {
    return invoke<HistoryVersion[]>("list_history", {
      path: toNativePath(path),
    });
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const list = mockHistory.get(normalizePath(path)) ?? [];
  return list.map(({ id, savedAtMs, size }) => ({ id, savedAtMs, size }));
}

export async function readHistoryVersion(
  path: string,
  versionId: string,
): Promise<string> {
  if (isTauri()) {
    return invoke<string>("read_history_version", {
      path: toNativePath(path),
      versionId,
    });
  }
  if (!path || !path.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  if (!versionId || !/^\d+$/.test(versionId)) {
    throw createAppError("InvalidPath", `Invalid versionId: ${versionId}`);
  }
  const list = mockHistory.get(normalizePath(path)) ?? [];
  const found = list.find((v) => v.id === versionId);
  if (!found) {
    throw createAppError("NotFound", `History version not found: ${versionId}`);
  }
  return found.content;
}

export async function getHistoryStats(): Promise<HistoryStats> {
  if (isTauri()) {
    return invoke<HistoryStats>("get_history_stats");
  }
  let totalBytes = 0;
  let totalVersions = 0;
  let fileCount = 0;
  for (const list of mockHistory.values()) {
    if (list.length === 0) continue;
    fileCount += 1;
    totalVersions += list.length;
    for (const v of list) totalBytes += v.size;
  }
  return { totalBytes, totalVersions, fileCount };
}

export async function clearAllHistory(): Promise<void> {
  if (isTauri()) {
    await invoke<null>("clear_all_history");
    return;
  }
  mockHistory.clear();
}

/** Test hook: directly seed a historical snapshot for `path` in non-Tauri environments. */
export function seedMockHistoryVersion(
  path: string,
  content: string,
  savedAtMs?: number,
): HistoryVersion {
  const norm = normalizePath(path);
  const list = mockHistory.get(norm) ?? [];
  const ts = savedAtMs ?? nextMockTimestampMs();
  const size = new TextEncoder().encode(content).byteLength;
  const record: MockHistoryRecord = {
    id: String(ts),
    savedAtMs: ts,
    size,
    content,
  };
  const next = [...list.filter((r) => r.id !== record.id), record].sort(
    (a, b) => b.savedAtMs - a.savedAtMs,
  );
  mockHistory.set(norm, next);
  return { id: record.id, savedAtMs: record.savedAtMs, size: record.size };
}

export function setMockHistoryThrottleMs(ms: number): void {
  mockHistoryThrottleMs = Math.max(0, ms);
}
