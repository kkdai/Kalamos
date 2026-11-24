use std::fs;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{AppError, ErrorKind};
use crate::files::save_file_impl;

static SETTINGS_WRITE_LOCK: Mutex<()> = Mutex::new(());

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

/// #74: what the app shows when it starts.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum StartupBehavior {
    /// Reopen the last folder in the sidebar (behaviour before #74).
    #[default]
    RestoreFolder,
    /// Start with an empty document and no folder.
    Blank,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
pub enum UiLocale {
    #[default]
    #[serde(rename = "zh-TW")]
    ZhTw,
    #[serde(rename = "en")]
    En,
}

impl UiLocale {
    pub fn from_setting_str(raw: &str) -> Option<Self> {
        match raw {
            "zh-TW" => Some(Self::ZhTw),
            "en" => Some(Self::En),
            _ => None,
        }
    }
}

impl<'de> Deserialize<'de> for UiLocale {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        // An unsupported or malformed locale must not reset unrelated settings.
        let raw = serde_json::Value::deserialize(deserializer)?;
        Ok(raw.as_str().and_then(Self::from_setting_str).unwrap_or_default())
    }
}

fn deserialize_optional_ui_locale<'de, D>(deserializer: D) -> Result<Option<UiLocale>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    // An unsupported or malformed locale falls back to system locale without
    // resetting unrelated settings.
    let raw = serde_json::Value::deserialize(deserializer)?;
    Ok(raw.as_str().and_then(UiLocale::from_setting_str))
}

/// Maps a BCP-47 / POSIX system locale tag to the default UI locale:
/// any `zh` locale uses Traditional Chinese (`zh-TW`); all others use English (`en`).
pub fn default_ui_locale_for_tag(tag: Option<&str>) -> UiLocale {
    let Some(raw) = tag else {
        return UiLocale::En;
    };
    let lower = raw.trim().to_ascii_lowercase();
    if lower == "zh"
        || lower.starts_with("zh-")
        || lower.starts_with("zh_")
        || lower.starts_with("zh.")
    {
        UiLocale::ZhTw
    } else {
        UiLocale::En
    }
}

pub fn resolve_ui_locale(stored: Option<UiLocale>, system_locale: Option<&str>) -> UiLocale {
    stored.unwrap_or_else(|| default_ui_locale_for_tag(system_locale))
}

pub fn current_system_locale() -> Option<String> {
    sys_locale::get_locale()
}

pub const DEFAULT_FONT_SIZE: u32 = 17;
pub const DEFAULT_CONTENT_WIDTH: u32 = 720;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub theme: String,
    /// The UI language to use the next time the app starts (`None` = follow system language).
    #[serde(
        default,
        deserialize_with = "deserialize_optional_ui_locale",
        skip_serializing_if = "Option::is_none"
    )]
    pub ui_locale: Option<UiLocale>,
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
    /// #74 preferences: startup behaviour.
    pub startup_behavior: StartupBehavior,
    /// #74 preferences: autosave named documents after typing stops.
    pub auto_save: bool,
    /// #74 preferences: editor font size in px (`--k-font-size`).
    pub font_size: u32,
    /// #74 preferences: content column width in px (`--k-max-width`).
    pub content_width: u32,
    /// #104: recently opened / saved file paths (newest first, up to 20).
    pub recent_files: Vec<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: "system".to_string(),
            ui_locale: None,
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
            startup_behavior: StartupBehavior::RestoreFolder,
            auto_save: true,
            font_size: DEFAULT_FONT_SIZE,
            content_width: DEFAULT_CONTENT_WIDTH,
            recent_files: Vec::new(),
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

/// Startup locale shared by the native menu and the WebView until the app quits.
pub struct ActiveUiLocale(OnceLock<UiLocale>);

impl Default for ActiveUiLocale {
    fn default() -> Self {
        Self::new()
    }
}

impl ActiveUiLocale {
    pub fn new() -> Self {
        Self(OnceLock::new())
    }

    fn load_for(app_data_dir: Option<&Path>, system_locale: Option<&str>) -> UiLocale {
        let stored = app_data_dir
            .and_then(|dir| get_settings_in(dir).ok())
            .and_then(|settings| settings.ui_locale);
        resolve_ui_locale(stored, system_locale)
    }

    /// Resolves and caches the active startup locale once.
    pub fn resolve<R: tauri::Runtime>(&self, app: &tauri::AppHandle<R>) -> UiLocale {
        *self.0.get_or_init(|| {
            let app_data_dir = app.path().app_data_dir().ok();
            let system_locale = current_system_locale();
            Self::load_for(app_data_dir.as_deref(), system_locale.as_deref())
        })
    }
}

/// Reads (initializing on first call) the managed `ActiveUiLocale` state.
pub(crate) fn active_ui_locale<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> UiLocale {
    app.state::<ActiveUiLocale>().resolve(app)
}

#[tauri::command]
pub fn get_active_ui_locale(
    app: tauri::AppHandle,
    active: tauri::State<'_, ActiveUiLocale>,
) -> UiLocale {
    active.resolve(&app)
}

/// Keep the on-disk uploader (which runs a local program) and the locale
/// (written only by `set_ui_locale`, so a stale settings copy cannot reset it).
pub fn keep_protected_from_disk(incoming: &Settings, on_disk: &Settings) -> Settings {
    Settings {
        upload_command: on_disk.upload_command.clone(),
        upload_args: on_disk.upload_args.clone(),
        ui_locale: on_disk.ui_locale,
        ..incoming.clone()
    }
}

fn update_settings_in(
    app_data_dir: &Path,
    update: impl FnOnce(Settings) -> Settings,
) -> Result<(), AppError> {
    // A general settings save and a locale save must not overwrite each other.
    let _guard = SETTINGS_WRITE_LOCK
        .lock()
        .map_err(|_| AppError::new(ErrorKind::Io, "settings write lock poisoned"))?;
    fs::create_dir_all(app_data_dir)?;
    let settings_path = app_data_dir.join("settings.json");
    let settings_path_str = settings_path
        .to_str()
        .ok_or_else(|| AppError::invalid_path("Non-UTF-8 settings path"))?;
    let updated = update(get_settings_in(app_data_dir)?);
    let json = serde_json::to_string_pretty(&updated)?;
    save_file_impl(settings_path_str, &json)?;
    Ok(())
}

/// Write settings, preserving the stored `uploadCommand`, `uploadArgs` and `uiLocale`.
pub fn set_settings_in(app_data_dir: &Path, settings: &Settings) -> Result<(), AppError> {
    update_settings_in(app_data_dir, |on_disk| keep_protected_from_disk(settings, &on_disk))
}

fn set_ui_locale_in(app_data_dir: &Path, locale: UiLocale) -> Result<(), AppError> {
    update_settings_in(app_data_dir, |settings| Settings {
        ui_locale: Some(locale),
        ..settings
    })
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

/// Save the language for the next launch without changing the active locale.
#[tauri::command]
pub fn set_ui_locale(app: tauri::AppHandle, locale: UiLocale) -> Result<(), AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    set_ui_locale_in(&app_data_dir, locale)
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
        assert!(v.get("uiLocale").is_none());
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
        assert_eq!(v["startupBehavior"], "restoreFolder");
        assert_eq!(v["autoSave"], true);
        assert_eq!(v["fontSize"], 17);
        assert_eq!(v["contentWidth"], 720);
        assert_eq!(v["recentFiles"], serde_json::json!([]));
    }

    #[test]
    fn set_and_get_settings_roundtrip() {
        let dir = tempdir().expect("tempdir");
        let updated = Settings {
            theme: "melan".to_string(),
            ui_locale: None,
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
            startup_behavior: StartupBehavior::Blank,
            auto_save: false,
            font_size: 20,
            content_width: 960,
            recent_files: vec![
                "/tmp/kalamos-test/Notes/a.md".to_string(),
                "/tmp/kalamos-test/Notes/b.md".to_string(),
            ],
        };
        set_settings_in(dir.path(), &updated).expect("set_settings");
        let loaded = get_settings_in(dir.path()).expect("get_settings");
        assert_eq!(loaded, updated);
    }

    #[test]
    fn locale_save_preserves_other_settings_and_survives_stale_saves() {
        let dir = tempdir().unwrap();
        let previous = Settings {
            theme: "papyros".into(),
            auto_save: false,
            ..Settings::default()
        };
        set_settings_in(dir.path(), &previous).unwrap();
        // General settings writes must not lock in a uiLocale when unset.
        let raw_before: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(dir.path().join("settings.json")).unwrap())
                .unwrap();
        assert!(raw_before.get("uiLocale").is_none());

        set_ui_locale_in(dir.path(), UiLocale::En).unwrap();
        let stored = get_settings_in(dir.path()).unwrap();
        assert_eq!(stored, Settings { ui_locale: Some(UiLocale::En), ..previous.clone() });
        assert_eq!(serde_json::to_value(stored).unwrap()["uiLocale"], "en");

        let stale = Settings { font_size: 22, ..previous };
        set_settings_in(dir.path(), &stale).unwrap();
        assert_eq!(
            get_settings_in(dir.path()).unwrap(),
            Settings { ui_locale: Some(UiLocale::En), ..stale }
        );
    }

    #[test]
    fn unknown_ui_locale_does_not_reset_other_settings() {
        let dir = tempdir().unwrap();
        for invalid in [r#""ja""#, "null", "42", "{}"] {
            fs::write(
                dir.path().join("settings.json"),
                format!(r#"{{"uiLocale":{invalid},"theme":"papyros","uploadArgs":["upload"]}}"#),
            )
            .unwrap();
            let settings = get_settings_in(dir.path()).unwrap();
            assert_eq!(settings.ui_locale, None);
            assert_eq!(settings.theme, "papyros");
            assert_eq!(settings.upload_args, ["upload"]);
            assert_eq!(
                ActiveUiLocale::load_for(Some(dir.path()), Some("zh-Hant-TW")),
                UiLocale::ZhTw
            );
            assert_eq!(
                ActiveUiLocale::load_for(Some(dir.path()), Some("en-US")),
                UiLocale::En
            );
        }
    }

    #[test]
    fn default_ui_locale_follows_system_language_tags() {
        for zh_tag in [
            "zh",
            "zh-TW",
            "zh-Hant",
            "zh-Hant-TW",
            "zh-CN",
            "zh-Hans-CN",
            "zh-HK",
            "ZH_tw",
            "zh_TW.UTF-8",
            "zh.UTF-8",
            "  zh-TW  ",
        ] {
            assert_eq!(
                default_ui_locale_for_tag(Some(zh_tag)),
                UiLocale::ZhTw,
                "expected zh-TW for {zh_tag:?}"
            );
        }
        for other_tag in [
            Some("en"),
            Some("en-US"),
            Some("en-GB"),
            Some("ja"),
            Some("ja-JP"),
            Some("ko-KR"),
            Some("fr-FR"),
            Some("de-DE"),
            Some(""),
            None,
        ] {
            assert_eq!(
                default_ui_locale_for_tag(other_tag),
                UiLocale::En,
                "expected en for {other_tag:?}"
            );
        }
    }

    #[test]
    fn active_ui_locale_follows_system_when_unset_and_respects_saved_locale() {
        let dir = tempdir().unwrap();
        // Fresh install (no settings.json): follows system locale.
        assert_eq!(
            ActiveUiLocale::load_for(Some(dir.path()), Some("zh-Hant-TW")),
            UiLocale::ZhTw
        );
        assert_eq!(
            ActiveUiLocale::load_for(Some(dir.path()), Some("en-US")),
            UiLocale::En
        );
        assert_eq!(
            ActiveUiLocale::load_for(Some(dir.path()), Some("ja-JP")),
            UiLocale::En
        );

        // Existing settings.json without uiLocale: still follows system locale.
        fs::write(dir.path().join("settings.json"), r#"{"theme":"melan"}"#).unwrap();
        assert_eq!(
            ActiveUiLocale::load_for(Some(dir.path()), Some("zh-CN")),
            UiLocale::ZhTw
        );
        assert_eq!(
            ActiveUiLocale::load_for(Some(dir.path()), Some("en-GB")),
            UiLocale::En
        );

        // Explicit saved zh-TW overrides an English system locale.
        set_ui_locale_in(dir.path(), UiLocale::ZhTw).unwrap();
        assert_eq!(
            ActiveUiLocale::load_for(Some(dir.path()), Some("en-US")),
            UiLocale::ZhTw
        );

        // Explicit saved en overrides a Chinese system locale.
        set_ui_locale_in(dir.path(), UiLocale::En).unwrap();
        assert_eq!(
            ActiveUiLocale::load_for(Some(dir.path()), Some("zh-Hant-TW")),
            UiLocale::En
        );
    }

    #[test]
    fn active_ui_locale_stays_fixed_until_the_next_launch() {
        let dir = tempdir().unwrap();
        let startup = ActiveUiLocale::new();
        let first = *startup
            .0
            .get_or_init(|| ActiveUiLocale::load_for(Some(dir.path()), Some("zh-TW")));
        assert_eq!(serde_json::to_value(first).unwrap(), "zh-TW");

        set_ui_locale_in(dir.path(), UiLocale::En).unwrap();
        assert_eq!(*startup.0.get().unwrap(), UiLocale::ZhTw);
        let next_launch = ActiveUiLocale::load_for(Some(dir.path()), Some("zh-TW"));
        assert_eq!(serde_json::to_value(next_launch).unwrap(), "en");
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
        assert_eq!(loaded.ui_locale, None);
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

        fs::write(
            &settings_path,
            r#"{ "imageRootDir": "/tmp/kalamos-test/blog" }"#,
        )
        .expect("write settings.json");
        let loaded = get_settings_in(dir.path()).expect("load settings");
        assert_eq!(
            loaded.image_root_dir.as_deref(),
            Some("/tmp/kalamos-test/blog")
        );
        assert_eq!(loaded.theme, "system");

        let v = serde_json::to_value(&loaded).unwrap();
        assert_eq!(v["imageRootDir"], "/tmp/kalamos-test/blog");
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
    fn reads_settings_written_before_the_preferences_window() {
        let dir = tempdir().expect("tempdir");
        let settings_path = dir.path().join("settings.json");
        // A settings file written before #74 (v0.1.1).
        fs::write(
            &settings_path,
            r#"{ "theme": "melan", "lastFolder": "/tmp/kalamos-test/notes", "autoPairBrackets": false,
                 "uploadCommand": "/tmp/kalamos-test/bin/picgo", "uploadArgs": ["upload"] }"#,
        )
        .expect("write settings.json");
        let mut loaded = get_settings_in(dir.path()).expect("load settings");
        assert_eq!(loaded.theme, "melan");
        assert!(!loaded.auto_pair_brackets);
        assert_eq!(loaded.startup_behavior, StartupBehavior::RestoreFolder);
        assert!(loaded.auto_save);
        assert_eq!(loaded.font_size, DEFAULT_FONT_SIZE);
        assert_eq!(loaded.content_width, DEFAULT_CONTENT_WIDTH);

        loaded.startup_behavior = StartupBehavior::Blank;
        loaded.auto_save = false;
        loaded.font_size = 19;
        loaded.content_width = 880;
        set_settings_in(dir.path(), &loaded).expect("save settings");
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert_eq!(raw["startupBehavior"], "blank");
        assert_eq!(raw["autoSave"], false);
        assert_eq!(raw["fontSize"], 19);
        assert_eq!(raw["contentWidth"], 880);
        assert_eq!(raw["uploadCommand"], "/tmp/kalamos-test/bin/picgo");
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

    #[test]
    fn reads_settings_without_recent_files_and_roundtrips_them() {
        let dir = tempdir().expect("tempdir");
        let settings_path = dir.path().join("settings.json");
        fs::write(
            &settings_path,
            r#"{ "theme": "papyros", "fontSize": 18, "contentWidth": 800 }"#,
        )
        .expect("write settings without recentFiles");

        let mut loaded = get_settings_in(dir.path()).expect("load settings");
        assert!(loaded.recent_files.is_empty());

        loaded.recent_files = vec![
            "/tmp/kalamos-test/a.md".to_string(),
            "/tmp/kalamos-test/sub/b.md".to_string(),
        ];
        set_settings_in(dir.path(), &loaded).expect("save settings");
        let raw: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&settings_path).unwrap()).unwrap();
        assert_eq!(
            raw["recentFiles"],
            serde_json::json!(["/tmp/kalamos-test/a.md", "/tmp/kalamos-test/sub/b.md"])
        );
        assert_eq!(get_settings_in(dir.path()).unwrap(), loaded);
    }
}
