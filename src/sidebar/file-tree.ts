import type { TreeNode } from "../ipc";
import { shortcutLabel } from "../platform";

export interface FileTreeContextTarget {
  path: string;
  kind: "dir" | "file";
}

export interface FileTreeOptions {
  container: HTMLElement;
  /** #81 B: `newTab` = Cmd+click (always open in a new tab). */
  onSelectFile: (
    path: string,
    options?: { newTab: boolean },
  ) => void | Promise<void>;
  onContextMenu?: (event: MouseEvent, target: FileTreeContextTarget) => void;
}

export interface FileTreeView {
  render: (tree: TreeNode | null, activeFilePath?: string | null) => void;
  getExpandedPaths: () => Set<string>;
  setExpandedPaths: (paths: Iterable<string>) => void;
  toggleDir: (dirPath: string) => boolean;
  expandDir: (dirPath: string) => void;
  isExpanded: (dirPath: string) => boolean;
  setActiveFile: (path: string | null) => void;
  destroy: () => void;
}

function sortTreeChildren(nodes: TreeNode[]): TreeNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) {
      return a.kind === "dir" ? -1 : 1;
    }
    const aLower = a.name.toLowerCase();
    const bLower = b.name.toLowerCase();
    if (aLower < bLower) return -1;
    if (aLower > bLower) return 1;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return 0;
  });
}

export function createFileTree(options: FileTreeOptions): FileTreeView {
  const { container, onSelectFile, onContextMenu } = options;
  let expandedPaths = new Set<string>();
  let currentTree: TreeNode | null = null;
  let currentActivePath: string | null = null;

  function renderNodes(
    nodes: TreeNode[],
    parentEl: HTMLElement,
    depth: number,
  ): void {
    const sorted = sortTreeChildren(nodes);
    for (const node of sorted) {
      if (node.kind === "dir") {
        const isExpanded = expandedPaths.has(node.path);
        const dirRow = document.createElement("div");
        dirRow.className = "k-tree-row k-tree-dir";
        dirRow.dataset.testid = "folder-item";
        dirRow.dataset.path = node.path;
        dirRow.dataset.kind = "dir";
        dirRow.dataset.expanded = isExpanded ? "true" : "false";
        dirRow.setAttribute("role", "treeitem");
        dirRow.setAttribute("aria-expanded", isExpanded ? "true" : "false");
        dirRow.style.paddingLeft = `${12 + depth * 14}px`;

        const chevron = document.createElement("span");
        chevron.className = "k-tree-chevron";
        chevron.innerHTML = `<svg class="k-icon" width="12" height="12" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

        const label = document.createElement("span");
        label.className = "k-tree-label";
        label.textContent = node.name;

        dirRow.append(chevron, label);

        dirRow.addEventListener("click", (e) => {
          e.stopPropagation();
          toggleDir(node.path);
        });

        dirRow.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu?.(e, { path: node.path, kind: "dir" });
        });

        parentEl.appendChild(dirRow);

        if (isExpanded && node.children && node.children.length > 0) {
          const groupEl = document.createElement("div");
          groupEl.className = "k-tree-children";
          groupEl.setAttribute("role", "group");
          renderNodes(node.children, groupEl, depth + 1);
          parentEl.appendChild(groupEl);
        }
      } else {
        const fileRow = document.createElement("div");
        fileRow.className = "k-tree-row k-tree-file";
        fileRow.dataset.testid = "file-item";
        fileRow.dataset.path = node.path;
        fileRow.dataset.kind = "file";
        fileRow.dataset.active =
          node.path === currentActivePath ? "true" : "false";
        fileRow.setAttribute("role", "treeitem");
        fileRow.style.paddingLeft = `${26 + depth * 14}px`;

        const label = document.createElement("span");
        label.className = "k-tree-label";
        label.textContent = node.name;
        fileRow.appendChild(label);

        fileRow.addEventListener("click", (e) => {
          e.stopPropagation();
          void onSelectFile(node.path, { newTab: e.metaKey || e.ctrlKey });
        });

        fileRow.addEventListener("contextmenu", (e) => {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu?.(e, { path: node.path, kind: "file" });
        });

        parentEl.appendChild(fileRow);
      }
    }
  }

  function render(tree: TreeNode | null, activeFilePath?: string | null): void {
    currentTree = tree;
    if (activeFilePath !== undefined) {
      currentActivePath = activeFilePath;
    }
    container.innerHTML = "";
    if (!tree) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "k-sidebar-empty";
      emptyEl.textContent = shortcutLabel("尚未開啟資料夾（Cmd+Shift+O）");
      container.appendChild(emptyEl);
      return;
    }

    const rootChildren = tree.children ?? [];
    if (rootChildren.length === 0) {
      const emptyEl = document.createElement("div");
      emptyEl.className = "k-sidebar-empty";
      emptyEl.textContent = "此資料夾尚無 Markdown 檔案";
      container.appendChild(emptyEl);
      return;
    }

    const treeRoot = document.createElement("div");
    treeRoot.className = "k-tree-root";
    treeRoot.setAttribute("role", "tree");
    renderNodes(rootChildren, treeRoot, 0);
    container.appendChild(treeRoot);
  }

  function toggleDir(dirPath: string): boolean {
    const nextExpanded = !expandedPaths.has(dirPath);
    if (nextExpanded) {
      expandedPaths.add(dirPath);
    } else {
      expandedPaths.delete(dirPath);
    }
    render(currentTree, currentActivePath);
    return nextExpanded;
  }

  function expandDir(dirPath: string): void {
    if (!expandedPaths.has(dirPath)) {
      expandedPaths.add(dirPath);
      render(currentTree, currentActivePath);
    }
  }

  function isExpanded(dirPath: string): boolean {
    return expandedPaths.has(dirPath);
  }

  function getExpandedPaths(): Set<string> {
    return new Set(expandedPaths);
  }

  function setExpandedPaths(paths: Iterable<string>): void {
    expandedPaths = new Set(paths);
    if (currentTree) {
      render(currentTree, currentActivePath);
    }
  }

  function setActiveFile(path: string | null): void {
    currentActivePath = path;
    if (currentTree) {
      render(currentTree, currentActivePath);
    }
  }

  function destroy(): void {
    container.innerHTML = "";
  }

  return {
    render,
    getExpandedPaths,
    setExpandedPaths,
    toggleDir,
    expandDir,
    isExpanded,
    setActiveFile,
    destroy,
  };
}
