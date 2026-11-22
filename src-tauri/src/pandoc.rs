//! EX-02 / EX-03: export to other formats and import through Pandoc.
//!
//! Pandoc is an external tool; it is detected at runtime (PATH plus the
//! Homebrew folders, since GUI apps on macOS do not inherit the shell PATH).
//! It is always run with an argument vector (never through a shell), the
//! Markdown goes in on stdin, output is written to a temp file next to the
//! target and renamed into place, and every run is killed after a timeout.

use std::ffi::OsString;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, ErrorKind};
use crate::files::FileMeta;

/// A conversion must finish within this time; the child is killed otherwise.
pub const PANDOC_TIMEOUT: Duration = Duration::from_secs(120);
/// `pandoc --version` must answer within this time.
const VERSION_TIMEOUT: Duration = Duration::from_secs(10);
// Extra folders searched after PATH: see `platform::extra_search_dirs`
// (Homebrew on macOS; Pandoc / winget / Scoop / Chocolatey folders on Windows).
/// Markdown dialect Kalamos documents are written in.
pub const MARKDOWN_READER: &str =
    "markdown+tex_math_dollars+footnotes+yaml_metadata_block+pipe_tables+task_lists";
/// Markdown dialect produced on import. `gfm` enables `tex_math_gfm` by
/// default (math as $`…`$ / ```math), which Kalamos does not read; turn it off
/// so math comes out as `$…$` / `$$…$$` (#48).
pub const MARKDOWN_WRITER: &str = "gfm-tex_math_gfm+tex_math_dollars+footnotes";
#[cfg(not(target_os = "windows"))]
pub const PANDOC_MISSING_MESSAGE: &str = "找不到 Pandoc：請先安裝（brew install pandoc）";
#[cfg(target_os = "windows")]
pub const PANDOC_MISSING_MESSAGE: &str =
    "找不到 Pandoc：請先安裝（winget install JohnMacFarlane.Pandoc，或至 pandoc.org 下載安裝程式）";
pub const PANDOC_TOO_OLD_FOR_IMPORT_MESSAGE: &str = "Pandoc 版本過舊，匯入需要 2.15 以上";
/// First pandoc release with `--sandbox` (imports run sandboxed).
pub const MIN_SANDBOX_VERSION: (u32, u32, u32) = (2, 15, 0);
const STDERR_TAIL_CHARS: usize = 600;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static STATUS_CACHE: Mutex<Option<PandocStatus>> = Mutex::new(None);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PandocStatus {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    pub markdown: String,
    /// Folder the embedded images were extracted to (absolute paths in `markdown`), if any.
    pub media_dir: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Docx,
    Odt,
    Latex,
    Mediawiki,
    Epub,
}

impl ExportFormat {
    pub fn parse(value: &str) -> Result<Self, AppError> {
        match value.trim().to_ascii_lowercase().as_str() {
            "docx" => Ok(Self::Docx),
            "odt" => Ok(Self::Odt),
            "latex" | "tex" => Ok(Self::Latex),
            "mediawiki" | "wiki" => Ok(Self::Mediawiki),
            "epub" => Ok(Self::Epub),
            other => Err(AppError::invalid_path(format!("不支援的匯出格式：{other}"))),
        }
    }

    /// Pandoc writer name.
    pub fn writer(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Odt => "odt",
            Self::Latex => "latex",
            Self::Mediawiki => "mediawiki",
            Self::Epub => "epub3",
        }
    }

    pub fn extension(self) -> &'static str {
        match self {
            Self::Docx => "docx",
            Self::Odt => "odt",
            Self::Latex => "tex",
            Self::Mediawiki => "wiki",
            Self::Epub => "epub",
        }
    }
}

/// Pandoc reader for an importable file, chosen from its extension.
pub fn reader_for_path(path: &Path) -> Result<&'static str, AppError> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "docx" => Ok("docx"),
        "odt" => Ok("odt"),
        "epub" => Ok("epub"),
        "tex" | "latex" => Ok("latex"),
        "html" | "htm" => Ok("html"),
        "wiki" | "mediawiki" => Ok("mediawiki"),
        _ => Err(AppError::invalid_path(format!(
            "不支援匯入的檔案類型：.{ext}（支援 docx、odt、epub、tex、html、wiki）"
        ))),
    }
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/// First executable `pandoc` (`pandoc.exe` on Windows) in `path_env`
/// (PATH-style list), then `extra_dirs`.
pub fn find_pandoc(path_env: Option<OsString>, extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    crate::platform::find_executable("pandoc", path_env, extra_dirs)
}

/// Detects pandoc at `path` and reads its version (first line of `--version`).
pub fn status_for(path: Option<PathBuf>) -> PandocStatus {
    let Some(path) = path else {
        return PandocStatus {
            available: false,
            path: None,
            version: None,
        };
    };
    let version = run_pandoc(&path, &[OsString::from("--version")], None, VERSION_TIMEOUT)
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| {
            String::from_utf8_lossy(&out.stdout)
                .lines()
                .next()
                .map(|l| l.trim().trim_start_matches("pandoc").trim().to_string())
        })
        .filter(|v| !v.is_empty());
    PandocStatus {
        available: true,
        path: Some(path.to_string_lossy().into_owned()),
        version,
    }
}

/// Leading `major.minor[.patch…]` of a version string ("3.1.11 (mock)" → (3, 1, 11)).
pub fn parse_version(text: &str) -> Option<(u32, u32, u32)> {
    let text = text.trim().trim_start_matches("pandoc").trim();
    let numeric: String = text
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let mut parts = numeric.split('.').filter(|p| !p.is_empty());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let patch = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    Some((major, minor, patch))
}

/// `--sandbox` needs pandoc ≥ 2.15; an unknown version is treated as too old.
pub fn supports_sandbox(version: Option<&str>) -> bool {
    version
        .and_then(parse_version)
        .is_some_and(|v| v >= MIN_SANDBOX_VERSION)
}

fn detect() -> PandocStatus {
    let extra = crate::platform::extra_search_dirs();
    status_for(find_pandoc(std::env::var_os("PATH"), &extra))
}

/// Cached detection; `recheck` forces a new lookup (e.g. after installing pandoc).
pub fn cached_status(recheck: bool) -> PandocStatus {
    let mut cache = STATUS_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    if recheck || cache.is_none() {
        *cache = Some(detect());
    }
    cache.clone().unwrap_or_else(detect)
}

/// Path and version of the installed pandoc.
fn require_pandoc() -> Result<(PathBuf, Option<String>), AppError> {
    // Re-detect when the cached answer is "missing", so installing pandoc
    // while the app is open works without a restart.
    let mut status = cached_status(false);
    if !status.available {
        status = cached_status(true);
    }
    let version = status.version.clone();
    status
        .path
        .filter(|_| status.available)
        .map(|p| (PathBuf::from(p), version))
        .ok_or_else(|| AppError::not_found(PANDOC_MISSING_MESSAGE))
}

// ---------------------------------------------------------------------------
// Running pandoc
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub struct RunOutput {
    pub status: ExitStatus,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
}

fn spawn_reader<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = reader.read_to_end(&mut buf);
        buf
    })
}

/// Runs `pandoc args…` (no shell), feeding `stdin`; kills it after `timeout`.
pub fn run_pandoc(
    pandoc: &Path,
    args: &[OsString],
    stdin: Option<&str>,
    timeout: Duration,
) -> Result<RunOutput, AppError> {
    let spawn = || {
        let mut cmd = Command::new(pandoc);
        crate::platform::no_console(&mut cmd)
            .args(args)
            .stdin(if stdin.is_some() {
                Stdio::piped()
            } else {
                Stdio::null()
            })
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    };
    // ETXTBSY (26): the binary was just written (e.g. by an installer) and is
    // briefly still open for writing in another process; retry a few times.
    let mut attempt = spawn();
    for _ in 0..5 {
        match &attempt {
            Err(e) if e.raw_os_error() == Some(26) => {
                thread::sleep(Duration::from_millis(50));
                attempt = spawn();
            }
            _ => break,
        }
    }
    let mut child = attempt
        .map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AppError::not_found(PANDOC_MISSING_MESSAGE)
            } else {
                AppError::new(ErrorKind::Io, format!("無法執行 Pandoc：{e}"))
            }
        })?;

    let writer = match (stdin, child.stdin.take()) {
        (Some(text), Some(mut pipe)) => {
            let bytes = text.as_bytes().to_vec();
            Some(thread::spawn(move || {
                // A child that exits early closes the pipe; ignore EPIPE.
                let _ = pipe.write_all(&bytes);
            }))
        }
        _ => None,
    };
    let out_reader = child.stdout.take().map(spawn_reader);
    let err_reader = child.stderr.take().map(spawn_reader);

    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    // Reader threads finish once the pipes close; do not
                    // block on them here.
                    return Err(AppError::new(
                        ErrorKind::Io,
                        format!("Pandoc 逾時（超過 {} 秒），已中止", timeout.as_secs()),
                    ));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(AppError::new(ErrorKind::Io, e.to_string())),
        }
    };
    if let Some(w) = writer {
        let _ = w.join();
    }
    let stdout = out_reader.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = err_reader.and_then(|h| h.join().ok()).unwrap_or_default();
    Ok(RunOutput {
        status,
        stdout,
        stderr,
    })
}

/// Last part of stderr, for error messages.
pub fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let trimmed = text.trim();
    let count = trimmed.chars().count();
    if count <= STDERR_TAIL_CHARS {
        return trimmed.to_string();
    }
    let tail: String = trimmed.chars().skip(count - STDERR_TAIL_CHARS).collect();
    format!("…{tail}")
}

fn check_exit(out: &RunOutput) -> Result<(), AppError> {
    if out.status.success() {
        return Ok(());
    }
    let code = out
        .status
        .code()
        .map(|c| c.to_string())
        .unwrap_or_else(|| "signal".to_string());
    let tail = stderr_tail(&out.stderr);
    Err(AppError::new(
        ErrorKind::Io,
        if tail.is_empty() {
            format!("Pandoc 執行失敗（exit {code}）")
        } else {
            format!("Pandoc 執行失敗（exit {code}）：{tail}")
        },
    ))
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub doc_path: Option<String>,
    pub markdown: String,
    pub format: String,
    pub out_path: String,
    /// IM-04 image root, searched after the document folder.
    #[serde(default)]
    pub image_root: Option<String>,
    /// Add a table of contents (the document had a `[TOC]` line).
    #[serde(default)]
    pub toc: bool,
}

fn temp_sibling(target: &Path) -> PathBuf {
    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("export");
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("out");
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    // Keep the real extension last: pandoc infers nothing from it (-t is
    // explicit), but tools inspecting the temp file expect it.
    parent.join(format!(
        ".{name}.kalamos-pandoc-{}-{nanos}-{seq}.{ext}",
        std::process::id()
    ))
}

fn validate_out_path(out_path: &str) -> Result<PathBuf, AppError> {
    if out_path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let target = PathBuf::from(out_path);
    if target.is_dir() {
        return Err(AppError::invalid_path("Target path is a directory"));
    }
    let parent = match target.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    if !parent.is_dir() {
        return Err(AppError::not_found(format!(
            "Parent directory does not exist: {}",
            parent.display()
        )));
    }
    Ok(target)
}

/// Folders pandoc searches for relative images: the document folder, then the image root.
pub fn resource_dirs(doc_path: Option<&str>, image_root: Option<&str>) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(dir) = doc_path
        .filter(|p| !p.trim().is_empty())
        .and_then(|p| Path::new(p).parent())
        .filter(|p| !p.as_os_str().is_empty())
    {
        dirs.push(dir.to_path_buf());
    }
    if let Some(root) = image_root.map(str::trim).filter(|r| !r.is_empty()) {
        let root = PathBuf::from(root);
        if !dirs.contains(&root) {
            dirs.push(root);
        }
    }
    dirs
}

/// Argument vector for an export (output goes to `temp_out`).
pub fn export_args(
    format: ExportFormat,
    resource_dirs: &[PathBuf],
    toc: bool,
    temp_out: &Path,
) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec![
        "-f".into(),
        MARKDOWN_READER.into(),
        "-t".into(),
        format.writer().into(),
    ];
    if !resource_dirs.is_empty() {
        let joined = std::env::join_paths(resource_dirs)
            .unwrap_or_else(|_| resource_dirs[0].clone().into_os_string());
        let mut arg = OsString::from("--resource-path=");
        arg.push(joined);
        args.push(arg);
    }
    if matches!(format, ExportFormat::Latex | ExportFormat::Mediawiki) {
        args.push("--standalone".into());
    }
    if toc {
        args.push("--toc".into());
    }
    args.push("-o".into());
    args.push(temp_out.as_os_str().to_owned());
    args
}

fn file_meta(path: &Path) -> Result<FileMeta, AppError> {
    let meta = fs::metadata(path)?;
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok(FileMeta {
        path: path.to_string_lossy().into_owned(),
        mtime_ms,
        size: meta.len(),
    })
}

/// Export with an explicit pandoc binary (used by the command and by tests).
pub fn export_with(
    pandoc: &Path,
    req: &ExportRequest,
    timeout: Duration,
) -> Result<FileMeta, AppError> {
    let format = ExportFormat::parse(&req.format)?;
    let target = validate_out_path(&req.out_path)?;
    let temp = temp_sibling(&target);
    let dirs = resource_dirs(req.doc_path.as_deref(), req.image_root.as_deref());
    let args = export_args(format, &dirs, req.toc, &temp);
    let result = run_pandoc(pandoc, &args, Some(&req.markdown), timeout).and_then(|out| {
        check_exit(&out)?;
        if !temp.is_file() {
            return Err(AppError::new(ErrorKind::Io, "Pandoc 沒有產生輸出檔"));
        }
        fs::rename(&temp, &target)?;
        file_meta(&target)
    });
    if result.is_err() {
        let _ = fs::remove_file(&temp);
    }
    result
}

#[tauri::command]
pub async fn export_pandoc(
    doc_path: Option<String>,
    markdown: String,
    format: String,
    out_path: String,
    image_root: Option<String>,
    toc: Option<bool>,
) -> Result<FileMeta, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        let (pandoc, _version) = require_pandoc()?;
        let req = ExportRequest {
            doc_path,
            markdown,
            format,
            out_path,
            image_root,
            toc: toc.unwrap_or(false),
        };
        export_with(&pandoc, &req, PANDOC_TIMEOUT)
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// File name of the import Lua filter inside the per-import temp folder.
pub const IMPORT_FILTER_NAME: &str = "kalamos-import.lua";

/// Import Lua filter (#48). Word / ODT / EPUB images carry a size and often a
/// caption, which GFM cannot express, so pandoc would fall back to raw HTML
/// (`<figure><img …><figcaption>`). This turns every Figure into a plain
/// paragraph of images (caption text as alt) and drops image attributes, so
/// the result is `![alt](path)`. Other raw HTML (`<u>`, `<sub>`…) is untouched.
pub const IMPORT_LUA_FILTER: &str = r#"-- Kalamos import filter (#48): figures become plain images, image sizes dropped.
local function plain(img)
  img.attr = pandoc.Attr()
  return img
end

function Image(img)
  return plain(img)
end

function Figure(fig)
  local caption = pandoc.utils.stringify(fig.caption.long or {})
  local images = {}
  fig:walk({
    Image = function(img)
      table.insert(images, img)
    end,
  })
  if #images == 0 then
    return nil
  end
  local inlines = {}
  for i, img in ipairs(images) do
    img = plain(img)
    if caption ~= "" then
      img.caption = pandoc.Inlines(caption)
    end
    if i > 1 then
      table.insert(inlines, pandoc.Space())
    end
    table.insert(inlines, img)
  end
  return pandoc.Para(inlines)
end"#;

/// Argument vector for an import (Markdown on stdout, media into `media_dir`).
///
/// Imported files come from outside (downloads), so pandoc runs with
/// `--sandbox`: it may not read other local files (`\input`, `<img src=/…>`,
/// …) into the result or the extracted media. Exports are not sandboxed
/// because they must read the document's images. The Lua filter is our own
/// file (written by `import_with`), not part of the imported document.
pub fn import_args(source: &Path, reader: &str, media_dir: &Path, filter: &Path) -> Vec<OsString> {
    let mut extract = OsString::from("--extract-media=");
    extract.push(media_dir.as_os_str());
    let mut lua = OsString::from("--lua-filter=");
    lua.push(filter.as_os_str());
    vec![
        "--sandbox".into(),
        "-f".into(),
        reader.into(),
        "-t".into(),
        MARKDOWN_WRITER.into(),
        "--wrap=none".into(),
        lua,
        extract,
        // `--` so a file name starting with `-` is never read as an option.
        "--".into(),
        source.as_os_str().to_owned(),
    ]
}

/// Post-processing of imported Markdown: drop zero-width spaces (U+200B), which
/// Word documents scatter around math and which would otherwise be invisible
/// noise in the file.
pub fn clean_imported_markdown(markdown: &str) -> String {
    markdown.replace('\u{200B}', "")
}

fn new_media_dir(base: &Path, source: &Path) -> PathBuf {
    let stem = source
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|s| {
            s.chars()
                .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
                .take(40)
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "import".to_string());
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let seq = TEMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    base.join(format!(
        "kalamos-import-{stem}-{}-{nanos}-{seq}",
        std::process::id()
    ))
}

/// Import with an explicit pandoc binary (`version` from `pandoc --version`);
/// media goes under `temp_base`. Refused when pandoc is too old for `--sandbox`.
pub fn import_with(
    pandoc: &Path,
    version: Option<&str>,
    source: &Path,
    temp_base: &Path,
    timeout: Duration,
) -> Result<ImportResult, AppError> {
    let reader = reader_for_path(source)?;
    if !supports_sandbox(version) {
        return Err(AppError::new(ErrorKind::Io, PANDOC_TOO_OLD_FOR_IMPORT_MESSAGE));
    }
    if !source.is_file() {
        return Err(AppError::not_found(format!(
            "File does not exist: {}",
            source.display()
        )));
    }
    // One temp folder per import: the Lua filter, and the extracted media.
    let work_dir = new_media_dir(temp_base, source);
    fs::create_dir_all(&work_dir)?;
    let filter = work_dir.join(IMPORT_FILTER_NAME);
    let result = fs::write(&filter, IMPORT_LUA_FILTER)
        .map_err(AppError::from)
        .and_then(|_| {
            let args = import_args(source, reader, &work_dir, &filter);
            let out = run_pandoc(pandoc, &args, None, timeout)?;
            check_exit(&out)?;
            String::from_utf8(out.stdout).map_err(|_| AppError::parse("Pandoc 輸出不是 UTF-8"))
        });
    let _ = fs::remove_file(&filter);
    let markdown = match result {
        Ok(markdown) => clean_imported_markdown(&markdown),
        Err(err) => {
            let _ = fs::remove_dir_all(&work_dir);
            return Err(err);
        }
    };
    // Keep the folder only when pandoc extracted something into it.
    let has_media = fs::read_dir(&work_dir)
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    if !has_media {
        let _ = fs::remove_dir(&work_dir);
    }
    #[cfg(target_os = "windows")]
    let markdown = if has_media {
        slash_media_paths(&markdown, &work_dir)
    } else {
        markdown
    };
    Ok(ImportResult {
        markdown,
        media_dir: has_media.then(|| work_dir.to_string_lossy().into_owned()),
    })
}

/// Windows: pandoc writes the extracted media paths with backslashes
/// (`C:\Temp\kalamos-import-…\media\image1.png`).
/// Rewrite them with forward slashes so they are plain Markdown destinations
/// (a backslash may escape the next character) that the editor resolves.
#[cfg(any(target_os = "windows", test))]
pub fn slash_media_paths(markdown: &str, work_dir: &Path) -> String {
    let native = work_dir.to_string_lossy().into_owned();
    if !native.contains('\\') {
        return markdown.to_string();
    }
    let slashed = native.replace('\\', "/");
    let mut out = String::with_capacity(markdown.len());
    let mut rest = markdown;
    while let Some(idx) = rest.find(&native) {
        out.push_str(&rest[..idx]);
        out.push_str(&slashed);
        let after = &rest[idx + native.len()..];
        let end = after
            .find(|c: char| {
                c.is_whitespace() || matches!(c, ')' | '"' | '\'' | '>' | '<' | ']' | '}')
            })
            .unwrap_or(after.len());
        out.push_str(&after[..end].replace('\\', "/"));
        rest = &after[end..];
    }
    out.push_str(rest);
    out
}

#[tauri::command]
pub async fn import_pandoc(path: String) -> Result<ImportResult, AppError> {
    tauri::async_runtime::spawn_blocking(move || {
        if path.trim().is_empty() {
            return Err(AppError::invalid_path("Path must not be empty"));
        }
        let source = PathBuf::from(&path);
        // Validate the extension before looking for pandoc, for a clearer error.
        reader_for_path(&source)?;
        let (pandoc, version) = require_pandoc()?;
        import_with(
            &pandoc,
            version.as_deref(),
            &source,
            &std::env::temp_dir(),
            PANDOC_TIMEOUT,
        )
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
}

#[tauri::command]
pub async fn pandoc_status(recheck: Option<bool>) -> Result<PandocStatus, AppError> {
    tauri::async_runtime::spawn_blocking(move || Ok(cached_status(recheck.unwrap_or(false))))
        .await
        .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    /// Writes an executable fake `pandoc` script into `dir`.
    fn fake_pandoc(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("pandoc");
        fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// Fake pandoc that records argv (one per line) and stdin, then writes
    /// "converted" to the path after `-o`.
    const RECORDING: &str = r#"
dir=$(dirname "$0")
: > "$dir/argv.txt"
for a in "$@"; do printf '%s\n' "$a" >> "$dir/argv.txt"; done
cat > "$dir/stdin.txt"
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-o" ]; then out="$a"; fi
  prev="$a"
done
[ -n "$out" ] && printf 'converted' > "$out"
exit 0
"#;

    fn argv(dir: &Path) -> Vec<String> {
        fs::read_to_string(dir.join("argv.txt"))
            .unwrap()
            .lines()
            .map(str::to_string)
            .collect()
    }

    fn request(out: &Path, format: &str) -> ExportRequest {
        ExportRequest {
            doc_path: Some("/tmp/kalamos-test/notes/doc.md".to_string()),
            markdown: "# 標題\n\n- a\n\n| a | b |\n|---|---|\n| 1 | 2 |\n".to_string(),
            format: format.to_string(),
            out_path: out.to_string_lossy().into_owned(),
            image_root: None,
            toc: false,
        }
    }

    #[test]
    fn format_parsing_and_writers() {
        assert_eq!(ExportFormat::parse("DOCX").unwrap(), ExportFormat::Docx);
        assert_eq!(ExportFormat::parse("latex").unwrap().writer(), "latex");
        assert_eq!(ExportFormat::parse("epub").unwrap().writer(), "epub3");
        assert_eq!(ExportFormat::parse("mediawiki").unwrap().extension(), "wiki");
        let err = ExportFormat::parse("pdf; rm -rf /").unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
    }

    #[test]
    fn extension_to_reader_mapping() {
        let r = |p: &str| reader_for_path(Path::new(p));
        assert_eq!(r("/tmp/kalamos-test/a.docx").unwrap(), "docx");
        assert_eq!(r("/tmp/kalamos-test/a.ODT").unwrap(), "odt");
        assert_eq!(r("/tmp/kalamos-test/a.epub").unwrap(), "epub");
        assert_eq!(r("/tmp/kalamos-test/a.tex").unwrap(), "latex");
        assert_eq!(r("/tmp/kalamos-test/a.htm").unwrap(), "html");
        assert_eq!(r("/tmp/kalamos-test/a.html").unwrap(), "html");
        assert_eq!(r("/tmp/kalamos-test/a.wiki").unwrap(), "mediawiki");
        assert_eq!(r("/tmp/kalamos-test/a.mediawiki").unwrap(), "mediawiki");
        assert_eq!(r("/tmp/kalamos-test/a.pdf").unwrap_err().kind, ErrorKind::InvalidPath);
        assert!(r("/tmp/kalamos-test/noext").is_err());
    }

    #[test]
    fn export_args_per_format_are_a_plain_vector() {
        let dirs = vec![PathBuf::from("/tmp/kalamos-test/notes")];
        let out = Path::new("/tmp/kalamos-test/notes/.doc.tmp.docx");
        for (fmt, writer, standalone) in [
            (ExportFormat::Docx, "docx", false),
            (ExportFormat::Odt, "odt", false),
            (ExportFormat::Latex, "latex", true),
            (ExportFormat::Mediawiki, "mediawiki", true),
            (ExportFormat::Epub, "epub3", false),
        ] {
            let args: Vec<String> = export_args(fmt, &dirs, false, out)
                .into_iter()
                .map(|a| a.into_string().unwrap())
                .collect();
            assert_eq!(&args[0..4], &["-f", MARKDOWN_READER, "-t", writer]);
            assert!(args.contains(&"--resource-path=/tmp/kalamos-test/notes".to_string()));
            assert_eq!(args.contains(&"--standalone".to_string()), standalone, "{writer}");
            assert!(!args.contains(&"--toc".to_string()));
            assert_eq!(&args[args.len() - 2..], &["-o", out.to_str().unwrap()]);
        }
        let with_toc = export_args(ExportFormat::Docx, &[], true, out);
        assert!(with_toc.iter().any(|a| a == "--toc"));
        assert!(!with_toc.iter().any(|a| a.to_string_lossy().starts_with("--resource-path")));
    }

    #[test]
    fn resource_path_includes_doc_dir_and_image_root() {
        let dirs = resource_dirs(Some("/tmp/kalamos-test/notes/doc.md"), Some("/tmp/kalamos-test/blog"));
        assert_eq!(
            dirs,
            vec![PathBuf::from("/tmp/kalamos-test/notes"), PathBuf::from("/tmp/kalamos-test/blog")]
        );
        assert!(resource_dirs(None, None).is_empty());
        assert_eq!(resource_dirs(None, Some("  ")), Vec::<PathBuf>::new());
        let args = export_args(ExportFormat::Odt, &dirs, false, Path::new("/tmp/kalamos-test/o.odt"));
        assert!(args
            .iter()
            .any(|a| a == "--resource-path=/tmp/kalamos-test/notes:/tmp/kalamos-test/blog"));
    }

    #[test]
    fn export_runs_pandoc_without_a_shell_and_renames_atomically() {
        let dir = tempdir().unwrap();
        let pandoc = fake_pandoc(dir.path(), RECORDING);
        let out_dir = dir.path().join("out dir");
        fs::create_dir(&out_dir).unwrap();
        let target = out_dir.join("報告 $(touch pwned).docx");
        fs::write(&target, "old").unwrap();
        let mut req = request(&target, "docx");
        req.image_root = Some("/tmp/kalamos-test/blog".to_string());
        req.toc = true;

        let meta = export_with(&pandoc, &req, Duration::from_secs(10)).unwrap();
        assert_eq!(meta.path, target.to_string_lossy());
        assert_eq!(fs::read_to_string(&target).unwrap(), "converted");
        assert_eq!(fs::read_to_string(dir.path().join("stdin.txt")).unwrap(), req.markdown);
        let args = argv(dir.path());
        assert!(args.contains(&"--toc".to_string()));
        assert!(args.contains(
            &"--resource-path=/tmp/kalamos-test/notes:/tmp/kalamos-test/blog".to_string()
        ));
        // The temp file was written next to the target, then renamed away.
        let o = args.iter().position(|a| a == "-o").unwrap();
        let temp = PathBuf::from(&args[o + 1]);
        assert_eq!(temp.parent().unwrap(), out_dir);
        assert!(!temp.exists());
        // No shell: the `$(...)` in the name was never executed.
        assert!(!out_dir.join("pwned").exists());
        assert!(!dir.path().join("pwned").exists());
        assert_eq!(fs::read_dir(&out_dir).unwrap().count(), 1);
    }

    #[test]
    fn nonzero_exit_maps_to_io_with_stderr_tail_and_keeps_target() {
        let dir = tempdir().unwrap();
        let pandoc = fake_pandoc(
            dir.path(),
            "cat > /dev/null\necho 'pandoc: Could not find image `cat.png`' >&2\nexit 83",
        );
        let target = dir.path().join("a.odt");
        fs::write(&target, "previous").unwrap();
        let err = export_with(&pandoc, &request(&target, "odt"), Duration::from_secs(10)).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Io);
        assert!(err.message.contains("exit 83"), "{}", err.message);
        assert!(err.message.contains("Could not find image"), "{}", err.message);
        assert_eq!(fs::read_to_string(&target).unwrap(), "previous");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 2); // pandoc + a.odt
    }

    #[test]
    fn stderr_tail_keeps_the_end() {
        let long = format!("{}END", "x".repeat(2000));
        let tail = stderr_tail(long.as_bytes());
        assert!(tail.starts_with('…'));
        assert!(tail.ends_with("END"));
        assert_eq!(tail.chars().count(), STDERR_TAIL_CHARS + 1);
        assert_eq!(stderr_tail(b"  short \n"), "short");
    }

    #[test]
    fn hanging_pandoc_is_killed_after_the_timeout() {
        let dir = tempdir().unwrap();
        let pandoc = fake_pandoc(dir.path(), "exec sleep 30");
        let target = dir.path().join("a.tex");
        let started = Instant::now();
        let err =
            export_with(&pandoc, &request(&target, "latex"), Duration::from_millis(300)).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(10));
        assert_eq!(err.kind, ErrorKind::Io);
        assert!(err.message.contains("逾時"), "{}", err.message);
        assert!(!target.exists());
        // No temp file left behind.
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[test]
    fn missing_pandoc_is_not_found() {
        let dir = tempdir().unwrap();
        let err = export_with(
            &dir.path().join("pandoc"),
            &request(&dir.path().join("a.docx"), "docx"),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
        assert_eq!(err.message, PANDOC_MISSING_MESSAGE);
        assert!(!status_for(None).available);
    }

    #[test]
    fn invalid_export_targets() {
        let dir = tempdir().unwrap();
        let pandoc = fake_pandoc(dir.path(), RECORDING);
        let err = export_with(&pandoc, &request(Path::new("  "), "docx"), Duration::from_secs(5))
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
        let err = export_with(
            &pandoc,
            &request(&dir.path().join("missing/a.docx"), "docx"),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
        let err = export_with(&pandoc, &request(dir.path(), "docx"), Duration::from_secs(5))
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
    }

    #[test]
    fn find_pandoc_searches_path_then_extra_dirs() {
        let dir = tempdir().unwrap();
        let a = dir.path().join("a");
        let b = dir.path().join("b");
        let extra = dir.path().join("extra");
        for d in [&a, &b, &extra] {
            fs::create_dir(d).unwrap();
        }
        // Not executable: skipped.
        fs::write(a.join("pandoc"), "x").unwrap();
        let path_env = std::env::join_paths([&a, &b]).unwrap();
        assert_eq!(find_pandoc(Some(path_env.clone()), std::slice::from_ref(&extra)), None);
        let in_extra = fake_pandoc(&extra, "echo 'pandoc 3.1.11'");
        assert_eq!(find_pandoc(Some(path_env.clone()), std::slice::from_ref(&extra)), Some(in_extra.clone()));
        let in_b = fake_pandoc(&b, "echo 'pandoc 3.2'");
        assert_eq!(find_pandoc(Some(path_env), std::slice::from_ref(&extra)), Some(in_b));
        assert_eq!(find_pandoc(None, &[extra]), Some(in_extra.clone()));

        let status = status_for(Some(in_extra));
        assert!(status.available);
        assert_eq!(status.version.as_deref(), Some("3.1.11"));
        let v = serde_json::to_value(&status).unwrap();
        assert!(v.get("available").is_some() && v.get("path").is_some() && v.get("version").is_some());
    }

    #[test]
    fn import_reads_stdout_and_extracts_media() {
        let dir = tempdir().unwrap();
        let pandoc = fake_pandoc(
            dir.path(),
            r#"
dir=$(dirname "$0")
: > "$dir/argv.txt"
for a in "$@"; do printf '%s\n' "$a" >> "$dir/argv.txt"; done
for a in "$@"; do
  case "$a" in
    --extract-media=*) m="${a#--extract-media=}"; mkdir -p "$m/media"; printf 'png' > "$m/media/image1.png";;
    --lua-filter=*) cp "${a#--lua-filter=}" "$dir/filter-copy.lua";;
  esac
done
printf '# 第一章\n\n## 第一節\n\n### 小節\n\n![](%s/media/image1.png)\n\n公式 $x$\342\200\213 後\n' "$m"
"#,
        );
        let source = dir.path().join("報告.docx");
        fs::write(&source, "PK").unwrap();
        let temp_base = dir.path().join("tmp");
        fs::create_dir(&temp_base).unwrap();

        let result =
            import_with(&pandoc, Some("3.1.11"), &source, &temp_base, Duration::from_secs(10)).unwrap();
        assert!(result.markdown.starts_with("# 第一章\n\n## 第一節\n\n### 小節"));
        let media = result.media_dir.expect("media dir");
        assert!(media.starts_with(temp_base.to_str().unwrap()));
        assert!(result.markdown.contains(&format!("{media}/media/image1.png")));
        let args = argv(dir.path());
        assert_eq!(
            &args[0..6],
            &["--sandbox", "-f", "docx", "-t", MARKDOWN_WRITER, "--wrap=none"]
        );
        let filter = format!("{media}/{IMPORT_FILTER_NAME}");
        assert_eq!(args[6], format!("--lua-filter={filter}"));
        assert_eq!(args[7], format!("--extract-media={media}"));
        assert_eq!(&args[8..], &["--", source.to_str().unwrap()]);
        // The filter was there for pandoc, then removed; U+200B is stripped.
        assert_eq!(fs::read_to_string(dir.path().join("filter-copy.lua")).unwrap(), IMPORT_LUA_FILTER);
        assert!(!Path::new(&filter).exists());
        assert!(result.markdown.contains("公式 $x$ 後"));
        assert!(!result.markdown.contains('\u{200B}'));
    }

    #[test]
    fn import_errors() {
        let dir = tempdir().unwrap();
        let failing = fake_pandoc(dir.path(), "echo 'pandoc: unknown reader' >&2\nexit 2");
        let source = dir.path().join("a.odt");
        fs::write(&source, "x").unwrap();
        let base = dir.path().join("base");
        fs::create_dir(&base).unwrap();
        let err = import_with(&failing, Some("3.1"), &source, &base, Duration::from_secs(5))
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Io);
        assert!(err.message.contains("unknown reader"));
        // The per-import temp folder (filter + media) is removed on failure.
        assert_eq!(fs::read_dir(&base).unwrap().count(), 0);
        let err = import_with(
            &failing,
            Some("3.1"),
            &dir.path().join("missing.docx"),
            dir.path(),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::NotFound);
        let err = import_with(
            &failing,
            Some("3.1"),
            &dir.path().join("a.pdf"),
            dir.path(),
            Duration::from_secs(5),
        )
        .unwrap_err();
        assert_eq!(err.kind, ErrorKind::InvalidPath);
    }

    #[test]
    fn import_without_media_leaves_no_temp_folder() {
        let dir = tempdir().unwrap();
        let pandoc = fake_pandoc(dir.path(), "printf '# 標題\\n'");
        let source = dir.path().join("a.html");
        fs::write(&source, "<h1>標題</h1>").unwrap();
        let base = dir.path().join("base");
        fs::create_dir(&base).unwrap();
        let result = import_with(&pandoc, Some("3.14"), &source, &base, Duration::from_secs(5)).unwrap();
        assert_eq!(result.markdown, "# 標題\n");
        assert_eq!(result.media_dir, None);
        assert_eq!(fs::read_dir(&base).unwrap().count(), 0);
    }

    #[test]
    fn imported_markdown_drops_zero_width_spaces() {
        assert_eq!(clean_imported_markdown("$x$\u{200B} 後\u{200B}"), "$x$ 後");
        assert_eq!(clean_imported_markdown("無變化 \u{200C}"), "無變化 \u{200C}");
    }

    #[test]
    fn version_parsing() {
        assert_eq!(parse_version("3.1.11"), Some((3, 1, 11)));
        assert_eq!(parse_version("pandoc 3.1.11"), Some((3, 1, 11)));
        assert_eq!(parse_version("2.14.0.3"), Some((2, 14, 0)));
        assert_eq!(parse_version("2.15"), Some((2, 15, 0)));
        assert_eq!(parse_version("3 (mock)"), Some((3, 0, 0)));
        assert_eq!(parse_version("3.1.11 (mock)"), Some((3, 1, 11)));
        assert_eq!(parse_version("unknown"), None);
        assert_eq!(parse_version(""), None);
        assert!(supports_sandbox(Some("2.15")));
        assert!(supports_sandbox(Some("2.15.0.1")));
        assert!(supports_sandbox(Some("3.1.11")));
        assert!(supports_sandbox(Some("10.0")));
        assert!(!supports_sandbox(Some("2.14.2")));
        assert!(!supports_sandbox(Some("1.19.2.4")));
        assert!(!supports_sandbox(Some("garbage")));
        assert!(!supports_sandbox(None));
    }

    #[test]
    fn old_pandoc_is_refused_for_import_before_running() {
        let dir = tempdir().unwrap();
        // Would create `ran` if it were executed.
        let pandoc = fake_pandoc(dir.path(), r#"touch "$(dirname "$0")/ran""#);
        let source = dir.path().join("a.html");
        fs::write(&source, "<h1>x</h1>").unwrap();
        for version in [Some("2.14.2"), None] {
            let err = import_with(&pandoc, version, &source, dir.path(), Duration::from_secs(5))
                .unwrap_err();
            assert_eq!(err.kind, ErrorKind::Io);
            assert_eq!(err.message, PANDOC_TOO_OLD_FOR_IMPORT_MESSAGE);
        }
        assert!(!dir.path().join("ran").exists());
        // Exports are not sandboxed and do not need a version.
        let args = export_args(ExportFormat::Docx, &[], false, Path::new("/tmp/kalamos-test/a.docx"));
        assert!(!args.iter().any(|a| a == "--sandbox"));
    }

    #[test]
    fn import_writer_disables_gfm_math() {
        assert!(MARKDOWN_WRITER.starts_with("gfm-tex_math_gfm+tex_math_dollars"));
        let args = import_args(
            Path::new("/tmp/kalamos-test/a.docx"),
            "docx",
            Path::new("/tmp/kalamos-test/m"),
            Path::new("/tmp/kalamos-test/m/f.lua"),
        );
        assert!(args.iter().any(|a| a == "gfm-tex_math_gfm+tex_math_dollars+footnotes"));
    }

    /// A valid 1×1 PNG.
    const PNG_1X1: &[u8] = &[
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
        0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f,
        0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8,
        0xcf, 0xc0, 0xf0, 0x1f, 0x00, 0x05, 0x00, 0x01, 0xff, 0x89, 0x99, 0x3d, 0x1d, 0x00, 0x00,
        0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
    ];

    const REAL_DOC: &str = "# 第一章 H1\n\n## 第一節 H2\n\n### 小節 H3\n\n- 項目甲\n- 項目乙\n\n\
| 欄A | 欄B |\n|---|---|\n| 1 | 2 |\n\n質能 $E=mc^2$ 公式，[底線]{.underline}\n\n$$\n\\int_0^1 x\\,dx\n$$\n\n\
![點](img/dot.png)\n";

    /// A document folder with `doc.md` + `img/dot.png`; returns (dir, request for `format`).
    fn real_fixture(format: &str, ext: &str) -> (tempfile::TempDir, ExportRequest) {
        let dir = tempdir().unwrap();
        fs::create_dir(dir.path().join("img")).unwrap();
        fs::write(dir.path().join("img/dot.png"), PNG_1X1).unwrap();
        let out = dir.path().join(format!("out.{ext}"));
        let req = ExportRequest {
            doc_path: Some(dir.path().join("doc.md").to_string_lossy().into_owned()),
            markdown: REAL_DOC.to_string(),
            format: format.to_string(),
            out_path: out.to_string_lossy().into_owned(),
            image_root: None,
            toc: false,
        };
        (dir, req)
    }

    fn real_pandoc() -> Option<(PathBuf, Option<String>)> {
        let status = detect();
        let path = status.path.filter(|_| status.available)?;
        Some((PathBuf::from(path), status.version))
    }

    /// Runs only when a real pandoc is installed (skipped otherwise): export a
    /// DOCX with headings, list, table, inline / display math and a local image,
    /// import it back and check everything survived.
    #[test]
    fn real_pandoc_roundtrip_if_installed() {
        let Some((pandoc, version)) = real_pandoc() else {
            eprintln!("pandoc not installed; skipping real_pandoc_roundtrip_if_installed");
            return;
        };
        let (dir, req) = real_fixture("docx", "docx");
        let meta = export_with(&pandoc, &req, PANDOC_TIMEOUT).unwrap();
        assert!(meta.size > 0);
        if !supports_sandbox(version.as_deref()) {
            eprintln!("pandoc too old for --sandbox; skipping import half");
            return;
        }
        let temp_base = dir.path().join("tmp");
        fs::create_dir(&temp_base).unwrap();
        let back = import_with(
            &pandoc,
            version.as_deref(),
            Path::new(&req.out_path),
            &temp_base,
            PANDOC_TIMEOUT,
        )
        .unwrap();
        let md = &back.markdown;
        assert!(md.contains("# 第一章 H1\n"), "{md}");
        assert!(md.contains("\n## 第一節 H2\n"), "{md}");
        assert!(md.contains("\n### 小節 H3\n"), "{md}");
        assert!(md.contains("- 項目甲") && md.contains("- 項目乙"), "{md}");
        assert!(md.contains("| 欄A") && md.contains("| 1 "), "{md}");
        // Math as $…$ / $$…$$, never the gfm $`…`$ / ```math forms.
        assert!(md.contains("$E = mc^{2}$"), "{md}");
        assert!(md.contains("$$") && md.contains("\\int_{0}^{1}"), "{md}");
        assert!(!md.contains("$`") && !md.contains("```math"), "{md}");
        // Lua filter: the captioned image is a plain ![caption](…), no HTML figure / img.
        assert!(md.contains("![點]("), "{md}");
        assert!(!md.contains("<figure") && !md.contains("<figcaption") && !md.contains("<img"), "{md}");
        // Other raw HTML is kept; zero-width spaces are gone.
        assert!(md.contains("<u>底線</u>"), "{md}");
        assert!(!md.contains('\u{200B}'), "{md}");
        // The embedded image was extracted and is referenced by absolute path.
        let media = back.media_dir.expect("media extracted");
        assert!(media.starts_with(temp_base.to_str().unwrap()));
        let extracted: Vec<_> = walk_files(Path::new(&media));
        // The filter file does not linger in the media folder.
        assert!(extracted.iter().all(|p| !p.ends_with(IMPORT_FILTER_NAME)));
        assert_eq!(extracted.len(), 1, "{extracted:?}");
        assert!(md.contains(extracted[0].to_str().unwrap()), "{md}");
    }

    fn walk_files(dir: &Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for entry in fs::read_dir(dir).unwrap().flatten() {
            let p = entry.path();
            if p.is_dir() {
                out.extend(walk_files(&p));
            } else {
                out.push(p);
            }
        }
        out
    }

    /// Runs only with a real pandoc: every export format keeps headings, the
    /// list, the table and the image (checked by reading the file back).
    #[test]
    fn real_pandoc_every_export_format_if_installed() {
        let Some((pandoc, _)) = real_pandoc() else {
            eprintln!("pandoc not installed; skipping real_pandoc_every_export_format_if_installed");
            return;
        };
        for (format, ext, reader) in [
            ("docx", "docx", "docx"),
            ("odt", "odt", "odt"),
            ("latex", "tex", "latex"),
            ("mediawiki", "wiki", "mediawiki"),
            ("epub", "epub", "epub"),
        ] {
            let (dir, req) = real_fixture(format, ext);
            export_with(&pandoc, &req, PANDOC_TIMEOUT)
                .unwrap_or_else(|e| panic!("{format}: {e:?}"));
            let args: Vec<OsString> = vec![
                "-f".into(),
                reader.into(),
                "-t".into(),
                MARKDOWN_WRITER.into(),
                "--wrap=none".into(),
                "--".into(),
                req.out_path.clone().into(),
            ];
            let out = run_pandoc(&pandoc, &args, None, PANDOC_TIMEOUT).unwrap();
            assert!(out.status.success(), "{format}: {}", stderr_tail(&out.stderr));
            let md = String::from_utf8_lossy(&out.stdout).into_owned();
            for needle in ["第一章 H1", "第一節 H2", "小節 H3"] {
                assert!(md.contains(needle), "{format} heading {needle}: {md}");
            }
            // Heading level = number of leading `#` (ODT adds <span id="anchor"> inside).
            for (prefix, text) in [("# ", "第一章 H1"), ("## ", "第一節 H2"), ("### ", "小節 H3")] {
                assert!(
                    md.lines().any(|l| l.starts_with(prefix) && l.ends_with(text)),
                    "{format} level of {text}: {md}"
                );
            }
            assert!(md.contains("- 項目甲") && md.contains("- 項目乙"), "{format} list: {md}");
            assert!(md.contains("欄A") && md.contains("欄B"), "{format} table: {md}");
            assert!(md.contains('|'), "{format} table as table: {md}");
            // DOCX / ODT / EPUB images carry a size GFM cannot express, so pandoc
            // writes them as an HTML <img> (inside <figure> when captioned).
            assert!(md.contains("![") || md.contains("<img "), "{format} image: {md}");
            if matches!(format, "latex" | "mediawiki") {
                // Text formats reference the image by path.
                assert!(md.contains("dot.png"), "{format} image path: {md}");
            }
            drop(dir);
        }
    }
}

#[cfg(test)]
mod media_path_tests {
    use super::slash_media_paths;
    use std::path::Path;

    #[test]
    fn rewrites_backslashed_media_paths_only() {
        let work = Path::new(r"C:\Temp\kalamos-import-a");
        let md = "![x](C:\\Temp\\kalamos-import-a\\media\\image1.png) and C:\\other\\keep.png\n";
        assert_eq!(
            slash_media_paths(md, work),
            "![x](C:/Temp/kalamos-import-a/media/image1.png) and C:\\other\\keep.png\n"
        );
        // Nothing to do for forward-slash work dirs.
        assert_eq!(slash_media_paths("a\\b", Path::new("/tmp/w")), "a\\b");
    }
}