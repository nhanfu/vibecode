//! App settings, kept in the user database (the `settings` table, one row per setting). An existing
//! `settings.json` of the Electron build is imported the first time.

use std::sync::LazyLock;

use parking_lot::RwLock;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::{
    core::{user_data, write_atomic},
    userdb,
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppSettings {
    pub recent_folders: Vec<String>,
    pub last_folder: Option<String>,
    /// "window" | "dropdown"
    pub mode: String,
    pub hotkey: String,
    pub drop_height: f64,
    pub drop_opacity: f64,
    pub hide_on_blur: bool,
    pub theme: String,
    pub model: String,
    pub effort: String,
    pub permission_mode: String,
    pub see_through: bool,
    /// web pages drawn dark while the app is dark
    pub web_dark: bool,
    pub editor_font: String,
    pub editor_font_size: f64,
    pub editor_ligatures: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub open_at_login: Option<bool>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            recent_folders: Vec::new(),
            last_folder: None,
            mode: "window".into(),
            hotkey: "Alt+`".into(),
            drop_height: 0.6,
            drop_opacity: 0.97,
            hide_on_blur: false,
            theme: "system".into(),
            model: "claude-opus-5-5".into(),
            effort: String::new(),
            permission_mode: String::new(),
            see_through: false,
            web_dark: true,
            editor_font: "JetBrains Mono".into(),
            editor_font_size: 12.0,
            editor_ligatures: true,
            open_at_login: None,
        }
    }
}

static CACHE: LazyLock<RwLock<AppSettings>> = LazyLock::new(|| {
    // the database first; the old settings.json is read once and moved in
    let s = userdb::settings_all().and_then(|m| serde_json::from_value::<AppSettings>(Value::Object(m)).ok()).unwrap_or_else(|| {
        let s: AppSettings = std::fs::read(user_data().join("settings.json")).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default();
        if let Ok(Value::Object(m)) = serde_json::to_value(&s) {
            let _ = userdb::settings_write(&m);
        }
        s
    });
    RwLock::new(s)
});

pub fn get() -> AppSettings {
    CACHE.read().clone()
}

/// Merges a partial patch (JSON object with camelCase keys) and saves.
pub async fn update(patch: Map<String, Value>) -> AppSettings {
    let next = {
        let mut cur = serde_json::to_value(&*CACHE.read()).unwrap_or_default();
        if let Value::Object(obj) = &mut cur {
            obj.extend(patch);
        }
        serde_json::from_value::<AppSettings>(cur).unwrap_or_else(|_| get())
    };
    *CACHE.write() = next.clone();
    if let Ok(Value::Object(m)) = serde_json::to_value(&next) {
        if userdb::settings_write(&m).is_err() {
            // no database: keep the old file working
            if let Ok(json) = serde_json::to_vec_pretty(&next) {
                let _ = write_atomic(user_data().join("settings.json"), json).await;
            }
        }
    }
    next
}

/// Typed single-field update, e.g. `set(|s| s.mode = "dropdown".into())`.
pub async fn set(f: impl FnOnce(&mut AppSettings)) -> AppSettings {
    let mut s = get();
    f(&mut s);
    let patch = match serde_json::to_value(&s) {
        Ok(Value::Object(m)) => m,
        _ => Map::new(),
    };
    update(patch).await
}

pub async fn remember_folder(folder: String) -> AppSettings {
    let lower = folder.to_lowercase();
    set(move |s| {
        s.recent_folders.retain(|f| f.to_lowercase() != lower);
        s.recent_folders.insert(0, folder.clone());
        s.recent_folders.truncate(10);
        s.last_folder = Some(folder);
    })
    .await
}
