use std::collections::BTreeSet;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use tauri::Emitter;

use crate::error::{AppError, ErrorKind};

pub const FS_CHANGED_EVENT: &str = "fs-changed";
pub const DEBOUNCE_MS: u64 = 200;
const MAX_BATCH_WINDOW_MS: u64 = 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FsChangedPayload {
    pub root: String,
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
    watcher.watch(&path, move |payload| {
        let _ = app.emit(FS_CHANGED_EVENT, payload);
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
}
