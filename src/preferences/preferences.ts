import "./preferences.css";

import {
  getUiLocale,
  normalizeUiLocale,
  t,
  UI_LOCALES,
  type UiLocale,
} from "../i18n";
import type { StartupBehavior } from "../ipc";
import { IS_WINDOWS, shortcutLabel, toNativePath } from "../platform";

/**
 * #74 偏好設定 (Cmd+,): an in-app modal. Every control applies its change at
 * once through the host (which also writes settings.json); there is no
 * "apply" button. Built with textContent only (no HTML strings).
 */

export type PreferencesTab = "general" | "editor" | "appearance" | "images";

const PREFERENCES_TABS: PreferencesTab[] = [
  "general",
  "editor",
  "appearance",
  "images",
];

const LANGUAGE_NAMES: Record<UiLocale, string> = {
  "zh-TW": "繁體中文",
  en: "English",
};

export const FONT_SIZE_MIN = 12;
export const FONT_SIZE_MAX = 28;
export const CONTENT_WIDTH_MIN = 480;
export const CONTENT_WIDTH_MAX = 1400;
export const CONTENT_WIDTH_STEP = 20;

export interface PreferencesValues {
  uiLocale: UiLocale;
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
  saveUiLocale: (locale: UiLocale) => Promise<void>;
  restartApp: () => Promise<void>;
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
    hint?: string | HTMLElement,
  ): HTMLElement {
    const wrap = el("div", "k-pref-row");
    const labelEl = el("label", "k-pref-label", label);
    if (control.id) labelEl.htmlFor = control.id;
    const body = el("div", "k-pref-control");
    body.append(control);
    if (hint)
      body.append(
        typeof hint === "string" ? el("div", "k-pref-hint", hint) : hint,
      );
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

  function buildLanguageRow(): HTMLElement {
    const select = el("select");
    select.id = "k-pref-language";
    select.dataset.testid = "pref-language";
    for (const locale of UI_LOCALES) {
      const opt = el("option", undefined, LANGUAGE_NAMES[locale]);
      opt.value = locale;
      opt.lang = locale;
      select.append(opt);
    }
    const notice = el("div", "k-pref-hint");
    notice.id = "k-pref-language-notice";
    notice.setAttribute("role", "status");
    select.setAttribute("aria-describedby", notice.id);
    const updateNotice = (locale: UiLocale): void => {
      notice.textContent =
        locale === getUiLocale() ? "" : t("prefs.languageOnRestart");
    };
    const prompt = el("dialog", "k-pref-restart");
    const title = el("h1", undefined, t("prefs.restartQuestion"));
    title.id = "k-pref-restart-title";
    prompt.setAttribute("aria-labelledby", title.id);
    const actions = el("form");
    actions.method = "dialog";
    const later = el("button", "k-pref-button", t("prefs.restartLater"));
    later.value = "later";
    later.autofocus = true;
    const now = el("button", "k-pref-button", t("prefs.restartNow"));
    now.value = "restart";
    actions.append(later, now);
    prompt.append(title, actions);
    prompt.addEventListener("keydown", (event) => event.stopPropagation());
    prompt.addEventListener("close", async () => {
      const confirmed = prompt.returnValue === "restart";
      prompt.returnValue = "";
      if (!confirmed || !prompt.isConnected) return;
      select.disabled = true;
      try {
        await host.restartApp();
      } catch {
        notice.textContent = t("prefs.restartFailed");
      } finally {
        select.disabled = false;
      }
    });
    syncers.push((values) => {
      select.value = values.uiLocale;
      updateNotice(values.uiLocale);
    });
    select.addEventListener("change", async () => {
      select.disabled = true;
      try {
        await host.saveUiLocale(normalizeUiLocale(select.value));
        updateNotice(host.getValues().uiLocale);
      } catch {
        select.value = host.getValues().uiLocale;
        notice.textContent = t("prefs.languageSaveError");
        return;
      } finally {
        select.disabled = false;
      }
      if (prompt.isConnected && host.getValues().uiLocale !== getUiLocale()) {
        prompt.showModal();
      }
    });
    const field = row(t("prefs.language"), select, notice);
    field.append(prompt);
    return field;
  }

  function buildGeneral(): HTMLElement {
    const panel = el("div", "k-pref-panel");
    const select = el("select");
    select.id = "k-pref-startup";
    select.dataset.testid = "pref-startup";
    for (const [value, label] of [
      ["restoreFolder", t("prefs.reopenFolder")],
      ["blank", t("prefs.blankDocument")],
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
      buildLanguageRow(),
      row(
        t("prefs.onStartup"),
        select,
        IS_WINDOWS ? t("prefs.startupWindowsHint") : t("prefs.startupMacHint"),
      ),
      row(
        t("prefs.autoSave"),
        checkbox("autoSave", t("prefs.autoSaveDescription"), "pref-auto-save"),
        shortcutLabel(t("prefs.autoSaveHint")),
      ),
    );
    return panel;
  }

  function buildEditor(): HTMLElement {
    const panel = el("div", "k-pref-panel");
    panel.append(
      row(
        t("prefs.fontSize"),
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
        t("prefs.contentWidth"),
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
        shortcutLabel(t("prefs.autoPairBrackets")),
        "pref-auto-pair-brackets",
      ),
      checkbox(
        "autoPairMarkdown",
        shortcutLabel(t("prefs.autoPairMarkdown")),
        "pref-auto-pair-markdown",
      ),
    );
    const blocks = el("div", "k-pref-stack");
    blocks.append(
      checkbox(
        "codeLineNumbers",
        shortcutLabel(t("prefs.codeLineNumbers")),
        "pref-code-line-numbers",
      ),
      checkbox(
        "mathAutoNumber",
        shortcutLabel(t("prefs.mathAutoNumber")),
        "pref-math-auto-number",
      ),
    );
    panel.append(
      row(t("prefs.autoPair"), pairs),
      row(t("prefs.blocks"), blocks),
    );
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
    const openBtn = el("button", "k-pref-button", t("prefs.openThemesFolder"));
    openBtn.type = "button";
    openBtn.dataset.testid = "pref-open-themes-dir";
    openBtn.addEventListener("click", () => {
      void host.openThemesDir();
    });
    panel.append(
      row(t("prefs.theme"), select, shortcutLabel(t("prefs.themeHint"))),
      row(t("prefs.customTheme"), openBtn, t("prefs.customThemeHint")),
    );
    return panel;
  }

  function buildImages(): HTMLElement {
    const panel = el("div", "k-pref-panel");
    const rootWrap = el("div", "k-pref-inline");
    const rootPath = el("code", "k-pref-path");
    rootPath.dataset.testid = "pref-image-root";
    const pick = el("button", "k-pref-button", t("prefs.choose"));
    pick.type = "button";
    pick.dataset.testid = "pref-image-root-pick";
    pick.addEventListener("click", () => {
      void host.pickImageRootDir().then(sync);
    });
    const clear = el("button", "k-pref-button", t("prefs.clear"));
    clear.type = "button";
    clear.dataset.testid = "pref-image-root-clear";
    clear.addEventListener("click", () => {
      void host.clearImageRootDir().then(sync);
    });
    syncers.push((v) => {
      rootPath.textContent = v.imageRootDir
        ? toNativePath(v.imageRootDir)
        : t("prefs.notSet");
      rootPath.dataset.empty = v.imageRootDir ? "false" : "true";
      clear.disabled = !v.imageRootDir;
    });
    rootWrap.append(rootPath, pick, clear);

    const uploader = el("code", "k-pref-path");
    uploader.dataset.testid = "pref-upload-command";
    syncers.push((v) => {
      const cmd = v.uploadCommand?.trim();
      uploader.textContent = cmd
        ? [cmd, ...v.uploadArgs].join(" ")
        : t("prefs.notSet");
      uploader.dataset.empty = cmd ? "false" : "true";
    });

    panel.append(
      row(
        t("prefs.imageRoot"),
        rootWrap,
        shortcutLabel(t("prefs.imageRootHint")),
      ),
      row(t("prefs.uploader"), uploader, t("prefs.uploaderHint")),
      row(
        t("prefs.uploadWhen"),
        checkbox(
          "uploadOnInsert",
          t("prefs.uploadOnInsert"),
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
    dialog.setAttribute("aria-labelledby", "k-pref-title");

    const header = el("div", "k-pref-header");
    const title = el("div", "k-pref-title", t("prefs.title"));
    title.id = "k-pref-title";
    header.append(title);
    const done = el("button", "k-pref-done", t("prefs.done"));
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
    for (const id of PREFERENCES_TABS) {
      const btn = el("button", "k-pref-tab", t(`prefs.tab.${id}`));
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
    if (!backdrop || backdrop.querySelector("dialog[open]")) return;
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
      const ids = PREFERENCES_TABS;
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
