use std::fs;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::AppError;
use crate::files::save_file_impl;

static LAST_SAVED_MS: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryEntry {
    pub doc_id: String,
    pub path: Option<String>,
    pub content: String,
    pub saved_at_ms: u64,
}

fn validate_doc_id(doc_id: &str) -> Result<(), AppError> {
    if doc_id.trim().is_empty()
        || doc_id.contains('/')
        || doc_id.contains('\\')
        || doc_id.contains("..")
        || doc_id.contains('\0')
    {
        return Err(AppError::invalid_path(format!("Invalid docId: {doc_id}")));
    }
    Ok(())
}

fn next_timestamp_ms() -> u64 {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    let mut prev = LAST_SAVED_MS.load(Ordering::Relaxed);
    loop {
        let next = if now > prev { now } else { prev + 1 };
        match LAST_SAVED_MS.compare_exchange_weak(prev, next, Ordering::SeqCst, Ordering::Relaxed) {
            Ok(_) => return next,
            Err(actual) => prev = actual,
        }
    }
}

pub fn write_recovery_in(
    app_data_dir: &Path,
    doc_id: &str,
    path: Option<String>,
    content: &str,
) -> Result<(), AppError> {
    validate_doc_id(doc_id)?;
    let recovery_dir = app_data_dir.join("recovery");
    fs::create_dir_all(&recovery_dir)?;

    let entry = RecoveryEntry {
        doc_id: doc_id.to_string(),
        path,
        content: content.to_string(),
        saved_at_ms: next_timestamp_ms(),
    };

    let json = serde_json::to_string_pretty(&entry)?;
    let file_path = recovery_dir.join(format!("{doc_id}.json"));
    let file_path_str = file_path
        .to_str()
        .ok_or_else(|| AppError::invalid_path("Non-UTF-8 recovery path"))?;
    save_file_impl(file_path_str, &json)?;
    Ok(())
}

pub fn list_recovery_in(app_data_dir: &Path) -> Result<Vec<RecoveryEntry>, AppError> {
    let recovery_dir = app_data_dir.join("recovery");
    if !recovery_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries = Vec::new();
    for dir_entry in fs::read_dir(&recovery_dir)? {
        let dir_entry = match dir_entry {
            Ok(e) => e,
            Err(err) => {
                eprintln!("Skipping unreadable recovery dir entry: {err}");
                continue;
            }
        };
        let path = dir_entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if name.starts_with('.') || !name.ends_with(".json") {
            continue;
        }
        let raw = match fs::read_to_string(&path) {
            Ok(s) => s,
            Err(err) => {
                eprintln!("Skipping unreadable recovery file {}: {err}", path.display());
                continue;
            }
        };
        let entry: RecoveryEntry = match serde_json::from_str(&raw) {
            Ok(e) => e,
            Err(err) => {
                eprintln!("Skipping corrupted recovery file {}: {err}", path.display());
                continue;
            }
        };
        entries.push(entry);
    }

    entries.sort_by_key(|a| std::cmp::Reverse(a.saved_at_ms));
    Ok(entries)
}

pub fn clear_recovery_in(app_data_dir: &Path, doc_id: &str) -> Result<(), AppError> {
    validate_doc_id(doc_id)?;
    let file_path = app_data_dir.join("recovery").join(format!("{doc_id}.json"));
    match fs::remove_file(&file_path) {
        Ok(()) => Ok(()),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(err) => Err(AppError::from(err)),
    }
}

#[tauri::command]
pub fn write_recovery(
    app: tauri::AppHandle,
    doc_id: String,
    path: Option<String>,
    content: String,
) -> Result<(), AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    write_recovery_in(&app_data_dir, &doc_id, path, &content)
}

#[tauri::command]
pub fn list_recovery(app: tauri::AppHandle) -> Result<Vec<RecoveryEntry>, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    list_recovery_in(&app_data_dir)
}

#[tauri::command]
pub fn clear_recovery(app: tauri::AppHandle, doc_id: String) -> Result<(), AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    clear_recovery_in(&app_data_dir, &doc_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use tempfile::tempdir;

    #[test]
    fn recovery_lifecycle_write_list_sorted_and_clear() {
        let dir = tempdir().expect("tempdir");

        assert!(list_recovery_in(dir.path()).unwrap().is_empty());

        write_recovery_in(dir.path(), "doc-1", None, "# 未命名草稿 1").expect("write doc-1");
        write_recovery_in(
            dir.path(),
            "doc-2",
            Some("/tmp/notes/a.md".to_string()),
            "# 已命名草稿 2\r\n第二行",
        )
        .expect("write doc-2");

        let list = list_recovery_in(dir.path()).expect("list recovery");
        assert_eq!(list.len(), 2);
        // Newest first
        assert_eq!(list[0].doc_id, "doc-2");
        assert_eq!(list[0].path.as_deref(), Some("/tmp/notes/a.md"));
        assert_eq!(list[0].content, "# 已命名草稿 2\r\n第二行");
        assert_eq!(list[1].doc_id, "doc-1");
        assert_eq!(list[1].path, None);
        assert_eq!(list[1].content, "# 未命名草稿 1");
        assert!(list[0].saved_at_ms > list[1].saved_at_ms);

        // Verify JSON schema keys match api.yaml
        let json_val = serde_json::to_value(&list[1]).unwrap();
        assert_eq!(json_val["docId"], "doc-1");
        assert!(json_val["path"].is_null());
        assert_eq!(json_val["content"], "# 未命名草稿 1");
        assert!(json_val["savedAtMs"].is_u64());

        // Clear doc-2
        clear_recovery_in(dir.path(), "doc-2").expect("clear doc-2");
        // Idempotent clear
        clear_recovery_in(dir.path(), "doc-2").expect("clear doc-2 again");

        let remaining = list_recovery_in(dir.path()).expect("list remaining");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].doc_id, "doc-1");
    }

    #[test]
    fn skips_corrupted_recovery_json_files() {
        let dir = tempdir().expect("tempdir");
        write_recovery_in(dir.path(), "valid-doc", None, "# Valid content")
            .expect("write valid-doc");

        let broken_path = dir.path().join("recovery").join("corrupted.json");
        fs::write(&broken_path, "{ not valid json").expect("write broken json");

        let list = list_recovery_in(dir.path()).expect("list recovery");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].doc_id, "valid-doc");
        assert_eq!(list[0].content, "# Valid content");
    }

    #[test]
    fn rejects_invalid_doc_id() {
        let dir = tempdir().expect("tempdir");
        for bad in ["", "  ", "../escape", "a/b", "a\\b"] {
            let err = write_recovery_in(dir.path(), bad, None, "x").unwrap_err();
            assert_eq!(err.kind, ErrorKind::InvalidPath);
        }
    }
}
