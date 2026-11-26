import "./theme-menu.css";
import { t } from "../i18n";
import {
  getSettings,
  listThemes,
  readThemeCss,
  type SystemDarkTheme,
  setSettings,
  type ThemeInfo,
} from "../ipc";
import { shortcutLabel } from "../platform";

export const CUSTOM_THEME_STYLE_ID = "k-custom-theme";

export type BuiltinThemeId = "papyros" | "melan" | "nyx";

export interface ThemeOptionItem {
  id: string;
  label: string;
  builtin: boolean;
}

export function normalizeSystemDarkTheme(
  value?: string | null,
): SystemDarkTheme {
  return value === "nyx" ? "nyx" : "melan";
}

export function applySystemDarkTheme(darkTheme?: string | null): void {
  if (typeof document === "undefined") return;
  const normalized = normalizeSystemDarkTheme(darkTheme);
  if (normalized === "nyx") {
    document.documentElement.setAttribute("data-system-dark-theme", "nyx");
  } else {
    document.documentElement.removeAttribute("data-system-dark-theme");
  }
}

export function builtinThemeLabel(id: string, fallback: string): string {
  switch (id) {
    case "papyros":
      return t("theme.papyros");
    case "melan":
      return t("theme.melan");
    case "nyx":
      return t("theme.nyx");
    default:
      return fallback;
  }
}

export function detectBaseThemeForCustomCss(css: string): BuiltinThemeId {
  if (/data-base-theme\s*:\s*nyx/i.test(css)) {
    return "nyx";
  }
  if (/data-base-theme\s*:\s*melan/i.test(css)) {
    return "melan";
  }
  if (/data-base-theme\s*:\s*papyros/i.test(css)) {
    return "papyros";
  }
  if (/color-scheme\s*:\s*dark/i.test(css)) {
    return "melan";
  }
  if (/color-scheme\s*:\s*light/i.test(css)) {
    return "papyros";
  }
  if (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  ) {
    return typeof document !== "undefined" &&
      document.documentElement.getAttribute("data-system-dark-theme") === "nyx"
      ? "nyx"
      : "melan";
  }
  return "papyros";
}

function removeCustomThemeStyleEl(): void {
  if (typeof document === "undefined") return;
  const existing = document.getElementById(CUSTOM_THEME_STYLE_ID);
  if (existing) {
    existing.remove();
  }
}

function setCustomThemeStyleEl(
  themeId: string,
  css: string,
): HTMLStyleElement | null {
  if (typeof document === "undefined") return null;
  let styleEl = document.getElementById(
    CUSTOM_THEME_STYLE_ID,
  ) as HTMLStyleElement | null;
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = CUSTOM_THEME_STYLE_ID;
  }
  // Always move/append to the very end of <head> so :root[data-custom-theme] (0,2,0)
  // overrides built-in :root[data-theme="papyros"|"melan"] (0,2,0)
  document.head.appendChild(styleEl);
  styleEl.dataset.themeId = themeId;
  styleEl.textContent = css;
  return styleEl;
}

export async function applyThemeWithCustomCss(themeId: string): Promise<void> {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const normalized = themeId?.trim() || "system";

  if (normalized === "system") {
    removeCustomThemeStyleEl();
    root.removeAttribute("data-custom-theme");
    root.removeAttribute("data-theme");
    return;
  }

  if (
    normalized === "papyros" ||
    normalized === "melan" ||
    normalized === "nyx"
  ) {
    removeCustomThemeStyleEl();
    root.removeAttribute("data-custom-theme");
    root.setAttribute("data-theme", normalized);
    return;
  }

  if (normalized.startsWith("custom:")) {
    const css = await readThemeCss(normalized);
    const baseTheme = detectBaseThemeForCustomCss(css);
    root.setAttribute("data-theme", baseTheme);
    root.setAttribute("data-custom-theme", normalized);
    setCustomThemeStyleEl(normalized, css);
    return;
  }

  // Fallback for unknown theme identifiers
  removeCustomThemeStyleEl();
  root.removeAttribute("data-custom-theme");
  root.setAttribute("data-theme", normalized);
}

export interface CreateThemeMenuOptions {
  parent: HTMLElement;
  onThemeChange?: (themeId: string) => void | Promise<void>;
  onError?: (prefix: string, err: unknown) => void;
}

export interface ThemeMenuController {
  element: HTMLElement;
  buttonElement: HTMLButtonElement;
  menuElement: HTMLElement;
  getCurrentTheme: () => string;
  getAvailableOptions: () => ThemeOptionItem[];
  isOpen: () => boolean;
  openMenu: () => Promise<void>;
  closeMenu: () => void;
  toggleMenu: () => Promise<boolean>;
  selectTheme: (themeId: string, persist?: boolean) => Promise<boolean>;
  cycleTheme: () => Promise<string>;
  refreshThemes: () => Promise<ThemeOptionItem[]>;
  init: () => Promise<void>;
  destroy: () => void;
}

export function createThemeMenu(
  options: CreateThemeMenuOptions,
): ThemeMenuController {
  const { parent, onThemeChange, onError } = options;

  function systemOption(): ThemeOptionItem {
    return { id: "system", label: t("theme.system"), builtin: true };
  }

  function defaultOptions(): ThemeOptionItem[] {
    return [
      systemOption(),
      { id: "papyros", label: t("theme.papyros"), builtin: true },
      { id: "melan", label: t("theme.melan"), builtin: true },
      { id: "nyx", label: t("theme.nyx"), builtin: true },
    ];
  }

  let currentTheme = "system";
  let menuOpen = false;
  let availableOptions = defaultOptions();

  const widgetEl = document.createElement("div");
  widgetEl.className = "k-theme-widget";

  const btnEl = document.createElement("button");
  btnEl.type = "button";
  btnEl.className = "k-theme-btn";
  btnEl.id = "theme-menu-btn";
  btnEl.dataset.testid = "theme-menu-button";
  btnEl.title = t("theme.menu.tooltip", {
    shortcut: shortcutLabel("Cmd+Shift+T"),
  });
  btnEl.setAttribute("aria-label", t("theme.menu.label"));
  btnEl.setAttribute("aria-haspopup", "menu");
  btnEl.setAttribute("aria-expanded", "false");
  // 1.5px stroke width, round linecap icon per PRD §12.5
  btnEl.innerHTML = `<svg class="k-icon" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="M12 3v2M12 19v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M3 12h2M19 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

  const menuEl = document.createElement("div");
  menuEl.className = "k-theme-menu";
  menuEl.id = "theme-menu";
  menuEl.dataset.testid = "theme-menu";
  menuEl.dataset.visible = "false";
  menuEl.setAttribute("role", "menu");

  widgetEl.append(btnEl, menuEl);
  parent.appendChild(widgetEl);

  function renderOptions(): void {
    menuEl.innerHTML = "";
    for (const item of availableOptions) {
      const isActive = item.id === currentTheme;
      const optBtn = document.createElement("button");
      optBtn.type = "button";
      optBtn.className = "k-theme-option";
      optBtn.dataset.testid = "theme-option";
      optBtn.dataset.themeId = item.id;
      optBtn.dataset.active = isActive ? "true" : "false";
      optBtn.setAttribute("role", "menuitemradio");
      optBtn.setAttribute("aria-checked", isActive ? "true" : "false");

      const labelSpan = document.createElement("span");
      labelSpan.textContent = item.label;

      const checkSpan = document.createElement("span");
      checkSpan.className = "k-theme-option-check";
      checkSpan.textContent = "✓";

      optBtn.append(labelSpan, checkSpan);
      optBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeMenu();
        void selectTheme(item.id, true);
      });
      menuEl.appendChild(optBtn);
    }
  }

  async function refreshThemes(): Promise<ThemeOptionItem[]> {
    try {
      const themes: ThemeInfo[] = await listThemes();
      availableOptions = [
        systemOption(),
        ...themes.map((theme) => ({
          id: theme.id,
          label: theme.builtin
            ? builtinThemeLabel(theme.id, theme.name)
            : theme.name,
          builtin: theme.builtin,
        })),
      ];
    } catch {
      availableOptions = defaultOptions();
    }
    renderOptions();
    return [...availableOptions];
  }

  async function selectTheme(
    themeId: string,
    persist = true,
  ): Promise<boolean> {
    const targetId = themeId?.trim() || "system";
    try {
      await applyThemeWithCustomCss(targetId);
      currentTheme = targetId;
      renderOptions();
      if (persist) {
        const settings = await getSettings();
        await setSettings({
          ...settings,
          theme: targetId,
        });
      }
      await onThemeChange?.(targetId);
      return true;
    } catch (err) {
      onError?.(t("theme.applyError"), err);
      return false;
    }
  }

  async function cycleTheme(): Promise<string> {
    await refreshThemes();
    if (availableOptions.length === 0) return currentTheme;
    const currentIdx = availableOptions.findIndex((o) => o.id === currentTheme);
    const nextIdx =
      currentIdx === -1 ? 0 : (currentIdx + 1) % availableOptions.length;
    const nextThemeId = availableOptions[nextIdx].id;
    await selectTheme(nextThemeId, true);
    return nextThemeId;
  }

  async function openMenu(): Promise<void> {
    await refreshThemes();
    menuOpen = true;
    menuEl.dataset.visible = "true";
    btnEl.setAttribute("aria-expanded", "true");
  }

  function closeMenu(): void {
    menuOpen = false;
    menuEl.dataset.visible = "false";
    btnEl.setAttribute("aria-expanded", "false");
  }

  async function toggleMenu(): Promise<boolean> {
    if (menuOpen) {
      closeMenu();
      return false;
    }
    await openMenu();
    return true;
  }

  btnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    void toggleMenu();
  });

  const onDocumentClick = (e: MouseEvent) => {
    if (menuOpen && !widgetEl.contains(e.target as Node)) {
      closeMenu();
    }
  };

  const onDocumentKeydown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && menuOpen) {
      e.preventDefault();
      closeMenu();
    }
  };

  document.addEventListener("click", onDocumentClick);
  document.addEventListener("keydown", onDocumentKeydown);

  async function init(): Promise<void> {
    await refreshThemes();
    const settings = await getSettings().catch(() => null);
    if (settings && settings.theme) {
      await selectTheme(settings.theme, false);
    } else {
      await selectTheme("system", false);
    }
  }

  function destroy(): void {
    document.removeEventListener("click", onDocumentClick);
    document.removeEventListener("keydown", onDocumentKeydown);
    widgetEl.remove();
  }

  renderOptions();

  return {
    element: widgetEl,
    buttonElement: btnEl,
    menuElement: menuEl,
    getCurrentTheme: () => currentTheme,
    getAvailableOptions: () => [...availableOptions],
    isOpen: () => menuOpen,
    openMenu,
    closeMenu,
    toggleMenu,
    selectTheme,
    cycleTheme,
    refreshThemes,
    init,
    destroy,
  };
}
