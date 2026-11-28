/**
 * #147: First-launch welcome document (zh-TW & en) and startup eligibility check.
 *
 * Content lives in `src/welcome/zh-TW.md` and `src/welcome/en.md`, opened in an
 * untitled tab without writing to disk. Shortcut placeholders are resolved from
 * `src/menu/menu-spec.json` via `formatAccelerator`.
 */
import { getUiLocale, type UiLocale } from "../i18n";
import type { Settings } from "../ipc";
import {
  currentMenuPlatform,
  formatAccelerator,
  type MenuPlatform,
  menuActions,
  menuSpecFor,
} from "../menu/menu-dispatch";
import enWelcomeRaw from "./en.md?raw";
import zhTwWelcomeRaw from "./zh-TW.md?raw";

const WELCOME_RAW: Record<UiLocale, string> = {
  "zh-TW": zhTwWelcomeRaw,
  en: enWelcomeRaw,
};

const PLACEHOLDER_ACTIONS: Record<string, string> = {
  quickOpen: "file.quickOpen",
  newTab: "file.newTab",
  sourceMode: "view.sourceMode",
  shortcuts: "help.shortcuts",
};

/** Returns the localized welcome document with platform-formatted shortcuts from menu-spec.json. */
export function getWelcomeContent(
  locale: UiLocale = getUiLocale(),
  platform: MenuPlatform = currentMenuPlatform(),
): string {
  const actions = new Map(
    menuActions(menuSpecFor(platform)).map((a) => [a.id, a.accel]),
  );
  const template = WELCOME_RAW[locale] ?? WELCOME_RAW["zh-TW"];
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
    const actionId = PLACEHOLDER_ACTIONS[key];
    const accel = actionId ? actions.get(actionId) : undefined;
    return accel ? formatAccelerator(accel, platform) : match;
  });
}

export interface WelcomeStartupContext {
  settings: Settings | null;
  hasRecoveryEntries: boolean;
  openedFilesFromOs: boolean;
}

/**
 * True only on a clean first launch: no settings file existed yet
 * (`welcomeShown === false`), no recent files, no restored folder, no crash
 * recovery entries, and no files opened from the OS.
 */
export function shouldShowWelcomeOnStartup({
  settings,
  hasRecoveryEntries,
  openedFilesFromOs,
}: WelcomeStartupContext): boolean {
  if (!settings) return false;
  if (settings.welcomeShown !== false) return false;
  if ((settings.recentFiles ?? []).length > 0) return false;
  if (settings.lastFolder) return false;
  if (hasRecoveryEntries || openedFilesFromOs) return false;
  return true;
}
