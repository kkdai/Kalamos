import "./updater.css";

import { type MessageKey, t } from "../i18n";
import {
  type AvailableUpdate,
  appErrorDetail,
  type UpdateDownloadEvent,
} from "../ipc";

/**
 * #91 in-app auto-updater modal.
 *
 * Security invariants:
 * - Never installs silently: always asks the user before downloading & installing.
 * - Release notes are rendered purely via DOM APIs (`createElement` + `textContent` /
 *   `createTextNode`), never via `innerHTML`.
 * - Before installing (which exits the app on Windows and replaces the bundle on macOS),
 *   runs `host.prepareForRestart()` so unsaved changes in every tab are settled first.
 */

export type UpdaterViewState =
  | "idle"
  | "checking"
  | "upToDate"
  | "available"
  | "downloading"
  | "installing"
  | "error";

export interface UpdaterHost {
  checkForUpdate: () => Promise<AvailableUpdate | null>;
  /** Settle all unsaved tabs (#81). Returns false if the user cancelled. */
  prepareForRestart: () => Promise<boolean>;
  /** Restart the app after installation (no-op if Windows NSIS already exited). */
  restartApp: () => Promise<void>;
  /** Restore recovery snapshots if install or restart fails after "Don't Save". */
  restoreRecoveryAfterFailedInstall?: () => Promise<void>;
}

export interface UpdaterController {
  checkForUpdates: (options?: { manual?: boolean }) => Promise<void>;
  getState: () => UpdaterViewState;
  isOpen: () => boolean;
  close: () => void;
  destroy: () => void;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "0 B";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type UpdaterErrorStage = "check" | "download" | "install" | "restart";

export type UpdaterErrorKind =
  | "fetch"
  | "signature"
  | "download"
  | "install"
  | "restart"
  | "unknown";

export interface ClassifiedUpdaterError {
  kind: UpdaterErrorKind;
  message: string;
  detail: string;
}

const SIGNATURE_ERROR_RE =
  /signature|minisign|pubkey|public key|signed version|requireSignedVersion|verification failed|verify|signed for version|different key/i;

const FETCH_ERROR_RE =
  /release json|valid release|could not fetch|endpoint|platforms?.*not found|fallback platforms|serde|json|expected value|eof while parsing|missing field|invalid type|trailing characters|semver|insecure.*protocol|url|reqwest|network|fetch|dns|lookup|resolve|connect|connection|timeout|timed out|unreachable|offline|socket|tls|ssl|certificate|http|status(?:\s+code)?\s*[45]\d\d|\b(?:403|404|408|429|500|502|503|504)\b|econnrefused|econnreset|enotfound|etimedout|ehostunreach|enetunreach|broken pipe|reset by peer/i;

const DOWNLOAD_ERROR_RE =
  /download(?:ing)?\s*(?:failed|error|interrupted|aborted)|failed to download|incomplete download/i;

const INSTALL_ERROR_RE =
  /install|extract|archive|mount point|temp(?:orary)? dir(?:ectory)?|permission denied|eacces|eperm|enospc|no space|read-only|restore the previous app|invalid updater binary|authentication failed|binary.*not found/i;

const ERROR_MESSAGE_KEYS: Record<UpdaterErrorKind, MessageKey> = {
  fetch: "updater.error.fetchFailed",
  signature: "updater.error.signatureFailed",
  download: "updater.error.downloadFailed",
  install: "updater.error.installFailed",
  restart: "updater.error.restartFailed",
  unknown: "updater.error.unknown",
};

function rawUpdaterErrorDetail(err: unknown): string {
  if (err === null || err === undefined) return "";
  return appErrorDetail(err).trim();
}

export function isSignatureError(err: unknown): boolean {
  return SIGNATURE_ERROR_RE.test(rawUpdaterErrorDetail(err));
}

export function classifyUpdaterError(
  err: unknown,
  stage?: UpdaterErrorStage,
): ClassifiedUpdaterError {
  const detail = rawUpdaterErrorDetail(err);
  let kind: UpdaterErrorKind;

  if (SIGNATURE_ERROR_RE.test(detail)) {
    kind = "signature";
  } else if (stage === "restart") {
    kind = "restart";
  } else if (stage === "download") {
    kind = "download";
  } else if (stage === "install") {
    kind = "install";
  } else if (stage === "check") {
    kind = FETCH_ERROR_RE.test(detail) ? "fetch" : "unknown";
  } else if (INSTALL_ERROR_RE.test(detail)) {
    kind = "install";
  } else if (DOWNLOAD_ERROR_RE.test(detail)) {
    kind = "download";
  } else if (FETCH_ERROR_RE.test(detail)) {
    kind = "fetch";
  } else {
    kind = "unknown";
  }

  return {
    kind,
    message: t(ERROR_MESSAGE_KEYS[kind]),
    detail,
  };
}

/**
 * Safely renders inline `**bold**` and `` `code` `` spans using only text nodes
 * and DOM elements — raw HTML tags are never parsed.
 */
function appendSafeInline(
  parent: HTMLElement,
  text: string,
  doc: Document,
): void {
  const tokenRe = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let lastIndex = 0;
  for (const match of text.matchAll(tokenRe)) {
    const start = match.index ?? 0;
    if (start > lastIndex) {
      parent.append(doc.createTextNode(text.slice(lastIndex, start)));
    }
    if (match[1] !== undefined) {
      const strong = doc.createElement("strong");
      strong.textContent = match[1];
      parent.append(strong);
    } else if (match[2] !== undefined) {
      const code = doc.createElement("code");
      code.textContent = match[2];
      parent.append(code);
    }
    lastIndex = start + match[0].length;
  }
  if (lastIndex < text.length) {
    parent.append(doc.createTextNode(text.slice(lastIndex)));
  }
}

/**
 * Renders release notes safely into a container without ever calling `innerHTML`.
 */
export function renderReleaseNotes(
  notes: string | undefined,
  doc: Document = document,
): HTMLElement {
  const container = doc.createElement("div");
  container.className = "k-update-notes";
  container.dataset.testid = "update-release-notes";

  const trimmed = notes?.trim() ?? "";
  if (!trimmed) {
    const empty = doc.createElement("p");
    empty.className = "k-update-notes-empty";
    empty.textContent = t("updater.available.noNotes");
    container.append(empty);
    return container;
  }

  const lines = trimmed.split(/\r?\n/);
  let currentList: HTMLUListElement | null = null;
  const flushList = () => {
    if (currentList) {
      container.append(currentList);
      currentList = null;
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flushList();
      continue;
    }
    const headingMatch = /^#{1,6}\s+(.*)$/.exec(line);
    if (headingMatch) {
      flushList();
      const heading = doc.createElement("h4");
      appendSafeInline(heading, headingMatch[1], doc);
      container.append(heading);
      continue;
    }
    const bulletMatch = /^[-*+]\s+(.*)$/.exec(line);
    if (bulletMatch) {
      if (!currentList) {
        currentList = doc.createElement("ul");
      }
      const li = doc.createElement("li");
      appendSafeInline(li, bulletMatch[1], doc);
      currentList.append(li);
      continue;
    }
    flushList();
    const p = doc.createElement("p");
    appendSafeInline(p, line, doc);
    container.append(p);
  }
  flushList();
  return container;
}

export function createUpdater(
  host: UpdaterHost,
  doc: Document = document,
): UpdaterController {
  let state: UpdaterViewState = "idle";
  let backdrop: HTMLElement | null = null;
  let dialogEl: HTMLElement | null = null;
  let previousFocus: HTMLElement | null = null;
  let pendingUpdate: AvailableUpdate | null = null;
  let activeCheckPromise: Promise<void> | null = null;
  let activeCheckManual = false;
  let checkSeq = 0;
  let destroyed = false;

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

  function canDismiss(): boolean {
    return state !== "downloading" && state !== "installing";
  }

  function releasePendingUpdate(): void {
    const update = pendingUpdate;
    pendingUpdate = null;
    if (update) {
      void update.close().catch(() => null);
    }
  }

  const onKeydown = (event: KeyboardEvent): void => {
    if (!backdrop) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (canDismiss()) {
        close();
      }
    }
  };

  function ensureDialog(): HTMLElement {
    if (!backdrop || !dialogEl) {
      previousFocus = doc.activeElement as HTMLElement | null;
      backdrop = el("div", "k-update-backdrop");
      dialogEl = el("div", "k-update-dialog");
      dialogEl.dataset.testid = "update-dialog";
      dialogEl.setAttribute("role", "dialog");
      dialogEl.setAttribute("aria-modal", "true");
      dialogEl.setAttribute("aria-labelledby", "k-update-title");
      backdrop.append(dialogEl);
      backdrop.addEventListener("mousedown", (event) => {
        if (event.target === backdrop && canDismiss()) {
          close();
        }
      });
      doc.body.append(backdrop);
      doc.addEventListener("keydown", onKeydown, true);
    }
    return dialogEl;
  }

  function close(): void {
    if (!backdrop && state === "idle") return;
    checkSeq += 1;
    state = "idle";
    releasePendingUpdate();
    if (backdrop) {
      doc.removeEventListener("keydown", onKeydown, true);
      backdrop.remove();
      backdrop = null;
      dialogEl = null;
    }
    previousFocus?.focus?.();
    previousFocus = null;
  }

  function renderDialog(options: {
    title: string;
    subtitle?: string;
    bodyNodes: HTMLElement[];
    buttons: HTMLButtonElement[];
  }): void {
    if (destroyed) return;
    const dialog = ensureDialog();
    dialog.dataset.state = state;
    dialog.replaceChildren();

    const header = el("div", "k-update-header");
    const titleEl = el("h2", "k-update-title", options.title);
    titleEl.id = "k-update-title";
    header.append(titleEl);
    if (options.subtitle) {
      header.append(el("p", "k-update-subtitle", options.subtitle));
    }

    const body = el("div", "k-update-body");
    body.append(...options.bodyNodes);

    dialog.append(header, body);

    if (options.buttons.length > 0) {
      const actions = el("div", "k-update-actions");
      actions.append(...options.buttons);
      dialog.append(actions);
    }
  }

  function makeButton(
    label: string,
    testId: string,
    onClick: () => void,
    primary = false,
  ): HTMLButtonElement {
    const btn = el(
      "button",
      primary ? "k-update-button k-update-button-primary" : "k-update-button",
      label,
    );
    btn.type = "button";
    btn.dataset.testid = testId;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function showChecking(): void {
    state = "checking";
    const msg = el("p", "k-update-message", t("updater.checking.message"));
    msg.setAttribute("role", "status");
    const closeBtn = makeButton(
      t("updater.button.close"),
      "update-close",
      close,
    );
    renderDialog({
      title: t("updater.checking.title"),
      bodyNodes: [msg],
      buttons: [closeBtn],
    });
  }

  function showUpToDate(): void {
    state = "upToDate";
    const msg = el("p", "k-update-message", t("updater.upToDate.message"));
    msg.dataset.testid = "update-status-message";
    const closeBtn = makeButton(
      t("updater.button.close"),
      "update-close",
      close,
      true,
    );
    renderDialog({
      title: t("updater.upToDate.title"),
      bodyNodes: [msg],
      buttons: [closeBtn],
    });
    closeBtn.focus();
  }

  function showError(
    message: string,
    allowRetry: boolean,
    detail?: string,
  ): void {
    state = "error";
    const msg = el("p", "k-update-message", message);
    msg.dataset.error = "true";
    msg.dataset.testid = "update-error-message";
    msg.setAttribute("role", "alert");

    const bodyNodes: HTMLElement[] = [msg];
    const trimmedDetail = detail?.trim() ?? "";
    if (trimmedDetail) {
      const detailsEl = el("details", "k-update-error-details");
      detailsEl.dataset.testid = "update-error-details";
      const summaryEl = el(
        "summary",
        "k-update-error-summary",
        t("updater.error.detailsLabel"),
      );
      summaryEl.dataset.testid = "update-error-details-summary";
      const detailPre = el("pre", "k-update-error-detail", trimmedDetail);
      detailPre.dataset.testid = "update-error-detail";
      detailsEl.append(summaryEl, detailPre);
      bodyNodes.push(detailsEl);
    }

    const buttons: HTMLButtonElement[] = [];
    if (allowRetry) {
      buttons.push(
        makeButton(t("updater.button.retry"), "update-retry", () => {
          void checkForUpdates({ manual: true });
        }),
      );
    }
    const closeBtn = makeButton(
      t("updater.button.close"),
      "update-close",
      close,
      !allowRetry,
    );
    buttons.push(closeBtn);
    renderDialog({
      title: t("updater.error.title"),
      bodyNodes,
      buttons,
    });
    closeBtn.focus();
  }

  function showAvailable(update: AvailableUpdate): void {
    releasePendingUpdate();
    pendingUpdate = update;
    state = "available";

    const notesLabel = el(
      "div",
      "k-update-notes-label",
      t("updater.available.notesHeading"),
    );
    const notesBox = renderReleaseNotes(update.body, doc);

    const laterBtn = makeButton(
      t("updater.button.later"),
      "update-later",
      close,
    );
    const updateNowBtn = makeButton(
      t("updater.button.updateNow"),
      "update-now",
      () => {
        void startDownloadAndInstall();
      },
      true,
    );

    renderDialog({
      title: t("updater.available.title", { version: update.version }),
      subtitle: t("updater.available.detail", {
        currentVersion: update.currentVersion,
        version: update.version,
      }),
      bodyNodes: [notesLabel, notesBox],
      buttons: [laterBtn, updateNowBtn],
    });
    updateNowBtn.focus();
  }

  async function startDownloadAndInstall(): Promise<void> {
    const update = pendingUpdate;
    if (!update || state !== "available" || destroyed) return;

    state = "downloading";
    const progressText = el(
      "p",
      "k-update-message",
      t("updater.downloading.starting"),
    );
    progressText.dataset.testid = "update-progress-text";
    progressText.setAttribute("role", "status");

    const progressBar = el("progress", "k-update-progress");
    progressBar.dataset.testid = "update-progress-bar";
    progressBar.max = 100;

    const wrap = el("div", "k-update-progress-wrap");
    wrap.append(progressBar, progressText);

    renderDialog({
      title: t("updater.downloading.title", { version: update.version }),
      bodyNodes: [wrap],
      buttons: [],
    });

    let totalBytes: number | undefined;
    let downloadedBytes = 0;

    const onEvent = (event: UpdateDownloadEvent): void => {
      if (destroyed || state !== "downloading") return;
      if (event.event === "Started") {
        totalBytes = event.data.contentLength;
        if (totalBytes && totalBytes > 0) {
          progressBar.value = 0;
          progressText.textContent = t("updater.downloading.progress", {
            percent: 0,
            downloaded: formatBytes(0),
            total: formatBytes(totalBytes),
          });
        } else {
          progressBar.removeAttribute("value");
          progressText.textContent = t("updater.downloading.starting");
        }
      } else if (event.event === "Progress") {
        downloadedBytes += event.data.chunkLength;
        if (totalBytes && totalBytes > 0) {
          const percent = Math.min(
            100,
            Math.round((downloadedBytes / totalBytes) * 100),
          );
          progressBar.value = percent;
          progressText.textContent = t("updater.downloading.progress", {
            percent,
            downloaded: formatBytes(downloadedBytes),
            total: formatBytes(totalBytes),
          });
        } else {
          progressBar.removeAttribute("value");
          progressText.textContent = t("updater.downloading.indeterminate", {
            downloaded: formatBytes(downloadedBytes),
          });
        }
      } else if (event.event === "Finished") {
        progressBar.value = 100;
        if (totalBytes && totalBytes > 0) {
          progressText.textContent = t("updater.downloading.progress", {
            percent: 100,
            downloaded: formatBytes(totalBytes),
            total: formatBytes(totalBytes),
          });
        }
      }
    };

    try {
      await update.download(onEvent);
    } catch (err) {
      releasePendingUpdate();
      if (destroyed) return;
      const classified = classifyUpdaterError(err, "download");
      showError(
        classified.message,
        classified.kind !== "signature",
        classified.detail,
      );
      return;
    }

    if (destroyed) {
      releasePendingUpdate();
      return;
    }

    state = "installing";
    const installMsg = el(
      "p",
      "k-update-message",
      t("updater.installing.preparing"),
    );
    installMsg.dataset.testid = "update-install-message";
    installMsg.setAttribute("role", "status");
    renderDialog({
      title: t("updater.installing.title", { version: update.version }),
      bodyNodes: [installMsg],
      buttons: [],
    });

    let readyToRestart = false;
    try {
      readyToRestart = await host.prepareForRestart();
    } catch (err) {
      releasePendingUpdate();
      if (destroyed) return;
      const classified = classifyUpdaterError(err, "install");
      showError(classified.message, false, classified.detail);
      return;
    }

    if (!readyToRestart || destroyed) {
      close();
      return;
    }

    installMsg.textContent = t("updater.installing.message");

    try {
      await update.install();
    } catch (err) {
      await host.restoreRecoveryAfterFailedInstall?.().catch(() => null);
      releasePendingUpdate();
      if (destroyed) return;
      const classified = classifyUpdaterError(err, "install");
      showError(classified.message, false, classified.detail);
      return;
    }

    pendingUpdate = null;

    try {
      await host.restartApp();
    } catch (err) {
      await host.restoreRecoveryAfterFailedInstall?.().catch(() => null);
      if (destroyed) return;
      const classified = classifyUpdaterError(err, "restart");
      showError(classified.message, false, classified.detail);
    }
  }

  async function checkForUpdates(options?: {
    manual?: boolean;
  }): Promise<void> {
    if (destroyed) return;
    const manual = Boolean(options?.manual);

    if (state === "downloading" || state === "installing") {
      return;
    }
    if (state === "available" && pendingUpdate) {
      return;
    }
    if (activeCheckPromise) {
      if (manual && !activeCheckManual) {
        activeCheckManual = true;
        showChecking();
      }
      return activeCheckPromise;
    }

    const seq = ++checkSeq;
    activeCheckManual = manual;
    if (manual) {
      showChecking();
    } else {
      state = "checking";
    }

    const run = (async () => {
      try {
        const update = await host.checkForUpdate();
        if (destroyed || seq !== checkSeq) {
          if (update) void update.close().catch(() => null);
          return;
        }
        if (update) {
          showAvailable(update);
        } else if (activeCheckManual) {
          showUpToDate();
        } else {
          state = "idle";
        }
      } catch (err) {
        if (destroyed || seq !== checkSeq) return;
        if (activeCheckManual) {
          const classified = classifyUpdaterError(err, "check");
          showError(
            classified.message,
            classified.kind !== "signature",
            classified.detail,
          );
        } else {
          state = "idle";
          console.warn("[Kalamos updater] background check failed:", err);
        }
      } finally {
        activeCheckPromise = null;
        activeCheckManual = false;
      }
    })();

    activeCheckPromise = run;
    return run;
  }

  function destroy(): void {
    destroyed = true;
    close();
  }

  return {
    checkForUpdates,
    getState: () => state,
    isOpen: () => backdrop !== null,
    close,
    destroy,
  };
}
