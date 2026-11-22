import "./sidebar.css";
import type { EditorView } from "@codemirror/view";
import {
  createFile,
  type FileEntry,
  type FolderSearchHit,
  getSettings,
  hasMockPromptHandler,
  isMarkdownName,
  listFiles,
  onFsChanged,
  pickOpenFolderPath,
  promptMockInput,
  readTree,
  renamePath,
  type Settings,
  type SidebarTab,
  setSettings,
  type TreeNode,
  trashPath,
  watchFolder,
} from "../ipc";
import { pathRoot, shortcutLabel, toNativePath } from "../platform";
import { createFileList, type FileListView } from "./file-list";
import { createFileTree, type FileTreeView } from "./file-tree";
import { createFolderSearch, type FolderSearchView } from "./folder-search";
import { createOutline, type OutlineView } from "./outline";

export interface SidebarTabDescriptor {
  id: SidebarTab;
  label: string;
  testId: string;
  render?: (container: HTMLElement) => void;
}

export interface CreateSidebarOptions {
  element: HTMLElement;
  editorView?: EditorView | null;
  /** #81 B: `newTab` = Cmd+click in the file tree / list. */
  onSelectFile: (
    path: string,
    options?: { newTab: boolean },
  ) => void | Promise<void>;
  onPathRenamed?: (fromPath: string, toPath: string) => void | Promise<void>;
  onPathTrashed?: (trashedPath: string) => void | Promise<void>;
  /** #73 B: a folder-search hit was clicked. */
  onOpenSearchHit?: (hit: FolderSearchHit) => void | Promise<void>;
  onError?: (prefix: string, err: unknown) => void;
  /** #74: visibility or tab changed (keeps the native menu check marks in sync). */
  onLayoutChange?: () => void;
}

export interface SidebarInitOptions {
  /** #74: false = do not reopen the last folder (preference "start blank"). */
  restoreFolder?: boolean;
}

export interface SidebarController {
  element: HTMLElement;
  fileTree: FileTreeView;
  fileList: FileListView;
  outline: OutlineView;
  folderSearch: FolderSearchView;
  /** #73 B: Cmd+Shift+F — show the sidebar's search tab and focus its field. */
  openSearch: () => Promise<void>;
  attachEditorView: (view: EditorView) => void;
  isVisible: () => boolean;
  setVisible: (visible: boolean, persist?: boolean) => Promise<void>;
  toggleVisible: () => Promise<boolean>;
  getTab: () => SidebarTab;
  setTab: (tab: SidebarTab, persist?: boolean) => Promise<void>;
  getCurrentFolder: () => string | null;
  openFolder: (explicitPath?: string) => Promise<boolean>;
  refresh: () => Promise<void>;
  setActiveFile: (path: string | null) => void;
  createNewFile: (
    parentDir: string,
    fileName: string,
  ) => Promise<string | null>;
  renameItem: (fromPath: string, newName: string) => Promise<boolean>;
  trashItem: (targetPath: string) => Promise<boolean>;
  registerTab: (descriptor: SidebarTabDescriptor) => void;
  init: (options?: SidebarInitOptions) => Promise<void>;
  destroy: () => void;
}

function dirnameOf(fullPath: string): string {
  const root = pathRoot(fullPath);
  const idx = fullPath.lastIndexOf("/");
  if (idx <= 0) return "/";
  const slice = fullPath.slice(0, idx);
  return root && `${slice}/` === root ? root.replace(/\/+$/, "") : slice;
}

function basenameOf(fullPath: string): string {
  const idx = fullPath.lastIndexOf("/");
  return idx === -1 ? fullPath : fullPath.slice(idx + 1);
}

export function validateSingleFileName(rawName: string): {
  valid: boolean;
  trimmed: string;
  reason?: string;
} {
  const trimmed = rawName.trim();
  if (!trimmed) {
    return { valid: false, trimmed, reason: "名稱不可為空" };
  }
  if (trimmed.includes("/") || trimmed.includes("\\")) {
    return { valid: false, trimmed, reason: "名稱不可包含路徑分隔符號" };
  }
  if (trimmed.includes("..")) {
    return { valid: false, trimmed, reason: "名稱不可包含 .." };
  }
  if (trimmed.startsWith(".")) {
    return { valid: false, trimmed, reason: "名稱不可為隱藏檔（. 開頭）" };
  }
  return { valid: true, trimmed };
}

function ensureMarkdownExtension(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  return isMarkdownName(trimmed) ? trimmed : `${trimmed}.md`;
}

function hasFileExtension(name: string): boolean {
  const dotIdx = name.lastIndexOf(".");
  return dotIdx > 0 && dotIdx < name.length - 1;
}

export function createSidebar(
  options: CreateSidebarOptions,
): SidebarController {
  const { element, onSelectFile, onPathRenamed, onPathTrashed, onError } =
    options;

  element.classList.add("k-sidebar");
  element.dataset.testid = "sidebar";
  if (!element.dataset.visible) {
    element.dataset.visible = "false";
  }

  let visible = element.dataset.visible === "true";
  let currentTab: SidebarTab = "tree";
  let currentFolder: string | null = null;
  let activeFilePath: string | null = null;
  let currentTree: TreeNode | null = null;
  let currentFiles: FileEntry[] = [];
  let unlistenFsChanged: (() => void) | null = null;
  let contextTarget: { path: string; kind: "dir" | "file" } | null = null;

  const tabs: SidebarTabDescriptor[] = [
    { id: "tree", label: "檔案樹", testId: "sidebar-tab-tree" },
    { id: "list", label: "檔案列表", testId: "sidebar-tab-list" },
    { id: "outline", label: "大綱", testId: "sidebar-tab-outline" },
    { id: "search", label: "搜尋", testId: "sidebar-tab-search" },
  ];

  // Build Sidebar DOM structure
  element.innerHTML = "";

  const headerEl = document.createElement("div");
  headerEl.className = "k-sidebar-header";

  const folderTitleEl = document.createElement("span");
  folderTitleEl.className = "k-sidebar-folder-title";
  folderTitleEl.dataset.testid = "sidebar-folder-title";
  folderTitleEl.textContent = "未開啟資料夾";

  const openFolderBtn = document.createElement("button");
  openFolderBtn.type = "button";
  openFolderBtn.className = "k-sidebar-icon-btn";
  openFolderBtn.dataset.testid = "sidebar-open-folder-btn";
  openFolderBtn.title = shortcutLabel("開啟資料夾 (Cmd+Shift+O)");
  openFolderBtn.textContent = "開啟";

  headerEl.append(folderTitleEl, openFolderBtn);

  const tabsEl = document.createElement("div");
  tabsEl.className = "k-sidebar-tabs";
  tabsEl.setAttribute("role", "tablist");

  const inlineSlotEl = document.createElement("div");
  inlineSlotEl.className = "k-sidebar-inline-slot";

  const bodyEl = document.createElement("div");
  bodyEl.className = "k-sidebar-body";

  const contextMenuEl = document.createElement("div");
  contextMenuEl.className = "k-sidebar-context-menu";
  contextMenuEl.dataset.testid = "sidebar-context-menu";
  contextMenuEl.dataset.visible = "false";
  contextMenuEl.setAttribute("role", "menu");

  const createBtn = document.createElement("button");
  createBtn.type = "button";
  createBtn.className = "k-sidebar-context-item";
  createBtn.dataset.testid = "context-menu-create";
  createBtn.dataset.action = "create";
  createBtn.setAttribute("role", "menuitem");
  createBtn.textContent = "新增檔案";

  const renameBtn = document.createElement("button");
  renameBtn.type = "button";
  renameBtn.className = "k-sidebar-context-item";
  renameBtn.dataset.testid = "context-menu-rename";
  renameBtn.dataset.action = "rename";
  renameBtn.setAttribute("role", "menuitem");
  renameBtn.textContent = "重新命名";

  const trashBtn = document.createElement("button");
  trashBtn.type = "button";
  trashBtn.className = "k-sidebar-context-item";
  trashBtn.dataset.testid = "context-menu-trash";
  trashBtn.dataset.action = "trash";
  trashBtn.setAttribute("role", "menuitem");
  trashBtn.textContent = "移到垃圾桶";

  contextMenuEl.append(createBtn, renameBtn, trashBtn);
  element.append(headerEl, tabsEl, inlineSlotEl, bodyEl, contextMenuEl);

  function openContextMenu(
    event: MouseEvent,
    target: { path: string; kind: "dir" | "file" },
  ): void {
    contextTarget = target;
    contextMenuEl.dataset.visible = "true";
    contextMenuEl.dataset.targetPath = target.path;
    contextMenuEl.dataset.targetKind = target.kind;
    const x = event.clientX || 24;
    const y = event.clientY || 64;
    contextMenuEl.style.left = `${x}px`;
    contextMenuEl.style.top = `${y}px`;
  }

  function closeContextMenu(): void {
    contextMenuEl.dataset.visible = "false";
  }

  const fileTree = createFileTree({
    container: bodyEl,
    onSelectFile: async (path, selectOptions) => {
      await onSelectFile(path, selectOptions);
    },
    onContextMenu: (e, target) => {
      openContextMenu(e, target);
    },
  });

  const fileList = createFileList({
    container: bodyEl,
    onSelectFile: async (path, selectOptions) => {
      await onSelectFile(path, selectOptions);
    },
    onContextMenu: (e, target) => {
      openContextMenu(e, target);
    },
  });

  const outline = createOutline({
    container: bodyEl,
    view: options.editorView ?? null,
  });

  const folderSearch = createFolderSearch({
    getFolder: () => currentFolder,
    onOpenHit: async (hit) => {
      await options.onOpenSearchHit?.(hit);
    },
  });

  bodyEl.addEventListener("contextmenu", (e) => {
    if (
      e.defaultPrevented ||
      !currentFolder ||
      currentTab === "outline" ||
      currentTab === "search"
    )
      return;
    e.preventDefault();
    openContextMenu(e, { path: currentFolder, kind: "dir" });
  });

  function renderTabsHeader(): void {
    tabsEl.innerHTML = "";
    for (const tab of tabs) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "k-sidebar-tab";
      btn.dataset.testid = tab.testId;
      btn.dataset.tab = tab.id;
      btn.setAttribute("role", "tab");
      btn.setAttribute(
        "aria-selected",
        tab.id === currentTab ? "true" : "false",
      );
      btn.textContent = tab.label;
      btn.addEventListener("click", () => {
        void setTab(tab.id, true);
      });
      tabsEl.appendChild(btn);
    }
  }

  function renderActiveTabView(): void {
    renderTabsHeader();
    if (currentTab === "tree") {
      outline.setActiveMount(false);
      fileTree.render(currentTree, activeFilePath);
    } else if (currentTab === "list") {
      outline.setActiveMount(false);
      fileList.render(currentFiles, activeFilePath);
    } else if (currentTab === "search") {
      outline.setActiveMount(false);
      // Keep the same DOM (and focus) when the folder data refreshes.
      if (
        folderSearch.element.parentElement !== bodyEl ||
        bodyEl.childElementCount !== 1
      ) {
        bodyEl.innerHTML = "";
        bodyEl.appendChild(folderSearch.element);
      }
      folderSearch.refresh();
    } else if (currentTab === "outline") {
      const customTab = tabs.find((t) => t.id === "outline");
      if (customTab?.render) {
        outline.setActiveMount(false);
        bodyEl.innerHTML = "";
        customTab.render(bodyEl);
      } else {
        outline.setActiveMount(true);
      }
    } else {
      outline.setActiveMount(false);
      fileTree.render(currentTree, activeFilePath);
    }
  }

  async function persistSettingsPatch(patch: Partial<Settings>): Promise<void> {
    try {
      const existing = await getSettings();
      await setSettings({
        ...existing,
        ...patch,
      });
    } catch {
      // Ignore settings persistence failure in UI
    }
  }

  async function setVisible(
    nextVisible: boolean,
    persist = true,
  ): Promise<void> {
    visible = nextVisible;
    element.dataset.visible = visible ? "true" : "false";
    options.onLayoutChange?.();
    if (persist) {
      await persistSettingsPatch({ sidebarVisible: visible });
    }
  }

  async function toggleVisible(): Promise<boolean> {
    await setVisible(!visible, true);
    return visible;
  }

  async function setTab(tab: SidebarTab, persist = true): Promise<void> {
    currentTab = tab;
    renderActiveTabView();
    options.onLayoutChange?.();
    if (persist) {
      await persistSettingsPatch({ sidebarTab: currentTab });
    }
  }

  async function openSearch(): Promise<void> {
    if (!visible) await setVisible(true, true);
    if (currentTab !== "search") await setTab("search", true);
    folderSearch.focusInput();
  }

  async function loadFolderData(folderPath: string): Promise<boolean> {
    const [tree, files] = await Promise.all([
      readTree(folderPath),
      listFiles(folderPath),
    ]);
    currentFolder = folderPath;
    currentTree = tree;
    currentFiles = files;
    folderTitleEl.textContent = basenameOf(folderPath) || folderPath;
    folderTitleEl.title = toNativePath(folderPath);
    renderActiveTabView();
    return true;
  }

  async function refresh(): Promise<void> {
    if (!currentFolder) return;
    try {
      await loadFolderData(currentFolder);
    } catch (err) {
      onError?.("重新整理資料夾失敗", err);
    }
  }

  async function openFolder(
    explicitPath?: string,
    persist = true,
  ): Promise<boolean> {
    let targetPath: string | null = null;
    try {
      targetPath = explicitPath ?? (await pickOpenFolderPath());
    } catch (err) {
      onError?.("開啟資料夾失敗", err);
      return false;
    }
    if (!targetPath) return false;

    try {
      await loadFolderData(targetPath);
      await watchFolder(targetPath);
      if (persist) {
        await persistSettingsPatch({ lastFolder: targetPath });
        // User-initiated open (Cmd+Shift+O / button): reveal the result on the
        // file tree even if the sidebar was hidden. Startup restore
        // (persist = false) keeps the saved visibility and tab.
        if (currentTab !== "tree") {
          await setTab("tree", true);
        }
        if (!visible) {
          await setVisible(true, true);
        }
      }
      return true;
    } catch (err) {
      onError?.("開啟資料夾失敗", err);
      return false;
    }
  }

  async function createNewFile(
    parentDir: string,
    rawFileName: string,
  ): Promise<string | null> {
    const validation = validateSingleFileName(rawFileName);
    if (!validation.valid) {
      onError?.("新增檔案失敗", {
        kind: "InvalidPath",
        message: validation.reason ?? "無效的檔案名稱",
      });
      return null;
    }
    const normalizedName = ensureMarkdownExtension(validation.trimmed);
    const fullPath =
      parentDir === "/"
        ? `/${normalizedName}`
        : `${parentDir.replace(/\/+$/, "")}/${normalizedName}`;
    try {
      await createFile(fullPath);
      fileTree.expandDir(parentDir);
      await refresh();
      await onSelectFile(fullPath);
      return fullPath;
    } catch (err) {
      onError?.("新增檔案失敗", err);
      return null;
    }
  }

  async function renameItem(
    fromPath: string,
    rawNewName: string,
  ): Promise<boolean> {
    const validation = validateSingleFileName(rawNewName);
    if (!validation.valid) {
      onError?.("重新命名失敗", {
        kind: "InvalidPath",
        message: validation.reason ?? "無效的檔案名稱",
      });
      return false;
    }
    const isMarkdownSource = isMarkdownName(basenameOf(fromPath));
    const finalName =
      isMarkdownSource && !hasFileExtension(validation.trimmed)
        ? `${validation.trimmed}.md`
        : validation.trimmed;
    const parentDir = dirnameOf(fromPath);
    const toPath =
      parentDir === "/" ? `/${finalName}` : `${parentDir}/${finalName}`;
    if (toPath === fromPath) return true;
    try {
      await renamePath(fromPath, toPath);
      if (activeFilePath === fromPath) {
        activeFilePath = toPath;
      } else if (activeFilePath && activeFilePath.startsWith(`${fromPath}/`)) {
        activeFilePath = `${toPath}${activeFilePath.slice(fromPath.length)}`;
      }
      await onPathRenamed?.(fromPath, toPath);
      await refresh();
      return true;
    } catch (err) {
      onError?.("重新命名失敗", err);
      return false;
    }
  }

  async function trashItem(targetPath: string): Promise<boolean> {
    try {
      await trashPath(targetPath);
      if (
        activeFilePath === targetPath ||
        (activeFilePath && activeFilePath.startsWith(`${targetPath}/`))
      ) {
        activeFilePath = null;
      }
      await onPathTrashed?.(targetPath);
      await refresh();
      return true;
    } catch (err) {
      onError?.("移到垃圾桶失敗", err);
      return false;
    }
  }

  function showInlineInput(
    defaultValue: string,
    onConfirm: (val: string) => void | Promise<void>,
  ): void {
    inlineSlotEl.innerHTML = "";
    const form = document.createElement("form");
    form.className = "k-sidebar-inline-form";
    form.dataset.testid = "sidebar-inline-form";

    const input = document.createElement("input");
    input.type = "text";
    input.className = "k-sidebar-inline-input";
    input.dataset.testid = "sidebar-inline-input";
    input.value = defaultValue;

    form.appendChild(input);
    inlineSlotEl.appendChild(form);

    let finished = false;
    const closeInline = () => {
      if (finished) return;
      finished = true;
      inlineSlotEl.innerHTML = "";
    };

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const val = input.value;
      closeInline();
      void onConfirm(val);
    });

    input.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        closeInline();
      } else if (e.key === "Enter") {
        e.preventDefault();
        const val = input.value;
        closeInline();
        void onConfirm(val);
      }
    });

    input.focus();
    input.select();
  }

  async function askNameOrShowInline(
    promptLabel: string,
    defaultValue: string,
    onConfirm: (val: string) => void | Promise<void>,
  ): Promise<void> {
    if (hasMockPromptHandler()) {
      const val = await promptMockInput(promptLabel, defaultValue);
      if (val !== null) {
        await onConfirm(val);
      }
      return;
    }
    const winPrompt =
      typeof window !== "undefined"
        ? (window.prompt as unknown as {
            mock?: unknown;
          } & typeof window.prompt)
        : undefined;
    if (typeof winPrompt === "function" && winPrompt.mock) {
      const val = winPrompt(promptLabel, defaultValue);
      if (val !== null) {
        await onConfirm(val);
      }
      return;
    }
    showInlineInput(defaultValue, onConfirm);
  }

  createBtn.addEventListener("click", () => {
    const target = contextTarget;
    closeContextMenu();
    const baseDir =
      target?.kind === "dir"
        ? target.path
        : target?.kind === "file"
          ? dirnameOf(target.path)
          : currentFolder;
    if (!baseDir) return;
    void askNameOrShowInline("新增檔案", "untitled.md", async (fileName) => {
      await createNewFile(baseDir, fileName);
    });
  });

  renameBtn.addEventListener("click", () => {
    const target = contextTarget;
    closeContextMenu();
    if (!target) return;
    const currentName = basenameOf(target.path);
    void askNameOrShowInline("重新命名", currentName, async (newName) => {
      await renameItem(target.path, newName);
    });
  });

  trashBtn.addEventListener("click", () => {
    const target = contextTarget;
    closeContextMenu();
    if (!target) return;
    void trashItem(target.path);
  });

  openFolderBtn.addEventListener("click", () => {
    void openFolder();
  });

  const onDocumentClick = (e: MouseEvent) => {
    if (!contextMenuEl.contains(e.target as Node)) {
      closeContextMenu();
    }
  };

  const onDocumentKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && contextMenuEl.dataset.visible === "true") {
      e.preventDefault();
      closeContextMenu();
    }
  };

  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);

  function setActiveFile(path: string | null): void {
    activeFilePath = path;
    if (currentTab === "tree") {
      fileTree.setActiveFile(path);
    } else if (currentTab === "list") {
      fileList.setActiveFile(path);
    }
  }

  function attachEditorView(view: EditorView): void {
    outline.attachView(view);
  }

  function registerTab(descriptor: SidebarTabDescriptor): void {
    const existingIdx = tabs.findIndex((t) => t.id === descriptor.id);
    if (existingIdx >= 0) {
      tabs[existingIdx] = descriptor;
    } else {
      tabs.push(descriptor);
    }
    renderActiveTabView();
  }

  async function init(initOptions: SidebarInitOptions = {}): Promise<void> {
    unlistenFsChanged = await onFsChanged(async () => {
      if (currentFolder) {
        await refresh();
      }
    });

    const settings = await getSettings().catch(() => null);
    if (settings) {
      await setVisible(Boolean(settings.sidebarVisible), false);
      const savedTab = settings.sidebarTab ?? "tree";
      await setTab(savedTab, false);
      if (settings.lastFolder && initOptions.restoreFolder !== false) {
        await openFolder(settings.lastFolder, false);
      }
    }
  }

  function destroy(): void {
    if (unlistenFsChanged) {
      unlistenFsChanged();
      unlistenFsChanged = null;
    }
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onDocumentKeydown);
    outline.destroy();
    folderSearch.destroy();
    fileTree.destroy();
    fileList.destroy();
    element.innerHTML = "";
  }

  renderActiveTabView();

  return {
    element,
    fileTree,
    fileList,
    outline,
    folderSearch,
    openSearch,
    attachEditorView,
    isVisible: () => visible,
    setVisible,
    toggleVisible,
    getTab: () => currentTab,
    setTab,
    getCurrentFolder: () => currentFolder,
    openFolder: (explicitPath?: string) => openFolder(explicitPath, true),
    refresh,
    setActiveFile,
    createNewFile,
    renameItem,
    trashItem,
    registerTab,
    init,
    destroy,
  };
}
