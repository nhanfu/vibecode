//! Plugins: folders with a `plugin.json`, found in `resources/plugins/` (shipped with the app), in
//! `<userData>/plugins/` (installed by the user, wins over a shipped one of the same id) and, while
//! developing, in `./plugins` of the checkout. See docs/plugins.md.
//!
//! A plugin can bring a **sidecar**: a program the app starts on a free localhost port (with a
//! random token), waits for, and shows in a panel as a web page. It can also bring an **MCP
//! server** (usually one of that sidecar's endpoints), which every chat is given. The app knows
//! nothing about what a plugin does: DBX, the first one, is only a manifest and a build script.

use std::{collections::HashMap, path::PathBuf, time::Duration};

use anyhow::{Context, Result, bail};
use parking_lot::Mutex;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::process::Child;

use crate::core::{Res, command, err, resource, user_data};

#[derive(Clone, Deserialize, Serialize)]
pub struct PanelSpec {
    pub title: String,
    #[serde(default)]
    pub icon: String,
    /// a built-in panel this one takes over (`"db"`), keeping the built-in one as a fallback
    #[serde(default)]
    pub replaces: Option<String>,
}

#[derive(Clone, Deserialize)]
struct Sidecar {
    /// relative to the plugin's folder
    command: String,
    #[serde(default)]
    args: Vec<String>,
    /// `{port}`, `{token}`, `{dir}` (the plugin's folder) and `{data}` (its private data folder) are filled in
    #[serde(default)]
    env: HashMap<String, String>,
    /// a path that answers 2xx when the sidecar is ready
    #[serde(default)]
    health: Option<String>,
    /// the page the panel shows
    #[serde(default = "root_path")]
    url: String,
    /// start with the app (needed when the plugin brings an MCP server chats should have)
    #[serde(default)]
    autostart: bool,
}

fn root_path() -> String {
    "/".into()
}

#[derive(Clone, Deserialize)]
struct McpSpec {
    name: String,
    path: String,
    #[serde(default)]
    bearer: bool,
}

#[derive(Clone, Deserialize)]
struct Manifest {
    id: String,
    name: String,
    #[serde(default)]
    version: String,
    #[serde(default)]
    description: String,
    #[serde(default)]
    license: String,
    #[serde(default)]
    homepage: String,
    #[serde(default)]
    panel: Option<PanelSpec>,
    #[serde(default)]
    sidecar: Option<Sidecar>,
    #[serde(default)]
    mcp: Option<McpSpec>,
}

#[derive(Clone)]
struct Plugin {
    manifest: Manifest,
    dir: PathBuf,
}

impl Plugin {
    fn program(&self) -> Option<PathBuf> {
        let cmd = &self.manifest.sidecar.as_ref()?.command;
        let p = self.dir.join(cmd);
        if p.is_file() {
            return Some(p);
        }
        let exe = p.with_extension("exe");
        (cfg!(windows) && exe.is_file()).then_some(exe)
    }
    /// Ready to run: a plugin with a sidecar needs its program built / installed.
    fn available(&self) -> bool {
        self.manifest.sidecar.is_none() || self.program().is_some()
    }
}

fn roots() -> Vec<PathBuf> {
    let mut v: Vec<PathBuf> = Vec::new();
    if let Some(d) = std::env::var_os("VIBE_PLUGINS_DIR") {
        v.push(d.into());
    }
    v.push(user_data().join("plugins"));
    v.push(resource("plugins"));
    if let Ok(cwd) = std::env::current_dir() {
        v.push(cwd.join("plugins"));
        v.push(cwd.join("..").join("plugins"));
    }
    if let Some(exe) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        for up in [".", "..", "../..", "../../..", "../../../.."] {
            v.push(exe.join(up).join("plugins"));
        }
    }
    v
}

/// Every plugin found, the first folder of an id winning.
fn discover() -> Vec<Plugin> {
    let mut out: Vec<Plugin> = Vec::new();
    for root in roots() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir()).collect();
        dirs.sort();
        for dir in dirs {
            let Ok(raw) = std::fs::read_to_string(dir.join("plugin.json")) else { continue };
            let Ok(manifest) = serde_json::from_str::<Manifest>(&raw) else { continue };
            if !out.iter().any(|p| p.manifest.id == manifest.id) {
                out.push(Plugin { manifest, dir });
            }
        }
    }
    out
}

fn find(id: &str) -> Option<Plugin> {
    discover().into_iter().find(|p| p.manifest.id == id)
}

/* ---------------- running sidecars ---------------- */

struct Running {
    port: u16,
    token: String,
    child: Child,
}

static RUNNING: Mutex<Option<HashMap<String, Running>>> = Mutex::new(None);
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

fn free_port() -> Result<u16> {
    Ok(std::net::TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port())
}

async fn healthy(port: u16, path: &str) -> bool {
    matches!(
        reqwest::Client::new().get(format!("http://127.0.0.1:{port}{path}")).timeout(Duration::from_secs(2)).send().await,
        Ok(r) if r.status().is_success()
    )
}

fn known(id: &str) -> Option<(u16, String)> {
    RUNNING.lock().as_ref()?.get(id).map(|r| (r.port, r.token.clone()))
}

/// Starts a plugin's sidecar (or finds it already up) and returns its port and token.
async fn ensure(plugin: &Plugin) -> Result<(u16, String)> {
    let id = plugin.manifest.id.clone();
    let side = plugin.manifest.sidecar.clone().context("this plugin has no sidecar")?;
    let _one_at_a_time = STARTING.lock().await;
    let health = side.health.clone().unwrap_or_else(root_path);
    if let Some((port, token)) = known(&id) {
        // still answering? (a crashed child leaves a stale port)
        if healthy(port, &health).await {
            return Ok((port, token));
        }
        if let Some(mut r) = RUNNING.lock().as_mut().and_then(|m| m.remove(&id)) {
            let _ = r.child.start_kill();
        }
    }
    let program = plugin.program().with_context(|| format!("{} is not built yet (see {}/README.md)", plugin.manifest.name, plugin.dir.display()))?;
    let port = free_port()?;
    let token = {
        let b: [u8; 24] = rand::rng().random();
        b.iter().map(|x| format!("{x:02x}")).collect::<String>()
    };
    let data = user_data().join("plugin-data").join(&id);
    std::fs::create_dir_all(&data)?;
    let fill = |s: &str| {
        s.replace("{port}", &port.to_string())
            .replace("{token}", &token)
            .replace("{dir}", &plugin.dir.to_string_lossy())
            .replace("{data}", &data.to_string_lossy())
    };
    let mut cmd = command(&program);
    cmd.current_dir(&plugin.dir)
        .args(side.args.iter().map(|a| fill(a)))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    for (k, v) in &side.env {
        cmd.env(k, fill(v));
    }
    let child = cmd.spawn().with_context(|| format!("could not start {}", plugin.manifest.name))?;
    RUNNING.lock().get_or_insert_with(HashMap::new).insert(id.clone(), Running { port, token: token.clone(), child });
    for _ in 0..100 {
        if healthy(port, &health).await {
            return Ok((port, token));
        }
        let exited = RUNNING.lock().as_mut().and_then(|m| m.get_mut(&id)).and_then(|r| r.child.try_wait().ok().flatten());
        if let Some(status) = exited {
            RUNNING.lock().as_mut().map(|m| m.remove(&id));
            bail!("{} exited at start ({status})", plugin.manifest.name);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    bail!("{} did not answer in time", plugin.manifest.name)
}

/// Stops every sidecar (the app is closing).
pub fn stop_all() {
    if let Some(map) = RUNNING.lock().take() {
        for (_, mut r) in map {
            let _ = r.child.start_kill();
        }
    }
}

/// Starts, in the background, the sidecars that ask for it, so chats get their MCP servers.
pub fn warm_up() {
    for p in discover() {
        if p.available() && p.manifest.sidecar.as_ref().is_some_and(|s| s.autostart) {
            tauri::async_runtime::spawn(async move {
                let _ = ensure(&p).await;
            });
        }
    }
}

/// The MCP servers plugins bring, for the config every chat starts with: `(name, config)`.
pub fn mcp_servers() -> Vec<(String, Value)> {
    let mut out = Vec::new();
    for p in discover() {
        let Some(m) = &p.manifest.mcp else { continue };
        let Some((port, token)) = known(&p.manifest.id) else { continue };
        let mut cfg = json!({ "type": "http", "url": format!("http://127.0.0.1:{port}{}", m.path) });
        if m.bearer {
            cfg["headers"] = json!({ "Authorization": format!("Bearer {token}") });
        }
        out.push((m.name.clone(), cfg));
    }
    out
}

/* ---------------- commands ---------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginInfo {
    id: String,
    name: String,
    version: String,
    description: String,
    license: String,
    homepage: String,
    panel: Option<PanelSpec>,
    /// ready to run (its program exists)
    available: bool,
    /// brings an MCP server to chats
    mcp: bool,
}

#[tauri::command]
pub fn plugin_list() -> Vec<PluginInfo> {
    discover()
        .into_iter()
        .map(|p| PluginInfo {
            available: p.available(),
            mcp: p.manifest.mcp.is_some(),
            id: p.manifest.id,
            name: p.manifest.name,
            version: p.manifest.version,
            description: p.manifest.description,
            license: p.manifest.license,
            homepage: p.manifest.homepage,
            panel: p.manifest.panel,
        })
        .collect()
}

#[derive(Serialize)]
pub struct Started {
    url: String,
}

/// A panel asks for its plugin's page (starting the sidecar the first time).
#[tauri::command]
pub async fn plugin_start(id: String) -> Res<Started> {
    let p = find(&id).ok_or_else(|| err(format!("no plugin \"{id}\"")))?;
    let side = p.manifest.sidecar.clone().ok_or_else(|| err("this plugin has no page"))?;
    let (port, _) = ensure(&p).await.map_err(|e| err(format!("{e:#}")))?;
    Ok(Started { url: format!("http://127.0.0.1:{port}{}", side.url) })
}
