//! IM-05: upload local images to an image host through a user-configured
//! command (Typora / PicGo style "custom command" uploader).
//!
//! - The uploader is configured only in the app settings (`uploadCommand` +
//!   `uploadArgs`), never from document content.
//! - It is run with an argument vector, never through a shell: the image
//!   paths are appended as extra argv entries, no string interpolation.
//! - It must print one `http(s)://` URL per image on stdout; the last N such
//!   lines are taken. A non-zero exit, a timeout (the child is killed) or a
//!   wrong URL count is an error, so nothing is partially replaced.

use std::ffi::OsString;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{AppError, ErrorKind};
use crate::images::ALLOWED_IMAGE_EXTS;
use crate::settings::{get_settings_in, Settings};

/// The uploader must finish within this time; it is killed otherwise.
pub const UPLOAD_TIMEOUT: Duration = Duration::from_secs(60);
pub const UPLOADER_NOT_CONFIGURED_MESSAGE: &str =
    "尚未設定圖床上傳指令（見 docs/image-upload.md）";
// Folders searched after PATH for a bare command name: see
// `platform::extra_search_dirs` (GUI apps on macOS do not inherit the shell PATH).
const STDERR_TAIL_CHARS: usize = 400;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    /// One URL per input path, same order.
    pub urls: Vec<String>,
}

/// The configured uploader: program + fixed arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Uploader {
    pub command: String,
    pub args: Vec<String>,
}

impl Uploader {
    /// From settings; None when `uploadCommand` is missing or blank.
    pub fn from_settings(settings: &Settings) -> Option<Self> {
        let command = settings.upload_command.as_deref()?.trim();
        if command.is_empty() {
            return None;
        }
        Some(Self {
            command: command.to_string(),
            args: settings.upload_args.clone(),
        })
    }
}

/// A local image file that may be uploaded (absolute, existing file, supported extension).
pub fn validate_image_path(path: &str) -> Result<PathBuf, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("圖片路徑是空的"));
    }
    let p = PathBuf::from(path);
    if !p.is_absolute() {
        return Err(AppError::invalid_path(format!("圖片路徑必須是絕對路徑：{path}")));
    }
    let meta = fs::metadata(&p).map_err(|_| AppError::not_found(format!("找不到圖片：{path}")))?;
    if meta.is_dir() {
        return Err(AppError::invalid_path(format!("不是圖片檔案（是資料夾）：{path}")));
    }
    let ext = p
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    if !ALLOWED_IMAGE_EXTS.contains(&ext.as_str()) {
        return Err(AppError::invalid_path(format!("不支援的圖片類型：{path}")));
    }
    Ok(p)
}

fn is_url_line(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    (lower.starts_with("https://") || lower.starts_with("http://"))
        && line.len() > "http://".len()
        && !line.chars().any(|c| c.is_whitespace() || c.is_control())
}

/// The last `count` lines of `stdout` that are `http(s)://` URLs.
pub fn parse_urls(stdout: &str, count: usize) -> Result<Vec<String>, AppError> {
    let urls: Vec<&str> = stdout
        .lines()
        .map(str::trim)
        .filter(|l| is_url_line(l))
        .collect();
    if urls.len() < count {
        return Err(AppError::parse(format!(
            "上傳指令只回傳 {} 個網址，需要 {count} 個",
            urls.len()
        )));
    }
    Ok(urls[urls.len() - count..].iter().map(|s| s.to_string()).collect())
}

fn stderr_tail(stderr: &[u8]) -> String {
    let text = String::from_utf8_lossy(stderr);
    let trimmed = text.trim();
    let chars: Vec<char> = trimmed.chars().collect();
    if chars.len() <= STDERR_TAIL_CHARS {
        trimmed.to_string()
    } else {
        format!("…{}", chars[chars.len() - STDERR_TAIL_CHARS..].iter().collect::<String>())
    }
}

use crate::platform::is_executable;

/// A command that names a path (contains `/`, or `\` on Windows, or is
/// absolute) is used as given; a bare name is looked up in PATH and then the
/// platform's extra folders (with `PATHEXT` extensions on Windows).
pub fn resolve_command(
    command: &str,
    path_env: Option<OsString>,
    extra_dirs: &[PathBuf],
) -> Result<PathBuf, AppError> {
    if crate::platform::is_path_like(command) {
        let p = PathBuf::from(command);
        return if is_executable(&p) {
            Ok(p)
        } else {
            Err(AppError::not_found(format!("找不到可執行的上傳指令：{command}")))
        };
    }
    crate::platform::find_executable(command, path_env, extra_dirs)
        .ok_or_else(|| AppError::not_found(format!("找不到上傳指令：{command}")))
}

fn spawn_reader<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<Vec<u8>> {
    thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = reader.read_to_end(&mut buf);
        buf
    })
}

/// Runs `program args… paths…` (no shell) and returns one URL per path.
pub fn run_uploader(
    program: &Path,
    args: &[String],
    paths: &[PathBuf],
    timeout: Duration,
) -> Result<Vec<String>, AppError> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }
    let mut cmd = Command::new(program);
    let mut child = crate::platform::no_console(&mut cmd)
        .args(args)
        .args(paths)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| AppError::new(ErrorKind::Io, format!("無法執行上傳指令：{e}")))?;
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
                    return Err(AppError::new(
                        ErrorKind::Io,
                        format!("上傳逾時（超過 {} 秒），已中止", timeout.as_secs()),
                    ));
                }
                thread::sleep(Duration::from_millis(20));
            }
            Err(e) => return Err(AppError::new(ErrorKind::Io, e.to_string())),
        }
    };
    let stdout = out_reader.and_then(|h| h.join().ok()).unwrap_or_default();
    let stderr = err_reader.and_then(|h| h.join().ok()).unwrap_or_default();
    if !status.success() {
        let code = status
            .code()
            .map(|c| c.to_string())
            .unwrap_or_else(|| "signal".to_string());
        let tail = stderr_tail(&stderr);
        return Err(AppError::new(
            ErrorKind::Io,
            if tail.is_empty() {
                format!("上傳指令失敗（結束碼 {code}）")
            } else {
                format!("上傳指令失敗（結束碼 {code}）：{tail}")
            },
        ));
    }
    parse_urls(&String::from_utf8_lossy(&stdout), paths.len())
}

/// Validates the paths, then uploads them with `uploader`.
pub fn upload_with(
    uploader: &Uploader,
    paths: &[String],
    timeout: Duration,
) -> Result<UploadResult, AppError> {
    if paths.is_empty() {
        return Ok(UploadResult { urls: Vec::new() });
    }
    let files = paths
        .iter()
        .map(|p| validate_image_path(p))
        .collect::<Result<Vec<_>, _>>()?;
    let extra = crate::platform::extra_search_dirs();
    let program = resolve_command(&uploader.command, std::env::var_os("PATH"), &extra)?;
    let urls = run_uploader(&program, &uploader.args, &files, timeout)?;
    Ok(UploadResult { urls })
}

#[tauri::command]
pub async fn upload_images(app: tauri::AppHandle, paths: Vec<String>) -> Result<UploadResult, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    tauri::async_runtime::spawn_blocking(move || {
        let settings = get_settings_in(&app_data_dir)?;
        let uploader = Uploader::from_settings(&settings)
            .ok_or_else(|| AppError::not_found(UPLOADER_NOT_CONFIGURED_MESSAGE))?;
        upload_with(&uploader, &paths, UPLOAD_TIMEOUT)
    })
    .await
    .map_err(|e| AppError::new(ErrorKind::Io, e.to_string()))?
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use tempfile::tempdir;

    /// Writes an executable `#!/bin/sh` script.
    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let p = dir.join(name);
        fs::write(&p, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        p
    }

    fn image(dir: &Path, name: &str) -> String {
        let p = dir.join(name);
        fs::write(&p, b"\x89PNG\r\n\x1a\n").unwrap();
        p.to_string_lossy().into_owned()
    }

    fn uploader(cmd: &Path, args: &[&str]) -> Uploader {
        Uploader {
            command: cmd.to_string_lossy().into_owned(),
            args: args.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn passes_args_then_paths_as_separate_argv_entries() {
        let dir = tempdir().unwrap();
        let log = dir.path().join("argv.txt");
        // Records each argv entry on its own line, prints one URL per path.
        let cmd = script(
            dir.path(),
            "fake-uploader",
            &format!(
                r#"for a in "$@"; do printf '%s\n' "$a" >> '{}'; done
shift 2
n=0
echo "Uploading..."
for p in "$@"; do n=$((n+1)); echo "https://img.example.test/$n.png"; done"#,
                log.display()
            ),
        );
        let a = image(dir.path(), "my cat.png");
        let b = image(dir.path(), "貓 $(touch pwned) ;.jpg");
        let result = upload_with(&uploader(&cmd, &["upload", "--quiet"]), &[a.clone(), b.clone()], UPLOAD_TIMEOUT)
            .expect("upload");
        assert_eq!(
            result.urls,
            vec!["https://img.example.test/1.png", "https://img.example.test/2.png"]
        );
        let argv = fs::read_to_string(&log).unwrap();
        assert_eq!(argv.lines().collect::<Vec<_>>(), vec!["upload", "--quiet", a.as_str(), b.as_str()]);
        // Nothing was interpreted by a shell.
        assert!(!dir.path().join("pwned").exists());
    }

    #[test]
    fn takes_the_last_url_lines() {
        let out = "PicGo SUCCESS:\nnot a url\nhttps://old.test/x.png\nhttps://a.test/1.png\n  http://b.test/2.png  \n";
        assert_eq!(
            parse_urls(out, 2).unwrap(),
            vec!["https://a.test/1.png", "http://b.test/2.png"]
        );
        assert!(parse_urls("https://a.test/has space.png\n", 1).is_err());
        assert!(parse_urls("ftp://a.test/x.png\n", 1).is_err());
        assert_eq!(parse_urls("", 0).unwrap(), Vec::<String>::new());
    }

    #[test]
    fn wrong_url_count_is_an_error() {
        let dir = tempdir().unwrap();
        let cmd = script(dir.path(), "one-url", "echo https://img.example.test/only.png");
        let a = image(dir.path(), "a.png");
        let b = image(dir.path(), "b.png");
        let err = upload_with(&uploader(&cmd, &[]), &[a, b], UPLOAD_TIMEOUT).unwrap_err();
        assert_eq!(err.kind, ErrorKind::Parse);
        assert!(err.message.contains("1 個網址"), "{}", err.message);
    }

    #[test]
    fn non_zero_exit_reports_the_stderr_tail() {
        let dir = tempdir().unwrap();
        let cmd = script(
            dir.path(),
            "failing",
            "echo https://img.example.test/1.png\necho 'token expired' >&2\nexit 3",
        );
        let err = upload_with(&uploader(&cmd, &[]), &[image(dir.path(), "a.png")], UPLOAD_TIMEOUT)
            .unwrap_err();
        assert_eq!(err.kind, ErrorKind::Io);
        assert!(err.message.contains("結束碼 3"), "{}", err.message);
        assert!(err.message.contains("token expired"), "{}", err.message);
    }

    #[test]
    fn a_hanging_uploader_is_killed_after_the_timeout() {
        let dir = tempdir().unwrap();
        let cmd = script(dir.path(), "hang", "exec sleep 30");
        let started = Instant::now();
        let err = upload_with(&uploader(&cmd, &[]), &[image(dir.path(), "a.png")], Duration::from_millis(300))
            .unwrap_err();
        assert!(err.message.contains("逾時"), "{}", err.message);
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn only_existing_local_image_files_are_accepted() {
        let dir = tempdir().unwrap();
        let ok = image(dir.path(), "ok.webp");
        assert!(validate_image_path(&ok).is_ok());
        assert_eq!(
            validate_image_path(dir.path().to_str().unwrap()).unwrap_err().kind,
            ErrorKind::InvalidPath
        );
        let txt = dir.path().join("notes.md");
        fs::write(&txt, "x").unwrap();
        assert_eq!(validate_image_path(txt.to_str().unwrap()).unwrap_err().kind, ErrorKind::InvalidPath);
        assert_eq!(
            validate_image_path("/tmp/kalamos-test/missing/none.png").unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(validate_image_path("relative/a.png").unwrap_err().kind, ErrorKind::InvalidPath);
        // The uploader never runs when a path is invalid.
        let log = dir.path().join("ran");
        let cmd = script(dir.path(), "never", &format!("touch '{}'", log.display()));
        assert!(upload_with(&uploader(&cmd, &[]), &[ok, "/tmp/kalamos-test/missing/x.png".into()], UPLOAD_TIMEOUT).is_err());
        assert!(!log.exists());
    }

    #[test]
    fn resolves_bare_names_through_path_and_extra_dirs() {
        let dir = tempdir().unwrap();
        let bin = dir.path().join("bin");
        fs::create_dir(&bin).unwrap();
        let cmd = script(&bin, "picgo-fake", "true");
        assert_eq!(
            resolve_command("picgo-fake", Some(bin.clone().into_os_string()), &[]).unwrap(),
            cmd
        );
        assert_eq!(resolve_command("picgo-fake", None, std::slice::from_ref(&bin)).unwrap(), cmd);
        assert_eq!(
            resolve_command("missing-tool", Some(bin.into_os_string()), &[]).unwrap_err().kind,
            ErrorKind::NotFound
        );
        assert_eq!(
            resolve_command("/tmp/kalamos-test/none/uploader", None, &[]).unwrap_err().kind,
            ErrorKind::NotFound
        );
    }

    #[test]
    fn uploader_comes_only_from_settings() {
        let mut s = Settings::default();
        assert_eq!(Uploader::from_settings(&s), None);
        s.upload_command = Some("   ".into());
        assert_eq!(Uploader::from_settings(&s), None);
        s.upload_command = Some("/tmp/kalamos-test/bin/picgo".into());
        s.upload_args = vec!["upload".into()];
        assert_eq!(
            Uploader::from_settings(&s),
            Some(Uploader {
                command: "/tmp/kalamos-test/bin/picgo".into(),
                args: vec!["upload".into()],
            })
        );
    }
}
