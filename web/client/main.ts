import "@fontsource/source-serif-4";
import "@fontsource/noto-serif-tc";
import "@fontsource/inter";
import "@fontsource/noto-sans-tc";
import "@fontsource/jetbrains-mono";
import "../../src/styles/tokens.css";
import "../../src/styles/themes/papyros.css";
import "../../src/styles/themes/melan.css";
import "../../src/styles/editor.css";
import "../../src/editor/search.css";
import "../../src/editor/word-count.css";
import "./shell.css";

import { StateEffect } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { openBrowserExternalLink } from "../../src/editor/browser-editor-host";
import { uploadImagesInEditor } from "../../src/editor/image-upload";
import { insertImageMarkdown, readFileAsBase64 } from "../../src/editor/images";
import { createEditor } from "../../src/editor/index";
import {
  jumpToHeadingSlug,
  resolveRelativeMarkdownPath,
} from "../../src/editor/lists";
import { openFind } from "../../src/editor/search";
import { createWordCounter } from "../../src/editor/word-count-view";
import { prepareCandidates, searchQuickOpen } from "../../src/quick-open/fuzzy";
import {
  extractOutlineHeadings,
  findActiveHeadingIndex,
} from "../../src/sidebar/outline";
import {
  type Attachment,
  assetUrl,
  basename,
  type DocumentSummary,
  download,
  json,
  RequestError,
  readMarkdown,
  type StoredDocument,
} from "./api";
import { pandocExport, pandocImport, pdfExport, uploadImage } from "./export";
import {
  createDocument,
  discardDraft,
  type OpenDocument,
  persistDraft,
  readDocument,
  readDraft,
  updateDocument,
} from "./workspace";
import {
  bindWorkspaceControls,
  type WorkspaceView,
} from "./workspace-controls";
import { bindWorkspaceSearch } from "./workspace-search";

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id}`);
  return node as T;
}

function button(label: string, action: () => void) {
  const node = document.createElement("button");
  node.textContent = label;
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function status(message: string) {
  element("workspace-status").textContent = message;
}

function report(error: unknown) {
  status(error instanceof Error ? error.message : String(error));
}

function onClick(id: string, action: () => unknown | Promise<unknown>) {
  element(id).addEventListener(
    "click",
    () => void Promise.resolve().then(action).catch(report),
  );
}

function showDialog(id: string): Promise<boolean> {
  const dialog = element<HTMLDialogElement>(id);
  if (dialog.open) return Promise.resolve(false);
  dialog.returnValue = "cancel";
  return new Promise((resolve) => {
    dialog.addEventListener(
      "close",
      () => resolve(dialog.returnValue === "ok"),
      { once: true },
    );
    dialog.showModal();
  });
}

async function decide(message: string, label: string) {
  element("decision-message").textContent = message;
  element("decision-confirm").textContent = label;
  return showDialog("decision-dialog");
}

async function askPath(title: string, path: string) {
  const input = element<HTMLInputElement>("document-path");
  element("path-heading").textContent = title;
  input.value = path;
  return (await showDialog("path-dialog")) ? input.value.trim() : null;
}

const defaults = {
  theme: "system",
  fontSize: 17,
  contentWidth: 880,
  imageRoot: "",
  customCss: "",
  autosave: true,
  source: false,
  focus: false,
  typewriter: false,
  lineNumbers: false,
  mathNumbers: false,
  pairBrackets: true,
  pairMarkdown: false,
};
let settings = { ...defaults };
let settingsWrite = Promise.resolve();
const tabs = new Map<string, OpenDocument>();
let active: OpenDocument | null = null;
let catalog: DocumentSummary[] = [];
let recent: string[] = [];
let pendingList = 0;
let searchTimer = 0;
let uploadTab: OpenDocument | null = null;
const container = element("editor-container");
const search = element<HTMLInputElement>("workspace-search");
let viewMode: WorkspaceView = "tree";
const collapsedBranches = new Set<string>();
const customStyle = document.createElement("style");
document.head.append(customStyle);

const editor = createEditor({
  parent: container,
  host: {
    resolveLocalImage: assetUrl,
    openExternalLink: openBrowserExternalLink,
  },
  handlers: {
    onOpenFile: () => element("markdown-files").click(),
    onSaveFile: () => {
      if (active) void save(active).catch(report);
    },
    onSaveFileAs: downloadCurrent,
    onNewFile: () => {
      void newDocument().catch(report);
    },
  },
  onSourceModeChange: (source) => updateSetting({ source }),
  onCodeLineNumbersChange: (lineNumbers) => updateSetting({ lineNumbers }),
  onMathAutoNumberChange: (mathNumbers) => updateSetting({ mathNumbers }),
  onFocusModeChange: (focus) => updateSetting({ focus }),
  onTypewriterModeChange: (typewriter) => updateSetting({ typewriter }),
  onAutoPairBracketsChange: (pairBrackets) => updateSetting({ pairBrackets }),
  onAutoPairMarkdownChange: (pairMarkdown) => updateSetting({ pairMarkdown }),
  onUserChange: () => {
    if (!active) return;
    const recoverable = persistDraft(active, editor);
    if (!editor.isSessionDirty(active.session)) {
      status("已儲存");
    } else {
      status(recoverable ? "尚未儲存" : "尚未儲存；瀏覽器無法保留草稿");
    }
    renderTabs();
    if (viewMode === "outline" && !search.value) renderOutline();
    scheduleSave(active);
  },
  onOpenRelativeLink: async (path, slug) => {
    if (!active || uploadTab) return;
    const relative = resolveRelativeMarkdownPath(
      `/${active.record.path}`,
      path,
    ).slice(1);
    const record = catalog.find((candidate) => candidate.path === relative);
    if (!record) return status(`找不到工作區文件：${relative}`);
    try {
      await openDocument(record.id);
      if (slug) jumpToHeadingSlug(editor.view, slug);
    } catch (error) {
      report(error);
    }
  },
  acceptsPastedImage: (file) => Boolean(imageType(file)),
  onPasteImages: (files, view) => {
    void insertImages(files, view.state.selection.main.head).catch(report);
  },
});
const wordCounter = createWordCounter({
  view: editor.view,
  parent: element("workspace-counter"),
});

function applySettings() {
  if (settings.theme === "system")
    delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = settings.theme;
  document.documentElement.style.setProperty(
    "--k-font-size",
    `${settings.fontSize}px`,
  );
  document.documentElement.style.setProperty(
    "--k-max-width",
    `${settings.contentWidth}px`,
  );
  customStyle.textContent = settings.customCss;
  editor.setImageRootDir(settings.imageRoot || null);
  editor.setSourceMode(settings.source);
  editor.setFocusMode(settings.focus);
  editor.setTypewriterMode(settings.typewriter);
  editor.setCodeLineNumbers(settings.lineNumbers);
  editor.setMathAutoNumber(settings.mathNumbers);
  editor.setAutoPairBrackets(settings.pairBrackets);
  editor.setAutoPairMarkdown(settings.pairMarkdown);
  element("source-mode").setAttribute("aria-pressed", String(settings.source));
}

function updateSetting(patch: Partial<typeof defaults>) {
  settings = { ...settings, ...patch };
  applySettings();
  const snapshot = settings;
  settingsWrite = settingsWrite
    .catch(() => {})
    .then(async () => {
      await json("settings", "POST", snapshot);
    });
  void settingsWrite.catch(report);
}

function renderTabs() {
  const list = element("open-documents");
  const focused = list.contains(document.activeElement)
    ? (document.activeElement as HTMLElement).dataset.tabKey
    : undefined;
  list.replaceChildren();
  for (const doc of tabs.values()) {
    const group = document.createElement("span");
    const name = basename(doc.record.path);
    const open = button(
      `${name}${editor.isSessionDirty(doc.session) ? " •" : ""}`,
      () => activate(doc),
    );
    open.dataset.tabKey = doc.record.id;
    open.title = doc.record.path;
    open.setAttribute("aria-current", String(active === doc));
    const close = button("×", () => void closeTab(doc).catch(report));
    close.dataset.tabKey = `${doc.record.id}-close`;
    close.setAttribute("aria-label", `關閉 ${name}`);
    group.append(open, close);
    list.append(group);
  }
  if (focused)
    list
      .querySelector<HTMLElement>(`[data-tab-key="${CSS.escape(focused)}"]`)
      ?.focus();
  for (const node of document.querySelectorAll<HTMLButtonElement>(
    "[data-document]",
  )) {
    node.disabled = !active;
  }
}

function activate(doc: OpenDocument | null) {
  if (uploadTab && doc !== uploadTab) return;
  if (active && active !== doc)
    active.scrollTop = editor.view.scrollDOM.scrollTop;
  active = doc;
  container.hidden = !doc;
  element("empty-workspace").hidden = Boolean(doc);
  if (doc) {
    editor.switchSession(doc.session);
    editor.setDocumentPath(`/${doc.record.path}`);
    editor.view.scrollDOM.scrollTop = doc.scrollTop;
    recent = [
      doc.record.path,
      ...recent.filter((path) => path !== doc.record.path),
    ].slice(0, 20);
    status(editor.isSessionDirty(doc.session) ? "尚未儲存" : "已儲存");
  }
  element("workspace-counter").hidden = !doc;
  wordCounter.flush();
  renderTabs();
  if (viewMode === "outline" && !search.value) renderOutline();
  for (const rowButton of element(
    "workspace-documents",
  ).querySelectorAll<HTMLButtonElement>("[data-document-id]")) {
    rowButton.setAttribute(
      "aria-current",
      String(rowButton.dataset.documentId === doc?.record.id),
    );
  }
}

async function openDocument(id: string, supplied?: StoredDocument) {
  if (uploadTab && uploadTab.record.id !== id)
    return status("請等待圖片上傳完成");
  const existing = tabs.get(id);
  if (existing) return activate(existing);
  const record = supplied ?? (await readDocument(id));
  const current = tabs.get(id);
  if (current) return activate(current);
  if (record.deleted) return;
  const doc: OpenDocument = {
    record,
    session: editor.createSession(record.content),
    queue: Promise.resolve(),
    scrollTop: 0,
  };
  tabs.set(id, doc);
  activate(doc);
  const draft = readDraft(record);
  if (draft) {
    const message =
      draft.revision === record.revision
        ? "有一份尚未寫入資料庫的草稿。要救回嗎？"
        : "資料庫已有較新版本。要將瀏覽器草稿救回為新文件嗎？";
    if (await decide(message, "救回草稿")) {
      if (draft.revision === record.revision) {
        if (active !== doc) return;
        editor.setContent(draft.content, { dirty: true });
        doc.session = editor.getSession();
        doc.recoveredDraft = draft;
        persistDraft(doc, editor);
        wordCounter.flush();
        status("已救回草稿；尚未儲存");
        renderTabs();
      } else {
        const path = await askPath(
          "將草稿存為新文件",
          `${record.path.replace(/\.\w+$/, "")}-recovered.md`,
        );
        if (path) {
          const restored = await createDocument(path, draft.content);
          discardDraft(draft.key, draft.snapshot);
          await openDocument(restored.id, restored);
          await refreshDocuments();
        }
      }
    } else {
      status("已載入資料庫版本；草稿仍保留在瀏覽器");
    }
  }
}

function scheduleSave(doc: OpenDocument) {
  window.clearTimeout(doc.timer);
  if (settings.autosave && editor.isSessionDirty(doc.session)) {
    doc.timer = window.setTimeout(() => void save(doc).catch(report), 1000);
  }
}

async function save(doc: OpenDocument) {
  window.clearTimeout(doc.timer);
  if (!editor.isSessionDirty(doc.session)) return;
  if (active === doc) status("儲存中…");
  try {
    await updateDocument(
      doc,
      () =>
        editor.isSessionDirty(doc.session)
          ? { content: editor.getSessionContent(doc.session) }
          : {},
      editor,
    );
    if (active === doc)
      status(editor.isSessionDirty(doc.session) ? "尚未儲存" : "已儲存");
  } catch (error) {
    if (active === doc)
      status(`尚未儲存：${error instanceof Error ? error.message : error}`);
  }
  renderTabs();
  if (viewMode === "search") workspaceSearch.refresh();
}

async function closeTab(doc: OpenDocument) {
  if (uploadTab === doc) return status("請等待圖片上傳完成");
  if (editor.isSessionDirty(doc.session)) {
    if (!persistDraft(doc, editor)) {
      status("瀏覽器無法保存草稿；請先儲存或下載目前內容。");
      return;
    }
    if (
      !(await decide(
        "文件尚未儲存。關閉分頁但保留瀏覽器中的草稿？",
        "關閉分頁",
      ))
    )
      return;
  }
  window.clearTimeout(doc.timer);
  tabs.delete(doc.record.id);
  if (active === doc) activate(Array.from(tabs.values()).at(-1) ?? null);
  else renderTabs();
}

function downloadCurrent() {
  if (!active) return;
  download(
    new Blob([editor.getContent()], { type: "text/markdown;charset=utf-8" }),
    basename(active.record.path),
  );
}

async function newDocument() {
  const path = await askPath("新建 Markdown 文件", "Untitled.md");
  if (!path) return;
  const record = await createDocument(path, "");
  await openDocument(record.id, record);
  await refreshDocuments();
}

function row(record: DocumentSummary) {
  const item = document.createElement("li");
  if (record.deleted) {
    item.append(
      button(`還原 ${record.path}`, () => void restore(record).catch(report)),
    );
  } else {
    const label =
      viewMode === "tree" && !search.value
        ? basename(record.path)
        : record.path;
    const open = button(
      label,
      () => void openDocument(record.id).catch(report),
    );
    open.title = record.path;
    open.dataset.documentId = record.id;
    open.setAttribute("aria-current", String(record.id === active?.record.id));
    item.append(open);
  }
  return item;
}

function renderOutline() {
  const headings = document.createElement("ul");
  if (active) {
    const state = editor.view.state;
    const all = extractOutlineHeadings(state);
    const selected = findActiveHeadingIndex(all, state.selection.main.head);
    for (const [index, heading] of all.entries()) {
      const item = document.createElement("li");
      item.style.paddingInlineStart = `${heading.level - 1}em`;
      const headingButton = button(heading.text, () => {
        editor.setCursor(heading.from);
        editor.view.dispatch({
          effects: EditorView.scrollIntoView(heading.from, { y: "center" }),
        });
        editor.view.focus();
      });
      if (index === selected)
        headingButton.setAttribute("aria-current", "true");
      item.append(headingButton);
      headings.append(item);
    }
  }
  element("workspace-documents").replaceChildren(headings);
}

async function refreshDocuments() {
  const sequence = ++pendingList;
  const mode = viewMode;
  if (mode === "search") workspaceSearch.refresh();
  const query = new URLSearchParams({
    q: mode === "search" ? "" : search.value,
  });
  if (mode === "trash") query.set("trash", "1");
  const [all, match] = await Promise.all([
    json<DocumentSummary[]>("documents"),
    mode === "trash" || (mode !== "search" && search.value)
      ? json<DocumentSummary[]>(`documents?${query}`)
      : null,
  ]);
  if (sequence !== pendingList) return;
  catalog = all;
  if (mode === "search") return;
  if (mode === "outline" && !search.value) return renderOutline();
  const list = document.createElement("ul");
  const branches = new Map<string, HTMLUListElement>([["", list]]);
  for (const record of match ?? all) {
    const parts =
      mode === "tree" && !search.value
        ? record.path.split("/").slice(0, -1)
        : [];
    let parent = list;
    let path = "";
    for (const name of parts) {
      path += `/${name}`;
      let branch = branches.get(path);
      if (!branch) {
        const item = document.createElement("li");
        const details = document.createElement("details");
        const branchPath = path;
        details.open = !collapsedBranches.has(branchPath);
        details.addEventListener("toggle", () => {
          if (!details.isConnected) return;
          if (details.open) collapsedBranches.delete(branchPath);
          else collapsedBranches.add(branchPath);
        });
        const summary = document.createElement("summary");
        summary.textContent = name;
        branch = document.createElement("ul");
        details.append(summary, branch);
        item.append(details);
        parent.append(item);
        branches.set(path, branch);
      }
      parent = branch;
    }
    parent.append(row(record));
  }
  element("workspace-documents").replaceChildren(list);
}

async function restore(record: DocumentSummary) {
  await json(`documents/${record.id}`, "PATCH", {
    revision: record.revision,
    deleted: false,
  });
  await refreshDocuments();
  status("已還原");
}

const markdownName = /\.(md|markdown|mdown|mkd|mkdn|mdwn)$/i;

async function importFiles(files: File[], folder = false) {
  const entryPath = (file: File) =>
    folder ? file.webkitRelativePath || file.name : file.name;
  const markdown = files.filter((file) => markdownName.test(file.name));
  if (!markdown.length) return status("沒有可匯入的 Markdown 檔");
  const attachments = folder
    ? await Promise.all(
        files
          .filter((file) => imageType(file))
          .map(async (file) => attachment(file, entryPath(file))),
      )
    : [];
  let imported = 0;
  let lastImportedId: string | undefined;
  try {
    for (const file of markdown) {
      const record = await createDocument(
        entryPath(file),
        await readMarkdown(file),
        imported === 0 ? attachments : [],
      );
      imported++;
      lastImportedId = record.id;
      await openDocument(record.id, record);
    }
  } catch (error) {
    throw new Error(
      `已匯入 ${imported} 份文件；${error instanceof Error ? error.message : error}`,
      { cause: error },
    );
  } finally {
    if (imported) await refreshDocuments();
  }
  status(`已匯入 ${imported} 份 Markdown`);
  return lastImportedId;
}

const imageTypes: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};
function imageType(file: File) {
  return (
    imageTypes[file.name.split(".").at(-1)?.toLowerCase() ?? ""] ??
    (Object.values(imageTypes).includes(file.type) ? file.type : null)
  );
}

async function attachment(file: File, path: string): Promise<Attachment> {
  const mime = imageType(file);
  if (!mime) throw new Error("不支援此圖片格式");
  if (file.size > 10 * 1024 * 1024) throw new Error("單張圖片不得超過 10 MiB");
  return { path, mime, data: await readFileAsBase64(file) };
}

async function insertImages(files: File[], position: number) {
  const doc = active;
  if (!doc) return;
  const original = editor.view.state;
  const paths: string[] = [];
  for (const file of files) {
    const name = file.name || `image.${file.type.split("/").at(-1)}`;
    const relative = `assets/${crypto.randomUUID().slice(0, 8)}-${name}`;
    const base = doc.record.path.slice(0, doc.record.path.lastIndexOf("/") + 1);
    const path = `${base}${relative}`;
    await json("assets", "POST", await attachment(file, path));
    const encoded = relative.split("/").map(encodeURIComponent).join("/");
    paths.push(encoded.replaceAll("(", "%28").replaceAll(")", "%29"));
  }
  if (active !== doc || editor.view.state.doc !== original.doc) {
    status("圖片已保存；文件已變更，請插入相應的 assets 相對路徑");
    return;
  }
  insertImageMarkdown(editor.view, position, paths);
}

function fileInput(id: string, read: (files: File[]) => Promise<unknown>) {
  const input = element<HTMLInputElement>(id);
  input.addEventListener("change", () => {
    const files = Array.from(input.files ?? []);
    input.value = "";
    if (files.length) void read(files).catch(report);
  });
}

fileInput("markdown-files", (files) => importFiles(files));
fileInput("folder-files", (files) => importFiles(files, true));
let reimportTarget: OpenDocument | null = null;
fileInput("reimport-file", async ([file]) => {
  const doc = reimportTarget;
  if (!doc || active !== doc) return;
  const content = await readMarkdown(file);
  if (content === doc.record.content && !editor.isSessionDirty(doc.session)) {
    status("本機文件與已儲存內容相同");
    return;
  }
  const revision = doc.record.revision;
  const original = editor.getSessionContent(doc.session);
  if (
    !(await decide(
      `用 ${file.name} 的內容取代工作區中的 ${doc.record.path}？本機原檔不會變更。`,
      "重新匯入",
    ))
  )
    return;
  await updateDocument(
    doc,
    () => {
      if (
        tabs.get(doc.record.id) !== doc ||
        doc.record.revision !== revision ||
        editor.isSessionDirty(doc.session)
      ) {
        throw new Error(
          "文件狀態已變更；請先儲存或另存編輯中的內容，再重新匯入。",
        );
      }
      return { content };
    },
    editor,
    (record) => {
      if (editor.getSessionContent(doc.session) !== original) return;
      if (active === doc) {
        editor.setContent(record.content);
        wordCounter.flush();
        if (viewMode === "outline" && !search.value) renderOutline();
      } else {
        doc.session = editor.createSession(record.content);
      }
    },
  );
  renderTabs();
  await refreshDocuments();
  status(
    editor.isSessionDirty(doc.session)
      ? "已重新匯入；較新的編輯尚未儲存"
      : "已重新匯入",
  );
});
fileInput("attachment-file", async ([file]) => {
  const doc = active;
  if (!doc) return;
  if (insertAttachment)
    return insertImages([file], editor.view.state.selection.main.head);
  const path = await askPath(
    "匯入圖片附件",
    `${doc.record.path.slice(0, doc.record.path.lastIndexOf("/") + 1)}assets/${file.name}`,
  );
  if (!path) return;
  await json("assets", "POST", await attachment(file, path));
  editor.refreshImages();
  status(`已匯入圖片：${path}`);
});
fileInput("conversion-file", async ([file]) => {
  const input = await pandocImport(file);
  const record = await createDocument(
    `${file.name.replace(/\.\w+$/, "")}.md`,
    input.content,
    input.attachments,
  );
  await openDocument(record.id, record);
  await refreshDocuments();
});
let insertAttachment = false;

const editorPane = element("empty-workspace").parentElement;
editorPane?.addEventListener("dragover", (event) => {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
});
editorPane?.addEventListener(
  "drop",
  (event) => {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length) return;
    // File drops belong to the workspace, not CodeMirror's text-file reader.
    event.stopPropagation();
    event.preventDefault();
    const images = files.filter(imageType);
    const markdown = files.filter((file) => markdownName.test(file.name));
    const target = active;
    const position = target
      ? (editor.view.posAtCoords({ x: event.clientX, y: event.clientY }) ??
        editor.view.state.selection.main.head)
      : 0;
    if (markdown.length) {
      void (async () => {
        let imageError: unknown;
        if (target && images.length) {
          try {
            await insertImages(images, position);
          } catch (error) {
            imageError = error;
          }
        }
        const id = await importFiles(markdown);
        if (!target && images.length && id && active?.record.id === id) {
          await insertImages(images, editor.view.state.selection.main.head);
        }
        if (imageError) report(imageError);
      })().catch(report);
    } else if (images.length && target) {
      void insertImages(images, position).catch(report);
    } else {
      status(
        images.length
          ? "請先新建或開啟文件，再插入圖片"
          : "沒有可匯入的 Markdown 或圖片檔",
      );
    }
  },
  { capture: true },
);

search.addEventListener("input", () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(
    () => void refreshDocuments().catch(report),
    150,
  );
});
const workspaceSearch = bindWorkspaceSearch({
  parent: element("workspace-content-search"),
  editor: editor.view,
  openDocument: async (id) => {
    await openDocument(id);
    return active?.record.id === id && !editor.isSessionDirty(active.session)
      ? active.record.revision
      : null;
  },
  onError: report,
});
bindWorkspaceControls((mode) => {
  viewMode = mode;
  const searching = mode === "search";
  element("workspace-filter").hidden = searching;
  element("workspace-documents").hidden = searching;
  element("workspace-content-search").hidden = !searching;
  if (searching) workspaceSearch.focusInput();
  void refreshDocuments().catch(report);
});
editor.view.dispatch({
  effects: StateEffect.appendConfig.of(
    EditorView.updateListener.of(({ selectionSet }) => {
      if (selectionSet && viewMode === "outline" && !search.value) {
        renderOutline();
      }
    }),
  ),
});

onClick("new-document", newDocument);
onClick("import-markdown", () => element("markdown-files").click());
onClick("import-markdown-menu", () => element("markdown-files").click());
onClick("import-folder", () => element("folder-files").click());
onClick("save-document", () => active && save(active));
onClick("source-mode", () => editor.toggleSourceMode());
onClick("download-document", downloadCurrent);
onClick("find-document", () => active && openFind(editor.view));
onClick("save-copy", async () => {
  const doc = active;
  if (!doc) return;
  const suggested = doc.record.path.replace(/(?:\.\w+)?$/, "-copy.md");
  const path = await askPath("另存新文件", suggested);
  if (!path) return;
  const copy = await createDocument(
    path,
    editor.getSessionContent(doc.session),
  );
  await openDocument(copy.id, copy);
  await refreshDocuments();
});
onClick("reimport-document", () => {
  if (!active) return;
  if (editor.isSessionDirty(active.session)) {
    status("請先儲存目前編輯，再重新匯入。");
    return;
  }
  reimportTarget = active;
  element("reimport-file").click();
});
onClick("rename-document", async () => {
  const doc = active;
  if (!doc) return;
  const path = await askPath("重新命名或移動", doc.record.path);
  if (!path || path === doc.record.path) return;
  await updateDocument(doc, () => ({ path }), editor);
  if (active === doc) editor.setDocumentPath(`/${path}`);
  renderTabs();
  await refreshDocuments();
});
onClick("trash-document", async () => {
  const doc = active;
  if (
    !doc ||
    uploadTab ||
    !(await decide(`將 ${doc.record.path} 移到垃圾桶？`, "移到垃圾桶"))
  )
    return;
  window.clearTimeout(doc.timer);
  await updateDocument(
    doc,
    () => ({
      deleted: true,
      ...(editor.isSessionDirty(doc.session)
        ? { content: editor.getSessionContent(doc.session) }
        : {}),
    }),
    editor,
  );
  tabs.delete(doc.record.id);
  activate(Array.from(tabs.values()).at(-1) ?? null);
  await refreshDocuments();
  status("已移到垃圾桶");
});
onClick("import-attachment", () => {
  insertAttachment = false;
  element("attachment-file").click();
});
onClick("insert-image", () => {
  insertAttachment = true;
  element("attachment-file").click();
});
onClick("import-converted", () => element("conversion-file").click());
onClick("upload-image", async () => {
  const doc = active;
  if (
    !doc ||
    uploadTab ||
    !(await decide(
      "將游標附近的本機圖片傳給管理者設定的圖床？若未選取圖片，將上傳文件中所有本機圖片。",
      "上傳",
    ))
  )
    return;
  if (active !== doc) return;
  uploadTab = doc;
  try {
    await uploadImagesInEditor({
      view: editor.view,
      uploader: "Kalamos",
      notConfiguredMessage: "未設定圖床",
      upload: async (paths) => ({
        urls: await Promise.all(
          paths.map(async (path) => {
            try {
              return await uploadImage(path.replace(/^\//, ""));
            } catch (error) {
              if (
                error instanceof RequestError &&
                error.status === 503 &&
                error.message.startsWith("Image upload is not configured")
              ) {
                throw new Error(
                  "尚未設定圖床；請由管理者在 API 設定 KALAMOS_UPLOAD_COMMAND。",
                );
              }
              throw error;
            }
          }),
        ),
      }),
      setStatus: status,
    });
  } finally {
    uploadTab = null;
  }
});
onClick("convert-document", async () => {
  const doc = active;
  if (!doc || !(await showDialog("export-dialog"))) return;
  const format = element<HTMLSelectElement>("export-format").value;
  const content = editor.getSessionContent(doc.session);
  const path = doc.record.path;
  status("匯出中…");
  const result =
    format === "pdf"
      ? await pdfExport(content, `/${path}`, {
          mathAutoNumber: settings.mathNumbers,
          imageRootDir: settings.imageRoot || null,
          resolveAttachment: assetUrl,
        })
      : await pandocExport(
          format as "docx" | "odt" | "latex" | "mediawiki" | "epub",
          content,
          path,
        );
  const ext =
    format === "latex" ? "tex" : format === "mediawiki" ? "wiki" : format;
  download(result, `${basename(path).replace(/\.\w+$/, "")}.${ext}`);
  status("已產生下載檔案");
});

const quickSearch = element<HTMLInputElement>("quick-search");
const quickDialog = element<HTMLDialogElement>("quick-dialog");
function renderQuick() {
  const results = element("quick-results");
  const candidates = prepareCandidates(
    catalog.map(({ path }) => path),
    null,
  );
  const paths = quickSearch.value.trim()
    ? searchQuickOpen(candidates, recent, quickSearch.value, null).map(
        (match) => match.path,
      )
    : [...new Set([...recent, ...catalog.map(({ path }) => path)])].slice(
        0,
        50,
      );
  results.replaceChildren();
  for (const path of paths) {
    const record = catalog.find((item) => item.path === path);
    if (!record) continue;
    const item = document.createElement("li");
    item.append(
      button(path, () => {
        quickDialog.close();
        void openDocument(record.id).catch(report);
      }),
    );
    results.append(item);
  }
}
quickSearch.addEventListener("input", renderQuick);
quickSearch.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault();
    element("quick-results")
      .querySelector<HTMLButtonElement>("button")
      ?.click();
  }
});
onClick("quick-open", () => {
  renderQuick();
  void showDialog("quick-dialog");
});

const preferenceForm = element<HTMLFormElement>("preferences-form");
const themeFile = element<HTMLInputElement>("theme-file");
let removeTheme = false;
onClick("remove-theme", () => {
  removeTheme = true;
  themeFile.value = "";
});
onClick("open-preferences", async () => {
  removeTheme = false;
  themeFile.value = "";
  for (const [name, value] of Object.entries(settings)) {
    const input = preferenceForm.elements.namedItem(name);
    if (
      input instanceof HTMLInputElement ||
      input instanceof HTMLSelectElement
    ) {
      if (input instanceof HTMLInputElement && input.type === "checkbox")
        input.checked = value === true;
      else input.value = String(value);
    }
  }
  if (!(await showDialog("preferences-dialog"))) return;
  const form = new FormData(preferenceForm);
  const file = themeFile.files?.[0];
  if (file && file.size > 64 * 1024)
    throw new Error("自訂 CSS 不得超過 64 KiB");
  const customCss = file
    ? await file.text()
    : removeTheme
      ? ""
      : settings.customCss;
  // Theme rules are local; don't allow {@import} or external resource loads from CSS.
  if (/@import|url\s*\(|image-set\s*\(|\\/i.test(customCss))
    throw new Error("自訂 CSS 不可載入外部資源");
  updateSetting({
    theme: String(form.get("theme")),
    fontSize: Number(form.get("fontSize")),
    contentWidth: Number(form.get("contentWidth")),
    imageRoot: String(form.get("imageRoot")),
    customCss,
    autosave: form.has("autosave"),
    focus: form.has("focus"),
    typewriter: form.has("typewriter"),
    lineNumbers: form.has("lineNumbers"),
    mathNumbers: form.has("mathNumbers"),
    pairBrackets: form.has("pairBrackets"),
    pairMarkdown: form.has("pairMarkdown"),
  });
});

window.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented ||
    event.isComposing ||
    document.querySelector("dialog[open]")
  )
    return;
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (mod && event.shiftKey && key === "f") {
    event.preventDefault();
    if (element("workspace-sidebar").hidden) element("toggle-sidebar").click();
    document
      .querySelector<HTMLButtonElement>('#workspace-view [data-view="search"]')
      ?.click();
    return;
  }
  const trigger =
    mod && key === "s"
      ? event.shiftKey
        ? "download-document"
        : "save-document"
      : mod && key === "p"
        ? "quick-open"
        : mod && key === "o"
          ? "import-markdown"
          : mod && key === "/"
            ? "source-mode"
            : event.key === "F8"
              ? "focus"
              : event.key === "F9"
                ? "typewriter"
                : null;
  if (!trigger) return;
  event.preventDefault();
  if (trigger === "focus") editor.toggleFocusMode();
  else if (trigger === "typewriter") editor.toggleTypewriterMode();
  else element(trigger).click();
});

window.addEventListener("beforeunload", (event) => {
  const needsWarning = Array.from(tabs.values()).some(
    (tab) => editor.isSessionDirty(tab.session) && !persistDraft(tab, editor),
  );
  if (needsWarning) event.preventDefault();
});

async function init() {
  renderTabs();
  const stored = await json<Partial<typeof defaults>>("settings");
  settings = { ...defaults, ...stored };
  applySettings();
  await refreshDocuments();
  status("工作區已連線");
}

void init().catch(report);
