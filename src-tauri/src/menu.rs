//! #74 / #89: native application menu bar (macOS menu bar; Windows / Linux window menu bar).
//!
//! The menu layout lives in `src/menu/menu-spec.json`, shared with the
//! frontend (which uses the same accelerators to keep a shortcut from running
//! twice). Items can carry an optional `"platforms"` list (`"macos"`,
//! `"windows"`, `"linux"`) so macOS-only items stay off Windows and Windows
//! puts Preferences and Quit under File and About under Help. Flat `labelKey`
//! values resolve against the shared dictionaries in `src/i18n/locales` using
//! the locale selected at startup. Clicking a custom item
//! emits `menu-action` to the WebView, where the existing keyboard handlers
//! run — no command logic is duplicated here. Standard edit items (undo / copy
//! / paste…) are predefined items, so they go through the OS / WebView
//! responder path.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::menu::{
    AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind,
    PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::{AppError, ErrorKind};
use crate::settings::{snapshot_ui_locale, UiLocale};

pub const MENU_SPEC_JSON: &str = include_str!("../../src/menu/menu-spec.json");
pub const MENU_ACTION_EVENT: &str = "menu-action";
/// Prefix of the ids of the generated theme items (`theme:custom:night`).
pub const THEME_ITEM_PREFIX: &str = "theme:";
pub const SET_THEME_ACTION: &str = "view.setTheme";
/// #104: prefix of the ids of the generated recent-file items (`recent:/path/to/file.md`).
pub const RECENT_ITEM_PREFIX: &str = "recent:";
pub const OPEN_RECENT_ACTION: &str = "file.openRecent";
const CLEAR_RECENT_ACTION: &str = "file.clearRecent";
const RECENT_EMPTY_ID: &str = "recent-empty";
const RECENT_EMPTY_LABEL_KEY: &str = "menu.file.recentEmpty";

struct MenuLabels(HashMap<String, String>);

impl MenuLabels {
    fn for_locale(locale: UiLocale) -> &'static Self {
        static ZH_TW: OnceLock<MenuLabels> = OnceLock::new();
        static EN: OnceLock<MenuLabels> = OnceLock::new();
        let (catalog, json) = match locale {
            UiLocale::ZhTw => (&ZH_TW, include_str!("../../src/i18n/locales/zh-TW.json")),
            UiLocale::En => (&EN, include_str!("../../src/i18n/locales/en.json")),
        };
        catalog.get_or_init(|| {
            Self(serde_json::from_str(json).expect("UI locale dictionary is a flat string map"))
        })
    }

    fn get<'a>(&'a self, key: &'a str) -> &'a str {
        self.0
            .get(key)
            .or_else(|| Self::for_locale(UiLocale::ZhTw).0.get(key))
            .map_or(key, String::as_str)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MenuPlatform {
    Macos,
    Windows,
    Linux,
}

impl MenuPlatform {
    pub const fn current() -> Self {
        #[cfg(target_os = "macos")]
        {
            Self::Macos
        }
        #[cfg(target_os = "windows")]
        {
            Self::Windows
        }
        #[cfg(not(any(target_os = "macos", target_os = "windows")))]
        {
            Self::Linux
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmenuRole {
    App,
    Window,
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MenuNode {
    Submenu {
        label_key: String,
        #[serde(default)]
        role: Option<SubmenuRole>,
        #[serde(default)]
        platforms: Option<Vec<MenuPlatform>>,
        items: Vec<MenuNode>,
    },
    /// One check item per theme (filled by `sync_menu_state`), then a separator and `items`.
    Themes {
        label_key: String,
        #[serde(default)]
        platforms: Option<Vec<MenuPlatform>>,
        items: Vec<MenuNode>,
    },
    /// #104: Recent files (filled by `sync_menu_state`), then a separator and `items`.
    RecentFiles {
        label_key: String,
        #[serde(default)]
        platforms: Option<Vec<MenuPlatform>>,
        items: Vec<MenuNode>,
    },
    Action {
        id: String,
        label_key: String,
        #[serde(default)]
        accel: Option<String>,
        #[serde(default)]
        check: bool,
        #[serde(default)]
        platforms: Option<Vec<MenuPlatform>>,
    },
    Predefined {
        item: String,
        #[serde(default)]
        label_key: Option<String>,
        #[serde(default)]
        platforms: Option<Vec<MenuPlatform>>,
    },
    Link {
        id: String,
        label_key: String,
        url: String,
        #[serde(default)]
        platforms: Option<Vec<MenuPlatform>>,
    },
}

impl MenuNode {
    fn platforms(&self) -> Option<&[MenuPlatform]> {
        match self {
            MenuNode::Submenu { platforms, .. }
            | MenuNode::Themes { platforms, .. }
            | MenuNode::RecentFiles { platforms, .. }
            | MenuNode::Action { platforms, .. }
            | MenuNode::Predefined { platforms, .. }
            | MenuNode::Link { platforms, .. } => platforms.as_deref(),
        }
    }

    pub fn matches_platform(&self, platform: MenuPlatform) -> bool {
        match self.platforms() {
            None => true,
            Some(list) => list.contains(&platform),
        }
    }
}

pub fn raw_menu_spec() -> Vec<MenuNode> {
    serde_json::from_str(MENU_SPEC_JSON).expect("src/menu/menu-spec.json is valid")
}

/// Filters `nodes` to those visible on `platform`, matching frontend `filterMenuSpec`.
pub fn filter_menu_spec(nodes: &[MenuNode], platform: MenuPlatform) -> Vec<MenuNode> {
    let mut out = Vec::new();
    for node in nodes {
        if !node.matches_platform(platform) {
            continue;
        }
        match node {
            MenuNode::Submenu { label_key, role, platforms, items } => {
                out.push(MenuNode::Submenu {
                    label_key: label_key.clone(),
                    role: role.clone(),
                    platforms: platforms.clone(),
                    items: filter_menu_spec(items, platform),
                });
            }
            MenuNode::Themes { label_key, platforms, items } => {
                out.push(MenuNode::Themes {
                    label_key: label_key.clone(),
                    platforms: platforms.clone(),
                    items: filter_menu_spec(items, platform),
                });
            }
            MenuNode::RecentFiles { label_key, platforms, items } => {
                out.push(MenuNode::RecentFiles {
                    label_key: label_key.clone(),
                    platforms: platforms.clone(),
                    items: filter_menu_spec(items, platform),
                });
            }
            other => out.push(other.clone()),
        }
    }
    out
}

pub fn menu_spec_for(platform: MenuPlatform) -> Vec<MenuNode> {
    filter_menu_spec(&raw_menu_spec(), platform)
}

pub fn menu_spec() -> Vec<MenuNode> {
    menu_spec_for(MenuPlatform::current())
}

fn walk<'a>(nodes: &'a [MenuNode], out: &mut Vec<&'a MenuNode>) {
    for node in nodes {
        out.push(node);
        match node {
            MenuNode::Submenu { items, .. }
            | MenuNode::Themes { items, .. }
            | MenuNode::RecentFiles { items, .. } => walk(items, out),
            _ => {}
        }
    }
}

/// Every node of the spec, depth first.
pub fn all_nodes(spec: &[MenuNode]) -> Vec<&MenuNode> {
    let mut out = Vec::new();
    walk(spec, &mut out);
    out
}

/// What a click on a menu item should do.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MenuDispatch {
    /// Ask the frontend to run an action (`menu-action` event).
    Emit(MenuActionPayload),
    /// Open a URL in the default browser (説明 menu).
    OpenUrl(String),
    /// Not ours (predefined items never reach here anyway).
    Ignore,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuActionPayload {
    pub action: String,
    pub arg: Option<String>,
}

pub fn dispatch_for(spec: &[MenuNode], id: &str) -> MenuDispatch {
    if let Some(theme) = id.strip_prefix(THEME_ITEM_PREFIX) {
        return MenuDispatch::Emit(MenuActionPayload {
            action: SET_THEME_ACTION.to_string(),
            arg: Some(theme.to_string()),
        });
    }
    if let Some(path) = id.strip_prefix(RECENT_ITEM_PREFIX) {
        return MenuDispatch::Emit(MenuActionPayload {
            action: OPEN_RECENT_ACTION.to_string(),
            arg: Some(path.to_string()),
        });
    }
    for node in all_nodes(spec) {
        match node {
            MenuNode::Action { id: node_id, .. } if node_id == id => {
                return MenuDispatch::Emit(MenuActionPayload {
                    action: id.to_string(),
                    arg: None,
                });
            }
            MenuNode::Link { id: node_id, url, .. } if node_id == id => {
                return MenuDispatch::OpenUrl(url.clone());
            }
            _ => {}
        }
    }
    MenuDispatch::Ignore
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeEntry {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentFileEntry {
    pub path: String,
    pub label: String,
}

/// Sent by the frontend whenever a checkable state changes.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuSyncState {
    #[serde(default)]
    pub checks: HashMap<String, bool>,
    #[serde(default)]
    pub theme: String,
    #[serde(default)]
    pub themes: Vec<ThemeEntry>,
    #[serde(default)]
    pub recent_files: Vec<RecentFileEntry>,
}

/// Handles to the items whose state follows the app.
pub struct MenuHandles<R: Runtime> {
    checks: HashMap<String, CheckMenuItem<R>>,
    theme_submenu: Option<Submenu<R>>,
    theme_items: Vec<(String, CheckMenuItem<R>)>,
    theme_list: Vec<ThemeEntry>,
    recent_submenu: Option<Submenu<R>>,
    recent_items: Vec<MenuItem<R>>,
    clear_recent_item: Option<MenuItem<R>>,
    recent_list: Vec<RecentFileEntry>,
    recent_synced: bool,
    recent_empty_label: String,
}

pub struct MenuStateStore<R: Runtime>(pub Mutex<Option<MenuHandles<R>>>);

fn predefined<R: Runtime>(
    app: &AppHandle<R>,
    item: &str,
    label: Option<&str>,
) -> tauri::Result<Option<PredefinedMenuItem<R>>> {
    let built = match item {
        "separator" => PredefinedMenuItem::separator(app)?,
        "about" => {
            let pkg = app.package_info();
            let metadata = AboutMetadata {
                name: Some(pkg.name.clone()),
                version: Some(pkg.version.to_string()),
                website: Some("https://github.com/kkdai/Kalamos".to_string()),
                website_label: Some("GitHub".to_string()),
                ..Default::default()
            };
            PredefinedMenuItem::about(app, label, Some(metadata))?
        }
        "services" => PredefinedMenuItem::services(app, label)?,
        "hide" => PredefinedMenuItem::hide(app, label)?,
        "hideOthers" => PredefinedMenuItem::hide_others(app, label)?,
        "showAll" => PredefinedMenuItem::show_all(app, label)?,
        "quit" => PredefinedMenuItem::quit(app, label)?,
        "undo" => PredefinedMenuItem::undo(app, label)?,
        "redo" => PredefinedMenuItem::redo(app, label)?,
        "cut" => PredefinedMenuItem::cut(app, label)?,
        "copy" => PredefinedMenuItem::copy(app, label)?,
        "paste" => PredefinedMenuItem::paste(app, label)?,
        "selectAll" => PredefinedMenuItem::select_all(app, label)?,
        "minimize" => PredefinedMenuItem::minimize(app, label)?,
        "maximize" => PredefinedMenuItem::maximize(app, label)?,
        "fullscreen" => PredefinedMenuItem::fullscreen(app, label)?,
        "closeWindow" => PredefinedMenuItem::close_window(app, label)?,
        "bringAllToFront" => PredefinedMenuItem::bring_all_to_front(app, label)?,
        _ => return Ok(None),
    };
    Ok(Some(built))
}

fn empty_recent_item<R: Runtime>(app: &AppHandle<R>, label: &str) -> tauri::Result<MenuItem<R>> {
    MenuItem::with_id(app, RECENT_EMPTY_ID, label, false, None::<&str>)
}

fn build_items<R: Runtime>(
    app: &AppHandle<R>,
    nodes: &[MenuNode],
    labels: &MenuLabels,
    handles: &mut MenuHandles<R>,
) -> tauri::Result<Vec<MenuItemKind<R>>> {
    let mut out: Vec<MenuItemKind<R>> = Vec::new();
    for node in nodes {
        match node {
            MenuNode::Submenu { label_key, role, items, .. } => {
                let children = build_items(app, items, labels, handles)?;
                let refs: Vec<&dyn IsMenuItem<R>> =
                    children.iter().map(|c| c as &dyn IsMenuItem<R>).collect();
                let label = if *role == Some(SubmenuRole::App) {
                    app.package_info().name.as_str()
                } else {
                    labels.get(label_key)
                };
                let submenu = Submenu::with_items(app, label, true, &refs)?;
                #[cfg(target_os = "macos")]
                match role {
                    Some(SubmenuRole::Window) => submenu.set_as_windows_menu_for_nsapp()?,
                    Some(SubmenuRole::Help) => submenu.set_as_help_menu_for_nsapp()?,
                    _ => {}
                }
                out.push(MenuItemKind::Submenu(submenu));
            }
            MenuNode::Themes { label_key, items, .. } => {
                let mut children = vec![MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?)];
                children.extend(build_items(app, items, labels, handles)?);
                let refs: Vec<&dyn IsMenuItem<R>> =
                    children.iter().map(|c| c as &dyn IsMenuItem<R>).collect();
                let submenu = Submenu::with_items(app, labels.get(label_key), true, &refs)?;
                handles.theme_submenu = Some(submenu.clone());
                out.push(MenuItemKind::Submenu(submenu));
            }
            MenuNode::RecentFiles { label_key, items, .. } => {
                let empty_item = empty_recent_item(app, &handles.recent_empty_label)?;
                let mut children = vec![
                    MenuItemKind::MenuItem(empty_item.clone()),
                    MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?),
                ];
                let trailing = build_items(app, items, labels, handles)?;
                for child in &trailing {
                    if let MenuItemKind::MenuItem(mi) = child {
                        if mi.id().as_ref() == CLEAR_RECENT_ACTION {
                            let _ = mi.set_enabled(false);
                            handles.clear_recent_item = Some(mi.clone());
                        }
                    }
                }
                children.extend(trailing);
                let refs: Vec<&dyn IsMenuItem<R>> =
                    children.iter().map(|c| c as &dyn IsMenuItem<R>).collect();
                let submenu = Submenu::with_items(app, labels.get(label_key), true, &refs)?;
                handles.recent_submenu = Some(submenu.clone());
                handles.recent_items.push(empty_item);
                out.push(MenuItemKind::Submenu(submenu));
            }
            MenuNode::Action { id, label_key, accel, check, .. } => {
                let label = labels.get(label_key);
                if *check {
                    let item = CheckMenuItem::with_id(
                        app,
                        id.as_str(),
                        label,
                        true,
                        false,
                        accel.as_deref(),
                    )?;
                    handles.checks.insert(id.clone(), item.clone());
                    out.push(MenuItemKind::Check(item));
                } else {
                    let item = MenuItem::with_id(app, id.as_str(), label, true, accel.as_deref())?;
                    out.push(MenuItemKind::MenuItem(item));
                }
            }
            MenuNode::Predefined { item, label_key, .. } => {
                let label = label_key.as_deref().map(|key| labels.get(key));
                if let Some(built) = predefined(app, item, label)? {
                    out.push(MenuItemKind::Predefined(built));
                }
            }
            MenuNode::Link { id, label_key, .. } => {
                let item = MenuItem::with_id(app, id.as_str(), labels.get(label_key), true, None::<&str>)?;
                out.push(MenuItemKind::MenuItem(item));
            }
        }
    }
    Ok(out)
}

/// Builds the menu bar and registers the handles `sync_menu_state` updates.
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let labels = MenuLabels::for_locale(snapshot_ui_locale(app));
    let mut handles = MenuHandles {
        checks: HashMap::new(),
        theme_submenu: None,
        theme_items: Vec::new(),
        theme_list: Vec::new(),
        recent_submenu: None,
        recent_items: Vec::new(),
        clear_recent_item: None,
        recent_list: Vec::new(),
        recent_synced: false,
        recent_empty_label: labels.get(RECENT_EMPTY_LABEL_KEY).to_owned(),
    };
    let top = build_items(app, &menu_spec(), labels, &mut handles)?;
    let refs: Vec<&dyn IsMenuItem<R>> = top.iter().map(|c| c as &dyn IsMenuItem<R>).collect();
    let menu = Menu::with_items(app, &refs)?;
    if let Some(store) = app.try_state::<MenuStateStore<R>>() {
        if let Ok(mut guard) = store.0.lock() {
            *guard = Some(handles);
        }
    } else {
        app.manage(MenuStateStore(Mutex::new(Some(handles))));
    }
    Ok(menu)
}

pub fn handle_menu_event<R: Runtime>(app: &AppHandle<R>, event: MenuEvent) {
    match dispatch_for(&menu_spec(), event.id().as_ref()) {
        MenuDispatch::Emit(payload) => {
            let _ = app.emit(MENU_ACTION_EVENT, payload);
        }
        MenuDispatch::OpenUrl(url) => {
            use tauri_plugin_opener::OpenerExt;
            if let Err(err) = app.opener().open_url(url, None::<&str>) {
                eprintln!("Failed to open help link: {err}");
            }
        }
        MenuDispatch::Ignore => {}
    }
}

fn apply_sync_state<R: Runtime>(
    app: &AppHandle<R>,
    handles: &mut MenuHandles<R>,
    state: &MenuSyncState,
) -> tauri::Result<()> {
    for (id, checked) in &state.checks {
        if let Some(item) = handles.checks.get(id) {
            item.set_checked(*checked)?;
        }
    }
    if let Some(submenu) = handles.theme_submenu.clone() {
        if !state.themes.is_empty() && state.themes != handles.theme_list {
            for (_, item) in handles.theme_items.drain(..) {
                submenu.remove(&item)?;
            }
            for (pos, theme) in state.themes.iter().enumerate() {
                let item = CheckMenuItem::with_id(
                    app,
                    format!("{THEME_ITEM_PREFIX}{}", theme.id),
                    &theme.label,
                    true,
                    false,
                    None::<&str>,
                )?;
                submenu.insert(&item, pos)?;
                handles.theme_items.push((theme.id.clone(), item));
            }
            handles.theme_list = state.themes.clone();
        }
        for (id, item) in &handles.theme_items {
            item.set_checked(*id == state.theme)?;
        }
    }
    if let Some(submenu) = handles.recent_submenu.clone() {
        if !handles.recent_synced || state.recent_files != handles.recent_list {
            for item in handles.recent_items.drain(..) {
                submenu.remove(&item)?;
            }
            if state.recent_files.is_empty() {
                let empty_item = empty_recent_item(app, &handles.recent_empty_label)?;
                submenu.insert(&empty_item, 0)?;
                handles.recent_items.push(empty_item);
            } else {
                for (pos, entry) in state.recent_files.iter().enumerate() {
                    let item = MenuItem::with_id(
                        app,
                        format!("{RECENT_ITEM_PREFIX}{}", entry.path),
                        &entry.label,
                        true,
                        None::<&str>,
                    )?;
                    submenu.insert(&item, pos)?;
                    handles.recent_items.push(item);
                }
            }
            if let Some(clear_item) = &handles.clear_recent_item {
                clear_item.set_enabled(!state.recent_files.is_empty())?;
            }
            handles.recent_list = state.recent_files.clone();
            handles.recent_synced = true;
        }
    }
    Ok(())
}

/// #81: 結束 Kalamos (⌘Q). The predefined Quit item calls `terminate:` directly,
/// with no event the WebView could cancel, so the menu sends `app.quit` to the
/// frontend instead; it settles every tab's unsaved changes, then calls this.
#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn sync_menu_state(app: AppHandle, state: MenuSyncState) -> Result<(), AppError> {
    let Some(store) = app.try_state::<MenuStateStore<tauri::Wry>>() else {
        return Ok(());
    };
    let mut guard = store
        .0
        .lock()
        .map_err(|_| AppError::new(ErrorKind::Io, "menu state lock poisoned"))?;
    if let Some(handles) = guard.as_mut() {
        apply_sync_state(&app, handles, &state)
            .map_err(|e| AppError::new(ErrorKind::Io, format!("menu sync failed: {e}")))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    fn assert_clean_separators(nodes: &[MenuNode]) {
        let mut prev_sep = true; // disallow leading separator
        for (i, node) in nodes.iter().enumerate() {
            let is_sep = matches!(node, MenuNode::Predefined { item, .. } if item == "separator");
            assert!(!(is_sep && prev_sep), "leading or consecutive separator at index {i}");
            prev_sep = is_sep;
            match node {
                MenuNode::Submenu { items, .. }
                | MenuNode::Themes { items, .. }
                | MenuNode::RecentFiles { items, .. } => {
                    assert_clean_separators(items);
                }
                _ => {}
            }
        }
        assert!(
            !matches!(nodes.last(), Some(MenuNode::Predefined { item, .. }) if item == "separator"),
            "trailing separator in submenu"
        );
    }

    #[test]
    fn spec_parses_and_ids_are_unique_per_platform() {
        for platform in [MenuPlatform::Macos, MenuPlatform::Windows, MenuPlatform::Linux] {
            let spec = menu_spec_for(platform);
            assert_clean_separators(&spec);
            let mut seen = HashSet::new();
            for node in all_nodes(&spec) {
                let id = match node {
                    MenuNode::Action { id, .. } | MenuNode::Link { id, .. } => id,
                    _ => continue,
                };
                assert!(seen.insert(id.clone()), "duplicate menu id {id} on {platform:?}");
                assert!(!id.starts_with(THEME_ITEM_PREFIX));
                assert!(!id.starts_with(RECENT_ITEM_PREFIX));
            }
            assert!(seen.len() > 30);
        }
    }

    #[test]
    fn accelerators_are_unique_per_platform() {
        for platform in [MenuPlatform::Macos, MenuPlatform::Windows, MenuPlatform::Linux] {
            let spec = menu_spec_for(platform);
            let mut seen = HashSet::new();
            for node in all_nodes(&spec) {
                if let MenuNode::Action { accel: Some(accel), id, .. } = node {
                    assert!(
                        seen.insert(accel.to_lowercase()),
                        "accelerator {accel} reused by {id} on {platform:?}"
                    );
                }
            }
        }
    }

    #[test]
    fn missing_menu_label_falls_back_to_traditional_chinese() {
        let partial = MenuLabels(HashMap::new());
        assert_eq!(partial.get("menu.file.title"), "檔案");
    }

    #[test]
    fn both_locales_cover_every_menu_label() {
        let spec = raw_menu_spec();
        for locale in [UiLocale::ZhTw, UiLocale::En] {
            let labels = MenuLabels::for_locale(locale);
            for node in all_nodes(&spec) {
                let key = match node {
                    MenuNode::Submenu { label_key, .. }
                    | MenuNode::Themes { label_key, .. }
                    | MenuNode::RecentFiles { label_key, .. }
                    | MenuNode::Action { label_key, .. }
                    | MenuNode::Link { label_key, .. } => label_key.as_str(),
                    MenuNode::Predefined { item, .. } if item == "separator" => continue,
                    MenuNode::Predefined { label_key, .. } => {
                        label_key.as_deref().expect("predefined items need localized labels")
                    }
                };
                assert!(labels.0.get(key).is_some_and(|s| !s.is_empty()), "missing {key} for {locale:?}");
            }
        }
    }

    #[test]
    fn menu_labels_are_localized_on_macos_and_windows() {
        for (locale, headings, mac_zoom, win_maximize, recent_empty) in [
            (
                UiLocale::ZhTw,
                ["Kalamos", "檔案", "編輯", "段落", "格式", "檢視", "視窗", "說明"],
                "縮放",
                "最大化",
                "沒有最近開啟的檔案",
            ),
            (
                UiLocale::En,
                ["Kalamos", "File", "Edit", "Paragraph", "Format", "View", "Window", "Help"],
                "Zoom",
                "Maximize",
                "No Recent Files",
            ),
        ] {
            let labels = MenuLabels::for_locale(locale);
            for (platform, expected, maximize_label) in [
                (MenuPlatform::Macos, &headings[..], mac_zoom),
                (MenuPlatform::Windows, &headings[1..], win_maximize),
            ] {
                let spec = menu_spec_for(platform);
                let top: Vec<&str> = spec
                    .iter()
                    .filter_map(|n| match n {
                        MenuNode::Submenu { label_key, .. } => Some(labels.get(label_key)),
                        _ => None,
                    })
                    .collect();
                assert_eq!(top, expected);
                let maximize = all_nodes(&spec).into_iter().find_map(|n| match n {
                    MenuNode::Predefined { item, label_key, .. } if item == "maximize" => {
                        label_key.as_deref().map(|key| labels.get(key))
                    }
                    _ => None,
                });
                assert_eq!(maximize, Some(maximize_label));
            }
            assert_eq!(labels.get(RECENT_EMPTY_LABEL_KEY), recent_empty);
        }
    }

    #[test]
    fn macos_spec_has_the_required_menus_and_items() {
        let spec = menu_spec_for(MenuPlatform::Macos);
        let nodes = all_nodes(&spec);
        let accel_of = |wanted: &str| {
            nodes.iter().find_map(|n| match n {
                MenuNode::Action { id, accel, .. } if id == wanted => accel.clone(),
                _ => None,
            })
        };
        assert_eq!(accel_of("app.preferences").as_deref(), Some("CmdOrCtrl+,"));
        assert_eq!(accel_of("file.quickOpen").as_deref(), Some("CmdOrCtrl+P"));
        assert_eq!(accel_of("edit.find").as_deref(), Some("CmdOrCtrl+F"));
        assert_eq!(accel_of("edit.findInFolder").as_deref(), Some("CmdOrCtrl+Shift+F"));
        assert_eq!(accel_of("view.focusMode").as_deref(), Some("F8"));

        let predefined: HashSet<&str> = nodes
            .iter()
            .filter_map(|n| match n {
                MenuNode::Predefined { item, .. } => Some(item.as_str()),
                _ => None,
            })
            .collect();
        // #81: 結束 is a custom action so the frontend can ask about unsaved tabs first.
        assert_eq!(accel_of("app.quit").as_deref(), Some("CmdOrCtrl+Q"));
        assert_eq!(accel_of("file.closeTab").as_deref(), Some("CmdOrCtrl+W"));
        assert_eq!(accel_of("window.nextTab").as_deref(), Some("Ctrl+Tab"));
        assert!(!predefined.contains("quit") && !predefined.contains("closeWindow"));
        for item in ["undo", "redo", "cut", "copy", "paste", "selectAll", "about", "services", "hideOthers", "showAll"] {
            assert!(predefined.contains(item), "missing predefined {item}");
        }
        // Every predefined item name is one we know how to build.
        let known = [
            "separator", "about", "services", "hide", "hideOthers", "showAll", "quit", "undo",
            "redo", "cut", "copy", "paste", "selectAll", "minimize", "maximize", "fullscreen",
            "closeWindow", "bringAllToFront",
        ];
        for item in &predefined {
            assert!(known.contains(item), "unknown predefined {item}");
        }
    }

    #[test]
    fn windows_spec_omits_macos_only_items_and_places_preferences_quit_about() {
        let win = menu_spec_for(MenuPlatform::Windows);
        let nodes = all_nodes(&win);
        let predefined: HashSet<&str> = nodes
            .iter()
            .filter_map(|n| match n {
                MenuNode::Predefined { item, .. } => Some(item.as_str()),
                _ => None,
            })
            .collect();
        for mac_only in ["services", "hide", "hideOthers", "showAll", "fullscreen", "bringAllToFront"] {
            assert!(!predefined.contains(mac_only), "Windows menu must not contain {mac_only}");
        }
        assert!(predefined.contains("about"));
        assert!(!predefined.contains("quit") && !predefined.contains("closeWindow"));

        let submenu_items = |wanted: &str| -> &[MenuNode] {
            win.iter()
                .find_map(|n| match n {
                    MenuNode::Submenu { label_key, items, .. } if label_key == wanted => Some(items.as_slice()),
                    _ => None,
                })
                .expect("submenu exists")
        };
        let file_items = submenu_items("menu.file.title");
        assert!(file_items.iter().any(|n| matches!(
            n,
            MenuNode::Action { id, accel: Some(a), .. } if id == "app.preferences" && a == "CmdOrCtrl+,"
        )));
        assert!(file_items.iter().any(|n| matches!(
            n,
            MenuNode::Action { id, accel: Some(a), .. } if id == "app.quit" && a == "CmdOrCtrl+Q"
        )));
        let help_items = submenu_items("menu.help.title");
        assert!(help_items.iter().any(|n| matches!(n, MenuNode::Predefined { item, .. } if item == "about")));

        // macOS and Windows expose the exact same set of custom action ids and accelerators.
        let action_pairs = |platform: MenuPlatform| -> HashSet<(String, Option<String>)> {
            all_nodes(&menu_spec_for(platform))
                .into_iter()
                .filter_map(|n| match n {
                    MenuNode::Action { id, accel, .. } => Some((id.clone(), accel.clone())),
                    _ => None,
                })
                .collect()
        };
        assert_eq!(action_pairs(MenuPlatform::Macos), action_pairs(MenuPlatform::Windows));
    }

    #[test]
    fn check_items_cover_the_toggle_states() {
        let spec = menu_spec();
        let checks: HashSet<String> = all_nodes(&spec)
            .into_iter()
            .filter_map(|n| match n {
                MenuNode::Action { id, check: true, .. } => Some(id.clone()),
                _ => None,
            })
            .collect();
        for id in ["view.sourceMode", "view.focusMode", "view.typewriterMode", "view.sidebar", "view.outline"] {
            assert!(checks.contains(id), "{id} should be checkable");
        }
        assert!(all_nodes(&spec).iter().any(|n| matches!(n, MenuNode::Themes { .. })));
        assert!(all_nodes(&spec).iter().any(|n| matches!(n, MenuNode::RecentFiles { .. })));
    }

    #[test]
    fn dispatch_maps_ids_to_events_and_links() {
        let spec = menu_spec();
        assert_eq!(
            dispatch_for(&spec, "file.save"),
            MenuDispatch::Emit(MenuActionPayload { action: "file.save".into(), arg: None })
        );
        assert_eq!(
            dispatch_for(&spec, "file.quickOpen"),
            MenuDispatch::Emit(MenuActionPayload { action: "file.quickOpen".into(), arg: None })
        );
        assert_eq!(
            dispatch_for(&spec, "file.clearRecent"),
            MenuDispatch::Emit(MenuActionPayload { action: "file.clearRecent".into(), arg: None })
        );
        assert_eq!(
            dispatch_for(&spec, "theme:custom:night"),
            MenuDispatch::Emit(MenuActionPayload {
                action: SET_THEME_ACTION.into(),
                arg: Some("custom:night".into())
            })
        );
        assert_eq!(
            dispatch_for(&spec, "recent:/tmp/kalamos-test/a.md"),
            MenuDispatch::Emit(MenuActionPayload {
                action: OPEN_RECENT_ACTION.into(),
                arg: Some("/tmp/kalamos-test/a.md".into())
            })
        );
        assert_eq!(
            dispatch_for(&spec, "help.repo"),
            MenuDispatch::OpenUrl("https://github.com/kkdai/Kalamos".into())
        );
        assert_eq!(dispatch_for(&spec, "nope"), MenuDispatch::Ignore);
        let payload = serde_json::to_value(MenuActionPayload {
            action: "view.setTheme".into(),
            arg: Some("melan".into()),
        })
        .unwrap();
        assert_eq!(payload, serde_json::json!({ "action": "view.setTheme", "arg": "melan" }));
    }

    #[test]
    fn sync_state_deserializes_camel_case_with_defaults() {
        let s: MenuSyncState = serde_json::from_str(
            r#"{ "checks": { "view.focusMode": true }, "theme": "melan",
                 "themes": [{ "id": "melan", "label": "Melan" }],
                 "recentFiles": [{ "path": "/tmp/kalamos-test/a.md", "label": "a.md" }] }"#,
        )
        .unwrap();
        assert_eq!(s.checks.get("view.focusMode"), Some(&true));
        assert_eq!(s.themes[0].label, "Melan");
        assert_eq!(s.recent_files.len(), 1);
        assert_eq!(s.recent_files[0].path, "/tmp/kalamos-test/a.md");
        let empty: MenuSyncState = serde_json::from_str("{}").unwrap();
        assert!(empty.checks.is_empty() && empty.themes.is_empty() && empty.recent_files.is_empty());
    }
}
