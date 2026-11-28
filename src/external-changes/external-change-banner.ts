import "./external-change-banner.css";
import { t } from "../i18n";

export type ExternalBannerViewState =
  | { kind: "hidden" }
  | { kind: "conflict"; fileName: string }
  | { kind: "missing"; fileName: string };

export interface CreateExternalChangeBannerOptions {
  parent: HTMLElement;
  before?: HTMLElement | null;
  onKeepMine: () => void | Promise<void>;
  onLoadDisk: () => void | Promise<void>;
  onSaveAs: () => void | Promise<void>;
  onRecreate: () => void | Promise<void>;
}

export interface ExternalChangeBanner {
  element: HTMLElement;
  render: (state: ExternalBannerViewState) => void;
  getState: () => ExternalBannerViewState;
  destroy: () => void;
}

const WARNING_ICON_SVG = `<svg class="k-icon k-external-banner-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

export function createExternalChangeBanner(
  options: CreateExternalChangeBannerOptions,
): ExternalChangeBanner {
  let current: ExternalBannerViewState = { kind: "hidden" };
  let busy = false;

  const root = document.createElement("div");
  root.className = "k-external-banner";
  root.dataset.testid = "external-change-banner";
  root.dataset.visible = "false";
  root.dataset.kind = "hidden";
  root.setAttribute("role", "alert");
  root.setAttribute("aria-live", "assertive");

  const lead = document.createElement("div");
  lead.className = "k-external-banner-lead";
  lead.innerHTML = WARNING_ICON_SVG;

  const messageEl = document.createElement("span");
  messageEl.className = "k-external-banner-message";
  messageEl.dataset.testid = "external-change-message";
  lead.appendChild(messageEl);

  const actionsEl = document.createElement("div");
  actionsEl.className = "k-external-banner-actions";

  const keepMineBtn = document.createElement("button");
  keepMineBtn.type = "button";
  keepMineBtn.className = "k-external-banner-btn k-external-banner-btn-primary";
  keepMineBtn.dataset.testid = "external-change-keep-mine";

  const loadDiskBtn = document.createElement("button");
  loadDiskBtn.type = "button";
  loadDiskBtn.className = "k-external-banner-btn";
  loadDiskBtn.dataset.testid = "external-change-load-disk";

  const saveAsBtn = document.createElement("button");
  saveAsBtn.type = "button";
  saveAsBtn.className = "k-external-banner-btn k-external-banner-btn-primary";
  saveAsBtn.dataset.testid = "external-change-save-as";

  const recreateBtn = document.createElement("button");
  recreateBtn.type = "button";
  recreateBtn.className = "k-external-banner-btn";
  recreateBtn.dataset.testid = "external-change-recreate";

  const buttons = [keepMineBtn, loadDiskBtn, saveAsBtn, recreateBtn];
  function setButtonsDisabled(disabled: boolean): void {
    for (const btn of buttons) {
      btn.disabled = disabled;
    }
  }

  async function runAction(fn: () => void | Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    setButtonsDisabled(true);
    try {
      await fn();
    } finally {
      busy = false;
      setButtonsDisabled(false);
    }
  }

  keepMineBtn.addEventListener(
    "click",
    () => void runAction(options.onKeepMine),
  );
  loadDiskBtn.addEventListener(
    "click",
    () => void runAction(options.onLoadDisk),
  );
  saveAsBtn.addEventListener("click", () => void runAction(options.onSaveAs));
  recreateBtn.addEventListener(
    "click",
    () => void runAction(options.onRecreate),
  );

  actionsEl.append(keepMineBtn, loadDiskBtn, saveAsBtn, recreateBtn);
  root.append(lead, actionsEl);

  if (options.before && options.before.parentElement === options.parent) {
    options.parent.insertBefore(root, options.before);
  } else {
    options.parent.appendChild(root);
  }

  function render(state: ExternalBannerViewState): void {
    current = state;
    root.dataset.kind = state.kind;
    if (state.kind === "hidden") {
      root.dataset.visible = "false";
      messageEl.textContent = "";
      return;
    }

    root.dataset.visible = "true";
    if (state.kind === "conflict") {
      messageEl.textContent = t("externalChange.conflictMessage", {
        name: state.fileName,
      });
      keepMineBtn.textContent = t("externalChange.keepMine");
      loadDiskBtn.textContent = t("externalChange.loadDisk");
      keepMineBtn.hidden = false;
      loadDiskBtn.hidden = false;
      saveAsBtn.hidden = true;
      recreateBtn.hidden = true;
    } else {
      messageEl.textContent = t("externalChange.missingMessage", {
        name: state.fileName,
      });
      saveAsBtn.textContent = t("externalChange.saveAs");
      recreateBtn.textContent = t("externalChange.recreate");
      keepMineBtn.hidden = true;
      loadDiskBtn.hidden = true;
      saveAsBtn.hidden = false;
      recreateBtn.hidden = false;
    }
  }

  function destroy(): void {
    root.remove();
  }

  return {
    element: root,
    render,
    getState: () => current,
    destroy,
  };
}
