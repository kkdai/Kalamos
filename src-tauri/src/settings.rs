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
    /// #73 B: folder search.
    Search,
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
    /// IM-05: image upload program (absolute path or a name found in PATH).
    pub upload_command: Option<String>,
    /// IM-05: fixed arguments before the image paths.
    pub upload_args: Vec<String>,
    /// IM-05: upload pasted / dropped images right after importing them.
    pub upload_on_insert: bool,
    /// ED-09: auto-close ( [ { " ' and full-width pairs (Cmd+Opt+P).
    pub auto_pair_brackets: bool,
    /// ED-09: auto-close Markdown * _ ` ~ (Cmd+Opt+Shift+P).
    pub auto_pair_markdown: bool,
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
            upload_command: None,
            upload_args: Vec::new(),
            upload_on_insert: false,
            auto_pair_brackets: true,
            auto_pair_markdown: false,
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

/// Settings the WebView may never change (IM-05 defence in depth): the upload
/// command runs a local program, so it is only ever taken from the file on
/// disk. Whatever the frontend sends for these keys is replaced by the
/// values currently stored (null / [] when the file has none).
pub fn keep_protected_from_disk(incoming: &Settings, on_disk: &Settings) -> Settings {
    Settings {
        upload_command: on_disk.upload_command.clone(),
        upload_args: on_disk.upload_args.clone(),
        ..incoming.clone()
    }
}

/// Writes `settings`, except the protected keys (`uploadCommand`, `uploadArgs`),
/// which keep the values already in `settings.json`.
pub fn set_settings_in(app_data_dir: &Path, settings: &Settings) -> Result<(), AppError> {
    fs::create_dir_all(app_data_dir)?;
    let settings_path = app_data_dir.join("settings.json");
    let settings_path_str = settings_path
        .to_str()
        .ok_or_else(|| AppError::invalid_path("Non-UTF-8 settings path"))?;
    let on_disk = get_settings_in(app_data_dir)?;
    let merged = keep_protected_from_disk(settings, &on_disk);
    let json = serde_json::to_string_pretty(&merged)?;
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
        assert!(v["uploadCommand"].is_null());
        assert_eq!(v["uploadArgs"], serde_json::json!([]));
        assert_eq!(v["uploadOnInsert"], false);
        assert_eq!(v["autoPairBrackets"], true);
        assert_eq!(v["autoPairMarkdown"], false);
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
            // Protected keys: cannot be written through set_settings (see below).
            upload_command: None,
            upload_args: Vec::new(),
            upload_on_insert: true,
            auto_pair_brackets: false,
            auto_pair_markdown: true,
        };
        set_settings_in(dir.path(), &updated).expect("set_settings");
        let loaded = get_settings_in(dir.path()).expect("get_settings");
        assert_eq!(loaded, updated);
    }

    #[test]
    fn set_settings_never_changes_the_upload_command_or_args() {
        let dir = tempdir().expect("tempdir");
        let settings_path = dir.path().join("settings.json");

        // No file yet: whatever the frontend sends, the keys stay null / [].
        let attempt = Settings {
            upload_command: Some("/bin/sh".to_string()),
            upload_args: vec!["-c".to_string(), "touch /tmp/kalamos-test/pwned".to_string()],
            upload_on_insert: true,
            theme: "melan".to_string(),
            ..Settings::default()
        };
        set_settings_in(dir.path(), &attempt).expect("set_settings");
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert!(raw["uploadCommand"].is_null());
        assert_eq!(raw["uploadArgs"], serde_json::json!([]));
        // Other fields, including uploadOnInsert, are written normally.
        assert_eq!(raw["theme"], "melan");
        assert_eq!(raw["uploadOnInsert"], true);

        // A user-edited file: its uploader survives any set_settings call.
        fs::write(
            &settings_path,
            r#"{ "theme": "papyros", "uploadCommand": "/tmp/kalamos-test/bin/picgo", "uploadArgs": ["upload"] }"#,
        )
        .unwrap();
        set_settings_in(dir.path(), &Settings { focus_mode: true, ..attempt.clone() }).expect("set_settings");
        let loaded = get_settings_in(dir.path()).expect("load");
        assert_eq!(loaded.upload_command.as_deref(), Some("/tmp/kalamos-test/bin/picgo"));
        assert_eq!(loaded.upload_args, vec!["upload".to_string()]);
        assert_eq!(loaded.theme, "melan");
        assert!(loaded.focus_mode);
        assert!(loaded.upload_on_insert);

        // Clearing them from the frontend does not work either.
        set_settings_in(
            dir.path(),
            &Settings { upload_command: None, upload_args: Vec::new(), ..loaded.clone() },
        )
        .expect("set_settings");
        assert_eq!(get_settings_in(dir.path()).unwrap(), loaded);
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
        assert_eq!(loaded.upload_command, None);
        assert!(loaded.upload_args.is_empty());
        assert!(!loaded.upload_on_insert);
    }

    #[test]
    fn upload_settings_are_optional_and_camel_case() {
        let dir = tempdir().expect("tempdir");
        let settings_path = dir.path().join("settings.json");
        // Written before IM-05: no upload keys.
        fs::write(&settings_path, r#"{ "theme": "papyros", "focusMode": true }"#).unwrap();
        let loaded = get_settings_in(dir.path()).expect("load settings");
        assert!(loaded.focus_mode);
        assert_eq!(loaded.upload_command, None);
        assert!(loaded.upload_args.is_empty());
        assert!(!loaded.upload_on_insert);

        fs::write(
            &settings_path,
            r#"{ "uploadCommand": "/tmp/kalamos-test/bin/picgo", "uploadArgs": ["upload"], "uploadOnInsert": true }"#,
        )
        .unwrap();
        let loaded = get_settings_in(dir.path()).expect("load settings");
        assert_eq!(loaded.upload_command.as_deref(), Some("/tmp/kalamos-test/bin/picgo"));
        assert_eq!(loaded.upload_args, vec!["upload".to_string()]);
        assert!(loaded.upload_on_insert);
        // Writing back what was read keeps everything.
        set_settings_in(dir.path(), &loaded).unwrap();
        assert_eq!(get_settings_in(dir.path()).unwrap(), loaded);
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
    fn reads_settings_without_auto_pair_keys_with_pairing_defaults() {
        let dir = tempdir().expect("tempdir");
        let settings_path = dir.path().join("settings.json");
        // A settings file written before ED-09 existed.
        fs::write(
            &settings_path,
            r#"{ "theme": "papyros", "focusMode": true, "typewriterMode": false }"#,
        )
        .expect("write settings.json");
        let mut loaded = get_settings_in(dir.path()).expect("load settings");
        assert!(loaded.focus_mode);
        assert!(loaded.auto_pair_brackets, "brackets default on");
        assert!(!loaded.auto_pair_markdown, "markdown pairs default off");

        loaded.auto_pair_brackets = false;
        loaded.auto_pair_markdown = true;
        set_settings_in(dir.path(), &loaded).expect("save settings");
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert_eq!(raw["autoPairBrackets"], false);
        assert_eq!(raw["autoPairMarkdown"], true);
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
