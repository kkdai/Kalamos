//! Image import (IM-02) and asset protocol scope management (IM-01).
//!
//! Images dropped or pasted into a document are copied into `<doc dir>/assets/`
//! and the editor inserts the returned relative path (`assets/xxx.png`).

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind as IoErrorKind, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::error::AppError;

pub const ASSETS_DIR: &str = "assets";
pub const ALLOWED_IMAGE_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "webp", "svg"];
const MAX_NAME_ATTEMPTS: u32 = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub relative_path: String,
}

/// Lowercased extension if it is one of the accepted image types.
pub fn normalize_image_ext(ext: &str) -> Result<String, AppError> {
    let lower = ext.trim().trim_start_matches('.').to_ascii_lowercase();
    if ALLOWED_IMAGE_EXTS.contains(&lower.as_str()) {
        Ok(lower)
    } else {
        Err(AppError::invalid_path(format!(
            "Unsupported image type: .{lower} (allowed: png, jpg, jpeg, gif, webp, svg)"
        )))
    }
}

/// Checks the file header matches the extension. SVG only checks that the text starts like XML/SVG.
pub fn matches_magic_bytes(ext: &str, bytes: &[u8]) -> bool {
    match ext {
        "png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
        "jpg" | "jpeg" => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
        "gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "webp" => bytes.len() >= 12 && &bytes[0..4] == b"RIFF" && &bytes[8..12] == b"WEBP",
        "svg" => {
            let head = &bytes[..bytes.len().min(512)];
            let text = String::from_utf8_lossy(head);
            let trimmed = text.trim_start_matches('\u{feff}').trim_start().to_ascii_lowercase();
            trimmed.starts_with("<svg")
                || trimmed.starts_with("<?xml")
                || trimmed.starts_with("<!--")
                || trimmed.starts_with("<!doctype svg")
        }
        _ => false,
    }
}

fn validate_image(ext: &str, bytes: &[u8]) -> Result<String, AppError> {
    let ext = normalize_image_ext(ext)?;
    if !matches_magic_bytes(&ext, bytes) {
        return Err(AppError::parse(format!(
            "File content does not look like a .{ext} image"
        )));
    }
    Ok(ext)
}

fn doc_dir(doc_path: &str) -> Result<PathBuf, AppError> {
    if doc_path.trim().is_empty() {
        return Err(AppError::invalid_path(
            "Document must be saved before importing images",
        ));
    }
    match Path::new(doc_path).parent() {
        Some(p) if !p.as_os_str().is_empty() => Ok(p.to_path_buf()),
        _ => Err(AppError::invalid_path(format!(
            "Cannot resolve document folder: {doc_path}"
        ))),
    }
}

/// Percent-encodes characters that would break a Markdown link destination.
pub fn encode_markdown_path(path: &str) -> String {
    let mut out = String::with_capacity(path.len());
    for ch in path.chars() {
        match ch {
            '%' => out.push_str("%25"),
            ' ' => out.push_str("%20"),
            '(' => out.push_str("%28"),
            ')' => out.push_str("%29"),
            '<' => out.push_str("%3C"),
            '>' => out.push_str("%3E"),
            _ => out.push(ch),
        }
    }
    out
}

fn relative_asset_path(file_name: &str) -> String {
    format!("{ASSETS_DIR}/{}", encode_markdown_path(file_name))
}

/// Writes `bytes` to `<dir>/<stem>.<ext>`, or `<stem>-1.<ext>`, `<stem>-2.<ext>`… if taken.
/// Uses `create_new` so concurrent imports never overwrite each other.
fn write_unique(dir: &Path, stem: &str, ext: &str, bytes: &[u8]) -> Result<String, AppError> {
    fs::create_dir_all(dir)?;
    for n in 0..MAX_NAME_ATTEMPTS {
        let name = if n == 0 {
            format!("{stem}.{ext}")
        } else {
            format!("{stem}-{n}.{ext}")
        };
        let target = dir.join(&name);
        match OpenOptions::new().write(true).create_new(true).open(&target) {
            Ok(mut file) => {
                if let Err(err) = file.write_all(bytes).and_then(|_| file.sync_all()) {
                    let _ = fs::remove_file(&target);
                    return Err(err.into());
                }
                return Ok(name);
            }
            Err(err) if err.kind() == IoErrorKind::AlreadyExists => continue,
            Err(err) => return Err(err.into()),
        }
    }
    Err(AppError::new(
        crate::error::ErrorKind::AlreadyExists,
        format!("Too many files named {stem}.{ext}"),
    ))
}

fn sanitize_stem(stem: &str) -> String {
    let cleaned: String = stem
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '\0' => '-',
            c if c.is_control() => '-',
            c => c,
        })
        .collect();
    let trimmed = cleaned.trim().trim_start_matches('.');
    if trimmed.is_empty() {
        "image".to_string()
    } else {
        trimmed.to_string()
    }
}

pub fn import_image_impl(doc_path: &str, source_path: &str) -> Result<ImportedImage, AppError> {
    let dir = doc_dir(doc_path)?;
    if source_path.trim().is_empty() {
        return Err(AppError::invalid_path("Source path must not be empty"));
    }
    let source = Path::new(source_path);
    let raw_ext = source
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default();
    let ext = normalize_image_ext(raw_ext)?;
    if !source.is_file() {
        return Err(AppError::not_found(format!("Image not found: {source_path}")));
    }
    let bytes = fs::read(source)?;
    validate_image(&ext, &bytes)?;

    let assets = dir.join(ASSETS_DIR);
    // Already inside this document's assets folder: reference it instead of copying again.
    if let (Some(src_parent), Some(file_name)) = (source.parent(), source.file_name()) {
        if let (Ok(a), Ok(b)) = (crate::platform::canonicalize(src_parent), crate::platform::canonicalize(&assets)) {
            if a == b {
                return Ok(ImportedImage {
                    relative_path: relative_asset_path(&file_name.to_string_lossy()),
                });
            }
        }
    }

    let stem = sanitize_stem(
        &source
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
    );
    // Keep the original extension spelling (lowercased) so `.jpeg` stays `.jpeg`.
    let name = write_unique(&assets, &stem, &ext, &bytes)?;
    Ok(ImportedImage {
        relative_path: relative_asset_path(&name),
    })
}

pub fn pasted_stem(now: chrono::NaiveDateTime) -> String {
    format!("pasted-{}", now.format("%Y%m%d-%H%M%S"))
}

pub fn import_image_bytes_impl(
    doc_path: &str,
    bytes_b64: &str,
    ext: &str,
    now: chrono::NaiveDateTime,
) -> Result<ImportedImage, AppError> {
    let dir = doc_dir(doc_path)?;
    let ext = normalize_image_ext(ext)?;
    let payload = bytes_b64
        .split_once(";base64,")
        .map(|(_, data)| data)
        .unwrap_or(bytes_b64)
        .trim();
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(payload)
        .map_err(|e| AppError::parse(format!("Invalid base64 image data: {e}")))?;
    validate_image(&ext, &bytes)?;
    let name = write_unique(&dir.join(ASSETS_DIR), &pasted_stem(now), &ext, &bytes)?;
    Ok(ImportedImage {
        relative_path: relative_asset_path(&name),
    })
}

/// Adds a folder (recursively) to the asset protocol scope so `convertFileSrc` URLs load.
pub fn allow_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>, dir: &Path) -> Result<(), AppError> {
    use tauri::Manager;
    if dir.as_os_str().is_empty() || !dir.is_dir() {
        return Err(AppError::invalid_path(format!(
            "Not a folder: {}",
            dir.display()
        )));
    }
    app.asset_protocol_scope()
        .allow_directory(dir, true)
        .map_err(|e| AppError::new(crate::error::ErrorKind::Io, e.to_string()))
}

/// Allows the folder containing `file_path`; errors are ignored (best effort).
pub fn allow_parent_dir<R: tauri::Runtime>(app: &tauri::AppHandle<R>, file_path: &str) {
    if let Some(parent) = Path::new(file_path).parent() {
        let _ = allow_dir(app, parent);
    }
}

#[tauri::command]
pub fn import_image(
    app: tauri::AppHandle,
    doc_path: String,
    source_path: String,
) -> Result<ImportedImage, AppError> {
    let result = import_image_impl(&doc_path, &source_path)?;
    allow_parent_dir(&app, &doc_path);
    Ok(result)
}

#[tauri::command]
pub fn import_image_bytes(
    app: tauri::AppHandle,
    doc_path: String,
    bytes: String,
    ext: String,
) -> Result<ImportedImage, AppError> {
    let now = chrono::Local::now().naive_local();
    let result = import_image_bytes_impl(&doc_path, &bytes, &ext, now)?;
    allow_parent_dir(&app, &doc_path);
    Ok(result)
}

/// Prefix of the error message returned when a folder is too broad to expose.
pub const TOO_BROAD_MESSAGE: &str = "Image root folder is too broad";

/// True when exposing `path` (recursively) would open too much of the disk:
/// the filesystem root, or the home folder itself or any of its ancestors
/// (`/`, `/Users`, `/Users/<me>`). Both paths should already be canonical.
pub fn is_too_broad(path: &Path, home: Option<&Path>) -> bool {
    if path.parent().is_none() {
        return true;
    }
    home.is_some_and(|h| h.starts_with(path))
}

fn canonical_home<R: tauri::Runtime>(app: &tauri::AppHandle<R>) -> Option<PathBuf> {
    use tauri::Manager;
    let home = app
        .path()
        .home_dir()
        .ok()
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("USERPROFILE").map(PathBuf::from))?;
    Some(crate::platform::canonicalize(&home).unwrap_or(home))
}

/// Checks a requested asset folder (e.g. an image root that may come from a
/// downloaded document's front matter) before it is allowed recursively.
pub fn check_asset_dir(path: &Path, home: Option<&Path>) -> Result<PathBuf, AppError> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(AppError::invalid_path(format!(
            "Image root folder must be absolute: {}",
            path.display()
        )));
    }
    let canonical = crate::platform::canonicalize(path)
        .map_err(|_| AppError::invalid_path(format!("Not a folder: {}", path.display())))?;
    if is_too_broad(&canonical, home) {
        return Err(AppError::invalid_path(format!(
            "{TOO_BROAD_MESSAGE}: {}",
            path.display()
        )));
    }
    Ok(canonical)
}

#[tauri::command]
pub fn allow_asset_dir(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    let p = Path::new(&path);
    if p.is_file() {
        // The document's own folder: unchanged behaviour.
        allow_parent_dir(&app, &path);
        return Ok(());
    }
    let home = canonical_home(&app);
    let canonical = check_asset_dir(p, home.as_deref())?;
    allow_dir(&app, &canonical)
}

/// Image types the editor may *display* (WebKit decodes all of these). Wider
/// than `ALLOWED_IMAGE_EXTS`, which limits what gets imported into `assets/`.
pub const DISPLAY_IMAGE_EXTS: &[&str] = &[
    "png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "ico", "avif", "tiff", "tif", "heic",
];

/// Checks a single image the editor wants to show from outside the folders
/// already in scope (e.g. `../images/pic.png`, #69). Symlinks are resolved
/// first, so the real target must be a regular file with an image extension.
/// Returns the canonical path.
pub fn check_asset_file(path: &Path) -> Result<PathBuf, AppError> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(AppError::invalid_path(format!(
            "Image path must be absolute: {}",
            path.display()
        )));
    }
    let canonical = crate::platform::canonicalize(path)
        .map_err(|_| AppError::not_found(format!("Image not found: {}", path.display())))?;
    if !canonical.is_file() {
        return Err(AppError::invalid_path(format!(
            "Not a file: {}",
            path.display()
        )));
    }
    let ext = canonical
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .unwrap_or_default();
    if !DISPLAY_IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(AppError::invalid_path(format!(
            "Not an image file: {}",
            path.display()
        )));
    }
    Ok(canonical)
}

/// Allows exactly one image file (not its folder) in the asset protocol scope.
#[tauri::command]
pub fn allow_asset_file(app: tauri::AppHandle, path: String) -> Result<(), AppError> {
    use tauri::Manager;
    let requested = Path::new(&path);
    let canonical = check_asset_file(requested)?;
    let scope = app.asset_protocol_scope();
    let to_err = |e: tauri::Error| AppError::new(crate::error::ErrorKind::Io, e.to_string());
    scope.allow_file(&canonical).map_err(to_err)?;
    // The WebView requests the path as written (it may go through a symlink or `..`).
    if requested != canonical {
        scope.allow_file(requested).map_err(to_err)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::ErrorKind;
    use tempfile::tempdir;

    #[test]
    fn too_broad_folders_are_rejected() {
        let home = Path::new("/Users/me");
        assert!(is_too_broad(Path::new("/"), Some(home)));
        assert!(is_too_broad(Path::new("/Users"), Some(home)));
        assert!(is_too_broad(Path::new("/Users/me"), Some(home)));
        assert!(!is_too_broad(Path::new("/Users/me/blog"), Some(home)));
        assert!(!is_too_broad(Path::new("/tmp/x"), Some(home)));
        assert!(!is_too_broad(Path::new("/Users/other"), Some(home)));
        // Without a known home only the filesystem root is refused.
        assert!(is_too_broad(Path::new("/"), None));
        assert!(!is_too_broad(Path::new("/Users"), None));
    }

    #[test]
    fn check_asset_dir_canonicalizes_before_judging() {
        let dir = tempdir().expect("tempdir");
        let home = crate::platform::canonicalize(dir.path()).unwrap();
        let blog = home.join("blog");
        fs::create_dir(&blog).unwrap();

        assert_eq!(check_asset_dir(&blog, Some(&home)).unwrap(), blog);
        // `blog/..` is the home folder itself once canonicalized.
        let err = check_asset_dir(&blog.join(".."), Some(&home)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
        assert!(err.message.starts_with(TOO_BROAD_MESSAGE));
        // The filesystem root (`/` on Unix, `C:\` on Windows) is always too broad.
        let fs_root = home.ancestors().last().expect("filesystem root");
        let err = check_asset_dir(fs_root, Some(&home)).unwrap_err();
        assert!(err.message.starts_with(TOO_BROAD_MESSAGE));
        // Missing folders are an InvalidPath error, not "too broad".
        let err = check_asset_dir(&home.join("missing"), Some(&home)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
        assert!(!err.message.starts_with(TOO_BROAD_MESSAGE));
        // Relative or empty folders are rejected without consulting cwd.
        let err = check_asset_dir(Path::new("relative/root"), Some(&home)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
        let err = check_asset_dir(Path::new(""), Some(&home)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
    }

    const PNG: &[u8] = &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13];
    const JPG: &[u8] = &[0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
    const GIF: &[u8] = b"GIF89a\x01\x00\x01\x00";
    const WEBP: &[u8] = b"RIFF\x24\x00\x00\x00WEBPVP8 ";
    const SVG: &[u8] = b"\n  <svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";

    fn setup() -> (tempfile::TempDir, String) {
        let dir = tempdir().expect("tempdir");
        let doc = dir.path().join("note.md");
        fs::write(&doc, "# note\n").unwrap();
        let doc_str = doc.to_str().unwrap().to_string();
        (dir, doc_str)
    }

    fn write_source(dir: &Path, name: &str, bytes: &[u8]) -> String {
        let src_dir = dir.join("incoming");
        fs::create_dir_all(&src_dir).unwrap();
        let p = src_dir.join(name);
        fs::write(&p, bytes).unwrap();
        p.to_str().unwrap().to_string()
    }

    #[test]
    fn copies_into_assets_and_returns_slash_relative_path() {
        let (dir, doc) = setup();
        let src = write_source(dir.path(), "cat.png", PNG);
        let out = import_image_impl(&doc, &src).expect("import");
        assert_eq!(out.relative_path, "assets/cat.png");
        assert_eq!(fs::read(dir.path().join("assets/cat.png")).unwrap(), PNG);
        // Source is untouched.
        assert!(Path::new(&src).exists());
    }

    #[test]
    fn name_collisions_get_numeric_suffixes() {
        let (dir, doc) = setup();
        let src = write_source(dir.path(), "cat.png", PNG);
        let a = import_image_impl(&doc, &src).unwrap();
        let b = import_image_impl(&doc, &src).unwrap();
        let c = import_image_impl(&doc, &src).unwrap();
        assert_eq!(a.relative_path, "assets/cat.png");
        assert_eq!(b.relative_path, "assets/cat-1.png");
        assert_eq!(c.relative_path, "assets/cat-2.png");
        for name in ["cat.png", "cat-1.png", "cat-2.png"] {
            assert!(dir.path().join("assets").join(name).is_file(), "{name}");
        }
    }

    #[test]
    fn spaces_are_percent_encoded_in_returned_path() {
        let (dir, doc) = setup();
        let src = write_source(dir.path(), "my photo (1).JPG", JPG);
        let out = import_image_impl(&doc, &src).unwrap();
        assert_eq!(out.relative_path, "assets/my%20photo%20%281%29.jpg");
        assert!(dir.path().join("assets/my photo (1).jpg").is_file());
    }

    #[test]
    fn accepts_all_supported_types() {
        let (dir, doc) = setup();
        for (name, bytes) in [
            ("a.png", PNG),
            ("b.jpg", JPG),
            ("c.jpeg", JPG),
            ("d.gif", GIF),
            ("e.webp", WEBP),
            ("f.svg", SVG),
        ] {
            let src = write_source(dir.path(), name, bytes);
            let out = import_image_impl(&doc, &src).unwrap_or_else(|e| panic!("{name}: {e}"));
            assert_eq!(out.relative_path, format!("assets/{name}"));
        }
    }

    #[test]
    fn rejects_unsupported_extension() {
        let (dir, doc) = setup();
        let src = write_source(dir.path(), "notes.txt", b"hello");
        let err = import_image_impl(&doc, &src).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
        let src = write_source(dir.path(), "noext", PNG);
        assert!(import_image_impl(&doc, &src).is_err());
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn rejects_mismatched_magic_bytes() {
        let (dir, doc) = setup();
        let fake = write_source(dir.path(), "fake.png", b"not really a png");
        let err = import_image_impl(&doc, &fake).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Parse);
        let jpg_as_png = write_source(dir.path(), "x.png", JPG);
        assert!(import_image_impl(&doc, &jpg_as_png).is_err());
        let bad_svg = write_source(dir.path(), "x.svg", b"#!/bin/sh\necho hi");
        assert!(import_image_impl(&doc, &bad_svg).is_err());
        assert!(!dir.path().join("assets").exists());
    }

    #[test]
    fn magic_bytes_table() {
        assert!(matches_magic_bytes("png", PNG));
        assert!(!matches_magic_bytes("png", GIF));
        assert!(matches_magic_bytes("jpeg", JPG));
        assert!(matches_magic_bytes("gif", GIF));
        assert!(matches_magic_bytes("webp", WEBP));
        assert!(!matches_magic_bytes("webp", b"RIFF\0\0\0\0WAVE"));
        assert!(matches_magic_bytes("svg", "\u{feff}<?xml version=\"1.0\"?><svg/>".as_bytes()));
        assert!(matches_magic_bytes("svg", b"<!-- c --><svg/>"));
        assert!(!matches_magic_bytes("svg", b"<html></html>"));
    }

    #[test]
    fn requires_saved_document() {
        let dir = tempdir().unwrap();
        let src = write_source(dir.path(), "a.png", PNG);
        let err = import_image_impl("", &src).unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
    }

    #[test]
    fn source_already_in_assets_is_not_copied_again() {
        let (dir, doc) = setup();
        let assets = dir.path().join("assets");
        fs::create_dir_all(&assets).unwrap();
        fs::write(assets.join("in place.png"), PNG).unwrap();
        let out = import_image_impl(&doc, assets.join("in place.png").to_str().unwrap()).unwrap();
        assert_eq!(out.relative_path, "assets/in%20place.png");
        assert_eq!(fs::read_dir(&assets).unwrap().count(), 1);
    }

    #[test]
    fn imports_pasted_bytes_with_timestamp_name() {
        let (dir, doc) = setup();
        let now = chrono::NaiveDate::from_ymd_opt(2026, 11, 19)
            .unwrap()
            .and_hms_opt(8, 5, 9)
            .unwrap();
        let b64 = base64::engine::general_purpose::STANDARD.encode(PNG);
        let a = import_image_bytes_impl(&doc, &b64, "png", now).unwrap();
        assert_eq!(a.relative_path, "assets/pasted-20261119-080509.png");
        let with_prefix = format!("data:image/png;base64,{b64}");
        let b = import_image_bytes_impl(&doc, &with_prefix, ".PNG", now).unwrap();
        assert_eq!(b.relative_path, "assets/pasted-20261119-080509-1.png");
        assert_eq!(
            fs::read(dir.path().join("assets/pasted-20261119-080509.png")).unwrap(),
            PNG
        );
    }

    #[test]
    fn pasted_bytes_are_validated() {
        let (_dir, doc) = setup();
        let now = chrono::NaiveDateTime::default();
        let b64 = base64::engine::general_purpose::STANDARD.encode(b"plain text");
        assert_eq!(
            import_image_bytes_impl(&doc, &b64, "png", now).unwrap_err().kind,
            ErrorKind::Parse
        );
        assert_eq!(
            import_image_bytes_impl(&doc, &b64, "bmp", now).unwrap_err().kind,
            ErrorKind::InvalidPath
        );
        assert_eq!(
            import_image_bytes_impl(&doc, "***", "png", now).unwrap_err().kind,
            ErrorKind::Parse
        );
    }

    fn asset_test_dir() -> tempfile::TempDir {
        let base = Path::new("/tmp/kalamos-test");
        fs::create_dir_all(base).unwrap();
        tempfile::Builder::new()
            .prefix("asset-file-")
            .tempdir_in(base)
            .unwrap()
    }

    #[test]
    fn asset_file_in_parent_folder_is_allowed() {
        let dir = asset_test_dir();
        let posts = dir.path().join("blog/_posts");
        let images = dir.path().join("blog/images");
        fs::create_dir_all(&posts).unwrap();
        fs::create_dir_all(&images).unwrap();
        fs::write(images.join("pic.png"), PNG).unwrap();
        fs::write(images.join("UPPER.JPG"), JPG).unwrap();
        let via_parent = posts.join("../images/pic.png");
        let got = check_asset_file(&via_parent).unwrap();
        assert_eq!(got, crate::platform::canonicalize(images.join("pic.png")).unwrap());
        assert!(check_asset_file(&posts.join("../images/UPPER.JPG")).is_ok());
    }

    #[test]
    fn asset_file_rejects_non_images_folders_and_missing() {
        let dir = asset_test_dir();
        let root = dir.path();
        fs::write(root.join("secret.txt"), b"nope").unwrap();
        fs::write(root.join("noext"), PNG).unwrap();
        fs::create_dir_all(root.join("folder.png")).unwrap();
        let kind = |p: &Path| check_asset_file(p).unwrap_err().kind;
        assert_eq!(kind(&root.join("secret.txt")), ErrorKind::InvalidPath);
        assert_eq!(kind(&root.join("noext")), ErrorKind::InvalidPath);
        assert_eq!(kind(&root.join("folder.png")), ErrorKind::InvalidPath);
        assert_eq!(kind(&root.join("missing.png")), ErrorKind::NotFound);
        assert_eq!(kind(Path::new("relative/pic.png")), ErrorKind::InvalidPath);
        assert_eq!(kind(Path::new("")), ErrorKind::InvalidPath);
    }

    #[cfg(unix)]
    #[test]
    fn asset_file_resolves_symlinks_before_checking() {
        let dir = asset_test_dir();
        let root = dir.path();
        fs::write(root.join("secret.txt"), b"nope").unwrap();
        fs::write(root.join("real.png"), PNG).unwrap();
        std::os::unix::fs::symlink(root.join("secret.txt"), root.join("disguised.png")).unwrap();
        std::os::unix::fs::symlink(root.join("real.png"), root.join("link.png")).unwrap();
        assert_eq!(
            check_asset_file(&root.join("disguised.png")).unwrap_err().kind,
            ErrorKind::InvalidPath
        );
        assert_eq!(
            check_asset_file(&root.join("link.png")).unwrap(),
            crate::platform::canonicalize(root.join("real.png")).unwrap()
        );
    }
}
