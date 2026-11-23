import type { EditorView } from "@codemirror/view";
import { lineColumnToRange, revealRange } from "../../src/editor/search";
import type { SearchHit, SearchResults } from "../shared/search";
import { basename } from "./api";

interface Binding {
  parent: HTMLElement;
  editor: EditorView;
  /** Returns the active clean revision, or null if the hit cannot be opened. */
  openDocument: (id: string) => Promise<number | null>;
  onError: (error: unknown) => void;
}

const prefix = "workspace-content-search-";

function part<K extends keyof HTMLElementTagNameMap>(tag: K, name: string) {
  const node = document.createElement(tag);
  node.className = prefix + name;
  return node;
}

function shortenLead(before: string) {
  const chars = Array.from(before);
  return chars.length > 8 ? `…${chars.slice(-6).join("").trimStart()}` : before;
}

export function bindWorkspaceSearch({
  parent,
  editor,
  openDocument,
  onError,
}: Binding) {
  const field = part("form", "field");
  field.setAttribute("role", "search");
  const label = document.createElement("label");
  const input = part("input", "input");
  input.id = `${prefix}input`;
  input.type = "search";
  input.spellcheck = false;
  input.autocomplete = "off";
  label.htmlFor = input.id;
  label.textContent = "搜尋文件內容";
  const query = part("div", "query");
  const submit = document.createElement("button");
  submit.type = "submit";
  submit.textContent = "搜尋";
  query.append(input, submit);
  const options = part("div", "options");
  options.setAttribute("role", "group");
  options.setAttribute("aria-label", "搜尋選項");
  const status = part("div", "status");
  status.id = `${prefix}status`;
  status.setAttribute("role", "status");
  const results = part("div", "results");
  const collapsed = new Set<string>();
  let timer = 0;
  let request: AbortController | undefined;
  let composing = false;
  let opening = false;

  for (const [key, text, label] of [
    ["case", "Aa", "區分大小寫"],
    ["word", "ab", "全字比對"],
    ["regex", ".*", "正規表示式"],
  ]) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = text;
    button.title = label;
    button.dataset.option = key;
    button.setAttribute("aria-label", label);
    button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => {
      const pressed = button.getAttribute("aria-pressed") === "true";
      button.setAttribute("aria-pressed", String(!pressed));
      void run();
    });
    options.append(button);
  }
  field.append(label, query, options);
  parent.append(field, status, results);

  async function jump(hit: SearchHit, button: HTMLButtonElement) {
    if (opening) return;
    opening = true;
    try {
      const revision = await openDocument(hit.id);
      if (revision !== hit.revision) {
        onError("此位置對應已儲存版本；請先儲存或重開文件，再重新搜尋。");
        return;
      }
      const { from, to } = lineColumnToRange(
        editor.state,
        hit.line,
        hit.column,
        hit.length,
      );
      revealRange(editor, from, to);
      results
        .querySelector('[aria-current="true"]')
        ?.removeAttribute("aria-current");
      button.setAttribute("aria-current", "true");
    } catch (error) {
      onError(error);
    } finally {
      opening = false;
    }
  }

  function render({ hits, truncated }: SearchResults) {
    const groups = new Map<string, SearchHit[]>();
    for (const hit of hits) {
      const group = groups.get(hit.id);
      if (group) group.push(hit);
      else groups.set(hit.id, [hit]);
    }
    const fragment = document.createDocumentFragment();
    for (const [id, group] of groups) {
      const { path } = group[0];
      const file = part("details", "group");
      file.dataset.path = path;
      file.open = !collapsed.has(id);
      file.addEventListener("toggle", () => {
        if (!file.isConnected) return;
        if (file.open) collapsed.delete(id);
        else collapsed.add(id);
      });
      const summary = part("summary", "file");
      summary.title = path;
      const name = part("span", "file-name");
      name.textContent = basename(path);
      const directory = part("span", "file-dir");
      directory.textContent = path.slice(0, Math.max(0, path.lastIndexOf("/")));
      const count = part("span", "file-count");
      count.textContent = `（${group.length} 筆）`;
      summary.append(name, " ", directory, " ", count);
      const list = part("ul", "hits");
      // Safari can drop list semantics when CSS removes the markers.
      list.setAttribute("role", "list");
      for (const hit of group) {
        const item = document.createElement("li");
        const button = part("button", "hit");
        button.type = "button";
        button.dataset.line = String(hit.line);
        button.dataset.column = String(hit.column);
        const position = part("span", "position");
        position.textContent = `${hit.line}:${hit.column}`;
        const snippet = part("span", "snippet");
        const mark = document.createElement("mark");
        mark.textContent = hit.match;
        snippet.append(shortenLead(hit.before), mark, hit.after);
        button.append(position, snippet);
        button.addEventListener("click", () => void jump(hit, button));
        item.append(button);
        list.append(item);
      }
      file.append(summary, list);
      fragment.append(file);
    }
    results.replaceChildren(fragment);
    status.textContent = hits.length
      ? `${hits.length}${truncated ? "+" : ""} 筆結果，${groups.size} 個檔案${truncated ? "（已截斷，請縮小搜尋範圍）" : ""}`
      : "無結果";
  }

  function cancel() {
    window.clearTimeout(timer);
    request?.abort();
  }

  async function run() {
    cancel();
    if (composing || parent.hidden) return;
    results.replaceChildren();
    input.removeAttribute("aria-invalid");
    input.removeAttribute("aria-describedby");
    status.textContent = "";
    if (!input.value) return;
    const params = new URLSearchParams({ q: input.value });
    for (const toggle of options.querySelectorAll<HTMLButtonElement>(
      '[aria-pressed="true"]',
    )) {
      if (toggle.dataset.option) params.set(toggle.dataset.option, "1");
    }
    const controller = new AbortController();
    request = controller;
    try {
      const response = await fetch(`/api/search?${params}`, {
        signal: controller.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        if (controller.signal.aborted || parent.hidden) return;
        status.textContent =
          typeof data?.error === "string" ? data.error : "搜尋失敗";
        if (response.status === 422 || response.status === 400) {
          input.setAttribute("aria-invalid", "true");
          input.setAttribute("aria-describedby", status.id);
        }
        return;
      }
      const data: SearchResults = await response.json();
      if (!controller.signal.aborted && !parent.hidden) render(data);
    } catch {
      if (!controller.signal.aborted && !parent.hidden)
        status.textContent = "搜尋失敗；請確認工作區已連線。";
    }
  }

  function schedule() {
    cancel();
    timer = window.setTimeout(() => void run(), 250);
  }

  input.addEventListener("compositionstart", () => {
    composing = true;
    cancel();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    schedule();
  });
  input.addEventListener("input", (event) => {
    if (!composing && !(event as InputEvent).isComposing) schedule();
  });
  // Native implicit submission waits for the IME to commit Enter.
  field.addEventListener("submit", (event) => {
    event.preventDefault();
    void run();
  });
  input.addEventListener("keydown", (event) => {
    if (composing || event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape" && input.value) {
      event.preventDefault();
      input.value = "";
      void run();
    }
  });

  return {
    refresh: () => void run(),
    focusInput: () => {
      input.focus();
      input.select();
    },
  };
}
