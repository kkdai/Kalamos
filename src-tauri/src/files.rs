use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppError;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
}

pub fn open_file_impl(path: &str) -> Result<String, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let bytes = fs::read(path)?;
    String::from_utf8(bytes).map_err(|e| AppError::parse(e.to_string()))
}

pub fn save_file_impl(path: &str, content: &str) -> Result<FileMeta, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let target = Path::new(path);
    if target.is_dir() {
        return Err(AppError::invalid_path("Target path is a directory"));
    }

    let parent = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    if !parent.exists() {
        return Err(AppError::not_found(format!(
            "Parent directory does not exist: {}",
            parent.display()
        )));
    }

    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::invalid_path("Invalid file name"))?;

    let existing_permissions = fs::metadata(target).ok().map(|m| m.permissions());

    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let tmp_name = format!(".{file_name}.kalamos-tmp-{pid}-{nanos}-{seq}");
    let tmp_path = parent.join(tmp_name);

    let write_res = (|| -> Result<(), AppError> {
        let mut tmp_file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)?;
        if let Some(perms) = existing_permissions {
            tmp_file.set_permissions(perms)?;
        }
        tmp_file.write_all(content.as_bytes())?;
        tmp_file.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(err);
    }

    if let Err(err) = fs::rename(&tmp_path, target) {
        let _ = fs::remove_file(&tmp_path);
        return Err(AppError::from(err));
    }

    let meta = fs::metadata(target)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let size = meta.len();

    Ok(FileMeta {
        path: path.to_string(),
        mtime_ms,
        size,
    })
}

#[tauri::command]
pub fn open_file(path: String) -> Result<String, AppError> {
    open_file_impl(&path)
}

#[tauri::command]
pub fn save_file(path: String, content: String) -> Result<FileMeta, AppError> {
    save_file_impl(&path, &content)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use tempfile::tempdir;

    #[test]
    fn atomic_write_and_no_leftover_temp_files() {
        let dir = tempdir().expect("tempdir");
        let file_path = dir.path().join("note.md");
        let path_str = file_path.to_str().unwrap();

        let meta1 = save_file_impl(path_str, "# First\n").expect("first save");
        assert_eq!(meta1.path, path_str);
        assert_eq!(meta1.size, "# First\n".len() as u64);
        assert!(meta1.mtime_ms > 0);

        let meta2 = save_file_impl(path_str, "# Second longer content\n").expect("second save");
        assert_eq!(meta2.size, "# Second longer content\n".len() as u64);

        let entries: Vec<_> = fs::read_dir(dir.path())
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .collect();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].file_name(), "note.md");
    }

    #[test]
    fn preserves_exact_bytes_crlf_no_trailing_newline_and_cjk() {
        let dir = tempdir().expect("tempdir");

        let cases = [
            ("crlf.md", "# Title\r\n\r\nParagraph with CRLF\r\n"),
            ("no_newline.md", "# 無結尾換行\n第二行沒有 newline"),
            (
                "cjk_mixed.md",
                "# 蘆葦筆 Kalamos (κάλαμος)\r\n\r\n中英混寫 **粗體** 與 `code` — 不加 BOM、不改行尾",
            ),
            ("empty.md", ""),
        ];

        for (name, content) in cases {
            let p = dir.path().join(name);
            let p_str = p.to_str().unwrap();
            let meta = save_file_impl(p_str, content).expect("save_file_impl");
            assert_eq!(meta.size, content.len() as u64);

            let raw_bytes = fs::read(&p).expect("read raw bytes");
            assert_eq!(raw_bytes, content.as_bytes(), "byte mismatch for {name}");
            // Ensure no UTF-8 BOM was added
            assert!(!raw_bytes.starts_with(&[0xEF, 0xBB, 0xBF]));

            let loaded = open_file_impl(p_str).expect("open_file_impl");
            assert_eq!(loaded, content);
            assert_eq!(loaded.as_bytes(), content.as_bytes());
        }
    }

    #[cfg(unix)]
    #[test]
    fn preserves_existing_file_permissions_on_save() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempdir().expect("tempdir");
        let file_path = dir.path().join("secret.md");
        let path_str = file_path.to_str().unwrap();

        save_file_impl(path_str, "v1").expect("initial save");
        fs::set_permissions(&file_path, fs::Permissions::from_mode(0o600))
            .expect("chmod 0600");

        save_file_impl(path_str, "v2").expect("second save");
        let mode = fs::metadata(&file_path)
            .expect("metadata")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[test]
    fn open_and_save_error_kinds() {
        let dir = tempdir().expect("tempdir");
        let missing = dir.path().join("does-not-exist.md");
        let err = open_file_impl(missing.to_str().unwrap()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);

        let empty_err = open_file_impl("").unwrap_err();
        assert_eq!(empty_err.kind, ErrorKind::InvalidPath);

        let save_empty_err = save_file_impl("   ", "abc").unwrap_err();
        assert_eq!(save_empty_err.kind, ErrorKind::InvalidPath);
    }
}
