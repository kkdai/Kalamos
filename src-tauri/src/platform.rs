//! Small cross-platform helpers (macOS / Windows / Linux).
//!
//! - `canonicalize`: like `fs::canonicalize`, but on Windows without the
//!   `\\?\` verbatim prefix (which the WebView, the asset scope and users do
//!   not expect).
//! - `extra_search_dirs` / `find_executable`: where GUI apps look for helper
//!   programs (pandoc, image uploaders). macOS GUI apps do not inherit the
//!   shell PATH, so Homebrew folders are added; on Windows the usual installer
//!   locations are added and `PATHEXT` extensions (`.exe`, `.cmd`, …) are tried.
//! - `no_console`: child processes must not flash a console window on Windows.

use std::ffi::OsString;
use std::io;
use std::path::{Path, PathBuf};
use std::process::Command;

/// `fs::canonicalize` without the Windows verbatim (`\\?\`) prefix.
pub fn canonicalize<P: AsRef<Path>>(path: P) -> io::Result<PathBuf> {
    dunce::canonicalize(path)
}

/// Folders searched after PATH for helper programs.
pub fn extra_search_dirs() -> Vec<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let mut dirs = Vec::new();
        let env_dir = |var: &str, rest: &[&str]| -> Option<PathBuf> {
            let mut p = PathBuf::from(std::env::var_os(var)?);
            for r in rest {
                p.push(r);
            }
            Some(p)
        };
        // Pandoc's MSI installs per user (LOCALAPPDATA) or per machine.
        dirs.extend(env_dir("LOCALAPPDATA", &["Pandoc"]));
        dirs.extend(env_dir("ProgramFiles", &["Pandoc"]));
        dirs.extend(env_dir("ProgramFiles(x86)", &["Pandoc"]));
        // winget portable links, Scoop shims, Chocolatey shims.
        dirs.extend(env_dir("LOCALAPPDATA", &["Microsoft", "WinGet", "Links"]));
        dirs.extend(env_dir("USERPROFILE", &["scoop", "shims"]));
        dirs.extend(env_dir("ProgramData", &["chocolatey", "bin"]));
        // npm global installs (e.g. PicGo CLI).
        dirs.extend(env_dir("APPDATA", &["npm"]));
        dirs
    }
    #[cfg(not(target_os = "windows"))]
    {
        ["/opt/homebrew/bin", "/usr/local/bin"]
            .iter()
            .map(PathBuf::from)
            .collect()
    }
}

/// Executable file extensions tried for a bare name (Windows: `PATHEXT`).
pub fn executable_extensions() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        let raw = std::env::var("PATHEXT").unwrap_or_else(|_| ".COM;.EXE;.BAT;.CMD".into());
        let mut exts: Vec<String> = raw
            .split(';')
            .map(|e| e.trim().to_ascii_lowercase())
            .filter(|e| e.starts_with('.') && e.len() > 1)
            .collect();
        // Prefer real executables.
        exts.sort_by_key(|e| match e.as_str() {
            ".exe" => 0,
            ".com" => 1,
            ".cmd" => 2,
            ".bat" => 3,
            _ => 4,
        });
        exts.dedup();
        exts
    }
    #[cfg(not(target_os = "windows"))]
    {
        Vec::new()
    }
}

/// Is `path` a file we may run?
pub fn is_executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_file() && (meta.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

/// Candidate files for program `name` inside `dir`.
pub fn candidates_in(dir: &Path, name: &str) -> Vec<PathBuf> {
    let mut out = Vec::new();
    let has_ext = Path::new(name).extension().is_some();
    let exts = executable_extensions();
    if exts.is_empty() || has_ext {
        out.push(dir.join(name));
    }
    for ext in exts {
        out.push(dir.join(format!("{name}{ext}")));
    }
    out
}

/// First executable `name` in `path_env` (PATH-style list), then `extra_dirs`.
pub fn find_executable(
    name: &str,
    path_env: Option<OsString>,
    extra_dirs: &[PathBuf],
) -> Option<PathBuf> {
    let mut dirs: Vec<PathBuf> = path_env
        .map(|p| std::env::split_paths(&p).collect())
        .unwrap_or_default();
    dirs.extend(extra_dirs.iter().cloned());
    dirs.into_iter()
        .filter(|d| !d.as_os_str().is_empty())
        .flat_map(|d| candidates_in(&d, name))
        .find(|candidate| is_executable(candidate))
}

/// True when `command` names a path (absolute, or containing a separator)
/// rather than a bare program name to look up in PATH.
pub fn is_path_like(command: &str) -> bool {
    command.contains('/')
        || (cfg!(target_os = "windows") && command.contains('\\'))
        || Path::new(command).is_absolute()
}

/// Keep child processes from opening a console window (Windows GUI apps).
pub fn no_console(cmd: &mut Command) -> &mut Command {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn canonicalize_has_no_verbatim_prefix() {
        let dir = tempdir().unwrap();
        let c = canonicalize(dir.path()).unwrap();
        assert!(!c.to_string_lossy().starts_with(r"\\?\"));
        assert!(c.is_absolute());
    }

    #[test]
    fn finds_program_in_extra_dirs() {
        let dir = tempdir().unwrap();
        let name = if cfg!(target_os = "windows") {
            "fake-tool.exe"
        } else {
            "fake-tool"
        };
        let p = dir.path().join(name);
        fs::write(&p, "x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&p, fs::Permissions::from_mode(0o755)).unwrap();
        }
        let found = find_executable("fake-tool", None, &[dir.path().to_path_buf()]);
        assert_eq!(found, Some(p));
        assert_eq!(find_executable("missing-tool", None, &[dir.path().to_path_buf()]), None);
    }

    #[test]
    fn path_like_detection() {
        assert!(is_path_like("/usr/bin/picgo"));
        assert!(is_path_like("./bin/picgo"));
        assert!(!is_path_like("picgo"));
        #[cfg(target_os = "windows")]
        {
            assert!(is_path_like(r"C:\tools\picgo.exe"));
            assert!(is_path_like(r"tools\picgo.exe"));
        }
    }
}
