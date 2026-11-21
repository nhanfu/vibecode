//! Terminals: one pseudo-console per chat / shell, streamed to the page through its own Channel.
//!
//! The pseudo-consoles live in ptyd (ptyd.rs), a process that outlives the app: this module is its
//! client. A chat's terminal is kept when the app quits or the page reloads, and the next start
//! attaches to it (`reuse`); a shell's is not.

use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        Arc, LazyLock,
        atomic::{AtomicU64, Ordering},
    },
    time::Duration,
};

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use tauri::ipc::Channel;
use tokio::sync::mpsc;

use crate::core::{Res, clean_env, err, which};
use crate::ptyd::{self, Daemon, Event, NewSession};

/* ---------------- coding agents ---------------- */

/// (id, command on PATH) — src/shared/agents.ts
const AGENTS: [(&str, &str); 7] = [
    ("claude", "claude"),
    ("codex", "codex"),
    ("grok", "grok"),
    ("gemini", "gemini"),
    ("qwen", "qwen"),
    ("copilot", "copilot"),
    ("opencode", "opencode"),
];

fn agent_cmd(id: Option<&str>) -> &'static str {
    let id = id.unwrap_or("claude");
    AGENTS.iter().find(|(a, _)| *a == id).map_or("claude", |(_, c)| c)
}

fn default_shell() -> String {
    static SHELL: LazyLock<String> = LazyLock::new(|| {
        if cfg!(windows) {
            which("pwsh.exe").map(|p| p.to_string_lossy().into_owned()).unwrap_or_else(|| "powershell.exe".into())
        } else {
            std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".into())
        }
    });
    SHELL.clone()
}

/// The `claude` executable, also where npm / the native installer put it when PATH misses it.
pub async fn claude_path() -> Option<PathBuf> {
    tokio::task::spawn_blocking(|| {
        which("claude").or_else(|| {
            if !cfg!(windows) {
                return None;
            }
            let home = crate::core::home();
            let appdata = std::env::var_os("APPDATA").map(PathBuf::from).unwrap_or_default();
            [home.join(".local").join("bin").join("claude.exe"), appdata.join("npm").join("claude.cmd")].into_iter().find(|p| p.exists())
        })
    })
    .await
    .ok()
    .flatten()
}

#[derive(Serialize)]
pub struct ClaudeInfo {
    found: bool,
    path: Option<String>,
    shell: String,
}

#[tauri::command]
pub async fn claude_detect() -> Res<ClaudeInfo> {
    let path = claude_path().await;
    Ok(ClaudeInfo { found: path.is_some(), path: path.map(|p| p.to_string_lossy().into_owned()), shell: default_shell() })
}

#[derive(Serialize)]
pub struct AgentInfo {
    id: &'static str,
    found: bool,
}

#[tauri::command]
pub async fn agents_detect() -> Res<Vec<AgentInfo>> {
    Ok(tokio::task::spawn_blocking(|| AGENTS.iter().map(|(id, cmd)| AgentInfo { id, found: which(cmd).is_some() }).collect()).await?)
}

/* ---------------- processes ---------------- */

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnOptions {
    id: String,
    cwd: String,
    /// "claude" | "shell"
    kind: String,
    agent: Option<String>,
    claude_args: Option<Vec<String>>,
    cols: u16,
    rows: u16,
    /// the terminal may already be running in ptyd (a chat from before the app was closed): attach to
    /// it instead of starting another
    #[serde(default)]
    reuse: bool,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum PtyMsg {
    Data { data: String },
    Exit { code: i32 },
}

enum Chunk {
    Data(Vec<u8>),
    Exit(i32),
}

/// PowerShell-safe argument.
fn quote_arg(a: &str) -> String {
    if !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "_-./:=".contains(c)) {
        a.to_owned()
    } else {
        format!("'{}'", a.replace('\'', "''"))
    }
}

/// The connection to ptyd, once made.
static DAEMON: Mutex<Option<Arc<Daemon>>> = Mutex::new(None);
static CONN: AtomicU64 = AtomicU64::new(0);
/// Where each terminal's output goes: the task that gathers it for the page.
static SINKS: LazyLock<Mutex<HashMap<String, mpsc::UnboundedSender<Chunk>>>> = LazyLock::new(Default::default);
/// Terminals that are running as far as this side knows.
static LIVE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// Terminals on screen right now. Their output goes out every 16 ms; the others' is gathered for
/// 50 ms — ten busy chats in the background then wake the page ~200×/s instead of ~2000×/s.
static VISIBLE: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);

fn on_event(conn: u64, ev: Event) {
    match ev {
        Event::Snapshot(id, data) | Event::Data(id, data) => {
            if let Some(tx) = SINKS.lock().get(&id) {
                let _ = tx.send(Chunk::Data(data));
            }
        }
        Event::Exit(id, code) => {
            LIVE.lock().remove(&id);
            if let Some(tx) = SINKS.lock().remove(&id) {
                let _ = tx.send(Chunk::Exit(code));
            }
        }
        Event::Error(id, message) => {
            LIVE.lock().remove(&id);
            if let Some(tx) = SINKS.lock().remove(&id) {
                let _ = tx.send(Chunk::Data(format!("\r\n\x1b[31mcould not start: {message}\x1b[0m\r\n").into_bytes()));
                let _ = tx.send(Chunk::Exit(1));
            }
        }
        Event::Closed => {
            // ptyd went away (it stopped, or was closed here): what ran in it is gone. Only the
            // current connection speaks for the terminals (a newer one may have replaced it).
            if CONN.load(Ordering::SeqCst) != conn {
                return;
            }
            *DAEMON.lock() = None;
            LIVE.lock().clear();
            for (_, tx) in SINKS.lock().drain() {
                // -1: found dead; the chat starts again by itself, resuming its conversation
                let _ = tx.send(Chunk::Exit(-1));
            }
        }
    }
}

/// The connection to ptyd, starting ptyd when it is not running. Blocks for a moment the first time.
fn daemon() -> Result<Arc<Daemon>, String> {
    if let Some(d) = DAEMON.lock().clone() {
        return Ok(d);
    }
    let conn = CONN.fetch_add(1, Ordering::SeqCst) + 1;
    let mut d = ptyd::connect_or_start(move |e| on_event(conn, e)).map_err(|e| format!("could not start the terminal service: {e}"))?;
    // an older ptyd with nothing worth keeping is replaced; one that holds chats is left alone
    if d.version != ptyd::VERSION && d.sessions.iter().all(|s| !s.persist) {
        d.quit_if_idle();
        std::thread::sleep(Duration::from_millis(300));
        d = ptyd::connect_or_start(move |e| on_event(conn, e)).map_err(|e| format!("could not start the terminal service: {e}"))?;
    }
    let d = Arc::new(d);
    *DAEMON.lock() = Some(d.clone());
    Ok(d)
}

fn current() -> Option<Arc<Daemon>> {
    DAEMON.lock().clone()
}

#[tauri::command]
pub async fn pty_spawn(opts: SpawnOptions, out: Channel<PtyMsg>) -> Res<()> {
    let shell = default_shell();
    let windows = cfg!(windows);

    let args: Vec<String> = if opts.kind == "claude" {
        let cmd = agent_cmd(opts.agent.as_deref());
        let mut parts = vec![cmd.to_owned()];
        parts.extend(opts.claude_args.unwrap_or_default());
        // hooks that tell the app which session the chat writes to (it changes on /clear, forks…)
        if cmd == "claude"
            && let Some(settings) = crate::mcp::settings_for(&opts.id)
        {
            parts.extend(["--settings".to_owned(), settings]);
        }
        // the chat's own Web tab and databases as MCP tools (Claude only); last, because
        // --mcp-config takes several values
        if cmd == "claude"
            && let Some(cfg) = crate::mcp::config_for(&opts.id)
        {
            parts.extend(["--mcp-config".to_owned(), cfg]);
        }
        let line = parts.iter().map(|p| quote_arg(p)).collect::<Vec<_>>().join(" ");
        // inside an interactive shell: when the agent exits the user lands in a shell in the
        // same folder instead of a dead pane
        if windows { vec!["-NoLogo".into(), "-NoExit".into(), "-Command".into(), line] } else { vec!["-lc".into(), format!("{line}; exec {shell}")] }
    } else if windows {
        vec!["-NoLogo".into()]
    } else {
        vec!["-l".into()]
    };

    let mut env: Vec<(String, String)> = clean_env().into_iter().collect();
    env.extend([("TERM".into(), "xterm-256color".into()), ("COLORTERM".into(), "truecolor".into()), ("FORCE_COLOR".into(), "1".into())]);
    let req = NewSession {
        id: opts.id.clone(),
        // a chat is kept when the app goes; a shell is not
        persist: opts.kind != "shell",
        reuse: opts.reuse,
        // Claude Code keys folder trust by the exact path (`E:/x` ≠ `E:\x`): hand it the native form
        cwd: if windows { opts.cwd.replace('/', "\\") } else { opts.cwd.clone() },
        program: shell,
        args,
        env,
        cols: opts.cols.max(2),
        rows: opts.rows.max(2),
    };

    let d = tokio::task::spawn_blocking(daemon).await?.map_err(err)?;
    // the output goes here from the first byte (a re-attached terminal starts with its screen)
    let (tx, mut rx) = mpsc::unbounded_channel::<Chunk>();
    SINKS.lock().insert(opts.id.clone(), tx);
    LIVE.lock().insert(opts.id.clone());
    if !d.spawn(&req) {
        SINKS.lock().remove(&opts.id);
        LIVE.lock().remove(&opts.id);
        return Err(err("the terminal service is not answering"));
    }

    // Claude Code redraws in many tiny chunks; one message per chunk floods the page and makes the
    // chat stutter. But a fixed gathering delay lands on every keystroke's echo (and a 5 ms sleep is
    // really ~16 ms on Windows' default timer), which made typing lag. So: output after a quiet
    // moment goes out at once; a running stream is sent at most once a frame (hidden: every 50 ms).
    let id = opts.id;
    tauri::async_runtime::spawn(async move {
        let mut carry: Vec<u8> = Vec::new();
        let mut last_send = std::time::Instant::now() - Duration::from_secs(1);
        let send = |carry: &mut Vec<u8>, out: &Channel<PtyMsg>| {
            if carry.is_empty() {
                return;
            }
            // keep a UTF-8 sequence that was cut in half for the next round
            let cut = match std::str::from_utf8(carry) {
                Ok(_) => carry.len(),
                Err(e) if e.error_len().is_none() => e.valid_up_to(),
                Err(_) => carry.len(),
            };
            let rest = carry.split_off(cut);
            let data = String::from_utf8_lossy(carry).into_owned();
            *carry = rest;
            if !data.is_empty() {
                let _ = out.send(PtyMsg::Data { data });
            }
        };
        // a sink replaced by a restart (or dropped by a page reset) ends the channel: that is not an exit
        while let Some(first) = rx.recv().await {
            let mut exit = None;
            match first {
                Chunk::Data(d) => carry.extend(d),
                Chunk::Exit(c) => exit = Some(c),
            }
            // whatever is already queued goes in the same piece
            while exit.is_none() {
                match rx.try_recv() {
                    Ok(Chunk::Data(d)) => carry.extend(d),
                    Ok(Chunk::Exit(c)) => exit = Some(c),
                    Err(_) => break,
                }
            }
            let gap = Duration::from_millis(if VISIBLE.lock().contains(&id) { 16 } else { 50 });
            let wait = gap.saturating_sub(last_send.elapsed());
            if exit.is_none() && !wait.is_zero() {
                let deadline = tokio::time::sleep(wait);
                tokio::pin!(deadline);
                while carry.len() < 256 * 1024 {
                    tokio::select! {
                        _ = &mut deadline => break,
                        m = rx.recv() => match m {
                            Some(Chunk::Data(d)) => carry.extend(d),
                            Some(Chunk::Exit(c)) => { exit = Some(c); break }
                            None => break,
                        }
                    }
                }
            }
            send(&mut carry, &out);
            last_send = std::time::Instant::now();
            if let Some(code) = exit {
                VISIBLE.lock().remove(&id);
                let _ = out.send(PtyMsg::Exit { code });
                break;
            }
        }
    });
    Ok(())
}

/// false when there is no live process for this id (it died without us hearing about it).
#[tauri::command]
pub fn pty_write(id: String, data: String) -> bool {
    if !LIVE.lock().contains(&id) {
        return false;
    }
    current().is_some_and(|d| d.input(&id, data.as_bytes()))
}

#[tauri::command]
pub fn pty_resize(id: String, cols: u16, rows: u16) {
    if let Some(d) = current() {
        d.resize(&id, cols.max(2), rows.max(2));
    }
}

#[tauri::command]
pub fn pty_visible(id: String, visible: bool) {
    let mut v = VISIBLE.lock();
    if visible {
        v.insert(id);
    } else {
        v.remove(&id);
    }
}

#[tauri::command]
pub fn pty_kill(id: String) {
    VISIBLE.lock().remove(&id);
    SINKS.lock().remove(&id);
    LIVE.lock().remove(&id);
    if let Some(d) = current() {
        d.kill(&id);
    }
}

/// The page asks for this on start: shells left from a page that was reloaded are stopped, and the
/// chats' terminals (still running in ptyd) are forgotten here until the page attaches to them again.
#[tauri::command]
pub fn pty_page_reset() {
    SINKS.lock().clear();
    LIVE.lock().clear();
    VISIBLE.lock().clear();
    if let Some(d) = current() {
        d.wipe();
    }
}

/// The chats' terminals that are still running in ptyd from before (empty when ptyd is not running).
#[tauri::command]
pub async fn pty_list() -> Vec<String> {
    tokio::task::spawn_blocking(|| {
        let d = match current() {
            Some(d) => d,
            // ptyd is not started for this: only looked for
            None => {
                let Some(info) = ptyd::read_info() else { return Vec::new() };
                let conn = CONN.fetch_add(1, Ordering::SeqCst) + 1;
                let Ok(d) = Daemon::connect(&info, move |e| on_event(conn, e)) else { return Vec::new() };
                let d = Arc::new(d);
                *DAEMON.lock() = Some(d.clone());
                d
            }
        };
        d.list().into_iter().filter(|s| s.persist).map(|s| s.id).collect()
    })
    .await
    .unwrap_or_default()
}

/// The app is going away (quit, restart, update): its connection to ptyd ends. The chats' terminals
/// keep running there; shells started here stop.
pub fn detach_all() {
    if let Some(d) = DAEMON.lock().take() {
        d.close();
    }
}
