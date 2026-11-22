//! #67: files handed to Kalamos by the OS (Finder double-click, "Open With",
//! dropping on the Dock icon, `open -a Kalamos x.md`).
//!
//! macOS delivers them as `RunEvent::Opened { urls }`. On a cold launch that
//! event can arrive before the webview has loaded, so requests are queued here
//! until the frontend calls `take_pending_open_files`; after that they are
//! emitted straight away as `OPEN_FILES_EVENT`.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::{Emitter, Manager, Url};

/// Event the frontend listens to once it is ready.
pub const OPEN_FILES_EVENT: &str = "kalamos://open-files";

/// Extensions Kalamos accepts from the OS (same list as `bundle.fileAssociations`).
pub const MARKDOWN_EXTENSIONS: &[&str] =
    &["md", "markdown", "mdown", "mkd", "mkdn", "mdwn", "mdtxt"];

/// One batch of files the OS asked us to open.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilesRequest {
    /// Canonical paths of accepted Markdown files, in the order the OS gave them.
    pub paths: Vec<String>,
    /// Display names of what was refused (not file://, wrong extension, not a regular file).
    pub rejected: Vec<String>,
}

impl OpenFilesRequest {
    pub fn is_empty(&self) -> bool {
        self.paths.is_empty() && self.rejected.is_empty()
    }

    fn append(&mut self, other: OpenFilesRequest) {
        self.paths.extend(other.paths);
        self.rejected.extend(other.rejected);
    }
}

pub fn has_markdown_extension(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| {
            let lower = e.to_ascii_lowercase();
            MARKDOWN_EXTENSIONS.contains(&lower.as_str())
        })
        .unwrap_or(false)
}

/// file:// URL → canonical path of an existing regular Markdown file.
pub fn markdown_path_from_url(url: &Url) -> Option<PathBuf> {
    if url.scheme() != "file" {
        return None;
    }
    let path = url.to_file_path().ok()?;
    if !has_markdown_extension(&path) {
        return None;
    }
    let canonical = crate::platform::canonicalize(&path).ok()?;
    // canonicalize follows symlinks: re-check the real target.
    if !has_markdown_extension(&canonical) || !canonical.is_file() {
        return None;
    }
    Some(canonical)
}

fn display_name(url: &Url) -> String {
    if url.scheme() == "file" {
        if let Ok(path) = url.to_file_path() {
            if let Some(name) = path.file_name() {
                return name.to_string_lossy().into_owned();
            }
            return path.to_string_lossy().into_owned();
        }
    }
    url.as_str().to_string()
}

pub fn filter_urls(urls: &[Url]) -> OpenFilesRequest {
    let mut req = OpenFilesRequest::default();
    for url in urls {
        match markdown_path_from_url(url) {
            Some(path) => {
                let s = path.to_string_lossy().into_owned();
                if !req.paths.contains(&s) {
                    req.paths.push(s);
                }
            }
            None => req.rejected.push(display_name(url)),
        }
    }
    req
}

#[derive(Debug, Default)]
struct Inner {
    frontend_ready: bool,
    pending: OpenFilesRequest,
}

/// Queue for open requests that arrive before the frontend is listening.
#[derive(Debug, Default)]
pub struct PendingOpenFiles {
    inner: Mutex<Inner>,
}

impl PendingOpenFiles {
    pub fn new() -> Self {
        Self::default()
    }

    /// Queue `req` while the frontend is not ready; otherwise hand it back to be emitted.
    pub fn offer(&self, req: OpenFilesRequest) -> Option<OpenFilesRequest> {
        if req.is_empty() {
            return None;
        }
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if inner.frontend_ready {
            Some(req)
        } else {
            inner.pending.append(req);
            None
        }
    }

    /// Mark the frontend ready and drain everything queued so far.
    pub fn take(&self) -> OpenFilesRequest {
        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.frontend_ready = true;
        std::mem::take(&mut inner.pending)
    }
}

/// Handle a `RunEvent::Opened`: filter, then queue or emit.
pub fn handle_opened_urls<R: tauri::Runtime>(app: &tauri::AppHandle<R>, urls: &[Url]) {
    deliver(app, filter_urls(urls));
}

/// Windows / Linux: files handed to Kalamos on the command line (Explorer
/// double-click / "Open with", or forwarded from a second instance).
///
/// `args` starts with `argv[0]` (the executable); flags (`-...`) are skipped
/// and relative paths are resolved against `cwd`.
pub fn filter_cli_args(args: &[String], cwd: Option<&Path>) -> OpenFilesRequest {
    let mut urls = Vec::new();
    let mut req = OpenFilesRequest::default();
    let mut after_double_dash = false;
    for raw in args.iter().skip(1) {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        if !after_double_dash {
            if trimmed == "--" {
                after_double_dash = true;
                continue;
            }
            if trimmed.starts_with('-') {
                continue;
            }
        }
        if let Ok(u) = Url::parse(trimmed) {
            if u.scheme() == "file" {
                urls.push(u);
                continue;
            }
            // A Windows drive letter (`C:\...`) parses as scheme `c`: fall through.
            if u.scheme().len() > 1 {
                req.rejected.push(trimmed.to_string());
                continue;
            }
        }
        let p = Path::new(trimmed);
        let full = if p.is_absolute() {
            p.to_path_buf()
        } else if let Some(base) = cwd {
            base.join(p)
        } else {
            std::env::current_dir()
                .map(|c| c.join(p))
                .unwrap_or_else(|_| p.to_path_buf())
        };
        match Url::from_file_path(&full) {
            Ok(u) => urls.push(u),
            Err(()) => req.rejected.push(
                p.file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_else(|| trimmed.to_string()),
            ),
        }
    }
    let mut from_urls = filter_urls(&urls);
    from_urls.append(req);
    from_urls
}

/// Handle command-line arguments (cold launch or single-instance callback).
pub fn handle_cli_args<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    args: &[String],
    cwd: Option<&Path>,
) {
    deliver(app, filter_cli_args(args, cwd));
}

fn deliver<R: tauri::Runtime>(app: &tauri::AppHandle<R>, req: OpenFilesRequest) {
    let state = app.state::<PendingOpenFiles>();
    if let Some(ready) = state.offer(req) {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
        let _ = app.emit(OPEN_FILES_EVENT, ready);
    } else if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

/// Called by the frontend once its `OPEN_FILES_EVENT` listener is in place.
#[tauri::command]
pub fn take_pending_open_files(state: tauri::State<'_, PendingOpenFiles>) -> OpenFilesRequest {
    state.take()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn file_url(path: &Path) -> Url {
        Url::from_file_path(path).expect("file url")
    }

    #[test]
    fn accepts_whitelisted_extensions_case_insensitively() {
        let dir = tempdir().unwrap();
        let mut urls = Vec::new();
        for name in [
            "a.md",
            "b.markdown",
            "c.mdown",
            "d.mkd",
            "e.mkdn",
            "f.mdwn",
            "g.mdtxt",
            "H.MD",
        ] {
            let p = dir.path().join(name);
            fs::write(&p, "# x").unwrap();
            urls.push(file_url(&p));
        }
        let req = filter_urls(&urls);
        assert_eq!(req.paths.len(), 8);
        assert!(req.rejected.is_empty());
        let canonical_dir = crate::platform::canonicalize(dir.path()).unwrap();
        assert!(req
            .paths
            .iter()
            .all(|p| Path::new(p).starts_with(&canonical_dir)));
    }

    #[test]
    fn rejects_other_extensions_dirs_missing_and_non_file_urls() {
        let dir = tempdir().unwrap();
        let txt = dir.path().join("notes.txt");
        fs::write(&txt, "x").unwrap();
        let no_ext = dir.path().join("README");
        fs::write(&no_ext, "x").unwrap();
        let folder = dir.path().join("folder.md");
        fs::create_dir(&folder).unwrap();
        let missing = dir.path().join("missing.md");
        let urls = vec![
            file_url(&txt),
            file_url(&no_ext),
            file_url(&folder),
            file_url(&missing),
            Url::parse("https://example.com/a.md").unwrap(),
            Url::parse("kalamos://open/a.md").unwrap(),
        ];
        let req = filter_urls(&urls);
        assert!(req.paths.is_empty());
        assert_eq!(req.rejected.len(), 6);
        assert_eq!(req.rejected[0], "notes.txt");
        assert_eq!(req.rejected[4], "https://example.com/a.md");
    }

    #[test]
    fn canonicalizes_and_dedupes() {
        let dir = tempdir().unwrap();
        let sub = dir.path().join("sub");
        fs::create_dir(&sub).unwrap();
        let p = dir.path().join("a.md");
        fs::write(&p, "# a").unwrap();
        let dotted = sub.join("..").join("a.md");
        let req = filter_urls(&[file_url(&p), file_url(&dotted)]);
        assert_eq!(
            req.paths,
            vec![crate::platform::canonicalize(&p).unwrap().to_string_lossy().into_owned()]
        );
    }

    #[cfg(unix)]
    #[test]
    fn symlink_to_non_markdown_target_is_rejected() {
        let dir = tempdir().unwrap();
        let target = dir.path().join("secret.txt");
        fs::write(&target, "x").unwrap();
        let link = dir.path().join("link.md");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        let req = filter_urls(&[file_url(&link)]);
        assert!(req.paths.is_empty());
        assert_eq!(req.rejected, vec!["link.md".to_string()]);
    }

    #[test]
    fn queues_until_frontend_takes_then_passes_through() {
        let q = PendingOpenFiles::new();
        let first = OpenFilesRequest {
            paths: vec!["/tmp/kalamos-test/a.md".into()],
            rejected: vec![],
        };
        let second = OpenFilesRequest {
            paths: vec!["/tmp/kalamos-test/b.md".into()],
            rejected: vec!["c.txt".into()],
        };
        assert_eq!(q.offer(first), None);
        assert_eq!(q.offer(second), None);
        assert_eq!(q.offer(OpenFilesRequest::default()), None);

        let taken = q.take();
        assert_eq!(
            taken.paths,
            vec!["/tmp/kalamos-test/a.md", "/tmp/kalamos-test/b.md"]
        );
        assert_eq!(taken.rejected, vec!["c.txt"]);

        // Ready now: nothing is queued, requests come back to be emitted.
        let later = OpenFilesRequest {
            paths: vec!["/tmp/kalamos-test/d.md".into()],
            rejected: vec![],
        };
        assert_eq!(q.offer(later.clone()), Some(later));
        assert!(q.take().is_empty());
        assert_eq!(q.offer(OpenFilesRequest::default()), None);
    }

    #[test]
    fn cli_args_accept_paths_and_file_urls_and_skip_flags() {
        let dir = tempdir().unwrap();
        let md = dir.path().join("note.md");
        let txt = dir.path().join("other.txt");
        fs::write(&md, "# hi").unwrap();
        fs::write(&txt, "x").unwrap();
        let args = vec![
            "kalamos.exe".to_string(),
            "--some-flag".to_string(),
            "note.md".to_string(),
            txt.to_string_lossy().into_owned(),
            file_url(&md).to_string(),
        ];
        let req = filter_cli_args(&args, Some(dir.path()));
        assert_eq!(
            req.paths,
            vec![crate::platform::canonicalize(&md).unwrap().to_string_lossy().into_owned()]
        );
        assert_eq!(req.rejected, vec!["other.txt".to_string()]);
    }
}
