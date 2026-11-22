use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThemeInfo {
    pub id: String,
    pub name: String,
    pub builtin: bool,
}

fn is_valid_theme_stem(stem: &str) -> bool {
    !stem.is_empty()
        && stem == stem.trim()
        && !stem.starts_with('.')
        && !stem.contains('/')
        && !stem.contains('\\')
        && !stem.contains("..")
        && !stem.contains('\0')
        && !stem.contains(':')
}

pub fn list_themes_in(app_data_dir: &Path) -> Result<Vec<ThemeInfo>, AppError> {
    let themes_dir = app_data_dir.join("themes");
    fs::create_dir_all(&themes_dir)?;

    let mut themes = vec![
        ThemeInfo {
            id: "papyros".to_string(),
            name: "Papyros".to_string(),
            builtin: true,
        },
        ThemeInfo {
            id: "melan".to_string(),
            name: "Melan".to_string(),
            builtin: true,
        },
    ];

    let mut custom_themes = Vec::new();
    for entry_res in fs::read_dir(&themes_dir)? {
        let Ok(entry) = entry_res else {
            continue;
        };
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_file() {
            continue;
        }
        let path = entry.path();
        let is_css = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.eq_ignore_ascii_case("css"))
            .unwrap_or(false);
        if !is_css {
            continue;
        }
        let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        if !is_valid_theme_stem(stem) {
            continue;
        }
        custom_themes.push(ThemeInfo {
            id: format!("custom:{stem}"),
            name: stem.to_string(),
            builtin: false,
        });
    }

    custom_themes.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            .then_with(|| a.name.cmp(&b.name))
    });

    themes.extend(custom_themes);
    Ok(themes)
}

pub fn read_theme_css_in(app_data_dir: &Path, id: &str) -> Result<String, AppError> {
    let themes_dir = app_data_dir.join("themes");
    fs::create_dir_all(&themes_dir)?;

    let Some(stem) = id.strip_prefix("custom:") else {
        return Err(AppError::invalid_path(format!(
            "Theme id must start with 'custom:': {id}"
        )));
    };
    if !is_valid_theme_stem(stem) {
        return Err(AppError::invalid_path(format!(
            "Invalid custom theme id: {id}"
        )));
    }

    let css_path = themes_dir.join(format!("{stem}.css"));
    if !css_path.exists() || !css_path.is_file() {
        return Err(AppError::not_found(format!(
            "Custom theme not found: {id}"
        )));
    }

    let bytes = fs::read(&css_path)?;
    String::from_utf8(bytes).map_err(|e| AppError::parse(e.to_string()))
}

#[tauri::command]
pub fn list_themes(app: tauri::AppHandle) -> Result<Vec<ThemeInfo>, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    list_themes_in(&app_data_dir)
}

#[tauri::command]
pub fn read_theme_css(app: tauri::AppHandle, id: String) -> Result<String, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    read_theme_css_in(&app_data_dir, &id)
}

/// #74: the custom theme folder (created when missing).
pub fn ensure_themes_dir_in(app_data_dir: &Path) -> Result<std::path::PathBuf, AppError> {
    let themes_dir = app_data_dir.join("themes");
    fs::create_dir_all(&themes_dir)?;
    Ok(themes_dir)
}

/// #74 preferences: show the custom CSS theme folder in Finder; returns its path.
#[tauri::command]
pub fn open_themes_dir(app: tauri::AppHandle) -> Result<String, AppError> {
    use tauri_plugin_opener::OpenerExt;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    let themes_dir = ensure_themes_dir_in(&app_data_dir)?;
    let path = themes_dir
        .to_str()
        .ok_or_else(|| AppError::invalid_path("Non-UTF-8 themes path"))?
        .to_string();
    app.opener()
        .open_path(path.clone(), None::<&str>)
        .map_err(|e| AppError::new(crate::error::ErrorKind::Io, e.to_string()))?;
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_themes_dir_creates_the_folder() {
        let dir = tempfile::tempdir().expect("tempdir");
        let themes = ensure_themes_dir_in(dir.path()).expect("themes dir");
        assert_eq!(themes, dir.path().join("themes"));
        assert!(themes.is_dir());
        // Idempotent.
        ensure_themes_dir_in(dir.path()).expect("again");
    }
    use crate::error::ErrorKind;
    use tempfile::tempdir;

    #[test]
    fn list_themes_auto_creates_dir_and_lists_builtins_plus_sorted_custom_css() {
        let dir = tempdir().expect("tempdir");
        let themes_dir = dir.path().join("themes");
        assert!(!themes_dir.exists());

        // First call auto-creates themes/ and returns built-ins
        let initial = list_themes_in(dir.path()).expect("list_themes_in");
        assert!(themes_dir.exists());
        assert_eq!(
            initial,
            vec![
                ThemeInfo {
                    id: "papyros".to_string(),
                    name: "Papyros".to_string(),
                    builtin: true,
                },
                ThemeInfo {
                    id: "melan".to_string(),
                    name: "Melan".to_string(),
                    builtin: true,
                },
            ]
        );

        // Add custom CSS files and ignored non-css / hidden files
        fs::write(themes_dir.join("zebra.css"), ":root { --k-bg: #000; }").unwrap();
        fs::write(themes_dir.join("Amber.css"), ":root { --k-bg: #fff; }").unwrap();
        fs::write(themes_dir.join(".hidden.css"), "ignored").unwrap();
        fs::write(themes_dir.join("readme.txt"), "ignored").unwrap();

        let listed = list_themes_in(dir.path()).expect("list_themes_in with custom");
        assert_eq!(listed.len(), 4);
        assert_eq!(
            listed[2],
            ThemeInfo {
                id: "custom:Amber".to_string(),
                name: "Amber".to_string(),
                builtin: false,
            }
        );
        assert_eq!(
            listed[3],
            ThemeInfo {
                id: "custom:zebra".to_string(),
                name: "zebra".to_string(),
                builtin: false,
            }
        );
    }

    #[test]
    fn read_theme_css_reads_valid_custom_theme_and_rejects_traversal_or_builtin() {
        let dir = tempdir().expect("tempdir");
        let themes_dir = dir.path().join("themes");
        fs::create_dir_all(&themes_dir).unwrap();
        let css_content = ":root {\n  --k-accent: #7aa2f7;\n}\n";
        fs::write(themes_dir.join("night.css"), css_content).unwrap();

        let loaded = read_theme_css_in(dir.path(), "custom:night").expect("read custom:night");
        assert_eq!(loaded, css_content);

        // Builtin or missing prefix rejected with InvalidPath
        for invalid_id in [
            "papyros",
            "melan",
            "custom:",
            "custom:../secret",
            "custom:a/b",
            "custom:a\\b",
            "custom:.hidden",
            "custom:a:b",
        ] {
            let err = read_theme_css_in(dir.path(), invalid_id).unwrap_err();
            assert_eq!(
                err.kind,
                ErrorKind::InvalidPath,
                "expected InvalidPath for {invalid_id}"
            );
        }

        // Missing custom theme returns NotFound
        let missing_err = read_theme_css_in(dir.path(), "custom:does-not-exist").unwrap_err();
        assert_eq!(missing_err.kind, ErrorKind::NotFound);
    }
}
