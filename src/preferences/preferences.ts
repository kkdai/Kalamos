import "./preferences.css";

import type { StartupBehavior } from "../ipc";

/**
 * #74 偏好設定 (Cmd+,): an in-app modal. Every control applies its change at
 * once through the host (which also writes settings.json); there is no
 * "apply" button. Built with textContent only (no HTML strings).
 */

export type PreferencesTab = "general" | "editor" | "appearance" | "images";

export const PREFERENCES_TABS: Array<{ id: PreferencesTab; label: string }> = [
  { id: "general", label: "一般" },
  { id: "editor", label: "編輯器" },
  { id: "appearance", label: "外觀" },
  { id: "images", label: "圖片" },
];

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 28;
export const CONTENT_WIDTH_MIN = 480;
export const CONTENT_WIDTH_MAX = 1400;
export const CONTENT_WIDTH_STEP = 20;

export interface PreferencesValues {
  startupBehavior: StartupBehavior;
  autoSave: boolean;
  fontSize: number;
  contentWidth: number;
  autoPairBrackets: boolean;
  autoPairMarkdown: boolean;
  codeLineNumbers: boolean;
  mathAutoNumber: boolean;
  theme: string;
  imageRootDir: string | null;
  uploadOnInsert: boolean;
  uploadCommand: string | null;
  uploadArgs: string[];
}

/** Values the modal can change directly (the image root and upload program have their own flows). */
export type PreferencesPatch = Partial<
  Pick<
    PreferencesValues,
    | "startupBehavior"
    | "autoSave"
    | "fontSize"
    | "contentWidth"
    | "autoPairBrackets"
    | "autoPairMarkdown"
    | "codeLineNumbers"
    | "mathAutoNumber"
    | "theme"
    | "uploadOnInsert"
  >
>;

export interface PreferencesHost {
  getValues: () => PreferencesValues;
  getThemes: () => Array<{ id: string; label: string }>;
  /** Reload theme list / upload settings before the modal is shown. */
  refresh?: () => Promise<void>;
  applyChange: (patch: PreferencesPatch) => void | Promise<void>;
  pickImageRootDir: () => Promise<unknown>;
  clearImageRootDir: () => Promise<unknown>;
  openThemesDir: () => Promise<unknown>;
}

export interface PreferencesController {
  open: (tab?: PreferencesTab) => Promise<void>;
  close: () => void;
  isOpen: () => boolean;
  getTab: () => PreferencesTab;
  /** Re-read the host values into the controls (state changed elsewhere). */
  sync: () => void;
  destroy: () => void;
}

export function clampFontSize(value: number): number {
  if (!Number.isFinite(value)) return 17;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, Math.round(value)));
}

export function clampContentWidth(value: number): number {
  if (!Number.isFinite(value)) return 720;
  const stepped = Math.round(value / CONTENT_WIDTH_STEP) * CONTENT_WIDTH_STEP;
  return Math.min(CONTENT_WIDTH_MAX, Math.max(CONTENT_WIDTH_MIN, stepped));
}

export function createPreferences(
  host: PreferencesHost,
  doc: Document = document,
): PreferencesController {
  let backdrop: HTMLElement | null = null;
  let currentTab: PreferencesTab = "general";
  let previousFocus: HTMLElement | null = null;
  const syncers: Array<(v: PreferencesValues) => void> = [];

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

  function row(
    label: string,
    control: HTMLElement,
    hint?: string,
  ): HTMLElement {
    const wrap = el("div", "k-pref-row");
    const labelEl = el("label", "k-pref-label", label);
    if (control.id) labelEl.htmlFor = control.id;
    const body = el("div", "k-pref-control");
    body.append(control);
    if (hint) body.append(el("div", "k-pref-hint", hint));
    wrap.append(labelEl, body);
    return wrap;
  }

  function checkbox(
    key:
      | "autoSave"
      | "autoPairBrackets"
      | "autoPairMarkdown"
      | "codeLineNumbers"
      | "mathAutoNumber"
      | "uploadOnInsert",
    text: string,
    testId: string,
  ): HTMLElement {
    const wrap = el("label", "k-pref-check");
    const input = el("input");
    input.type = "checkbox";
    input.dataset.testid = testId;
    input.addEventListener("change", () => {
      void host.applyChange({ [key]: input.checked } as PreferencesPatch);
    });
    syncers.push((v) => {
      input.checked = Boolean(v[key]);
    });
    wrap.append(input, el("span", undefined, text));
    return wrap;
  }

  function slider(
    key: "fontSize" | "contentWidth",
    min: number,
    max: number,
    step: number,
    clamp: (n: number) => number,
    testId: string,
  ): HTMLElement {
    const wrap = el("div", "k-pref-slider");
    const input = el("input");
    input.type = "range";
    input.id = `k-pref-${key}`;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.dataset.testid = testId;
    const out = el("output", "k-pref-value");
    out.dataset.testid = `${testId}-value`;
    const show = (n: number) => {
      out.textContent = `${n} px`;
    };
    input.addEventListener("input", () => {
      const n = clamp(Number(input.value));
      show(n);
      void host.applyChange({ [key]: n } as PreferencesPatch);
    });
    syncers.push((v) => {
      input.value = String(v[key]);
      show(v[key]);
    });
    wrap.append(input, out);
    return wrap;
  }

  function buildGeneral(): HTMLElement {
    const panel = el("div", "k-pref-panel");
    const select = el("select");
    select.id = "k-pref-startup";
    select.dataset.testid = "pref-startup";
    for (const [value, label] of [
      ["restoreFolder", "重新開啟上次的資料夾"],
      ["blank", "空白文件"],
    ] as const) {
      const opt = el("option", undefined, label);
      opt.value = value;
      select.append(opt);
    }
    select.addEventListener("change", () => {
      void host.applyChange({
        startupBehavior: select.value as StartupBehavior,
      });
    });
    syncers.push((v) => {
      select.value = v.startupBehavior;
    });
    panel.append(
      row("啟動時", select, "從 Finder 開啟的檔案不受影響。"),
      row(
        "自動儲存",
        checkbox(
          "autoSave",
          "停止輸入 1 秒後自動儲存已命名的文件",
          "pref-auto-save",
        ),
        "關閉後只有 Cmd+S 會寫入檔案；切換或關閉文件時仍會儲存，未命名文件仍會寫入救回檔。",
      ),
    );
    return panel;
  }

  function buildEditor(): HTMLElement {
    const panel = el("div", "k-pref-panel");
    panel.append(
      row(
        "字體大小",
        slider(
          "fontSize",
          FONT_SIZE_MIN,
          FONT_SIZE_MAX,
          1,
          clampFontSize,
          "pref-font-size",
        ),
      ),
      row(
        "內容寬度",
        slider(
          "contentWidth",
          CONTENT_WIDTH_MIN,
          CONTENT_WIDTH_MAX,
          CONTENT_WIDTH_STEP,
          clampContentWidth,
          "pref-content-width",
        ),
      ),
    );
    const pairs = el("div", "k-pref-stack");
    pairs.append(
      checkbox(
        "autoPairBrackets",
        "自動配對括號與引號（Cmd+Opt+P）",
        "pref-auto-pair-brackets",
      ),
      checkbox(
        "autoPairMarkdown",
        "自動配對 Markdown 符號 * _ ` ~（Cmd+Opt+Shift+P）",
        "pref-auto-pair-markdown",
      ),
    );
    const blocks = el("div", "k-pref-stack");
    blocks.append(
      checkbox(
        "codeLineNumbers",
        "程式碼區塊顯示行號（Cmd+Opt+L）",
        "pref-code-line-numbers",
      ),
      checkbox(
        "mathAutoNumber",
        "公式自動編號（Cmd+Opt+N）",
        "pref-math-auto-number",
      ),
    );
    panel.append(row("自動配對", pairs), row("區塊", blocks));
    return panel;
  }

  function buildAppearance(): HTMLElement {
    const panel = el("div", "k-pref-panel");
    const select = el("select");
    select.id = "k-pref-theme";
    select.dataset.testid = "pref-theme";
    select.addEventListener("change", () => {
      void host.applyChange({ theme: select.value });
    });
    syncers.push((v) => {
      select.replaceChildren();
      for (const theme of host.getThemes()) {
        const opt = el("option", undefined, theme.label);
        opt.value = theme.id;
        select.append(opt);
      }
      select.value = v.theme;
    });
    const openBtn = el("button", "k-pref-button", "開啟自訂 CSS 資料夾");
    openBtn.type = "button";
    openBtn.dataset.testid = "pref-open-themes-dir";
    openBtn.addEventListener("click", () => {
      void host.openThemesDir();
    });
    panel.append(
      row("主題", select, "也可以用 Cmd+Shift+T 循環切換。"),
      row(
        "自訂主題",
        openBtn,
        "把 .css 檔放進這個資料夾，重新開啟偏好設定或主題選單即可選用。",
      ),
    );
    return panel;
  }

  function buildImages(): HTMLElement {
    const panel = el("div", "k-pref-panel");
    const rootWrap = el("div", "k-pref-inline");
    const rootPath = el("code", "k-pref-path");
    rootPath.dataset.testid = "pref-image-root";
    const pick = el("button", "k-pref-button", "選擇…");
    pick.type = "button";
    pick.dataset.testid = "pref-image-root-pick";
    pick.addEventListener("click", () => {
      void host.pickImageRootDir().then(sync);
    });
    const clear = el("button", "k-pref-button", "清除");
    clear.type = "button";
    clear.dataset.testid = "pref-image-root-clear";
    clear.addEventListener("click", () => {
      void host.clearImageRootDir().then(sync);
    });
    syncers.push((v) => {
      rootPath.textContent = v.imageRootDir ?? "未設定";
      rootPath.dataset.empty = v.imageRootDir ? "false" : "true";
      clear.disabled = !v.imageRootDir;
    });
    rootWrap.append(rootPath, pick, clear);

    const uploader = el("code", "k-pref-path");
    uploader.dataset.testid = "pref-upload-command";
    syncers.push((v) => {
      const cmd = v.uploadCommand?.trim();
      uploader.textContent = cmd ? [cmd, ...v.uploadArgs].join(" ") : "未設定";
      uploader.dataset.empty = cmd ? "false" : "true";
    });

    panel.append(
      row(
        "圖片根目錄",
        rootWrap,
        "以 / 開頭的圖片路徑會相對於這個資料夾（Cmd+Opt+R）。",
      ),
      row(
        "上傳程式",
        uploader,
        "上傳程式只能在 settings.json 的 uploadCommand / uploadArgs 設定，避免網頁內容執行本機程式。",
      ),
      row(
        "上傳時機",
        checkbox(
          "uploadOnInsert",
          "貼上或拖入圖片後立即上傳",
          "pref-upload-on-insert",
        ),
      ),
    );
    return panel;
  }

  const panels = new Map<PreferencesTab, HTMLElement>();
  const tabButtons = new Map<PreferencesTab, HTMLButtonElement>();

  function selectTab(tab: PreferencesTab): void {
    currentTab = tab;
    for (const [id, btn] of tabButtons) {
      const active = id === tab;
      btn.setAttribute("aria-selected", active ? "true" : "false");
      btn.tabIndex = active ? 0 : -1;
    }
    for (const [id, panel] of panels) panel.hidden = id !== tab;
  }

  function sync(): void {
    if (!backdrop) return;
    const values = host.getValues();
    for (const fn of syncers) fn(values);
  }

  function build(): HTMLElement {
    syncers.length = 0;
    panels.clear();
    tabButtons.clear();
    const root = el("div", "k-pref-backdrop");
    const dialog = el("div", "k-pref-dialog");
    dialog.dataset.testid = "preferences";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-label", "偏好設定");

    const header = el("div", "k-pref-header");
    header.append(el("div", "k-pref-title", "偏好設定"));
    const done = el("button", "k-pref-done", "完成");
    done.type = "button";
    done.dataset.testid = "pref-close";
    done.addEventListener("click", close);
    header.append(done);

    const tabs = el("div", "k-pref-tabs");
    tabs.setAttribute("role", "tablist");
    const builders: Record<PreferencesTab, () => HTMLElement> = {
      general: buildGeneral,
      editor: buildEditor,
      appearance: buildAppearance,
      images: buildImages,
    };
    const body = el("div", "k-pref-body");
    for (const { id, label } of PREFERENCES_TABS) {
      const btn = el("button", "k-pref-tab", label);
      btn.type = "button";
      btn.dataset.testid = `pref-tab-${id}`;
      btn.setAttribute("role", "tab");
      btn.addEventListener("click", () => selectTab(id));
      tabButtons.set(id, btn);
      tabs.append(btn);
      const panel = builders[id]();
      panel.setAttribute("role", "tabpanel");
      panel.dataset.testid = `pref-panel-${id}`;
      panels.set(id, panel);
      body.append(panel);
    }
    dialog.append(header, tabs, body);
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
    const target = event.target as HTMLElement | null;
    if (
      target?.getAttribute("role") === "tab" &&
      (event.key === "ArrowLeft" || event.key === "ArrowRight")
    ) {
      event.preventDefault();
      const ids = PREFERENCES_TABS.map((t) => t.id);
      const idx = ids.indexOf(currentTab);
      const next =
        ids[
          (idx + (event.key === "ArrowRight" ? 1 : -1) + ids.length) %
            ids.length
        ];
      selectTab(next);
      tabButtons.get(next)?.focus();
    }
  };

  async function open(tab?: PreferencesTab): Promise<void> {
    await host.refresh?.().catch(() => null);
    if (!backdrop) {
      previousFocus = doc.activeElement as HTMLElement | null;
      backdrop = build();
      doc.body.append(backdrop);
      doc.addEventListener("keydown", onKeydown, true);
    }
    selectTab(tab ?? currentTab);
    sync();
    tabButtons.get(currentTab)?.focus();
  }

  function close(): void {
    if (!backdrop) return;
    doc.removeEventListener("keydown", onKeydown, true);
    backdrop.remove();
    backdrop = null;
    previousFocus?.focus?.();
    previousFocus = null;
  }

  return {
    open,
    close,
    isOpen: () => backdrop !== null,
    getTab: () => currentTab,
    sync,
    destroy: close,
  };
}
