/**
 * #147: single-source-of-truth builder for the keyboard shortcuts cheatsheet.
 *
 * Every menu shortcut comes directly from `src/menu/menu-spec.json` via
 * `menuSpecFor(platform)`, and non-menu editor/search/table/app shortcuts come
 * directly from their defining keymap exports (`EDITOR_EXTRA_SHORTCUT_LIST`,
 * `SEARCH_EXTRA_SHORTCUTS`, `TABLE_SHORTCUTS`, `APP_EXTRA_SHORTCUTS`).
 */
import {
  EDITOR_EXTRA_SHORTCUT_LIST,
  type KeymapShortcutDef,
} from "../editor/keymaps";
import { SEARCH_EXTRA_SHORTCUTS } from "../editor/search";
import { TABLE_ACTION_LABELS, TABLE_SHORTCUTS } from "../editor/table-toolbar";
import { type MessageKey, t } from "../i18n";
import {
  currentMenuPlatform,
  formatAccelerator,
  type MenuNode,
  type MenuPlatform,
  menuSpecFor,
} from "../menu/menu-dispatch";

export type ShortcutCategoryId =
  | "file"
  | "edit"
  | "paragraph"
  | "format"
  | "view"
  | "tabs"
  | "search";

export const SHORTCUT_CATEGORY_ORDER: readonly ShortcutCategoryId[] = [
  "file",
  "edit",
  "paragraph",
  "format",
  "view",
  "tabs",
  "search",
];

const CATEGORY_LABEL_KEYS: Record<ShortcutCategoryId, MessageKey> = {
  file: "shortcuts.category.file",
  edit: "shortcuts.category.edit",
  paragraph: "shortcuts.category.paragraph",
  format: "shortcuts.category.format",
  view: "shortcuts.category.view",
  tabs: "shortcuts.category.tabs",
  search: "shortcuts.category.search",
};

export interface ShortcutEntry {
  readonly id: string;
  readonly category: ShortcutCategoryId;
  readonly labelKey: MessageKey;
  readonly label: string;
  /** Canonical Tauri-style accelerator string ("CmdOrCtrl+Shift+S"). */
  readonly accel: string;
  /** Formatted for the target platform ("⇧⌘S" on macOS, "Ctrl+Shift+S" on Windows). */
  readonly displayKey: string;
  readonly source: "menu" | "predefined" | "keymap";
}

export interface ShortcutGroup {
  readonly id: ShortcutCategoryId;
  readonly labelKey: MessageKey;
  readonly title: string;
  readonly items: ShortcutEntry[];
}

export interface AppExtraShortcutDef {
  readonly id: string;
  readonly accel: string;
  readonly labelKey: MessageKey;
  readonly category: ShortcutCategoryId;
}

/**
 * App-level window shortcuts not listed in `src/menu/menu-spec.json`.
 * Shared between `src/main.ts` and the cheatsheet.
 */
export const APP_EXTRA_SHORTCUTS: readonly AppExtraShortcutDef[] = [
  {
    id: "app.pickImageRoot",
    accel: "CmdOrCtrl+Alt+R",
    labelKey: "shortcuts.item.pickImageRoot",
    category: "edit",
  },
  {
    id: "app.clearImageRoot",
    accel: "CmdOrCtrl+Alt+Shift+R",
    labelKey: "shortcuts.item.clearImageRoot",
    category: "edit",
  },
  {
    id: "app.uploadImages",
    accel: "CmdOrCtrl+Alt+U",
    labelKey: "shortcuts.item.uploadImages",
    category: "edit",
  },
];

/** Converts a CodeMirror key spec ("Mod-Alt-ArrowUp", "Mod-Shift-c") to a Tauri accelerator. */
export function cmKeyToAccelerator(cmKey: string): string {
  // Handle a trailing "-" key (e.g. "Mod--") safely if ever added.
  const trailingMinus = cmKey.endsWith("--");
  const raw = trailingMinus ? cmKey.slice(0, -1) : cmKey;
  const parts = raw.split("-").filter((p) => p.length > 0);
  if (trailingMinus) parts.push("-");
  const keyToken = parts.pop() ?? "";
  const mods: string[] = [];
  for (const mod of parts) {
    const lower = mod.toLowerCase();
    if (lower === "mod") mods.push("CmdOrCtrl");
    else if (lower === "ctrl" || lower === "control") mods.push("Ctrl");
    else if (lower === "alt" || lower === "option") mods.push("Alt");
    else if (lower === "shift") mods.push("Shift");
    else if (lower === "cmd" || lower === "meta") mods.push("Cmd");
    else mods.push(mod);
  }
  const formattedKey =
    keyToken.length === 1 && /^[a-z]$/.test(keyToken)
      ? keyToken.toUpperCase()
      : keyToken;
  return [...mods, formattedKey].join("+");
}

function cleanLabel(labelKey: MessageKey): string {
  return t(labelKey).replace(/…$/, "");
}

function categoryForMenuAction(
  id: string,
  submenuLabelKey: string,
): ShortcutCategoryId {
  if (
    id === "file.newTab" ||
    id === "file.closeTab" ||
    submenuLabelKey === "menu.window.title"
  ) {
    return "tabs";
  }
  if (submenuLabelKey === "menu.edit.findMenu") return "search";
  if (
    submenuLabelKey === "menu.file.title" ||
    submenuLabelKey === "menu.file.exportMenu" ||
    submenuLabelKey === "menu.app.title" ||
    id.startsWith("file.") ||
    id.startsWith("app.")
  ) {
    return "file";
  }
  if (submenuLabelKey === "menu.edit.title" || id.startsWith("edit.")) {
    return "edit";
  }
  if (submenuLabelKey === "menu.para.title" || id.startsWith("para.")) {
    return "paragraph";
  }
  if (submenuLabelKey === "menu.fmt.title" || id.startsWith("fmt.")) {
    return "format";
  }
  return "view";
}

function predefinedEditAccel(
  item: string,
  platform: MenuPlatform,
): string | null {
  switch (item) {
    case "undo":
      return "CmdOrCtrl+Z";
    case "redo":
      return platform === "macos" ? "CmdOrCtrl+Shift+Z" : "Ctrl+Y";
    case "cut":
      return "CmdOrCtrl+X";
    case "copy":
      return "CmdOrCtrl+C";
    case "paste":
      return "CmdOrCtrl+V";
    case "selectAll":
      return "CmdOrCtrl+A";
    default:
      return null;
  }
}

/** Builds all categorized shortcut groups for `platform` from the canonical sources. */
export function buildShortcutGroups(
  platform: MenuPlatform = currentMenuPlatform(),
): ShortcutGroup[] {
  const buckets = new Map<ShortcutCategoryId, ShortcutEntry[]>();
  for (const id of SHORTCUT_CATEGORY_ORDER) {
    buckets.set(id, []);
  }
  const seenAccels = new Set<string>();

  const push = (entry: ShortcutEntry): void => {
    const key = `${entry.category}:${entry.accel.toLowerCase()}`;
    if (seenAccels.has(key)) return;
    seenAccels.add(key);
    buckets.get(entry.category)!.push(entry);
  };

  const walk = (nodes: MenuNode[], submenuLabelKey: string): void => {
    for (const node of nodes) {
      if (node.type === "submenu") {
        walk(node.items, node.labelKey);
      } else if (node.type === "themes" || node.type === "recentFiles") {
        walk(node.items, submenuLabelKey);
      } else if (node.type === "action" && node.accel) {
        const category = categoryForMenuAction(node.id, submenuLabelKey);
        const labelKey = node.labelKey as MessageKey;
        push({
          id: node.id,
          category,
          labelKey,
          label: cleanLabel(labelKey),
          accel: node.accel,
          displayKey: formatAccelerator(node.accel, platform),
          source: "menu",
        });
      } else if (
        node.type === "predefined" &&
        submenuLabelKey === "menu.edit.title" &&
        node.labelKey
      ) {
        const accel = predefinedEditAccel(node.item, platform);
        if (!accel) continue;
        const labelKey = node.labelKey as MessageKey;
        push({
          id: `edit.${node.item}`,
          category: "edit",
          labelKey,
          label: cleanLabel(labelKey),
          accel,
          displayKey: formatAccelerator(accel, platform),
          source: "predefined",
        });
      }
    }
  };

  walk(menuSpecFor(platform), "");

  const pushKeymapDef = (def: KeymapShortcutDef): void => {
    const accel = cmKeyToAccelerator(def.key);
    push({
      id: def.id,
      category: def.category,
      labelKey: def.labelKey,
      label: cleanLabel(def.labelKey),
      accel,
      displayKey: formatAccelerator(accel, platform),
      source: "keymap",
    });
  };

  for (const def of EDITOR_EXTRA_SHORTCUT_LIST) {
    pushKeymapDef(def);
  }
  for (const def of SEARCH_EXTRA_SHORTCUTS) {
    pushKeymapDef(def);
  }
  for (const def of APP_EXTRA_SHORTCUTS) {
    push({
      id: def.id,
      category: def.category,
      labelKey: def.labelKey,
      label: cleanLabel(def.labelKey),
      accel: def.accel,
      displayKey: formatAccelerator(def.accel, platform),
      source: "keymap",
    });
  }
  for (const spec of TABLE_SHORTCUTS) {
    const accel = cmKeyToAccelerator(spec.key);
    const labelKey = TABLE_ACTION_LABELS[spec.action];
    push({
      id: `table.${spec.action}`,
      category: "paragraph",
      labelKey,
      label: cleanLabel(labelKey),
      accel,
      displayKey: formatAccelerator(accel, platform),
      source: "keymap",
    });
  }

  return SHORTCUT_CATEGORY_ORDER.map((id) => ({
    id,
    labelKey: CATEGORY_LABEL_KEYS[id],
    title: t(CATEGORY_LABEL_KEYS[id]),
    items: buckets.get(id) ?? [],
  })).filter((g) => g.items.length > 0);
}

/** Normalizes a search string so users can query by symbol or modifier name. */
function searchableText(entry: ShortcutEntry, groupTitle: string): string {
  const expanded = entry.displayKey
    .replace(/⌘/g, " cmd command ⌘ ")
    .replace(/⌥/g, " opt option alt ⌥ ")
    .replace(/⇧/g, " shift ⇧ ")
    .replace(/⌃/g, " ctrl control ⌃ ")
    .replace(/⇥/g, " tab ⇥ ")
    .replace(/⌫/g, " backspace delete ⌫ ");
  return `${entry.label} ${groupTitle} ${entry.displayKey} ${entry.accel} ${expanded}`.toLowerCase();
}

/** Filters shortcut groups by space-separated search terms (case-insensitive). */
export function filterShortcutGroups(
  groups: readonly ShortcutGroup[],
  rawQuery: string,
): ShortcutGroup[] {
  const terms = rawQuery
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((term) => term.length > 0);
  if (terms.length === 0) return groups.map((g) => ({ ...g }));

  const out: ShortcutGroup[] = [];
  for (const group of groups) {
    const items = group.items.filter((entry) => {
      const haystack = searchableText(entry, group.title);
      return terms.every((term) => haystack.includes(term));
    });
    if (items.length > 0) {
      out.push({ ...group, items });
    }
  }
  return out;
}
