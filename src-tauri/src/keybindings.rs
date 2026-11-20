//! The user's keyboard shortcuts: `<userData>/keybindings.json`, in VS Code's format (a JSON array
//! with comments of `{ "key", "command", "when" }`). The page parses it and writes the first copy
//! (keybindings.ts); here it is only found, read, and watched so a save applies at once.

use std::{
    path::PathBuf,
    sync::mpsc::{self, RecvTimeoutError},
    thread,
    time::Duration,
};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;

use crate::core::{Res, emit, user_data};

static WATCHER: Mutex<Option<RecommendedWatcher>> = Mutex::new(None);

const FILE: &str = "keybindings.json";

fn path() -> PathBuf {
    user_data().join(FILE)
}

/// Where the file is (it may not exist yet: the page writes it, with the commands listed, on first open).
#[tauri::command]
pub async fn keybindings_path() -> Res<String> {
    Ok(path().to_string_lossy().into_owned())
}

/// The file's text (None when there is none), and from now on a "keybindings:changed" event on each save.
#[tauri::command]
pub async fn keybindings_read() -> Res<Option<String>> {
    watch();
    match tokio::fs::read_to_string(path()).await {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Editors save by writing a new file and renaming it over the old one, so the folder is watched,
/// not the file.
fn watch() {
    let mut slot = WATCHER.lock();
    if slot.is_some() {
        return;
    }
    let (tx, rx) = mpsc::channel::<()>();
    let watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        if let Ok(ev) = res
            && (ev.need_rescan() || ev.paths.iter().any(|p| p.file_name().is_some_and(|n| n == FILE)))
        {
            let _ = tx.send(());
        }
    });
    let Ok(mut watcher) = watcher else { return };
    if watcher.watch(&user_data(), RecursiveMode::NonRecursive).is_err() {
        return;
    }
    // one event per save: a save is several file events in a row
    thread::Builder::new()
        .name("keybindings-watch".into())
        .spawn(move || {
            while rx.recv().is_ok() {
                loop {
                    match rx.recv_timeout(Duration::from_millis(150)) {
                        Ok(()) => continue,
                        Err(RecvTimeoutError::Timeout) => break,
                        Err(RecvTimeoutError::Disconnected) => return,
                    }
                }
                // the page spreads the payload into the listener's arguments: an empty list, no arguments
                emit("keybindings:changed", Vec::<u8>::new());
            }
        })
        .ok();
    *slot = Some(watcher);
}
