//! The user's data in one DuckDB file: `<userData>/vibecode.duckdb` (override: `VIBECODE_DB`).
//!
//! Real tables, so it can be queried and backed up by copying one file:
//!   meta         schema version
//!   settings     one row per app setting (value is JSON)
//!   plan_items   plans and tasks (a tree through parent_id)
//!   open_chats   the chats open when the app quit, in tab order
//!   web_pages    torn-off web pages
//!   ui_prefs     small UI preferences (panel sizes, last model…) as key → text
//! Secrets (the key store, saved SQL passwords) are deliberately not here.
//!
//! The page keeps working with whole lists (`userdb_save` by table name); a save replaces the
//! table's rows in one transaction.

use std::{collections::HashMap, sync::LazyLock};

use anyhow::{Context, Result, bail};
use duckdb::{Connection, params};
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::core::{Res, user_data};

static DB: LazyLock<Mutex<Option<Connection>>> = LazyLock::new(|| Mutex::new(open().map_err(|e| eprintln!("userdb: {e:#}")).ok()));

/// Each step runs once, in order; `meta.schema_version` records how far this file has got.
const MIGRATIONS: &[&str] = &[
    // 1
    "CREATE TABLE settings (
        key     VARCHAR PRIMARY KEY,
        value   JSON NOT NULL,
        updated TIMESTAMP NOT NULL DEFAULT now()
     );
     CREATE TABLE ui_prefs (
        key     VARCHAR PRIMARY KEY,
        value   VARCHAR NOT NULL,
        updated TIMESTAMP NOT NULL DEFAULT now()
     );
     CREATE TABLE plan_items (
        id          VARCHAR PRIMARY KEY,
        project     VARCHAR,                                   -- folder it belongs to; NULL = every project
        parent_id   VARCHAR,                                   -- the plan it sits under; NULL = top level
        kind        VARCHAR NOT NULL CHECK (kind IN ('plan', 'task')),
        title       VARCHAR NOT NULL,
        description VARCHAR NOT NULL DEFAULT '',
        position    INTEGER NOT NULL CHECK (position >= 0),    -- order among its siblings
        updated     TIMESTAMP NOT NULL DEFAULT now(),
        CHECK (parent_id IS NULL OR parent_id <> id)
     );
     CREATE TABLE open_chats (
        position        INTEGER PRIMARY KEY CHECK (position >= 0),
        cwd             VARCHAR NOT NULL,
        agent           VARCHAR,                               -- NULL = Claude Code
        session_id      VARCHAR,
        title           VARCHAR NOT NULL,
        pinned_title    BOOLEAN NOT NULL DEFAULT false,
        model           VARCHAR,
        effort          VARCHAR,
        permission_mode VARCHAR,
        host            VARCHAR,                               -- NULL = this machine
        active          BOOLEAN NOT NULL DEFAULT false
     );
     CREATE TABLE web_pages (
        id       VARCHAR PRIMARY KEY,
        url      VARCHAR NOT NULL,
        title    VARCHAR NOT NULL DEFAULT '',
        position INTEGER NOT NULL CHECK (position >= 0)
     );",
];

fn open() -> Result<Connection> {
    let file = std::env::var_os("VIBECODE_DB").map(std::path::PathBuf::from).unwrap_or_else(|| user_data().join("vibecode.duckdb"));
    let conn = Connection::open(&file).with_context(|| format!("opening {}", file.display()))?;
    conn.execute_batch("CREATE TABLE IF NOT EXISTS meta (key VARCHAR PRIMARY KEY, value VARCHAR NOT NULL)")?;
    let have: usize = conn.query_row("SELECT value FROM meta WHERE key = 'schema_version'", [], |r| r.get::<_, String>(0)).ok().and_then(|v| v.parse().ok()).unwrap_or(0);
    if have > MIGRATIONS.len() {
        bail!("{} was written by a newer VIBE CODE (schema {have}, this one knows {})", file.display(), MIGRATIONS.len());
    }
    for (i, sql) in MIGRATIONS.iter().enumerate().skip(have) {
        tx(&conn, || {
            conn.execute_batch(sql)?;
            conn.execute("INSERT INTO meta VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params![(i + 1).to_string()])?;
            Ok(())
        })?;
    }
    Ok(conn)
}

fn with<T>(f: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
    let g = DB.lock();
    let conn = g.as_ref().context("the user database could not be opened")?;
    f(conn)
}

/// Runs `f` inside a transaction; any error rolls everything back.
fn tx<T>(conn: &Connection, f: impl FnOnce() -> Result<T>) -> Result<T> {
    conn.execute_batch("BEGIN")?;
    match f() {
        Ok(v) => {
            conn.execute_batch("COMMIT")?;
            Ok(v)
        }
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            Err(e)
        }
    }
}

/* ---------------- settings ---------------- */

pub fn settings_all() -> Option<Map<String, Value>> {
    with(|c| {
        let mut st = c.prepare("SELECT key, value::VARCHAR FROM settings")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|(k, v)| serde_json::from_str(&v).ok().map(|v| (k, v))).collect::<Map<_, _>>())
    })
    .ok()
    .filter(|m| !m.is_empty())
}

pub fn settings_write(all: &Map<String, Value>) -> Result<()> {
    with(|c| {
        tx(c, || {
            for (k, v) in all {
                c.execute("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = now()", params![k, v.to_string()])?;
            }
            Ok(())
        })
    })
}

/* ---------------- ui_prefs (key → text) ---------------- */

fn prefs_all() -> Result<HashMap<String, String>> {
    with(|c| {
        let mut st = c.prepare("SELECT key, value FROM ui_prefs")?;
        let rows = st.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    })
}

/// `null` deletes the key.
fn prefs_write(entries: HashMap<String, Option<String>>) -> Result<()> {
    with(|c| {
        tx(c, || {
            for (k, v) in entries {
                match v {
                    Some(v) => c.execute("INSERT INTO ui_prefs (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated = now()", params![k, v])?,
                    None => c.execute("DELETE FROM ui_prefs WHERE key = ?", params![k])?,
                };
            }
            Ok(())
        })
    })
}

/* ---------------- plan_items ---------------- */

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanItem {
    id: String,
    kind: String,
    title: String,
    #[serde(default)]
    description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_id: Option<String>,
}

fn load_plans(c: &Connection) -> Result<Vec<PlanItem>> {
    let mut st = c.prepare("SELECT id, kind, title, description, parent_id FROM plan_items ORDER BY position")?;
    let rows = st.query_map([], |r| Ok(PlanItem { id: r.get(0)?, kind: r.get(1)?, title: r.get(2)?, description: r.get(3)?, parent_id: r.get(4)? }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn save_plans(c: &Connection, items: Vec<PlanItem>) -> Result<()> {
    let ids: std::collections::HashSet<&str> = items.iter().map(|i| i.id.as_str()).collect();
    tx(c, || {
        c.execute_batch("DELETE FROM plan_items")?;
        let mut st = c.prepare("INSERT INTO plan_items (id, parent_id, kind, title, description, position) VALUES (?, ?, ?, ?, ?, ?)")?;
        for (pos, i) in items.iter().enumerate() {
            // a parent that no longer exists puts the item at the top level
            let parent = i.parent_id.as_deref().filter(|p| ids.contains(p) && *p != i.id);
            st.execute(params![i.id, parent, i.kind, i.title, i.description, pos as i32])?;
        }
        Ok(())
    })
}

/* ---------------- open_chats ---------------- */

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SavedChat {
    cwd: String,
    title: String,
    #[serde(default)]
    pinned_title: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    permission_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    host: Option<String>,
    #[serde(default)]
    active: bool,
}

fn load_chats(c: &Connection) -> Result<Vec<SavedChat>> {
    let mut st = c.prepare("SELECT cwd, title, pinned_title, agent, session_id, model, effort, permission_mode, host, active FROM open_chats ORDER BY position")?;
    let rows = st.query_map([], |r| {
        Ok(SavedChat { cwd: r.get(0)?, title: r.get(1)?, pinned_title: r.get(2)?, agent: r.get(3)?, session_id: r.get(4)?, model: r.get(5)?, effort: r.get(6)?, permission_mode: r.get(7)?, host: r.get(8)?, active: r.get(9)? })
    })?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn save_chats(c: &Connection, chats: Vec<SavedChat>) -> Result<()> {
    tx(c, || {
        c.execute_batch("DELETE FROM open_chats")?;
        let mut st = c.prepare("INSERT INTO open_chats (position, cwd, agent, session_id, title, pinned_title, model, effort, permission_mode, host, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")?;
        for (pos, ch) in chats.iter().enumerate() {
            st.execute(params![pos as i32, ch.cwd, ch.agent, ch.session_id, ch.title, ch.pinned_title, ch.model, ch.effort, ch.permission_mode, ch.host, ch.active])?;
        }
        Ok(())
    })
}

/* ---------------- web_pages ---------------- */

#[derive(Serialize, Deserialize)]
struct WebPage {
    id: String,
    url: String,
    #[serde(default)]
    title: String,
}

fn load_pages(c: &Connection) -> Result<Vec<WebPage>> {
    let mut st = c.prepare("SELECT id, url, title FROM web_pages ORDER BY position")?;
    let rows = st.query_map([], |r| Ok(WebPage { id: r.get(0)?, url: r.get(1)?, title: r.get(2)? }))?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

fn save_pages(c: &Connection, pages: Vec<WebPage>) -> Result<()> {
    tx(c, || {
        c.execute_batch("DELETE FROM web_pages")?;
        let mut st = c.prepare("INSERT INTO web_pages (id, url, title, position) VALUES (?, ?, ?, ?)")?;
        for (pos, p) in pages.iter().enumerate() {
            st.execute(params![p.id, p.url, p.title, pos as i32])?;
        }
        Ok(())
    })
}

/* ---------------- commands ---------------- */

/// Everything the page reads at startup: the UI preferences, and each list as JSON text.
#[derive(Serialize)]
pub struct Snapshot {
    prefs: HashMap<String, String>,
    plans: String,
    chats: String,
    pages: String,
}

#[tauri::command]
pub fn userdb_snapshot() -> Res<Snapshot> {
    let prefs = prefs_all()?;
    let snap = with(|c| Ok(Snapshot { prefs, plans: serde_json::to_string(&load_plans(c)?)?, chats: serde_json::to_string(&load_chats(c)?)?, pages: serde_json::to_string(&load_pages(c)?)? }))?;
    Ok(snap)
}

#[tauri::command]
pub fn userdb_prefs_write(entries: HashMap<String, Option<String>>) -> Res<()> {
    Ok(prefs_write(entries)?)
}

/// Replaces one list. `table`: "plans" | "chats" | "pages"; `json`: the whole list.
#[tauri::command]
pub fn userdb_save(table: String, json: String) -> Res<()> {
    with(|c| match table.as_str() {
        "plans" => save_plans(c, serde_json::from_str(&json)?),
        "chats" => save_chats(c, serde_json::from_str(&json)?),
        "pages" => save_pages(c, serde_json::from_str(&json)?),
        other => bail!("unknown table {other}"),
    })?;
    Ok(())
}

/// Folds the write-ahead log into the file so a copy of it is complete (on quit).
pub fn checkpoint() {
    let _ = with(|c| Ok(c.execute_batch("CHECKPOINT")?));
}
