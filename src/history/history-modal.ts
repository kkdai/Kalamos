import "./history-modal.css";

import { getUiLocale, t } from "../i18n";
import { formatErrorMessage, type HistoryVersion } from "../ipc";
import { shortcutLabel } from "../platform";
import { computeLineDiff, formatBytes, formatHistoryTimestamp } from "./diff";

export interface HistoryModalHost {
  getCurrentDocument: () => {
    path: string | null;
    label: string;
    content: string;
  };
  isHistoryEnabled: () => boolean;
  listVersions: (path: string) => Promise<HistoryVersion[]>;
  readVersion: (path: string, versionId: string) => Promise<string>;
  restoreContent: (content: string) => void;
  onRestoreFocus?: (previousFocus: HTMLElement | null) => void;
}

export interface HistoryModalController {
  open: () => Promise<void>;
  close: () => void;
  isOpen: () => boolean;
  destroy: () => void;
}

export function createHistoryModal(
  host: HistoryModalHost,
  doc: Document = document,
): HistoryModalController {
  let backdrop: HTMLElement | null = null;
  let previousFocus: HTMLElement | null = null;

  let listEl: HTMLElement | null = null;
  let countEl: HTMLElement | null = null;
  let subtitleEl: HTMLElement | null = null;
  let previewBarEl: HTMLElement | null = null;
  let previewStatsEl: HTMLElement | null = null;
  let diffEl: HTMLElement | null = null;
  let restoreBtn: HTMLButtonElement | null = null;

  let currentPath: string | null = null;
  let currentContent = "";
  let versions: HistoryVersion[] = [];
  let selectedId: string | null = null;
  let selectedContent: string | null = null;
  let openSeq = 0;
  let readSeq = 0;

  function el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K] {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function updateRestoreButton(): void {
    if (!restoreBtn) return;
    restoreBtn.disabled = selectedContent === null;
  }

  function renderPreviewMessage(message: string, isError = false): void {
    if (!diffEl || !previewBarEl || !previewStatsEl) return;
    previewBarEl.hidden = true;
    previewStatsEl.replaceChildren();
    diffEl.replaceChildren();
    const box = el("div", "k-hist-empty", message);
    box.dataset.testid = "history-preview-message";
    if (isError) box.dataset.error = "true";
    diffEl.append(box);
  }

  function renderDiff(oldContent: string): void {
    if (!diffEl || !previewBarEl || !previewStatsEl) return;
    const result = computeLineDiff(oldContent, currentContent);
    previewBarEl.hidden = false;
    previewStatsEl.replaceChildren();

    if (result.identical) {
      const badge = el("span", "k-hist-stat-same", t("history.identical"));
      badge.dataset.testid = "history-diff-identical";
      previewStatsEl.append(badge);
    } else {
      const addBadge = el("span", "k-hist-stat-add", `+${result.added}`);
      addBadge.dataset.testid = "history-diff-added";
      const delBadge = el("span", "k-hist-stat-del", `−${result.removed}`);
      delBadge.dataset.testid = "history-diff-removed";
      previewStatsEl.append(addBadge, delBadge);
    }

    const frag = doc.createDocumentFragment();
    for (const line of result.lines) {
      const row = el("div", `k-hist-line k-hist-line-${line.kind}`);
      row.dataset.diffKind = line.kind;
      const oldLn = el(
        "span",
        "k-hist-ln",
        line.oldLine === null ? "" : String(line.oldLine),
      );
      const newLn = el(
        "span",
        "k-hist-ln",
        line.newLine === null ? "" : String(line.newLine),
      );
      const sign = el(
        "span",
        "k-hist-sign",
        line.kind === "added" ? "+" : line.kind === "removed" ? "−" : " ",
      );
      const text = el("span", "k-hist-text", line.text);
      row.append(oldLn, newLn, sign, text);
      frag.append(row);
    }
    diffEl.replaceChildren(frag);
    diffEl.scrollTop = 0;
  }

  function syncSelectionAria(): void {
    if (!listEl) return;
    const buttons = listEl.querySelectorAll<HTMLButtonElement>(".k-hist-item");
    for (const btn of buttons) {
      const active = btn.dataset.versionId === selectedId;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    }
  }

  async function selectVersion(versionId: string): Promise<void> {
    if (!currentPath) return;
    selectedId = versionId;
    selectedContent = null;
    syncSelectionAria();
    updateRestoreButton();
    renderPreviewMessage(t("history.loading"));

    const seq = ++readSeq;
    try {
      const content = await host.readVersion(currentPath, versionId);
      if (seq !== readSeq || !backdrop || selectedId !== versionId) return;
      selectedContent = content;
      updateRestoreButton();
      renderDiff(content);
    } catch (err) {
      if (seq !== readSeq || !backdrop || selectedId !== versionId) return;
      selectedContent = null;
      updateRestoreButton();
      renderPreviewMessage(
        formatErrorMessage(t("history.loadError"), err),
        true,
      );
    }
  }

  function renderVersionList(): void {
    if (!listEl || !countEl) return;
    listEl.replaceChildren();
    const locale = getUiLocale();

    if (versions.length === 0) {
      countEl.textContent = "";
      return;
    }

    countEl.textContent = t(
      versions.length === 1
        ? "history.versionCountOne"
        : "history.versionCount",
      { count: versions.length },
    );

    const frag = doc.createDocumentFragment();
    for (const v of versions) {
      const btn = el("button", "k-hist-item");
      btn.type = "button";
      btn.setAttribute("role", "option");
      btn.dataset.testid = "history-item";
      btn.dataset.versionId = v.id;
      btn.setAttribute("aria-selected", v.id === selectedId ? "true" : "false");
      btn.tabIndex = v.id === selectedId ? 0 : -1;

      const time = el(
        "span",
        "k-hist-time",
        formatHistoryTimestamp(v.savedAtMs, locale),
      );
      const size = el("span", "k-hist-size", formatBytes(v.size));
      btn.append(time, size);
      btn.addEventListener("click", () => {
        if (selectedId === v.id && selectedContent !== null) return;
        void selectVersion(v.id);
      });
      frag.append(btn);
    }
    listEl.append(frag);
  }

  function build(): HTMLElement {
    const root = el("div", "k-hist-backdrop");
    const dialog = el("div", "k-hist-dialog");
    dialog.dataset.testid = "history-modal";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "k-hist-title");

    const header = el("div", "k-hist-header");
    const heading = el("div", "k-hist-heading");
    const title = el("h2", "k-hist-title", t("history.title"));
    title.id = "k-hist-title";
    subtitleEl = el("div", "k-hist-subtitle");
    subtitleEl.dataset.testid = "history-subtitle";
    heading.append(title, subtitleEl);

    const closeTop = el("button", "k-hist-button", t("history.cancel"));
    closeTop.type = "button";
    closeTop.dataset.testid = "history-close";
    closeTop.addEventListener("click", close);
    header.append(heading, closeTop);

    const body = el("div", "k-hist-body");

    const sidebar = el("div", "k-hist-sidebar");
    const sidebarHeader = el("div", "k-hist-sidebar-header");
    countEl = el("span", "k-hist-count");
    countEl.dataset.testid = "history-count";
    sidebarHeader.append(countEl);

    listEl = el("div", "k-hist-list");
    listEl.setAttribute("role", "listbox");
    listEl.setAttribute("aria-label", t("history.listLabel"));
    listEl.dataset.testid = "history-list";
    sidebar.append(sidebarHeader, listEl);

    const preview = el("div", "k-hist-preview");
    preview.dataset.testid = "history-preview";
    previewBarEl = el("div", "k-hist-preview-bar");
    previewBarEl.hidden = true;
    const legend = el("span", "k-hist-legend", t("history.diffLegend"));
    previewStatsEl = el("div", "k-hist-stats");
    previewBarEl.append(legend, previewStatsEl);

    diffEl = el("div", "k-hist-diff");
    diffEl.dataset.testid = "history-diff";
    preview.append(previewBarEl, diffEl);

    body.append(sidebar, preview);

    const footer = el("div", "k-hist-footer");
    const hint = el(
      "span",
      "k-hist-hint",
      shortcutLabel(t("history.restoreHint")),
    );
    const actions = el("div", "k-hist-actions");
    const cancel = el("button", "k-hist-button", t("history.cancel"));
    cancel.type = "button";
    cancel.dataset.testid = "history-cancel";
    cancel.addEventListener("click", close);

    restoreBtn = el(
      "button",
      "k-hist-button k-hist-button-primary",
      t("history.restore"),
    );
    restoreBtn.type = "button";
    restoreBtn.dataset.testid = "history-restore";
    restoreBtn.disabled = true;
    restoreBtn.addEventListener("click", () => {
      if (selectedContent === null) return;
      const toRestore = selectedContent;
      close();
      host.restoreContent(toRestore);
    });
    actions.append(cancel, restoreBtn);
    footer.append(hint, actions);

    dialog.append(header, body, footer);
    root.append(dialog);
    root.addEventListener("mousedown", (event) => {
      if (event.target === root) close();
    });
    return root;
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (!backdrop) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (
      versions.length > 0 &&
      (event.key === "ArrowDown" || event.key === "ArrowUp")
    ) {
      const target = event.target as HTMLElement | null;
      if (listEl && target && listEl.contains(target)) {
        event.preventDefault();
        const idx = versions.findIndex((v) => v.id === selectedId);
        const delta = event.key === "ArrowDown" ? 1 : -1;
        const nextIdx =
          idx < 0 ? 0 : Math.max(0, Math.min(versions.length - 1, idx + delta));
        const next = versions[nextIdx];
        if (next && next.id !== selectedId) {
          void selectVersion(next.id);
          const nextBtn = listEl.querySelector<HTMLButtonElement>(
            `[data-version-id="${next.id}"]`,
          );
          nextBtn?.focus();
          nextBtn?.scrollIntoView?.({ block: "nearest" });
        }
      }
    }
  };

  async function open(): Promise<void> {
    const seq = ++openSeq;
    readSeq++;
    const current = host.getCurrentDocument();
    currentPath = current.path;
    currentContent = current.content;
    versions = [];
    selectedId = null;
    selectedContent = null;

    if (!backdrop) {
      previousFocus = doc.activeElement as HTMLElement | null;
      backdrop = build();
      doc.body.append(backdrop);
      doc.addEventListener("keydown", onKeydown, true);
    }

    if (subtitleEl) subtitleEl.textContent = current.label;
    updateRestoreButton();
    renderVersionList();

    if (!currentPath) {
      renderPreviewMessage(t("history.untitledNotice"));
      backdrop
        .querySelector<HTMLButtonElement>('[data-testid="history-close"]')
        ?.focus();
      return;
    }

    renderPreviewMessage(t("history.loading"));
    try {
      const list = await host.listVersions(currentPath);
      if (seq !== openSeq || !backdrop) return;
      versions = list;
      renderVersionList();
      if (versions.length === 0) {
        renderPreviewMessage(
          host.isHistoryEnabled()
            ? t("history.empty")
            : t("history.emptyDisabled"),
        );
        backdrop
          .querySelector<HTMLButtonElement>('[data-testid="history-close"]')
          ?.focus();
        return;
      }
      await selectVersion(versions[0].id);
      if (seq !== openSeq || !backdrop) return;
      listEl?.querySelector<HTMLButtonElement>(".k-hist-item")?.focus();
    } catch (err) {
      if (seq !== openSeq || !backdrop) return;
      renderPreviewMessage(
        formatErrorMessage(t("history.loadError"), err),
        true,
      );
    }
  }

  function close(): void {
    if (!backdrop) return;
    openSeq++;
    readSeq++;
    doc.removeEventListener("keydown", onKeydown, true);
    backdrop.remove();
    backdrop = null;
    listEl = null;
    countEl = null;
    subtitleEl = null;
    previewBarEl = null;
    previewStatsEl = null;
    diffEl = null;
    restoreBtn = null;
    const prev = previousFocus;
    previousFocus = null;
    if (host.onRestoreFocus) host.onRestoreFocus(prev);
    else prev?.focus?.();
  }

  return {
    open,
    close,
    isOpen: () => backdrop !== null,
    destroy: close,
  };
}
