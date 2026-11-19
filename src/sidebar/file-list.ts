import type { FileEntry } from "../ipc";

export interface FileListContextTarget {
  path: string;
  kind: "file";
}

export interface FileListOptions {
  container: HTMLElement;
  onSelectFile: (path: string) => void | Promise<void>;
  onContextMenu?: (event: MouseEvent, target: FileListContextTarget) => void;
}

export interface FileListView {
  render: (entries: FileEntry[], activeFilePath?: string | null) => void;
  setActiveFile: (path: string | null) => void;
  destroy: () => void;
}

function sortFileEntries(entries: FileEntry[]): FileEntry[] {
  return [...entries].sort((a, b) => {
    if (b.mtimeMs !== a.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    const aLower = a.name.toLowerCase();
    const bLower = b.name.toLowerCase();
    if (aLower < bLower) return -1;
    if (aLower > bLower) return 1;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

export function createFileList(options: FileListOptions): FileListView {
  const { container, onSelectFile, onContextMenu } = options;
  let currentEntries: FileEntry[] = [];
  let currentActivePath: string | null = null;

  function render(entries: FileEntry[], activeFilePath?: string | null): void {
    currentEntries = entries;
    if (activeFilePath !== undefined) {
      currentActivePath = activeFilePath;
    }
    container.innerHTML = "";

    const sorted = sortFileEntries(entries);
    if (sorted.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "k-sidebar-empty";
      emptyEl.textContent = "尚無 Markdown 檔案";
      container.appendChild(emptyEl);
      return;
    }

    const listEl = document.createElement("div");
    listEl.className = "k-file-list";
    listEl.setAttribute("role", "list");

    for (const entry of sorted) {
      const itemEl = document.createElement("div");
      itemEl.className = "k-file-list-item";
      itemEl.dataset.testid = "file-item";
      itemEl.dataset.path = entry.path;
      itemEl.dataset.active =
        entry.path === currentActivePath ? "true" : "false";
      itemEl.setAttribute("role", "listitem");

      const nameEl = document.createElement("div");
      nameEl.className = "k-file-list-name";
      nameEl.textContent = entry.name;

      const excerptEl = document.createElement("div");
      excerptEl.className = "k-file-list-excerpt";
      excerptEl.textContent = entry.excerpt;

      itemEl.append(nameEl, excerptEl);

      itemEl.addEventListener("click", (e) => {
        e.stopPropagation();
        void onSelectFile(entry.path);
      });

      itemEl.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e, { path: entry.path, kind: "file" });
      });

      listEl.appendChild(itemEl);
    }

    container.appendChild(listEl);
  }

  function setActiveFile(path: string | null): void {
    currentActivePath = path;
    render(currentEntries, currentActivePath);
  }

  function destroy(): void {
    container.innerHTML = "";
  }

  return {
    render,
    setActiveFile,
    destroy,
  };
}
