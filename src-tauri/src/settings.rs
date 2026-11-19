use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::AppError;
use crate::files::save_file_impl;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SidebarTab {
    #[default]
    Tree,
    List,
    Outline,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    pub last_folder: Option<String>,
    pub sidebar_visible: bool,
    pub sidebar_tab: SidebarTab,
    pub source_mode: bool,
    pub code_line_numbers: bool,
    pub math_auto_number: bool,
    /// IM-04: folder that `/`-rooted image paths resolve against.
    pub image_root_dir: Option<String>,
    /// WM-01 Ataraxia focus mode (F8).
    pub focus_mode: bool,
    /// WM-02 Stichos typewriter mode (F9).
    pub typewriter_mode: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            last_folder: None,
            sidebar_visible: false,
            sidebar_tab: SidebarTab::Tree,
            source_mode: false,
            code_line_numbers: false,
            math_auto_number: false,
            image_root_dir: None,
            focus_mode: false,
            typewriter_mode: false,
        }
    }
}

pub fn get_settings_in(app_data_dir: &Path) -> Result<Settings, AppError> {
    let settings_path = app_data_dir.join("settings.json");
    if !settings_path.exists() {
        return Ok(Settings::default());
    }
    let raw = match fs::read_to_string(&settings_path) {
        Ok(s) => s,
        Err(err) => {
            eprintln!("Failed to read settings.json, falling back to defaults: {err}");
            return Ok(Settings::default());
        }
    };
    match serde_json::from_str::<Settings>(&raw) {
        Ok(settings) => Ok(settings),
        Err(err) => {
            eprintln!("Corrupted settings.json, falling back to defaults: {err}");
            Ok(Settings::default())
        }
    }
}

pub fn set_settings_in(app_data_dir: &Path, settings: &Settings) -> Result<(), AppError> {
    fs::create_dir_all(app_data_dir)?;
    let settings_path = app_data_dir.join("settings.json");
    let settings_path_str = settings_path
        .to_str()
        .ok_or_else(|| AppError::invalid_path("Non-UTF-8 settings path"))?;
    let json = serde_json::to_string_pretty(settings)?;
    save_file_impl(settings_path_str, &json)?;
    Ok(())
}

#[tauri::command]
pub fn get_settings(app: tauri::AppHandle) -> Result<Settings, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    get_settings_in(&app_data_dir)
}

#[tauri::command]
pub fn set_settings(app: tauri::AppHandle, settings: Settings) -> Result<(), AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    set_settings_in(&app_data_dir, &settings)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn get_settings_returns_defaults_when_missing() {
        let dir = tempdir().expect("tempdir");
        let s = get_settings_in(dir.path()).expect("default settings");
        assert_eq!(s, Settings::default());

        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["theme"], "system");
        assert!(v["lastFolder"].is_null());
        assert_eq!(v["sidebarVisible"], false);
        assert_eq!(v["sidebarTab"], "tree");
        assert_eq!(v["sourceMode"], false);
        assert_eq!(v["codeLineNumbers"], false);
        assert_eq!(v["mathAutoNumber"], false);
        assert!(v["imageRootDir"].is_null());
        assert_eq!(v["focusMode"], false);
        assert_eq!(v["typewriterMode"], false);
    }

    #[test]
    fn set_and_get_settings_roundtrip() {
        let dir = tempdir().expect("tempdir");
        let updated = Settings {
            theme: "melan".to_string(),
            last_folder: Some("/tmp/kalamos-test/Notes".to_string()),
            sidebar_visible: true,
            sidebar_tab: SidebarTab::Outline,
            source_mode: true,
            code_line_numbers: true,
            math_auto_number: true,
            image_root_dir: Some("/tmp/kalamos-test/blog".to_string()),
            focus_mode: true,
            typewriter_mode: true,
        };
        set_settings_in(dir.path(), &updated).expect("set_settings");
        let loaded = get_settings_in(dir.path()).expect("get_settings");
        assert_eq!(loaded, updated);
    }

    #[test]
    fn reads_legacy_settings_json_without_new_fields() {
        let dir = tempdir().expect("tempdir");
        let settings_path = dir.path().join("settings.json");
        let legacy_json = r#"{
            "theme": "papyros",
            "lastFolder": "/demo",
            "sidebarVisible": true,
            "sidebarTab": "list",
            "sourceMode": false
        }"#;
        fs::write(&settings_path, legacy_json).expect("write legacy settings.json");

        let loaded = get_settings_in(dir.path()).expect("load legacy settings");
        assert_eq!(loaded.theme, "papyros");
        assert_eq!(loaded.last_folder.as_deref(), Some("/demo"));
        assert!(loaded.sidebar_visible);
        assert_eq!(loaded.sidebar_tab, SidebarTab::List);
        assert!(!loaded.source_mode);
        assert!(!loaded.code_line_numbers);
        assert!(!loaded.math_auto_number);
        assert_eq!(loaded.image_root_dir, None);
        assert!(!loaded.focus_mode);
        assert!(!loaded.typewriter_mode);
    }

    #[test]
    fn image_root_dir_is_camel_case_and_optional() {
        let dir = tempdir().expect("tempdir");
        let settings_path = dir.path().join("settings.json");
        // A settings file written before IM-04 (has mathAutoNumber, no imageRootDir).
        fs::write(
            &settings_path,
            r#"{ "theme": "melan", "codeLineNumbers": true, "mathAutoNumber": true }"#,
        )
        .expect("write settings.json");
        let loaded = get_settings_in(dir.path()).expect("load settings");
        assert_eq!(loaded.image_root_dir, None);
        assert!(loaded.math_auto_number);

        fs::write(&settings_path, r#"{ "imageRootDir": "/Users/me/blog" }"#)
            .expect("write settings.json");
        let loaded = get_settings_in(dir.path()).expect("load settings");
        assert_eq!(loaded.image_root_dir.as_deref(), Some("/Users/me/blog"));
        assert_eq!(loaded.theme, "system");

        let v = serde_json::to_value(&loaded).unwrap();
        assert_eq!(v["imageRootDir"], "/Users/me/blog");
    }

    #[test]
    fn reads_settings_without_writing_mode_keys_and_round_trips_them() {
        let dir = tempdir().expect("tempdir");
        let settings_path = dir.path().join("settings.json");
        // A settings file written before WM-01 / WM-02 existed.
        let previous_json = r#"{
            "theme": "melan",
            "lastFolder": "/tmp/kalamos-test/notes",
            "sidebarVisible": false,
            "sidebarTab": "outline",
            "sourceMode": true,
            "codeLineNumbers": true,
            "mathAutoNumber": true
        }"#;
        fs::write(&settings_path, previous_json).expect("write settings.json");
        let mut loaded = get_settings_in(dir.path()).expect("load settings");
        assert!(loaded.source_mode && loaded.code_line_numbers && loaded.math_auto_number);
        assert!(!loaded.focus_mode);
        assert!(!loaded.typewriter_mode);

        loaded.focus_mode = true;
        set_settings_in(dir.path(), &loaded).expect("save settings");
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert_eq!(raw["focusMode"], true);
        assert_eq!(raw["typewriterMode"], false);
        assert_eq!(get_settings_in(dir.path()).unwrap(), loaded);
    }

    #[test]
    fn returns_defaults_when_settings_json_is_corrupted() {
        let dir = tempdir().expect("tempdir");
        let settings_path = dir.path().join("settings.json");
        fs::write(&settings_path, "{ invalid json !!!").expect("write corrupted settings");

        let loaded = get_settings_in(dir.path()).expect("fallback to defaults");
        assert_eq!(loaded, Settings::default());
    }
}
