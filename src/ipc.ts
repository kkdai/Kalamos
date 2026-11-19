import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
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

export type SidebarTab = "tree" | "list" | "outline";

export interface Settings {
  theme: string;
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
}

export const DEFAULT_SETTINGS: Settings = {
  theme: "system",
  lastFolder: null,
  sidebarVisible: false,
  sidebarTab: "tree",
  sourceMode: false,
  codeLineNumbers: false,
  mathAutoNumber: false,
  imageRootDir: null,
  focusMode: false,
  typewriterMode: false,
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
let mockSettings: Settings = { ...DEFAULT_SETTINGS };
let mockWatchedFolder: string | null = null;
const mockAssetFiles = new Set<string>();
const mockAllowedAssetDirs = new Set<string>();
let lastMockTimestampMs = 0;

type DialogOpenHandler = () => string | null | Promise<string | null>;
type DialogSaveHandler = (
  defaultPath?: string | null,
) => string | null | Promise<string | null>;
type DialogAskHandler = (message: string) => boolean | Promise<boolean>;
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

let mockOpenDialogHandler: DialogOpenHandler | null = null;
let mockOpenFolderDialogHandler: DialogOpenHandler | null = null;
let mockSaveDialogHandler: DialogSaveHandler | null = null;
let mockAskDialogHandler: DialogAskHandler | null = null;
let mockPromptDialogHandler: DialogPromptHandler | null = null;
let mockSaveInterceptor: MockSaveInterceptor | null = null;
const mockCloseListeners = new Set<() => void | Promise<void>>();
const mockFsChangedListeners = new Set<FsChangedListener>();

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

function normalizePath(rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) return "";
  if (trimmed === "/") return "/";
  return trimmed.replace(/\/+$/, "");
}

function registerAncestorDirs(fileOrDirPath: string, includeSelf = false): void {
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
  const lower = name.toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
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
  mockSettings = { ...DEFAULT_SETTINGS };
  mockWatchedFolder = null;
  lastMockTimestampMs = 0;
  mockOpenDialogHandler = null;
  mockOpenFolderDialogHandler = null;
  mockSaveDialogHandler = null;
  mockAskDialogHandler = null;
  mockPromptDialogHandler = null;
  mockSaveInterceptor = null;
  mockCloseListeners.clear();
  mockFsChangedListeners.clear();
  mockAssetFiles.clear();
  mockAllowedAssetDirs.clear();
  mockFileDropListeners.clear();
  mockPdfExports.length = 0;
  mockExportPdfHandler = null;
  mockPandocStatus = { ...DEFAULT_MOCK_PANDOC_STATUS };
  mockPandocExports.length = 0;
  mockPandocExportHandler = null;
  mockPandocImportHandler = null;
  seedDemoFolder();
  seedDefaultCustomThemes();
}

export function setMockDialogHandlers(handlers: {
  open?: DialogOpenHandler | null;
  openFolder?: DialogOpenHandler | null;
  save?: DialogSaveHandler | null;
  ask?: DialogAskHandler | null;
  prompt?: DialogPromptHandler | null;
}): void {
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

export function seedMockFile(path: string, content: string, mtimeMs?: number): void {
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

export function getMockWatchedFolder(): string | null {
  return mockWatchedFolder;
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
    const norm = normalizePath(path);
    if (mockDirs.has(norm)) {
      throw createAppError("InvalidPath", `Target path is a directory: ${path}`);
    }
    const mtimeMs = nextMockTimestampMs();
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
    const childPath = dirPath === "/" ? `/${fileName}` : `${dirPath}/${fileName}`;
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
    return invoke<TreeNode>("read_tree", { path });
  }
  const norm = assertValidMockDir(path);
  return buildMockTree(norm);
}

export async function listFiles(path: string): Promise<FileEntry[]> {
  if (isTauri()) {
    return invoke<FileEntry[]>("list_files", { path });
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

export async function watchFolder(path: string): Promise<null> {
  if (isTauri()) {
    return invoke<null>("watch_folder", { path });
  }
  const norm = assertValidMockDir(path);
  mockWatchedFolder = norm;
  return null;
}

export async function createFile(path: string): Promise<FileMeta> {
  if (isTauri()) {
    return invoke<FileMeta>("create_file", { path });
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
    const relocated = d === normFrom ? normTo : `${normTo}${d.slice(normFrom.length)}`;
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
      void listener(event.payload);
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
    codeLineNumbers:
      settings.codeLineNumbers ?? DEFAULT_SETTINGS.codeLineNumbers,
    mathAutoNumber: settings.mathAutoNumber ?? DEFAULT_SETTINGS.mathAutoNumber,
    imageRootDir: settings.imageRootDir ?? DEFAULT_SETTINGS.imageRootDir,
    focusMode: settings.focusMode ?? DEFAULT_SETTINGS.focusMode,
    typewriterMode: settings.typewriterMode ?? DEFAULT_SETTINGS.typewriterMode,
  };
  return null;
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
    throw createAppError("InvalidPath", `Theme id must start with 'custom:': ${id}`);
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
      filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
    });
    return typeof selected === "string" ? selected : null;
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
    return typeof selected === "string" ? selected : null;
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
  return name.replace(/[% ()<>]/g, (ch) =>
    `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}

function mockImportUnique(docPath: string, stem: string, ext: string): ImportedImage {
  const dir = dirnameOf(docPath);
  if (!dir) {
    throw createAppError("InvalidPath", `Cannot resolve document folder: ${docPath}`);
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
    throw createAppError("InvalidPath", "Document must be saved before importing images");
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
    throw createAppError("InvalidPath", "Document must be saved before importing images");
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
  if (norm === "/" || MOCK_HOME_DIR === norm || MOCK_HOME_DIR.startsWith(`${norm}/`)) {
    throw createAppError("InvalidPath", `${ASSET_DIR_TOO_BROAD_MESSAGE}: ${path}`);
  }
  mockAllowedAssetDirs.add(norm);
  return null;
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
    return convertFileSrc(path);
  }
  return `asset://localhost/${encodeURIComponent(path)}`;
}

/** Listen for files dropped onto the window (Tauri drag & drop gives real paths). */
export async function onFileDrop(listener: FileDropListener): Promise<() => void> {
  if (isTauri()) {
    return getCurrentWebview().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const ratio =
        typeof window !== "undefined" && window.devicePixelRatio > 0
          ? window.devicePixelRatio
          : 1;
      void listener({
        paths: event.payload.paths,
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

export async function triggerMockFileDrop(payload: FileDropPayload): Promise<void> {
  for (const listener of Array.from(mockFileDropListeners)) {
    await listener(payload);
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
type MockExportPdfHandler = (job: MockPdfExport) => FileMeta | Promise<FileMeta>;
let mockExportPdfHandler: MockExportPdfHandler | null = null;

/** Save dialog for the exported PDF (`defaultPath` = suggested file path or name). */
export async function pickSavePdfPath(defaultPath: string): Promise<string | null> {
  if (isTauri()) {
    const selected = await saveDialog({
      defaultPath,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    return selected ?? null;
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
    return invoke<FileMeta>("export_pdf", { html, outPath, headings });
  }
  if (!outPath || !outPath.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  const job: MockPdfExport = { outPath: normalizePath(outPath), html, headings };
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

export function setMockExportPdfHandler(handler: MockExportPdfHandler | null): void {
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
type MockPandocExportHandler = (req: PandocExportRequest) => FileMeta | Promise<FileMeta>;
type MockPandocImportHandler = (path: string) => PandocImportResult | Promise<PandocImportResult>;
let mockPandocExportHandler: MockPandocExportHandler | null = null;
let mockPandocImportHandler: MockPandocImportHandler | null = null;

const PANDOC_FORMATS_MOCK = ["docx", "odt", "latex", "mediawiki", "epub"];
const PANDOC_IMPORT_EXTS_MOCK = ["docx", "odt", "epub", "tex", "latex", "html", "htm", "wiki", "mediawiki"];
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
export async function exportPandoc(req: PandocExportRequest): Promise<FileMeta> {
  if (isTauri()) {
    return invoke<FileMeta>("export_pandoc", {
      docPath: req.docPath,
      markdown: req.markdown,
      format: req.format,
      outPath: req.outPath,
      imageRoot: req.imageRoot ?? null,
      toc: Boolean(req.toc),
    });
  }
  if (!mockPandocStatus.available) throw createAppError("NotFound", PANDOC_MISSING);
  if (!req.outPath || !req.outPath.trim()) {
    throw createAppError("InvalidPath", "Path must not be empty");
  }
  if (!PANDOC_FORMATS_MOCK.includes(req.format)) {
    throw createAppError("InvalidPath", `不支援的匯出格式：${req.format}`);
  }
  const job: PandocExportRequest = { ...req, outPath: normalizePath(req.outPath) };
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
    return invoke<PandocImportResult>("import_pandoc", { path });
  }
  if (!path || !path.trim()) throw createAppError("InvalidPath", "Path must not be empty");
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  if (!path.includes(".") || !PANDOC_IMPORT_EXTS_MOCK.includes(ext)) {
    throw createAppError("InvalidPath", `不支援匯入的檔案類型：.${ext}`);
  }
  if (!mockPandocStatus.available) throw createAppError("NotFound", PANDOC_MISSING);
  if (!mockSupportsSandbox(mockPandocStatus.version)) {
    throw createAppError("Io", PANDOC_TOO_OLD_FOR_IMPORT);
  }
  if (mockPandocImportHandler) return mockPandocImportHandler(normalizePath(path));
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
      defaultPath,
      filters: [{ name: label, extensions: [ext] }],
    });
    return selected ?? null;
  }
  if (mockSaveDialogHandler) return await mockSaveDialogHandler(defaultPath);
  return null;
}

/** Open dialog for a file to import. */
export async function pickImportPath(extensions: string[]): Promise<string | null> {
  if (isTauri()) {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "可匯入的文件", extensions }],
    });
    return typeof selected === "string" ? selected : null;
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

export function setMockPandocExportHandler(handler: MockPandocExportHandler | null): void {
  mockPandocExportHandler = handler;
}

export function setMockPandocImportHandler(handler: MockPandocImportHandler | null): void {
  mockPandocImportHandler = handler;
}
