use std::fs::{self, OpenOptions};
use std::path::Path;
use std::time::UNIX_EPOCH;

use crate::error::{AppError, ErrorKind};
use crate::files::FileMeta;

fn file_meta_for(path_str: &str, target: &Path) -> Result<FileMeta, AppError> {
    let meta = fs::metadata(target)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let size = meta.len();
    Ok(FileMeta {
        path: path_str.to_string(),
        mtime_ms,
        size,
    })
}

pub fn create_file_impl(path: &str) -> Result<FileMeta, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let target = Path::new(path);
    if target.exists() {
        return Err(AppError::new(
            ErrorKind::AlreadyExists,
            format!("File already exists: {path}"),
        ));
    }
    if let Some(parent) = target.parent() {
        if !parent.as_os_str().is_empty() && !parent.exists() {
            return Err(AppError::not_found(format!(
                "Parent directory does not exist: {}",
                parent.display()
            )));
        }
    }
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)?;
    file.sync_all()?;
    file_meta_for(path, target)
}

pub fn rename_path_impl(from: &str, to: &str) -> Result<(), AppError> {
    if from.trim().is_empty() || to.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let from_path = Path::new(from);
    let to_path = Path::new(to);
    if !from_path.exists() {
        return Err(AppError::not_found(format!(
            "Source path does not exist: {from}"
        )));
    }
    if from != to && to_path.exists() {
        return Err(AppError::new(
            ErrorKind::AlreadyExists,
            format!("Destination path already exists: {to}"),
        ));
    }
    fs::rename(from_path, to_path)?;
    Ok(())
}

pub fn trash_path_impl(path: &str) -> Result<(), AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let target = Path::new(path);
    if !target.exists() {
        return Err(AppError::not_found(format!("Path does not exist: {path}")));
    }
    trash::delete(target).map_err(|err| match err {
        trash::Error::TargetedRoot => AppError::invalid_path(err.to_string()),
        _ => AppError::new(ErrorKind::Io, err.to_string()),
    })?;
    Ok(())
}

#[tauri::command]
pub fn create_file(path: String) -> Result<FileMeta, AppError> {
    create_file_impl(&path)
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), AppError> {
    rename_path_impl(&from, &to)
}

#[tauri::command]
pub fn trash_path(path: String) -> Result<(), AppError> {
    trash_path_impl(&path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn create_file_creates_empty_file_and_rejects_already_exists() {
        let dir = tempdir().expect("tempdir");
        let file_path = dir.path().join("new-note.md");
        let path_str = file_path.to_str().unwrap();

        let meta = create_file_impl(path_str).expect("create_file_impl");
        assert_eq!(meta.path, path_str);
        assert_eq!(meta.size, 0);
        assert!(file_path.exists());

        let dup_err = create_file_impl(path_str).unwrap_err();
        assert_eq!(dup_err.kind, ErrorKind::AlreadyExists);
    }

    #[test]
    fn rename_path_renames_file_and_validates_errors() {
        let dir = tempdir().expect("tempdir");
        let src = dir.path().join("a.md");
        let dst = dir.path().join("b.md");
        fs::write(&src, "# Hello").unwrap();

        rename_path_impl(src.to_str().unwrap(), dst.to_str().unwrap()).expect("rename_path_impl");
        assert!(!src.exists());
        assert!(dst.exists());
        assert_eq!(fs::read_to_string(&dst).unwrap(), "# Hello");

        // Missing source returns NotFound
        let missing_err =
            rename_path_impl(src.to_str().unwrap(), dst.to_str().unwrap()).unwrap_err();
        assert_eq!(missing_err.kind, ErrorKind::NotFound);

        // Existing destination returns AlreadyExists
        let another = dir.path().join("c.md");
        fs::write(&another, "# Another").unwrap();
        let exists_err =
            rename_path_impl(dst.to_str().unwrap(), another.to_str().unwrap()).unwrap_err();
        assert_eq!(exists_err.kind, ErrorKind::AlreadyExists);
    }

    #[test]
    fn trash_path_validates_missing_and_moves_to_trash_when_available() {
        let dir = tempdir().expect("tempdir");
        let missing = dir.path().join("ghost.md");
        let err = trash_path_impl(missing.to_str().unwrap()).unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);

        let file_to_trash = dir.path().join("kalamos-trash-test.md");
        fs::write(&file_to_trash, "temporary trash test").unwrap();
        // In sandboxed or headless CI environments without a user Trash folder, trash::delete
        // may return an OS error; when Trash is accessible, the file must be removed.
        match trash_path_impl(file_to_trash.to_str().unwrap()) {
            Ok(()) => assert!(!file_to_trash.exists()),
            Err(app_err) => assert_eq!(app_err.kind, ErrorKind::Io),
        }
    }
}
