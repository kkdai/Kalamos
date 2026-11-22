//! #74: native macOS menu bar.
//!
//! The menu layout lives in `src/menu/menu-spec.json`, shared with the
//! frontend (which uses the same accelerators to keep a shortcut from running
//! twice). Clicking a custom item emits `menu-action` to the WebView, where the
//! existing keyboard handlers run — no command logic is duplicated here.
//! Standard edit items (undo / copy / paste…) are predefined items, so they go
//! through the responder chain to the WebView exactly as before.

use std::collections::HashMap;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::menu::{
    AboutMetadata, CheckMenuItem, IsMenuItem, Menu, MenuEvent, MenuItem, MenuItemKind,
    PredefinedMenuItem, Submenu,
};
use tauri::{AppHandle, Emitter, Manager, Runtime};

use crate::error::{AppError, ErrorKind};

pub const MENU_SPEC_JSON: &str = include_str!("../../src/menu/menu-spec.json");
pub const MENU_ACTION_EVENT: &str = "menu-action";
/// Prefix of the ids of the generated theme items (`theme:custom:night`).
pub const THEME_ITEM_PREFIX: &str = "theme:";
pub const SET_THEME_ACTION: &str = "view.setTheme";

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SubmenuRole {
    App,
    Window,
    Help,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum MenuNode {
    Submenu {
        label: String,
        #[serde(default)]
        role: Option<SubmenuRole>,
        items: Vec<MenuNode>,
    },
    /// The 主題 submenu: one check item per theme (filled by `sync_menu_state`),
    /// then a separator and `items`.
    Themes { label: String, items: Vec<MenuNode> },
    Action {
        id: String,
        label: String,
        #[serde(default)]
        accel: Option<String>,
        #[serde(default)]
        check: bool,
    },
    Predefined {
        item: String,
        #[serde(default)]
        label: Option<String>,
    },
    Link { id: String, label: String, url: String },
}

pub fn menu_spec() -> Vec<MenuNode> {
    serde_json::from_str(MENU_SPEC_JSON).expect("src/menu/menu-spec.json is valid")
}

fn walk<'a>(nodes: &'a [MenuNode], out: &mut Vec<&'a MenuNode>) {
    for node in nodes {
        out.push(node);
        match node {
            MenuNode::Submenu { items, .. } | MenuNode::Themes { items, .. } => walk(items, out),
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
}

/// Handles to the items whose state follows the app.
pub struct MenuHandles<R: Runtime> {
    checks: HashMap<String, CheckMenuItem<R>>,
    theme_submenu: Option<Submenu<R>>,
    theme_items: Vec<(String, CheckMenuItem<R>)>,
    theme_list: Vec<ThemeEntry>,
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

fn build_items<R: Runtime>(
    app: &AppHandle<R>,
    nodes: &[MenuNode],
    handles: &mut MenuHandles<R>,
) -> tauri::Result<Vec<MenuItemKind<R>>> {
    let mut out: Vec<MenuItemKind<R>> = Vec::new();
    for node in nodes {
        match node {
            MenuNode::Submenu { label, role, items } => {
                let children = build_items(app, items, handles)?;
                let refs: Vec<&dyn IsMenuItem<R>> =
                    children.iter().map(|c| c as &dyn IsMenuItem<R>).collect();
                let label = if *role == Some(SubmenuRole::App) {
                    app.package_info().name.clone()
                } else {
                    label.clone()
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
            MenuNode::Themes { label, items } => {
                let mut children = vec![MenuItemKind::Predefined(PredefinedMenuItem::separator(app)?)];
                children.extend(build_items(app, items, handles)?);
                let refs: Vec<&dyn IsMenuItem<R>> =
                    children.iter().map(|c| c as &dyn IsMenuItem<R>).collect();
                let submenu = Submenu::with_items(app, label, true, &refs)?;
                handles.theme_submenu = Some(submenu.clone());
                out.push(MenuItemKind::Submenu(submenu));
            }
            MenuNode::Action { id, label, accel, check } => {
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
            MenuNode::Predefined { item, label } => {
                if let Some(built) = predefined(app, item, label.as_deref())? {
                    out.push(MenuItemKind::Predefined(built));
                }
            }
            MenuNode::Link { id, label, .. } => {
                let item = MenuItem::with_id(app, id.as_str(), label, true, None::<&str>)?;
                out.push(MenuItemKind::MenuItem(item));
            }
        }
    }
    Ok(out)
}

/// Builds the menu bar and registers the handles `sync_menu_state` updates.
pub fn build_app_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let mut handles = MenuHandles {
        checks: HashMap::new(),
        theme_submenu: None,
        theme_items: Vec::new(),
        theme_list: Vec::new(),
    };
    let top = build_items(app, &menu_spec(), &mut handles)?;
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
    Ok(())
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

    #[test]
    fn spec_parses_and_ids_are_unique() {
        let spec = menu_spec();
        let mut seen = HashSet::new();
        for node in all_nodes(&spec) {
            let id = match node {
                MenuNode::Action { id, .. } | MenuNode::Link { id, .. } => id,
                _ => continue,
            };
            assert!(seen.insert(id.clone()), "duplicate menu id {id}");
            assert!(!id.starts_with(THEME_ITEM_PREFIX));
        }
        assert!(seen.len() > 30);
    }

    #[test]
    fn accelerators_are_unique() {
        let spec = menu_spec();
        let mut seen = HashSet::new();
        for node in all_nodes(&spec) {
            if let MenuNode::Action { accel: Some(accel), id, .. } = node {
                assert!(seen.insert(accel.to_lowercase()), "accelerator {accel} reused by {id}");
            }
        }
    }

    #[test]
    fn spec_has_the_required_menus_and_items() {
        let spec = menu_spec();
        let labels: Vec<&str> = spec
            .iter()
            .filter_map(|n| match n {
                MenuNode::Submenu { label, .. } => Some(label.as_str()),
                _ => None,
            })
            .collect();
        assert_eq!(labels, ["Kalamos", "檔案", "編輯", "段落", "格式", "檢視", "視窗", "說明"]);

        let nodes = all_nodes(&spec);
        let accel_of = |wanted: &str| {
            nodes.iter().find_map(|n| match n {
                MenuNode::Action { id, accel, .. } if id == wanted => accel.clone(),
                _ => None,
            })
        };
        assert_eq!(accel_of("app.preferences").as_deref(), Some("CmdOrCtrl+,"));
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
        for item in ["undo", "redo", "cut", "copy", "paste", "selectAll", "quit", "about"] {
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
    }

    #[test]
    fn dispatch_maps_ids_to_events_and_links() {
        let spec = menu_spec();
        assert_eq!(
            dispatch_for(&spec, "file.save"),
            MenuDispatch::Emit(MenuActionPayload { action: "file.save".into(), arg: None })
        );
        assert_eq!(
            dispatch_for(&spec, "theme:custom:night"),
            MenuDispatch::Emit(MenuActionPayload {
                action: SET_THEME_ACTION.into(),
                arg: Some("custom:night".into())
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
                 "themes": [{ "id": "melan", "label": "Melan" }] }"#,
        )
        .unwrap();
        assert_eq!(s.checks.get("view.focusMode"), Some(&true));
        assert_eq!(s.themes[0].label, "Melan");
        let empty: MenuSyncState = serde_json::from_str("{}").unwrap();
        assert!(empty.checks.is_empty() && empty.themes.is_empty());
    }
}
