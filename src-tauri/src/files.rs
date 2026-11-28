use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

use crate::error::AppError;
use crate::watch::FileWatcherManager;

static TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMeta {
    pub path: String,
    pub mtime_ms: u64,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileSnapshot {
    pub path: String,
    pub content: String,
    pub mtime_ms: u64,
    pub size: u64,
    pub hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum FileDiskState {
    Exists {
        path: String,
        #[serde(rename = "mtimeMs")]
        mtime_ms: u64,
        size: u64,
        hash: String,
    },
    Missing {
        path: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveFileResult {
    Saved {
        path: String,
        #[serde(rename = "mtimeMs")]
        mtime_ms: u64,
        size: u64,
        hash: String,
    },
    Conflict {
        path: String,
        #[serde(rename = "mtimeMs")]
        mtime_ms: u64,
        size: u64,
        #[serde(rename = "diskHash")]
        disk_hash: String,
    },
    Missing {
        path: String,
    },
}

/// Pure-Rust SHA-256 (FIPS 180-4) returning lowercase hex.
pub fn sha256_hex(data: &[u8]) -> String {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
        0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut padded = Vec::with_capacity((data.len() + 9).div_ceil(64) * 64);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    let mut w = [0u32; 64];
    for chunk in padded.as_chunks::<64>().0 {
        for (i, word) in chunk.as_chunks::<4>().0.iter().enumerate() {
            w[i] = u32::from_be_bytes(*word);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = String::with_capacity(64);
    for word in h {
        use std::fmt::Write as _;
        let _ = write!(&mut out, "{word:08x}");
    }
    out
}

fn metadata_mtime_ms(meta: &fs::Metadata) -> u64 {
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn open_file_impl(path: &str) -> Result<String, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let bytes = fs::read(path)?;
    String::from_utf8(bytes).map_err(|e| AppError::parse(e.to_string()))
}

pub fn open_file_snapshot_impl(path: &str) -> Result<FileSnapshot, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let bytes = fs::read(path)?;
    let mtime_ms = fs::metadata(path)
        .ok()
        .map(|m| metadata_mtime_ms(&m))
        .unwrap_or(0);
    let size = bytes.len() as u64;
    let hash = sha256_hex(&bytes);
    let content = String::from_utf8(bytes).map_err(|e| AppError::parse(e.to_string()))?;
    Ok(FileSnapshot {
        path: path.to_string(),
        content,
        mtime_ms,
        size,
        hash,
    })
}

pub fn stat_file_snapshot_impl(path: &str) -> Result<FileDiskState, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    match fs::read(path) {
        Ok(bytes) => {
            let mtime_ms = fs::metadata(path)
                .ok()
                .map(|m| metadata_mtime_ms(&m))
                .unwrap_or(0);
            let size = bytes.len() as u64;
            let hash = sha256_hex(&bytes);
            Ok(FileDiskState::Exists {
                path: path.to_string(),
                mtime_ms,
                size,
                hash,
            })
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(FileDiskState::Missing {
            path: path.to_string(),
        }),
        Err(err) => Err(AppError::from(err)),
    }
}

pub fn save_file_checked_impl<F>(
    path: &str,
    content: &str,
    expected_hash: Option<&str>,
    before_write: F,
) -> Result<SaveFileResult, AppError>
where
    F: FnOnce(&str),
{
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let target = Path::new(path);
    if target.is_dir() {
        return Err(AppError::invalid_path("Target path is a directory"));
    }

    if let Some(expected) = expected_hash {
        match fs::read(target) {
            Ok(disk_bytes) => {
                let disk_hash = sha256_hex(&disk_bytes);
                if disk_hash != expected {
                    let mtime_ms = fs::metadata(target)
                        .ok()
                        .map(|m| metadata_mtime_ms(&m))
                        .unwrap_or(0);
                    return Ok(SaveFileResult::Conflict {
                        path: path.to_string(),
                        mtime_ms,
                        size: disk_bytes.len() as u64,
                        disk_hash,
                    });
                }
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return Ok(SaveFileResult::Missing {
                    path: path.to_string(),
                });
            }
            Err(err) => return Err(AppError::from(err)),
        }
    }

    let hash = sha256_hex(content.as_bytes());
    before_write(&hash);
    let meta = save_file_impl(path, content)?;
    Ok(SaveFileResult::Saved {
        path: meta.path,
        mtime_ms: meta.mtime_ms,
        size: meta.size,
        hash,
    })
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
pub fn open_file(app: tauri::AppHandle, path: String) -> Result<String, AppError> {
    let content = open_file_impl(&path)?;
    crate::images::allow_parent_dir(&app, &path);
    Ok(content)
}

#[tauri::command]
pub fn open_file_snapshot(app: tauri::AppHandle, path: String) -> Result<FileSnapshot, AppError> {
    let snapshot = open_file_snapshot_impl(&path)?;
    crate::images::allow_parent_dir(&app, &path);
    Ok(snapshot)
}

#[tauri::command]
pub fn stat_file_snapshot(path: String) -> Result<FileDiskState, AppError> {
    stat_file_snapshot_impl(&path)
}

#[tauri::command]
pub fn save_file(
    app: tauri::AppHandle,
    file_watcher: tauri::State<'_, FileWatcherManager>,
    path: String,
    content: String,
) -> Result<FileMeta, AppError> {
    let hash = sha256_hex(content.as_bytes());
    file_watcher.record_self_write(&path, &hash);
    let meta = save_file_impl(&path, &content)?;
    crate::images::allow_parent_dir(&app, &path);
    Ok(meta)
}

#[tauri::command]
pub fn save_file_checked(
    app: tauri::AppHandle,
    file_watcher: tauri::State<'_, FileWatcherManager>,
    path: String,
    content: String,
    expected_hash: Option<String>,
) -> Result<SaveFileResult, AppError> {
    let result = save_file_checked_impl(&path, &content, expected_hash.as_deref(), |hash| {
        file_watcher.record_self_write(&path, hash);
    })?;
    if matches!(result, SaveFileResult::Saved { .. }) {
        crate::images::allow_parent_dir(&app, &path);
    }
    Ok(result)
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

    #[test]
    fn sha256_hex_matches_nist_test_vectors_and_distinguishes_line_endings() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        assert_eq!(
            sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_ne!(sha256_hex(b"a\nb"), sha256_hex(b"a\r\nb"));
    }

    #[test]
    fn snapshot_stat_and_checked_save_detect_conflict_and_missing_without_overwriting() {
        let dir = tempdir().expect("tempdir");
        let file_path = dir.path().join("guarded.md");
        let path_str = file_path.to_str().unwrap();

        save_file_impl(path_str, "# Original\n").expect("seed");
        let snap = open_file_snapshot_impl(path_str).expect("open snapshot");
        assert_eq!(snap.content, "# Original\n");
        assert_eq!(snap.hash, sha256_hex(b"# Original\n"));
        assert_eq!(snap.size, "# Original\n".len() as u64);

        // Stat reports Exists with matching hash
        let state = stat_file_snapshot_impl(path_str).expect("stat existing");
        match state {
            FileDiskState::Exists { hash, size, .. } => {
                assert_eq!(hash, snap.hash);
                assert_eq!(size, snap.size);
            }
            other => panic!("expected Exists, got {other:?}"),
        }

        // Checked save succeeds when expected_hash matches disk
        let mut hooked_hash = String::new();
        let saved = save_file_checked_impl(path_str, "# Local v2\n", Some(&snap.hash), |h| {
            hooked_hash = h.to_string();
        })
        .expect("checked save matching");
        let v2_hash = match saved {
            SaveFileResult::Saved { hash, .. } => hash,
            other => panic!("expected Saved, got {other:?}"),
        };
        assert_eq!(v2_hash, sha256_hex(b"# Local v2\n"));
        assert_eq!(hooked_hash, v2_hash);

        // External edit modifies disk behind our back
        fs::write(&file_path, "# External v3\n").expect("external write");
        let mut hook_called = false;
        let conflict =
            save_file_checked_impl(path_str, "# Stale local v4\n", Some(&v2_hash), |_| {
                hook_called = true;
            })
            .expect("checked save conflict");
        assert!(!hook_called, "before_write must not run on conflict");
        match conflict {
            SaveFileResult::Conflict { disk_hash, .. } => {
                assert_eq!(disk_hash, sha256_hex(b"# External v3\n"));
            }
            other => panic!("expected Conflict, got {other:?}"),
        }
        // Disk must NOT have been overwritten
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "# External v3\n");

        // Force overwrite (expected_hash = None) succeeds
        let forced = save_file_checked_impl(path_str, "# Forced local\n", None, |_| {})
            .expect("force save");
        assert!(matches!(forced, SaveFileResult::Saved { .. }));
        assert_eq!(fs::read_to_string(&file_path).unwrap(), "# Forced local\n");

        // External delete -> stat returns Missing, checked save returns Missing without recreating
        fs::remove_file(&file_path).expect("remove");
        let stat_missing = stat_file_snapshot_impl(path_str).expect("stat missing");
        assert!(matches!(stat_missing, FileDiskState::Missing { .. }));

        let save_missing = save_file_checked_impl(
            path_str,
            "# Should not recreate\n",
            Some(&sha256_hex(b"# Forced local\n")),
            |_| {},
        )
        .expect("checked save missing");
        assert!(matches!(save_missing, SaveFileResult::Missing { .. }));
        assert!(!file_path.exists(), "checked save must not recreate deleted file");
    }
}
