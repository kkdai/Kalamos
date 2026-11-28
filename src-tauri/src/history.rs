//! #148: Local version history — keeps previous file revisions on disk under
//! `<app_data>/history/<path_hash>/<timestamp>.md` with a `meta.json` manifest.
//!
//! Snapshots are taken *before* overwriting a file on disk, throttled for
//! autosave, deduplicated when content has not changed, and pruned by both
//! per-file count and global storage cap.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::error::{AppError, ErrorKind};
use crate::settings::{get_settings_in, Settings};

pub const HISTORY_DIR_NAME: &str = "history";
pub const META_FILE_NAME: &str = "meta.json";
/// Minimum interval between autosave snapshots for the same file (5 minutes).
pub const DEFAULT_HISTORY_THROTTLE_MS: u64 = 5 * 60 * 1000;
pub const HISTORY_MAX_VERSIONS_MIN: u32 = 1;
pub const HISTORY_MAX_VERSIONS_MAX: u32 = 500;
pub const HISTORY_MAX_TOTAL_MB_MIN: u32 = 10;
pub const HISTORY_MAX_TOTAL_MB_MAX: u32 = 2048;

static HISTORY_LOCK: Mutex<()> = Mutex::new(());
static HISTORY_TMP_SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryVersion {
    pub id: String,
    pub saved_at_ms: u64,
    pub size: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryStats {
    pub total_bytes: u64,
    pub total_versions: u64,
    pub file_count: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HistoryPolicy {
    pub enabled: bool,
    pub max_versions: usize,
    pub max_total_bytes: u64,
    pub throttle_ms: u64,
}

impl HistoryPolicy {
    pub fn from_settings(settings: &Settings) -> Self {
        let max_versions = settings
            .history_max_versions
            .clamp(HISTORY_MAX_VERSIONS_MIN, HISTORY_MAX_VERSIONS_MAX)
            as usize;
        let max_mb = settings
            .history_max_total_mb
            .clamp(HISTORY_MAX_TOTAL_MB_MIN, HISTORY_MAX_TOTAL_MB_MAX);
        Self {
            enabled: settings.history_enabled,
            max_versions,
            max_total_bytes: u64::from(max_mb) * 1024 * 1024,
            throttle_ms: DEFAULT_HISTORY_THROTTLE_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryMetaEntry {
    id: String,
    saved_at_ms: u64,
    size: u64,
    content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HistoryMeta {
    original_path: String,
    versions: Vec<HistoryMetaEntry>,
}

/// Minimal, zero-dependency FIPS 180-4 SHA-256 returning lowercase hex.
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
    let mut padded = Vec::with_capacity(data.len() + 72);
    padded.extend_from_slice(data);
    padded.push(0x80);
    while padded.len() % 64 != 56 {
        padded.push(0);
    }
    padded.extend_from_slice(&bit_len.to_be_bytes());

    for chunk in padded.as_chunks::<64>().0 {
        let mut w = [0u32; 64];
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

    let mut hex = String::with_capacity(64);
    for word in h {
        use std::fmt::Write as _;
        let _ = write!(hex, "{word:08x}");
    }
    hex
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn canonical_history_key(path: &str) -> String {
    let raw = Path::new(path);
    if let Ok(canon) = dunce::canonicalize(raw) {
        return canon.to_string_lossy().into_owned();
    }
    if let (Some(parent), Some(name)) = (raw.parent(), raw.file_name()) {
        if !parent.as_os_str().is_empty() {
            if let Ok(canon_parent) = dunce::canonicalize(parent) {
                return canon_parent.join(name).to_string_lossy().into_owned();
            }
        }
    }
    path.trim().to_string()
}

pub fn path_hash_for(path: &str) -> String {
    let key = canonical_history_key(path);
    sha256_hex(key.as_bytes())
}

fn history_root(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join(HISTORY_DIR_NAME)
}

fn bucket_dir_for(app_data_dir: &Path, path: &str) -> PathBuf {
    history_root(app_data_dir).join(path_hash_for(path))
}

fn validate_version_id(version_id: &str) -> Result<(), AppError> {
    if version_id.is_empty()
        || version_id.len() > 40
        || !version_id.bytes().all(|b| b.is_ascii_digit())
    {
        return Err(AppError::invalid_path(format!(
            "Invalid history version id: {version_id}"
        )));
    }
    Ok(())
}

fn ensure_private_dir(dir: &Path) -> Result<(), AppError> {
    fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn write_private_bytes(target: &Path, bytes: &[u8]) -> Result<(), AppError> {
    let parent = target
        .parent()
        .ok_or_else(|| AppError::invalid_path("Missing parent directory"))?;
    let file_name = target
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| AppError::invalid_path("Invalid file name"))?;

    let pid = std::process::id();
    let seq = HISTORY_TMP_SEQ.fetch_add(1, Ordering::Relaxed);
    let tmp_path = parent.join(format!(".{file_name}.kalamos-tmp-{pid}-{seq}"));

    let write_res = (|| -> Result<(), AppError> {
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&tmp_path)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            file.set_permissions(fs::Permissions::from_mode(0o600))?;
        }
        file.write_all(bytes)?;
        file.sync_all()?;
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
    Ok(())
}

fn load_or_rebuild_meta(bucket_dir: &Path, fallback_path: &str) -> HistoryMeta {
    let meta_path = bucket_dir.join(META_FILE_NAME);
    if let Ok(raw) = fs::read_to_string(&meta_path) {
        if let Ok(mut meta) = serde_json::from_str::<HistoryMeta>(&raw) {
            meta.versions
                .retain(|v| validate_version_id(&v.id).is_ok() && bucket_dir.join(format!("{}.md", v.id)).is_file());
            meta.versions
                .sort_by_key(|a| std::cmp::Reverse(a.saved_at_ms));
            return meta;
        }
    }

    // Fallback: rebuild metadata from surviving `.md` files if `meta.json` is missing/corrupted.
    let mut versions = Vec::new();
    if let Ok(read_dir) = fs::read_dir(bucket_dir) {
        for entry in read_dir.flatten() {
            let p = entry.path();
            if !p.is_file() {
                continue;
            }
            let Some(stem) = p.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if p.extension().and_then(|e| e.to_str()) != Some("md")
                || validate_version_id(stem).is_err()
            {
                continue;
            }
            let Ok(saved_at_ms) = stem.parse::<u64>() else {
                continue;
            };
            let Ok(bytes) = fs::read(&p) else {
                continue;
            };
            versions.push(HistoryMetaEntry {
                id: stem.to_string(),
                saved_at_ms,
                size: bytes.len() as u64,
                content_hash: sha256_hex(&bytes),
            });
        }
    }
    versions.sort_by_key(|a| std::cmp::Reverse(a.saved_at_ms));
    HistoryMeta {
        original_path: fallback_path.to_string(),
        versions,
    }
}

fn save_meta(bucket_dir: &Path, meta: &HistoryMeta) -> Result<(), AppError> {
    let json = serde_json::to_vec_pretty(meta)?;
    write_private_bytes(&bucket_dir.join(META_FILE_NAME), &json)
}

fn cleanup_empty_bucket(bucket_dir: &Path) {
    let _ = fs::remove_file(bucket_dir.join(META_FILE_NAME));
    let _ = fs::remove_dir(bucket_dir);
}

fn enforce_total_size_limit(root: &Path, max_total_bytes: u64) -> Result<(), AppError> {
    if !root.exists() {
        return Ok(());
    }

    struct BucketState {
        dir: PathBuf,
        meta: HistoryMeta,
        dirty: bool,
    }

    let mut buckets: Vec<BucketState> = Vec::new();
    for entry in fs::read_dir(root)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta = load_or_rebuild_meta(&path, "");
        buckets.push(BucketState {
            dir: path,
            meta,
            dirty: false,
        });
    }

    let mut total_bytes: u64 = buckets
        .iter()
        .flat_map(|b| b.meta.versions.iter())
        .map(|v| v.size)
        .sum();

    if total_bytes <= max_total_bytes {
        return Ok(());
    }

    // Collect (saved_at_ms, bucket_idx, version_id, size) and evict globally oldest first.
    let mut candidates: Vec<(u64, usize, String, u64)> = Vec::new();
    for (idx, bucket) in buckets.iter().enumerate() {
        for v in &bucket.meta.versions {
            candidates.push((v.saved_at_ms, idx, v.id.clone(), v.size));
        }
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.2.cmp(&b.2)));

    for (_ts, bucket_idx, version_id, size) in candidates {
        if total_bytes <= max_total_bytes {
            break;
        }
        let bucket = &mut buckets[bucket_idx];
        let snap_path = bucket.dir.join(format!("{version_id}.md"));
        let _ = fs::remove_file(&snap_path);
        bucket.meta.versions.retain(|v| v.id != version_id);
        bucket.dirty = true;
        total_bytes = total_bytes.saturating_sub(size);
    }

    for bucket in buckets {
        if !bucket.dirty {
            continue;
        }
        if bucket.meta.versions.is_empty() {
            cleanup_empty_bucket(&bucket.dir);
        } else {
            let _ = save_meta(&bucket.dir, &bucket.meta);
        }
    }

    Ok(())
}

/// Snapshot the existing on-disk content of `path` *before* overwriting it with `new_content`.
///
/// Returns `Ok(Some(version))` when a new snapshot was written, or `Ok(None)` when
/// skipped (disabled, new file, identical content, or throttled autosave).
pub fn snapshot_before_save_in(
    app_data_dir: &Path,
    path: &str,
    new_content: &str,
    is_autosave: bool,
    policy: &HistoryPolicy,
    current_ms: u64,
) -> Result<Option<HistoryVersion>, AppError> {
    if !policy.enabled || path.trim().is_empty() {
        return Ok(None);
    }

    let target = Path::new(path);
    if !target.is_file() {
        return Ok(None);
    }

    let old_bytes = fs::read(target)?;
    // If disk content already equals what is being written, no revision happened.
    if old_bytes == new_content.as_bytes() {
        return Ok(None);
    }

    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| AppError::new(ErrorKind::Io, "history lock poisoned"))?;

    let root = history_root(app_data_dir);
    let canonical_path = canonical_history_key(path);
    let bucket_dir = root.join(sha256_hex(canonical_path.as_bytes()));

    let mut meta = if bucket_dir.is_dir() {
        load_or_rebuild_meta(&bucket_dir, &canonical_path)
    } else {
        HistoryMeta {
            original_path: canonical_path.clone(),
            versions: Vec::new(),
        }
    };
    meta.original_path = canonical_path;

    let old_hash = sha256_hex(&old_bytes);
    if let Some(latest) = meta.versions.first() {
        if latest.content_hash == old_hash {
            return Ok(None);
        }
        if is_autosave && current_ms.saturating_sub(latest.saved_at_ms) < policy.throttle_ms {
            return Ok(None);
        }
    }

    let saved_at_ms = match meta.versions.first() {
        Some(latest) if current_ms <= latest.saved_at_ms => latest.saved_at_ms + 1,
        _ => current_ms.max(1),
    };
    let id = saved_at_ms.to_string();

    ensure_private_dir(&root)?;
    ensure_private_dir(&bucket_dir)?;

    let snap_path = bucket_dir.join(format!("{id}.md"));
    write_private_bytes(&snap_path, &old_bytes)?;

    let size = old_bytes.len() as u64;
    let entry = HistoryMetaEntry {
        id: id.clone(),
        saved_at_ms,
        size,
        content_hash: old_hash,
    };
    meta.versions.insert(0, entry);

    // Per-file retention: keep the newest `max_versions`.
    let keep = policy.max_versions.max(1);
    if meta.versions.len() > keep {
        for evicted in meta.versions.drain(keep..) {
            let _ = fs::remove_file(bucket_dir.join(format!("{}.md", evicted.id)));
        }
    }

    save_meta(&bucket_dir, &meta)?;
    enforce_total_size_limit(&root, policy.max_total_bytes)?;

    // Check whether our snapshot survived total-size enforcement (e.g. single file > cap).
    let survived = bucket_dir.join(format!("{id}.md")).is_file();
    if !survived {
        return Ok(None);
    }

    Ok(Some(HistoryVersion {
        id,
        saved_at_ms,
        size,
    }))
}

pub fn list_history_in(app_data_dir: &Path, path: &str) -> Result<Vec<HistoryVersion>, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| AppError::new(ErrorKind::Io, "history lock poisoned"))?;

    let bucket_dir = bucket_dir_for(app_data_dir, path);
    if !bucket_dir.is_dir() {
        return Ok(Vec::new());
    }
    let meta = load_or_rebuild_meta(&bucket_dir, path);
    Ok(meta
        .versions
        .into_iter()
        .map(|v| HistoryVersion {
            id: v.id,
            saved_at_ms: v.saved_at_ms,
            size: v.size,
        })
        .collect())
}

pub fn read_history_version_in(
    app_data_dir: &Path,
    path: &str,
    version_id: &str,
) -> Result<String, AppError> {
    if path.trim().is_empty() {
        return Err(AppError::invalid_path("Path must not be empty"));
    }
    validate_version_id(version_id)?;

    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| AppError::new(ErrorKind::Io, "history lock poisoned"))?;

    let snap_path = bucket_dir_for(app_data_dir, path).join(format!("{version_id}.md"));
    let bytes = fs::read(&snap_path)?;
    String::from_utf8(bytes).map_err(|e| AppError::parse(e.to_string()))
}

pub fn get_history_stats_in(app_data_dir: &Path) -> Result<HistoryStats, AppError> {
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| AppError::new(ErrorKind::Io, "history lock poisoned"))?;

    let root = history_root(app_data_dir);
    if !root.is_dir() {
        return Ok(HistoryStats {
            total_bytes: 0,
            total_versions: 0,
            file_count: 0,
        });
    }

    let mut total_bytes = 0u64;
    let mut total_versions = 0u64;
    let mut file_count = 0u64;

    for entry in fs::read_dir(&root)? {
        let Ok(entry) = entry else { continue };
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let meta = load_or_rebuild_meta(&path, "");
        if !meta.versions.is_empty() {
            file_count += 1;
            total_versions += meta.versions.len() as u64;
            total_bytes += meta.versions.iter().map(|v| v.size).sum::<u64>();
        }
    }

    Ok(HistoryStats {
        total_bytes,
        total_versions,
        file_count,
    })
}

pub fn clear_all_history_in(app_data_dir: &Path) -> Result<(), AppError> {
    let _guard = HISTORY_LOCK
        .lock()
        .map_err(|_| AppError::new(ErrorKind::Io, "history lock poisoned"))?;

    let root = history_root(app_data_dir);
    if root.exists() {
        fs::remove_dir_all(&root)?;
    }
    Ok(())
}

/// Best-effort hook called by `files::save_file` before writing new content to disk.
pub(crate) fn snapshot_before_save_for_app(
    app: &tauri::AppHandle,
    path: &str,
    new_content: &str,
    is_autosave: bool,
) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    let settings = get_settings_in(&app_data_dir).unwrap_or_default();
    let policy = HistoryPolicy::from_settings(&settings);
    if let Err(err) = snapshot_before_save_in(
        &app_data_dir,
        path,
        new_content,
        is_autosave,
        &policy,
        now_ms(),
    ) {
        eprintln!("Failed to snapshot local history for {path}: {err}");
    }
}

#[tauri::command]
pub fn list_history(app: tauri::AppHandle, path: String) -> Result<Vec<HistoryVersion>, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    list_history_in(&app_data_dir, &path)
}

#[tauri::command]
pub fn read_history_version(
    app: tauri::AppHandle,
    path: String,
    version_id: String,
) -> Result<String, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    read_history_version_in(&app_data_dir, &path, &version_id)
}

#[tauri::command]
pub fn get_history_stats(app: tauri::AppHandle) -> Result<HistoryStats, AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    get_history_stats_in(&app_data_dir)
}

#[tauri::command]
pub fn clear_all_history(app: tauri::AppHandle) -> Result<(), AppError> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::invalid_path(e.to_string()))?;
    clear_all_history_in(&app_data_dir)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::files::save_file_impl;
    use tempfile::tempdir;

    fn test_policy() -> HistoryPolicy {
        HistoryPolicy {
            enabled: true,
            max_versions: 50,
            max_total_bytes: 200 * 1024 * 1024,
            throttle_ms: 5 * 60 * 1000,
        }
    }

    fn save_with_history(
        app_data: &Path,
        file: &Path,
        content: &str,
        is_autosave: bool,
        policy: &HistoryPolicy,
        ts: u64,
    ) -> Option<HistoryVersion> {
        let p = file.to_str().unwrap();
        let snap = snapshot_before_save_in(app_data, p, content, is_autosave, policy, ts)
            .expect("snapshot");
        save_file_impl(p, content).expect("save file");
        snap
    }

    #[test]
    fn sha256_matches_nist_vectors() {
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
    }

    #[test]
    fn snapshots_previous_disk_content_and_deduplicates_identical_content() {
        let app_data = tempdir().unwrap();
        let work = tempdir().unwrap();
        let note = work.path().join("note.md");
        let note_str = note.to_str().unwrap();
        let policy = test_policy();

        // First save creates the file: nothing on disk yet -> no snapshot.
        assert!(save_with_history(app_data.path(), &note, "# V1\n", false, &policy, 1_000).is_none());
        assert!(list_history_in(app_data.path(), note_str).unwrap().is_empty());

        // Second save: V1 is snapshotted before V2 is written.
        let v1 = save_with_history(app_data.path(), &note, "# V2\n", false, &policy, 2_000)
            .expect("v1 snapshot");
        assert_eq!(v1.saved_at_ms, 2_000);
        assert_eq!(v1.size, "# V1\n".len() as u64);

        // Saving identical content (V2 -> V2) creates no snapshot.
        assert!(save_with_history(app_data.path(), &note, "# V2\n", false, &policy, 3_000).is_none());

        // Third save: V2 is snapshotted before V3 is written.
        let v2 = save_with_history(app_data.path(), &note, "# V3\n", false, &policy, 4_000)
            .expect("v2 snapshot");
        assert_eq!(v2.saved_at_ms, 4_000);

        // If disk externally reverts to V2 (identical to latest snapshot V2), saving V4 skips duplicate.
        fs::write(&note, "# V2\n").unwrap();
        assert!(
            save_with_history(app_data.path(), &note, "# V4\n", false, &policy, 5_000).is_none()
        );

        let list = list_history_in(app_data.path(), note_str).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].id, v2.id);
        assert_eq!(list[1].id, v1.id);
        assert_eq!(
            read_history_version_in(app_data.path(), note_str, &list[0].id).unwrap(),
            "# V2\n"
        );
        assert_eq!(
            read_history_version_in(app_data.path(), note_str, &list[1].id).unwrap(),
            "# V1\n"
        );
    }

    #[test]
    fn autosave_is_throttled_while_manual_save_always_snapshots() {
        let app_data = tempdir().unwrap();
        let work = tempdir().unwrap();
        let note = work.path().join("draft.md");
        let note_str = note.to_str().unwrap();
        let policy = HistoryPolicy {
            throttle_ms: 300_000, // 5 minutes
            ..test_policy()
        };

        save_with_history(app_data.path(), &note, "v1", false, &policy, 1_000);
        // First autosave: no previous snapshot -> snapshots v1.
        assert!(save_with_history(app_data.path(), &note, "v2", true, &policy, 10_000).is_some());
        // Second autosave 10 seconds later -> throttled.
        assert!(save_with_history(app_data.path(), &note, "v3", true, &policy, 20_000).is_none());
        // Manual Cmd+S 5 seconds later -> bypasses throttle, snapshots v3.
        assert!(save_with_history(app_data.path(), &note, "v4", false, &policy, 25_000).is_some());
        // Autosave 1 minute after manual -> still inside throttle window since latest snapshot at 25_000.
        assert!(save_with_history(app_data.path(), &note, "v5", true, &policy, 85_000).is_none());
        // Autosave after throttle window (25_000 + 300_000 = 325_000) -> snapshots v5.
        assert!(save_with_history(app_data.path(), &note, "v6", true, &policy, 325_000).is_some());

        let list = list_history_in(app_data.path(), note_str).unwrap();
        let contents: Vec<String> = list
            .iter()
            .map(|v| read_history_version_in(app_data.path(), note_str, &v.id).unwrap())
            .collect();
        assert_eq!(contents, vec!["v5", "v3", "v1"]);
    }

    #[test]
    fn enforces_per_file_max_versions_limit() {
        let app_data = tempdir().unwrap();
        let work = tempdir().unwrap();
        let note = work.path().join("many.md");
        let note_str = note.to_str().unwrap();
        let policy = HistoryPolicy {
            max_versions: 3,
            ..test_policy()
        };

        save_with_history(app_data.path(), &note, "v0", false, &policy, 1_000);
        for i in 1..=6 {
            save_with_history(
                app_data.path(),
                &note,
                &format!("v{i}"),
                false,
                &policy,
                1_000 + i * 1_000,
            );
        }

        let list = list_history_in(app_data.path(), note_str).unwrap();
        assert_eq!(list.len(), 3);
        let contents: Vec<String> = list
            .iter()
            .map(|v| read_history_version_in(app_data.path(), note_str, &v.id).unwrap())
            .collect();
        assert_eq!(contents, vec!["v5", "v4", "v3"]);

        // Ensure evicted `.md` files were actually deleted from disk.
        let bucket = bucket_dir_for(app_data.path(), note_str);
        let md_count = fs::read_dir(&bucket)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("md"))
            .count();
        assert_eq!(md_count, 3);
    }

    #[test]
    fn enforces_global_total_size_cap_across_files() {
        let app_data = tempdir().unwrap();
        let work = tempdir().unwrap();
        let file_a = work.path().join("a.md");
        let file_b = work.path().join("b.md");
        let policy = HistoryPolicy {
            max_versions: 50,
            max_total_bytes: 25, // Each payload is 10 bytes -> at most 2 snapshots total across all files
            ..test_policy()
        };

        save_with_history(app_data.path(), &file_a, "aaaaaaaaa1", false, &policy, 1_000);
        save_with_history(app_data.path(), &file_b, "bbbbbbbbb1", false, &policy, 1_500);

        // Snapshot a1 at t=2000 (10 bytes total)
        save_with_history(app_data.path(), &file_a, "aaaaaaaaa2", false, &policy, 2_000);
        // Snapshot b1 at t=3000 (20 bytes total)
        save_with_history(app_data.path(), &file_b, "bbbbbbbbb2", false, &policy, 3_000);
        // Snapshot a2 at t=4000 (30 -> evicts a1, leaves b1 + a2 = 20 bytes)
        save_with_history(app_data.path(), &file_a, "aaaaaaaaa3", false, &policy, 4_000);
        // Snapshot b2 at t=5000 (30 -> evicts b1, leaves a2 + b2 = 20 bytes)
        save_with_history(app_data.path(), &file_b, "bbbbbbbbb3", false, &policy, 5_000);

        let a_list = list_history_in(app_data.path(), file_a.to_str().unwrap()).unwrap();
        let b_list = list_history_in(app_data.path(), file_b.to_str().unwrap()).unwrap();
        assert_eq!(a_list.len(), 1);
        assert_eq!(b_list.len(), 1);
        assert_eq!(
            read_history_version_in(app_data.path(), file_a.to_str().unwrap(), &a_list[0].id)
                .unwrap(),
            "aaaaaaaaa2"
        );
        assert_eq!(
            read_history_version_in(app_data.path(), file_b.to_str().unwrap(), &b_list[0].id)
                .unwrap(),
            "bbbbbbbbb2"
        );

        let stats = get_history_stats_in(app_data.path()).unwrap();
        assert_eq!(stats.total_bytes, 20);
        assert_eq!(stats.total_versions, 2);
        assert_eq!(stats.file_count, 2);

        // Evicting all snapshots of file_a removes its empty bucket dir too.
        save_with_history(app_data.path(), &file_b, "bbbbbbbbb4", false, &policy, 6_000);
        assert!(list_history_in(app_data.path(), file_a.to_str().unwrap())
            .unwrap()
            .is_empty());
        assert!(!bucket_dir_for(app_data.path(), file_a.to_str().unwrap()).exists());
    }

    #[test]
    fn disabled_history_writes_nothing_and_clear_removes_everything() {
        let app_data = tempdir().unwrap();
        let work = tempdir().unwrap();
        let note = work.path().join("doc.md");
        let note_str = note.to_str().unwrap();

        let off = HistoryPolicy {
            enabled: false,
            ..test_policy()
        };
        save_with_history(app_data.path(), &note, "v1", false, &off, 1_000);
        save_with_history(app_data.path(), &note, "v2", false, &off, 2_000);
        assert!(list_history_in(app_data.path(), note_str).unwrap().is_empty());
        assert!(!history_root(app_data.path()).exists());

        let on = test_policy();
        save_with_history(app_data.path(), &note, "v3", false, &on, 3_000);
        assert_eq!(list_history_in(app_data.path(), note_str).unwrap().len(), 1);

        clear_all_history_in(app_data.path()).unwrap();
        assert!(list_history_in(app_data.path(), note_str).unwrap().is_empty());
        assert_eq!(
            get_history_stats_in(app_data.path()).unwrap(),
            HistoryStats {
                total_bytes: 0,
                total_versions: 0,
                file_count: 0
            }
        );
    }

    #[test]
    fn rejects_invalid_version_ids() {
        let app_data = tempdir().unwrap();
        let work = tempdir().unwrap();
        let note = work.path().join("doc.md");
        let note_str = note.to_str().unwrap();
        for bad in ["", "../secret", "123/456", "abc", "123.md", ".."] {
            let err = read_history_version_in(app_data.path(), note_str, bad).unwrap_err();
            assert_eq!(err.kind, ErrorKind::InvalidPath, "expected InvalidPath for {bad}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn sets_private_0700_dir_and_0600_file_permissions_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let app_data = tempdir().unwrap();
        let work = tempdir().unwrap();
        let note = work.path().join("private.md");
        let note_str = note.to_str().unwrap();
        let policy = test_policy();

        save_with_history(app_data.path(), &note, "secret v1", false, &policy, 1_000);
        let v = save_with_history(app_data.path(), &note, "secret v2", false, &policy, 2_000)
            .expect("snapshot");

        let root = history_root(app_data.path());
        let bucket = bucket_dir_for(app_data.path(), note_str);
        let snap = bucket.join(format!("{}.md", v.id));
        let meta = bucket.join(META_FILE_NAME);

        assert_eq!(fs::metadata(&root).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&bucket).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(&snap).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(&meta).unwrap().permissions().mode() & 0o777, 0o600);
    }
}
