use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::error::{AppError, ErrorKind};
use crate::files::sha256_hex;

pub const FS_CHANGED_EVENT: &str = "fs-changed";
pub const OPEN_FILES_CHANGED_EVENT: &str = "open-files-changed";
pub const DEBOUNCE_MS: u64 = 200;
const MAX_BATCH_WINDOW_MS: u64 = 1000;
const SELF_WRITE_TTL: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedPayload {
    pub root: String,
    pub paths: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenFilesChangedPayload {
    pub paths: Vec<String>,
}

struct ActiveWatch {
    active_flag: Arc<AtomicBool>,
    _watcher: RecommendedWatcher,
}

impl Drop for ActiveWatch {
    fn drop(&mut self) {
        self.active_flag.store(false, Ordering::SeqCst);
    }
}

#[derive(Default)]
pub struct WatcherManager {
    inner: Mutex<Option<ActiveWatch>>,
}

fn is_relevant_event(event: &Event) -> bool {
    !matches!(event.kind, EventKind::Access(_))
}

fn is_ignored_watch_path(path: &Path) -> bool {
    for component in path.components() {
        if let Some(s) = component.as_os_str().to_str() {
            if s == ".git" || s == "node_modules" || s.contains(".kalamos-tmp-") {
                return true;
            }
        }
    }
    false
}

fn collect_event_paths(event: Event, out: &mut BTreeSet<String>) {
    if !is_relevant_event(&event) {
        return;
    }
    for p in event.paths {
        if !is_ignored_watch_path(&p) {
            out.insert(p.to_string_lossy().into_owned());
        }
    }
}

impl WatcherManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
        }
    }

    pub fn watch<F>(&self, path: &str, on_change: F) -> Result<(), AppError>
    where
        F: Fn(FsChangedPayload) + Send + 'static,
    {
        if path.trim().is_empty() {
            return Err(AppError::invalid_path("Path must not be empty"));
        }
        let root_path = Path::new(path);
        if !root_path.exists() {
            return Err(AppError::not_found(format!(
                "Directory does not exist: {path}"
            )));
        }
        if !root_path.is_dir() {
            return Err(AppError::invalid_path(format!(
                "Path is not a directory: {path}"
            )));
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|e| AppError::new(ErrorKind::Watch, e.to_string()))?;

        // Drop previous active watcher first so old watches stop before new one starts
        *guard = None;

        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default(),
        )
        .map_err(|e| AppError::new(ErrorKind::Watch, e.to_string()))?;

        watcher
            .watch(root_path, RecursiveMode::Recursive)
            .map_err(|e| AppError::new(ErrorKind::Watch, e.to_string()))?;

        let active_flag = Arc::new(AtomicBool::new(true));
        let thread_flag = Arc::clone(&active_flag);
        let root_string = path.to_string();
        let debounce_duration = Duration::from_millis(DEBOUNCE_MS);
        let max_batch_window = Duration::from_millis(MAX_BATCH_WINDOW_MS);

        thread::spawn(move || {
            while let Ok(first_res) = rx.recv() {
                if !thread_flag.load(Ordering::SeqCst) {
                    break;
                }
                let mut paths = BTreeSet::new();
                if let Ok(event) = first_res {
                    collect_event_paths(event, &mut paths);
                }

                let batch_start = Instant::now();
                loop {
                    if !thread_flag.load(Ordering::SeqCst) {
                        return;
                    }
                    if batch_start.elapsed() >= max_batch_window {
                        break;
                    }
                    match rx.recv_timeout(debounce_duration) {
                        Ok(Ok(next_event)) => {
                            collect_event_paths(next_event, &mut paths);
                        }
                        Ok(Err(_)) => {}
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            return;
                        }
                    }
                }

                if thread_flag.load(Ordering::SeqCst) && !paths.is_empty() {
                    on_change(FsChangedPayload {
                        root: root_string.clone(),
                        paths: paths.into_iter().collect(),
                    });
                }
            }
        });

        *guard = Some(ActiveWatch {
            active_flag,
            _watcher: watcher,
        });

        Ok(())
    }
}

#[tauri::command]
pub fn watch_folder(
    app: tauri::AppHandle,
    watcher: tauri::State<'_, WatcherManager>,
    path: String,
) -> Result<(), AppError> {
    let _ = crate::images::allow_dir(&app, Path::new(&path));
    watcher.watch(&path, move |payload| {
        let _ = app.emit(FS_CHANGED_EVENT, payload);
    })
}

type FileKey = (PathBuf, String);

struct SelfWriteRecord {
    hash: String,
    expires_at: Instant,
}

fn normalize_dir_key(dir: &Path) -> PathBuf {
    let canon = dunce::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(canon.to_string_lossy().to_lowercase())
    }
    #[cfg(not(target_os = "windows"))]
    {
        canon
    }
}

fn canonical_file_key(path: &Path) -> Option<FileKey> {
    let file_name = path.file_name()?.to_string_lossy().into_owned();
    if file_name.is_empty() {
        return None;
    }
    let parent = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let dir_key = normalize_dir_key(parent);
    #[cfg(target_os = "windows")]
    let name_key = file_name.to_lowercase();
    #[cfg(not(target_os = "windows"))]
    let name_key = file_name;
    Some((dir_key, name_key))
}

fn should_suppress_self_write(
    self_writes: &Mutex<HashMap<FileKey, SelfWriteRecord>>,
    key: &FileKey,
    disk_path: &str,
) -> bool {
    let now = Instant::now();
    let expected_hash = {
        let Ok(mut guard) = self_writes.lock() else {
            return false;
        };
        guard.retain(|_, rec| rec.expires_at > now);
        guard.get(key).map(|rec| rec.hash.clone())
    };
    let Some(expected) = expected_hash else {
        return false;
    };
    match fs::read(disk_path) {
        Ok(bytes) if sha256_hex(&bytes) == expected => true,
        _ => {
            if let Ok(mut guard) = self_writes.lock() {
                guard.remove(key);
            }
            false
        }
    }
}

fn collect_open_file_event_matches(
    event: Event,
    file_map: &HashMap<FileKey, Vec<String>>,
    dir_to_files: &HashMap<PathBuf, Vec<(FileKey, String)>>,
    out: &mut HashMap<String, FileKey>,
) {
    if !is_relevant_event(&event) {
        return;
    }
    for p in event.paths {
        if is_ignored_watch_path(&p) {
            continue;
        }
        if let Some(key) = canonical_file_key(&p) {
            if let Some(originals) = file_map.get(&key) {
                for orig in originals {
                    out.insert(orig.clone(), key.clone());
                }
                continue;
            }
        }
        let dir_key = normalize_dir_key(&p);
        if let Some(entries) = dir_to_files.get(&dir_key) {
            for (key, orig) in entries {
                out.insert(orig.clone(), key.clone());
            }
        }
    }
}

/// Watches parent directories of all currently open named files (non-recursively)
/// so in-place edits, atomic temp+rename (iCloud/vim/etc.), deletes, and renames
/// are detected even for files outside any open sidebar folder.
#[derive(Default)]
pub struct FileWatcherManager {
    inner: Mutex<Option<ActiveWatch>>,
    self_writes: Arc<Mutex<HashMap<FileKey, SelfWriteRecord>>>,
}

impl FileWatcherManager {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(None),
            self_writes: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn record_self_write(&self, path: &str, hash: &str) {
        if let Some(key) = canonical_file_key(Path::new(path)) {
            if let Ok(mut guard) = self.self_writes.lock() {
                let now = Instant::now();
                guard.retain(|_, rec| rec.expires_at > now);
                guard.insert(
                    key,
                    SelfWriteRecord {
                        hash: hash.to_string(),
                        expires_at: now + SELF_WRITE_TTL,
                    },
                );
            }
        }
    }

    pub fn watch_files<F>(&self, paths: &[String], on_change: F) -> Result<(), AppError>
    where
        F: Fn(OpenFilesChangedPayload) + Send + 'static,
    {
        let mut file_map: HashMap<FileKey, Vec<String>> = HashMap::new();
        let mut dir_to_files: HashMap<PathBuf, Vec<(FileKey, String)>> = HashMap::new();
        let mut unique_watch_dirs: HashMap<PathBuf, PathBuf> = HashMap::new();

        for raw in paths {
            let trimmed = raw.trim();
            if trimmed.is_empty() {
                continue;
            }
            let path = Path::new(trimmed);
            let Some(key) = canonical_file_key(path) else {
                continue;
            };
            let parent = match path.parent() {
                Some(p) if !p.as_os_str().is_empty() => p,
                _ => Path::new("."),
            };
            if parent.exists() && parent.is_dir() {
                unique_watch_dirs
                    .entry(key.0.clone())
                    .or_insert_with(|| dunce::canonicalize(parent).unwrap_or_else(|_| parent.to_path_buf()));
            }
            let originals = file_map.entry(key.clone()).or_default();
            if !originals.iter().any(|existing| existing == trimmed) {
                originals.push(trimmed.to_string());
                dir_to_files
                    .entry(key.0.clone())
                    .or_default()
                    .push((key, trimmed.to_string()));
            }
        }

        let mut guard = self
            .inner
            .lock()
            .map_err(|e| AppError::new(ErrorKind::Watch, e.to_string()))?;

        // Drop previous active watcher first so old watches stop cleanly.
        *guard = None;

        if unique_watch_dirs.is_empty() {
            return Ok(());
        }

        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = RecommendedWatcher::new(
            move |res| {
                let _ = tx.send(res);
            },
            Config::default(),
        )
        .map_err(|e| AppError::new(ErrorKind::Watch, e.to_string()))?;

        let mut watched_any = false;
        for dir in unique_watch_dirs.values() {
            if watcher.watch(dir, RecursiveMode::NonRecursive).is_ok() {
                watched_any = true;
            }
        }
        if !watched_any {
            return Ok(());
        }

        let active_flag = Arc::new(AtomicBool::new(true));
        let thread_flag = Arc::clone(&active_flag);
        let self_writes = Arc::clone(&self.self_writes);
        let debounce_duration = Duration::from_millis(DEBOUNCE_MS);
        let max_batch_window = Duration::from_millis(MAX_BATCH_WINDOW_MS);

        thread::spawn(move || {
            while let Ok(first_res) = rx.recv() {
                if !thread_flag.load(Ordering::SeqCst) {
                    break;
                }
                let mut matched: HashMap<String, FileKey> = HashMap::new();
                if let Ok(event) = first_res {
                    collect_open_file_event_matches(event, &file_map, &dir_to_files, &mut matched);
                }

                let batch_start = Instant::now();
                loop {
                    if !thread_flag.load(Ordering::SeqCst) {
                        return;
                    }
                    if batch_start.elapsed() >= max_batch_window {
                        break;
                    }
                    match rx.recv_timeout(debounce_duration) {
                        Ok(Ok(next_event)) => {
                            collect_open_file_event_matches(
                                next_event,
                                &file_map,
                                &dir_to_files,
                                &mut matched,
                            );
                        }
                        Ok(Err(_)) => {}
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            break;
                        }
                        Err(mpsc::RecvTimeoutError::Disconnected) => {
                            return;
                        }
                    }
                }

                if thread_flag.load(Ordering::SeqCst) && !matched.is_empty() {
                    let mut changed_paths = BTreeSet::new();
                    for (orig_path, key) in matched {
                        if !should_suppress_self_write(&self_writes, &key, &orig_path) {
                            changed_paths.insert(orig_path);
                        }
                    }
                    if !changed_paths.is_empty() {
                        on_change(OpenFilesChangedPayload {
                            paths: changed_paths.into_iter().collect(),
                        });
                    }
                }
            }
        });

        *guard = Some(ActiveWatch {
            active_flag,
            _watcher: watcher,
        });

        Ok(())
    }
}

#[tauri::command]
pub fn watch_open_files(
    app: tauri::AppHandle,
    watcher: tauri::State<'_, FileWatcherManager>,
    paths: Vec<String>,
) -> Result<(), AppError> {
    watcher.watch_files(&paths, move |payload| {
        let _ = app.emit(OPEN_FILES_CHANGED_EVENT, payload);
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn emits_debounced_fs_changed_and_replaces_previous_watch() {
        let dir1 = tempdir().expect("tempdir 1");
        let dir2 = tempdir().expect("tempdir 2");
        let root1 = dir1.path().to_str().unwrap().to_string();
        let root2 = dir2.path().to_str().unwrap().to_string();

        let manager = WatcherManager::new();
        let (tx1, rx1) = mpsc::channel::<FsChangedPayload>();

        manager
            .watch(&root1, move |payload| {
                let _ = tx1.send(payload);
            })
            .expect("watch dir1");

        // Allow macOS FSEvents stream a brief moment to register
        thread::sleep(Duration::from_millis(80));

        // Rapidly write two files within <200ms to test debounce coalescing
        fs::write(dir1.path().join("first.md"), "# First").unwrap();
        fs::write(dir1.path().join("second.md"), "# Second").unwrap();

        let event1 = rx1
            .recv_timeout(Duration::from_secs(3))
            .expect("should receive debounced fs-changed event from dir1");
        assert_eq!(event1.root, root1);
        assert!(!event1.paths.is_empty());

        // Now call watch again on dir2, which must replace the dir1 watcher
        let (tx2, rx2) = mpsc::channel::<FsChangedPayload>();
        manager
            .watch(&root2, move |payload| {
                let _ = tx2.send(payload);
            })
            .expect("watch dir2 replacing dir1");

        thread::sleep(Duration::from_millis(80));
        // Drain any trailing event from rx1 before testing replacement
        while rx1.try_recv().is_ok() {}

        // Modify dir1 (no longer watched) and dir2 (currently watched)
        fs::write(dir1.path().join("ignored_after_replace.md"), "# Old").unwrap();
        fs::write(dir2.path().join("active.md"), "# New").unwrap();

        let event2 = rx2
            .recv_timeout(Duration::from_secs(3))
            .expect("should receive fs-changed from dir2");
        assert_eq!(event2.root, root2);
        assert!(!event2.paths.is_empty());

        // Ensure old watch did not receive events after being replaced
        assert!(rx1.recv_timeout(Duration::from_millis(300)).is_err());
    }

    #[test]
    fn watch_folder_validates_invalid_and_missing_paths() {
        let manager = WatcherManager::new();
        let err_empty = manager.watch("", |_| {}).unwrap_err();
        assert_eq!(err_empty.kind, ErrorKind::InvalidPath);

        let err_missing = manager
            .watch("/tmp/kalamos-non-existent-watch-dir-xyz", |_| {})
            .unwrap_err();
        assert_eq!(err_missing.kind, ErrorKind::NotFound);
    }

    #[test]
    fn open_file_watcher_detects_modify_atomic_rename_delete_and_suppresses_self_write() {
        use crate::files::{save_file_checked_impl, save_file_impl};

        let dir = tempdir().expect("tempdir");
        let note = dir.path().join("note.md");
        let other = dir.path().join("unrelated.md");
        let note_str = note.to_str().unwrap().to_string();
        fs::write(&note, "# V0\n").unwrap();
        fs::write(&other, "# Other\n").unwrap();

        let manager = FileWatcherManager::new();
        let (tx, rx) = mpsc::channel::<OpenFilesChangedPayload>();
        manager
            .watch_files(std::slice::from_ref(&note_str), move |payload| {
                let _ = tx.send(payload);
            })
            .expect("watch_files");

        // Allow OS watcher stream to register
        thread::sleep(Duration::from_millis(120));
        while rx.try_recv().is_ok() {}

        // 1. Self-write via save_file_checked_impl with record_self_write must be suppressed
        let v0_hash = sha256_hex(b"# V0\n");
        let res = save_file_checked_impl(&note_str, "# Self v1\n", Some(&v0_hash), |h| {
            manager.record_self_write(&note_str, h);
        })
        .expect("self save");
        assert!(matches!(res, crate::files::SaveFileResult::Saved { .. }));
        assert!(
            rx.recv_timeout(Duration::from_millis(600)).is_err(),
            "self-write should not trigger open-files-changed"
        );

        // 2. Direct external edit immediately after self-write IS detected (hash differs)
        fs::write(&note, "# External direct v2\n").unwrap();
        let ev_direct = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("should detect external direct write");
        assert!(ev_direct.paths.contains(&note_str));

        // 3. iCloud-style atomic write (temp file + rename over target) IS detected
        let icloud_tmp = dir.path().join(".note.md.icloud-tmp");
        fs::write(&icloud_tmp, "# External atomic v3\n").unwrap();
        fs::rename(&icloud_tmp, &note).unwrap();
        let ev_atomic = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("should detect iCloud-style temp+rename");
        assert!(ev_atomic.paths.contains(&note_str));

        // Second atomic write proves watching parent dir survives inode replacement
        let icloud_tmp2 = dir.path().join(".note.md.icloud-tmp2");
        fs::write(&icloud_tmp2, "# External atomic v4\n").unwrap();
        fs::rename(&icloud_tmp2, &note).unwrap();
        let ev_atomic2 = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("should detect subsequent atomic rename");
        assert!(ev_atomic2.paths.contains(&note_str));

        // 4. External rename away IS detected
        let moved = dir.path().join("note-moved.md");
        fs::rename(&note, &moved).unwrap();
        let ev_rename = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("should detect external rename away");
        assert!(ev_rename.paths.contains(&note_str));

        // Recreate & test external delete
        save_file_impl(&note_str, "# Recreated\n").expect("recreate");
        let _ = rx.recv_timeout(Duration::from_secs(2));
        while rx.try_recv().is_ok() {}
        fs::remove_file(&note).unwrap();
        let ev_delete = rx
            .recv_timeout(Duration::from_secs(3))
            .expect("should detect external delete");
        assert!(ev_delete.paths.contains(&note_str));
    }
}
