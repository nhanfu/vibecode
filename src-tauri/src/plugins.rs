//! Plugins: folders with a `plugin.json`, found in `resources/plugins/` (shipped with the app), in
//! `<userData>/plugins/` (installed by the user, wins over a shipped one of the same id) and, while
//! developing, in `./plugins` of the checkout. See docs/plugins.md.
//!
//! A plugin can bring a **sidecar**: a program the app starts on a free localhost port (with a
//! random token), waits for, and shows in a panel as a web page. It can also bring an **MCP
//! server** (usually one of that sidecar's endpoints), which every chat is given. The app knows
//! nothing about what a plugin does: DBX, the first one, is only a manifest and a build script.

use std::{
    sync::LazyLock,
    collections::{HashMap, HashSet, VecDeque},
    path::{Path, PathBuf},
    time::Duration,
};

use anyhow::{Context, Result, bail};
use parking_lot::Mutex;
use rand::RngExt;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::{io::{AsyncBufReadExt, AsyncRead, BufReader}, process::Child};

use crate::core::{Res, command, err, resource, user_data};

#[derive(Clone, Deserialize, Serialize)]
pub struct PanelSpec {
    pub title: String,
    #[serde(default)]
    pub icon: String,
    /// a built-in panel this one takes over (`"db"`), keeping the built-in one as a fallback
    #[serde(default)]
    pub replaces: Option<String>,
    /// the page opens on the project folder the sidebar shows (`?folder=` in its address)
    #[serde(default)]
    pub folder: bool,
}

/// Where a plugin keeps the app's light / dark choice: a JSON setting in a file of its data folder,
/// set to `light` or `dark` (the theme names the plugin itself uses).
#[derive(Clone, Deserialize)]
struct ThemeSpec {
    /// relative to the plugin's data folder
    file: String,
    key: String,
    dark: String,
    light: String,
}

#[derive(Clone, Deserialize)]
struct Sidecar {
    /// the light / dark choice written into the plugin's settings (see `ThemeSpec`)
    #[serde(default)]
    theme: Option<ThemeSpec>,
    /// a JSON settings file in the plugin's data folder that the user edits from the command palette and
    /// the page takes as its defaults (default: the theme's file)
    #[serde(default)]
    settings: Option<String>,
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
    /// the oldest app version it works with (`0.2.0`)
    #[serde(default, rename = "minAppVersion")]
    min_app_version: String,
    /// the systems it has a build for (`linux`, `windows`, `macos`); empty: all
    #[serde(default)]
    platforms: Vec<String>,
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Source {
    /// shipped with the app
    Bundled,
    /// installed by the user (`<userData>/plugins`)
    User,
    /// `$VIBE_PLUGINS_DIR`
    Dev,
}

#[derive(Clone)]
struct Plugin {
    manifest: Manifest,
    dir: PathBuf,
    source: Source,
    /// a copy of the same id further down the search order is hidden by this one
    overrides: bool,
}

const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// `1.2.10` > `1.2.9`: numeric parts, missing ones count as 0.
fn newer(a: &str, b: &str) -> bool {
    let parts = |v: &str| v.trim_start_matches('v').split(['.', '-', '+']).map(|x| x.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    let (a, b) = (parts(a), parts(b));
    for i in 0..a.len().max(b.len()) {
        let (x, y) = (a.get(i).copied().unwrap_or(0), b.get(i).copied().unwrap_or(0));
        if x != y {
            return x > y;
        }
    }
    false
}

fn on_this_system(platforms: &[String]) -> bool {
    platforms.is_empty() || platforms.iter().any(|p| p.eq_ignore_ascii_case(std::env::consts::OS))
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
    /// Why it cannot run here (`None`: ready). A plugin with a sidecar needs its program built / installed.
    fn problem(&self) -> Option<String> {
        let m = &self.manifest;
        if !on_this_system(&m.platforms) {
            return Some(format!("no build for {} (only {})", std::env::consts::OS, m.platforms.join(", ")));
        }
        if !m.min_app_version.is_empty() && newer(&m.min_app_version, APP_VERSION) {
            return Some(format!("needs app {} or newer (this is {APP_VERSION})", m.min_app_version));
        }
        if m.sidecar.is_some() && self.program().is_none() {
            return Some("its program is missing (not built or installed)".into());
        }
        None
    }
    fn available(&self) -> bool {
        self.problem().is_none()
    }
}

fn user_plugins() -> PathBuf {
    user_data().join("plugins")
}

fn roots() -> Vec<(PathBuf, Source)> {
    let mut v: Vec<(PathBuf, Source)> = Vec::new();
    if let Some(d) = std::env::var_os("VIBE_PLUGINS_DIR") {
        v.push((d.into(), Source::Dev));
    }
    v.push((user_plugins(), Source::User));
    v.push((resource("plugins"), Source::Bundled));
    if let Ok(cwd) = std::env::current_dir() {
        v.push((cwd.join("plugins"), Source::Bundled));
        v.push((cwd.join("..").join("plugins"), Source::Bundled));
    }
    if let Some(exe) = std::env::current_exe().ok().and_then(|e| e.parent().map(|p| p.to_path_buf())) {
        for up in [".", "..", "../..", "../../..", "../../../.."] {
            v.push((exe.join(up).join("plugins"), Source::Bundled));
        }
    }
    v
}

/// Every plugin found, the first folder of an id winning.
fn discover() -> Vec<Plugin> {
    let mut out: Vec<Plugin> = Vec::new();
    for (root, source) in roots() {
        let Ok(rd) = std::fs::read_dir(&root) else { continue };
        let mut dirs: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.is_dir() && !p.file_name().is_some_and(|n| n.to_string_lossy().starts_with('.'))).collect();
        dirs.sort();
        for dir in dirs {
            let Ok(raw) = std::fs::read_to_string(dir.join("plugin.json")) else { continue };
            let Ok(manifest) = serde_json::from_str::<Manifest>(&raw) else { continue };
            // the same folder reached through two roots (`plugins` and `../plugins`) is not a copy
            let same = |p: &Plugin| p.dir.canonicalize().ok() == dir.canonicalize().ok();
            match out.iter_mut().find(|p| p.manifest.id == manifest.id) {
                Some(first) => first.overrides |= !same(first),
                None => out.push(Plugin { manifest, dir, source, overrides: false }),
            }
        }
    }
    // removed from the app (its files are kept): not listed until it is installed again
    out.retain(|p| !prefs(|s| s.plugins.get(&p.manifest.id).is_some_and(|x| x.removed)));
    out
}

fn find(id: &str) -> Option<Plugin> {
    discover().into_iter().find(|p| p.manifest.id == id)
}

/* ---------------- settings (enabled / autostart / registry) ---------------- */

#[derive(Default, Clone, Serialize, Deserialize)]
struct PluginPrefs {
    #[serde(default)]
    disabled: bool,
    /// overrides the manifest's `sidecar.autostart`
    #[serde(default)]
    autostart: Option<bool>,
    /// removed from the app by the user; its files are kept
    #[serde(default)]
    removed: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct Prefs {
    /// where "Browse" looks for plugins (an index.json)
    #[serde(default)]
    registry: Option<String>,
    #[serde(default)]
    plugins: HashMap<String, PluginPrefs>,
}

static PREFS: Mutex<Option<Prefs>> = Mutex::new(None);

fn prefs_path() -> PathBuf {
    user_data().join("plugin-settings.json")
}

fn prefs<R>(f: impl FnOnce(&mut Prefs) -> R) -> R {
    let mut guard = PREFS.lock();
    let p = guard.get_or_insert_with(|| std::fs::read_to_string(prefs_path()).ok().and_then(|raw| serde_json::from_str(&raw).ok()).unwrap_or_default());
    f(p)
}

/// Change the settings and save them.
fn update_prefs(f: impl FnOnce(&mut Prefs)) {
    prefs(|p| {
        f(p);
        if let Ok(raw) = serde_json::to_string_pretty(p) {
            let _ = std::fs::write(prefs_path(), raw);
        }
    });
}

fn enabled(id: &str) -> bool {
    !prefs(|p| p.plugins.get(id).is_some_and(|x| x.disabled))
}

fn autostarts(plugin: &Plugin) -> bool {
    let manifest = plugin.manifest.sidecar.as_ref().is_some_and(|s| s.autostart);
    prefs(|p| p.plugins.get(&plugin.manifest.id).and_then(|x| x.autostart)).unwrap_or(manifest)
}

/* ---------------- running sidecars ---------------- */

struct Running {
    port: u16,
    token: String,
    child: Child,
}

static RUNNING: Mutex<Option<HashMap<String, Running>>> = Mutex::new(None);
static STARTING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());
/// ids being started right now (for the status)
static STARTING_IDS: LazyLock<Mutex<HashSet<String>>> = LazyLock::new(Default::default);
/// why a sidecar last failed to start or exited
static ERRORS: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(Default::default);
/// the last lines each sidecar printed (and what the app did to it)
static LOGS: LazyLock<Mutex<HashMap<String, VecDeque<String>>>> = LazyLock::new(Default::default);

const LOG_LINES: usize = 1000;

fn log(id: &str, line: impl Into<String>) {
    let mut line: String = line.into();
    if line.len() > 2000 {
        line = line.chars().take(2000).collect();
    }
    let mut logs = LOGS.lock();
    let q = logs.entry(id.to_string()).or_default();
    if q.len() >= LOG_LINES {
        q.pop_front();
    }
    q.push_back(line);
}

/// Copies a sidecar's output into its log.
fn pump(id: String, r: impl AsyncRead + Unpin + Send + 'static) {
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(r).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            log(&id, line);
        }
    });
}

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
    let _one_at_a_time = STARTING.lock().await;
    STARTING_IDS.lock().insert(id.clone());
    let r = launch(plugin).await;
    STARTING_IDS.lock().remove(&id);
    match &r {
        Ok(_) => {
            ERRORS.lock().remove(&id);
        }
        Err(e) => {
            ERRORS.lock().insert(id.clone(), format!("{e:#}"));
            log(&id, format!("[error] {e:#}"));
        }
    }
    r
}

async fn launch(plugin: &Plugin) -> Result<(u16, String)> {
    let id = plugin.manifest.id.clone();
    let side = plugin.manifest.sidecar.clone().context("this plugin has no sidecar")?;
    if let Some(why) = plugin.problem() {
        bail!("{} cannot run: {why}", plugin.manifest.name);
    }
    let health = side.health.clone().unwrap_or_else(root_path);
    if let Some((port, token)) = known(&id) {
        // still answering? (a crashed child leaves a stale port)
        if healthy(port, &health).await {
            return Ok((port, token));
        }
        if let Some(mut r) = RUNNING.lock().as_mut().and_then(|m| m.remove(&id)) {
            kill_sidecar(&id, &mut r);
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
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    for (k, v) in &side.env {
        cmd.env(k, fill(v));
    }
    die_with_app(&mut cmd);
    own_group(&mut cmd);
    log(&id, format!("[start] {} on port {port}", program.display()));
    let mut child = cmd.spawn().with_context(|| format!("could not start {}", plugin.manifest.name))?;
    if let Some(pid) = child.id() {
        let _ = std::fs::write(pidfile(&id), format!("{pid}\n{}", program.display()));
    }
    if let Some(o) = child.stdout.take() {
        pump(id.clone(), o);
    }
    if let Some(e) = child.stderr.take() {
        pump(id.clone(), e);
    }
    RUNNING.lock().get_or_insert_with(HashMap::new).insert(id.clone(), Running { port, token: token.clone(), child });
    for _ in 0..100 {
        if healthy(port, &health).await {
            log(&id, "[ready]");
            return Ok((port, token));
        }
        let exited = RUNNING.lock().as_mut().and_then(|m| m.get_mut(&id)).and_then(|r| r.child.try_wait().ok().flatten());
        if let Some(status) = exited {
            RUNNING.lock().as_mut().map(|m| m.remove(&id));
            bail!("{} exited at start ({status})", plugin.manifest.name);
        }
        tokio::time::sleep(Duration::from_millis(150)).await;
    }
    if let Some(mut r) = RUNNING.lock().as_mut().and_then(|m| m.remove(&id)) {
        kill_sidecar(&id, &mut r);
    }
    bail!("{} did not answer in time", plugin.manifest.name)
}

/// The sidecar gets SIGKILL when the app dies, however it dies (a killed dev run, a crash): otherwise
/// it lives on holding its port and, in dev, the file the next build wants to overwrite.
#[cfg(target_os = "linux")]
fn die_with_app(cmd: &mut tokio::process::Command) {
    // SAFETY: only async-signal-safe calls (prctl, getppid) between fork and exec.
    unsafe {
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
            // the app may have died before the call above took effect
            if libc::getppid() == 1 {
                libc::_exit(1);
            }
            Ok(())
        });
    }
}
#[cfg(not(target_os = "linux"))]
fn die_with_app(_cmd: &mut tokio::process::Command) {}

/// The sidecar and everything it starts (VS Code's server has a language server, an extension host, a
/// file watcher…) form a process group of their own, so that stopping it stops all of them. Killing
/// only the program left the rest running, and a wrapper script's child outlived its parent.
#[cfg(unix)]
fn own_group(cmd: &mut tokio::process::Command) {
    cmd.process_group(0);
}
#[cfg(not(unix))]
fn own_group(_cmd: &mut tokio::process::Command) {}

#[cfg(unix)]
fn kill_group(pid: u32) {
    // SAFETY: plain signal to a process group; a group that is gone just answers ESRCH.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGKILL);
    }
}
#[cfg(not(unix))]
fn kill_group(_pid: u32) {}

/// Where the pid of a plugin's running sidecar is noted, so the next run of the app can find one
/// the last run left behind (`reap_stale`).
fn pidfile(id: &str) -> PathBuf {
    user_data().join("plugin-data").join(id).join("sidecar.pid")
}

fn kill_sidecar(id: &str, r: &mut Running) {
    if let Some(pid) = r.child.id() {
        kill_group(pid);
    }
    let _ = r.child.start_kill();
    let _ = std::fs::remove_file(pidfile(id));
}

/// A sidecar the previous run of the app did not get to stop (it was killed, or crashed) is stopped
/// now, once, before any starts. Only when the pid still belongs to that program.
#[cfg(unix)]
fn reap_stale(id: &str) {
    let Ok(raw) = std::fs::read_to_string(pidfile(id)) else { return };
    let _ = std::fs::remove_file(pidfile(id));
    let mut lines = raw.lines();
    let (Some(pid), Some(program)) = (lines.next().and_then(|p| p.trim().parse::<u32>().ok()), lines.next()) else { return };
    let args = crate::core::command_sync("ps").args(["-p", &pid.to_string(), "-o", "args="]).output().ok().map(|o| String::from_utf8_lossy(&o.stdout).into_owned()).unwrap_or_default();
    if args.contains(program) {
        kill_group(pid);
        // a sidecar from before it had a group of its own: the program alone
        // SAFETY: a plain signal to a pid whose command line was just checked.
        unsafe {
            libc::kill(pid as i32, libc::SIGKILL);
        }
    }
}
#[cfg(not(unix))]
fn reap_stale(_id: &str) {}

/// Stops one sidecar; false when it was not running.
fn stop(id: &str) -> bool {
    let r = RUNNING.lock().as_mut().and_then(|m| m.remove(id));
    match r {
        Some(mut r) => {
            kill_sidecar(id, &mut r);
            log(id, "[stopped]");
            true
        }
        None => false,
    }
}

/// Stops every sidecar (the app is closing).
pub fn stop_all() {
    if let Some(map) = RUNNING.lock().take() {
        for (id, mut r) in map {
            kill_sidecar(&id, &mut r);
        }
    }
}

/// Starts, in the background, the sidecars that ask for it, so chats get their MCP servers.
pub fn warm_up() {
    for p in discover() {
        reap_stale(&p.manifest.id);
        if p.available() && enabled(&p.manifest.id) && p.manifest.sidecar.is_some() && autostarts(&p) {
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
        if !enabled(&p.manifest.id) {
            continue;
        }
        let Some((port, token)) = known(&p.manifest.id) else { continue };
        let mut cfg = json!({ "type": "http", "url": format!("http://127.0.0.1:{port}{}", m.path) });
        if m.bearer {
            cfg["headers"] = json!({ "Authorization": format!("Bearer {token}") });
        }
        out.push((m.name.clone(), cfg));
    }
    out
}

/* ---------------- installing ---------------- */

const MAX_DOWNLOAD: u64 = 600 * 1024 * 1024;

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Reads and checks the `plugin.json` of a folder about to be installed.
fn check_manifest(dir: &Path) -> Result<Manifest> {
    let raw = std::fs::read_to_string(dir.join("plugin.json")).context("there is no plugin.json in it")?;
    let m: Manifest = serde_json::from_str(&raw).context("plugin.json is not valid")?;
    if !valid_id(&m.id) {
        bail!("the plugin id \"{}\" must be lowercase letters, digits, - or _", m.id);
    }
    if let Some(s) = &m.sidecar {
        let c = Path::new(&s.command);
        if c.is_absolute() || c.components().any(|x| matches!(x, std::path::Component::ParentDir)) {
            bail!("the sidecar command must stay inside the plugin's folder");
        }
    }
    if !on_this_system(&m.platforms) {
        bail!("{} has no build for {} (only {})", m.name, std::env::consts::OS, m.platforms.join(", "));
    }
    Ok(m)
}

fn copy_dir(from: &Path, to: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(to)?;
    for e in std::fs::read_dir(from)? {
        let e = e?;
        let (kind, dst) = (e.file_type()?, to.join(e.file_name()));
        if kind.is_dir() {
            copy_dir(&e.path(), &dst)?;
        } else if kind.is_file() {
            std::fs::copy(e.path(), &dst)?; // keeps the executable bit
        }
    }
    Ok(())
}

/// Copies a plugin folder into `<userData>/plugins/<id>`, replacing a previous install.
fn install_dir(src: &Path) -> Result<String> {
    let m = check_manifest(src)?;
    let dest = user_plugins().join(&m.id);
    if src.canonicalize().ok() == dest.canonicalize().ok() {
        bail!("{} is already installed from that folder", m.name);
    }
    std::fs::create_dir_all(user_plugins())?;
    let tmp = user_plugins().join(format!(".{}.new", m.id));
    let _ = std::fs::remove_dir_all(&tmp);
    copy_dir(src, &tmp).context("could not copy the plugin")?;
    stop(&m.id);
    let _ = std::fs::remove_dir_all(&dest);
    std::fs::rename(&tmp, &dest).context("could not put the plugin in place")?;
    log(&m.id, format!("[installed] {} {}", m.name, m.version));
    Ok(m.id)
}

fn extract(archive: &Path, to: &Path) -> Result<()> {
    use std::io::Read;
    let mut magic = [0u8; 2];
    std::fs::File::open(archive)?.read_exact(&mut magic).context("the file is empty")?;
    let file = std::fs::File::open(archive)?;
    match &magic {
        b"PK" => zip::ZipArchive::new(file)?.extract(to).context("could not unpack the .zip")?,
        [0x1f, 0x8b] => tar::Archive::new(flate2::read::GzDecoder::new(file)).unpack(to).context("could not unpack the .tar.gz")?,
        _ => bail!("only .zip and .tar.gz archives (or a folder) can be installed"),
    }
    Ok(())
}

/// The folder holding plugin.json: the archive's root, or its one top folder.
fn plugin_root(dir: &Path) -> Option<PathBuf> {
    if dir.join("plugin.json").is_file() {
        return Some(dir.to_path_buf());
    }
    std::fs::read_dir(dir).ok()?.flatten().map(|e| e.path()).find(|p| p.is_dir() && p.join("plugin.json").is_file())
}

fn install_archive(archive: &Path) -> Result<String> {
    let tmp = user_data().join("tmp").join(uuid::Uuid::new_v4().to_string());
    std::fs::create_dir_all(&tmp)?;
    let out = tmp.join("x");
    let r = extract(archive, &out).and_then(|_| install_dir(&plugin_root(&out).context("there is no plugin.json in the archive")?));
    let _ = std::fs::remove_dir_all(&tmp);
    r
}

fn https_or_local(url: &reqwest::Url) -> bool {
    url.scheme() == "https" || (url.scheme() == "http" && matches!(url.host_str(), Some("127.0.0.1" | "localhost")))
}

/// Downloads `url` into `dir/archive`, checking its SHA-256 when one is given.
async fn download(url: &str, sha256: Option<&str>, dir: &Path) -> Result<PathBuf> {
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;
    let u = reqwest::Url::parse(url).context("that is not a link")?;
    if !https_or_local(&u) {
        bail!("plugins can only be downloaded over https");
    }
    let mut resp = reqwest::Client::builder().timeout(Duration::from_secs(600)).build()?.get(u).send().await?.error_for_status().context("the download failed")?;
    let path = dir.join("archive");
    let mut file = tokio::fs::File::create(&path).await?;
    let (mut hash, mut total) = (Sha256::new(), 0u64);
    while let Some(chunk) = resp.chunk().await? {
        total += chunk.len() as u64;
        if total > MAX_DOWNLOAD {
            bail!("the download is larger than {} MB", MAX_DOWNLOAD / 1024 / 1024);
        }
        hash.update(&chunk);
        file.write_all(&chunk).await?;
    }
    file.flush().await?;
    if let Some(want) = sha256.map(str::trim).filter(|w| !w.is_empty()) {
        let got: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
        if !got.eq_ignore_ascii_case(want) {
            bail!("the checksum does not match (expected {want}, got {got})");
        }
    }
    Ok(path)
}

/* ---------------- registry ---------------- */

const DEFAULT_REGISTRY: &str = "https://raw.githubusercontent.com/nhanfu/vibecode/master/plugins/index.json";

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RegistryEntry {
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
    /// the .zip / .tar.gz to install from
    url: String,
    #[serde(default)]
    sha256: Option<String>,
    #[serde(default)]
    min_app_version: String,
    #[serde(default)]
    platforms: Vec<String>,
    /// works on this system and this app version (filled in here)
    #[serde(default, skip_deserializing)]
    compatible: bool,
}

#[derive(Deserialize)]
struct RegistryFile {
    #[serde(default)]
    plugins: Vec<RegistryEntry>,
}

#[derive(Serialize)]
pub struct Registry {
    url: String,
    entries: Vec<RegistryEntry>,
}

fn registry_url() -> String {
    prefs(|p| p.registry.clone()).filter(|u| !u.trim().is_empty()).unwrap_or_else(|| DEFAULT_REGISTRY.into())
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
    /// ready to run (its program exists, this system and app version are supported)
    available: bool,
    /// brings an MCP server to chats
    mcp: bool,
    mcp_name: Option<String>,
    /// bundled | user | dev
    source: Source,
    /// hides a copy of the same id from another folder
    overrides: bool,
    enabled: bool,
    has_sidecar: bool,
    /// has a settings file the command palette can open
    has_settings: bool,
    /// starts with the app (manifest, unless the user changed it)
    autostart: bool,
    /// running | starting | stopped | error | disabled | unavailable | ready (no sidecar)
    status: &'static str,
    /// why it is unavailable or failed
    error: Option<String>,
    port: Option<u16>,
    platforms: Vec<String>,
}

fn info(p: Plugin) -> PluginInfo {
    let id = p.manifest.id.clone();
    let problem = p.problem();
    let is_enabled = enabled(&id);
    // a sidecar that died on its own: say so, and forget it
    let exited = RUNNING.lock().as_mut().and_then(|m| m.get_mut(&id)).and_then(|r| r.child.try_wait().ok().flatten());
    if let Some(status) = exited {
        RUNNING.lock().as_mut().map(|m| m.remove(&id));
        ERRORS.lock().insert(id.clone(), format!("exited ({status})"));
        log(&id, format!("[exited] {status}"));
    }
    let port = known(&id).map(|k| k.0);
    let last_error = ERRORS.lock().get(&id).cloned();
    let (status, error) = if !is_enabled {
        ("disabled", None)
    } else if problem.is_some() {
        ("unavailable", problem.clone())
    } else if p.manifest.sidecar.is_none() {
        ("ready", None)
    } else if STARTING_IDS.lock().contains(&id) {
        ("starting", None)
    } else if port.is_some() {
        ("running", None)
    } else if last_error.is_some() {
        ("error", last_error)
    } else {
        ("stopped", None)
    };
    PluginInfo {
        available: problem.is_none(),
        mcp: p.manifest.mcp.is_some(),
        mcp_name: p.manifest.mcp.as_ref().map(|m| m.name.clone()),
        source: p.source,
        overrides: p.overrides,
        enabled: is_enabled,
        has_sidecar: p.manifest.sidecar.is_some(),
        has_settings: settings_path(&p).is_some(),
        autostart: autostarts(&p),
        status,
        error,
        port,
        platforms: p.manifest.platforms.clone(),
        id: p.manifest.id,
        name: p.manifest.name,
        version: p.manifest.version,
        description: p.manifest.description,
        license: p.manifest.license,
        homepage: p.manifest.homepage,
        panel: p.manifest.panel
    }
}

#[tauri::command]
pub fn plugin_list() -> Vec<PluginInfo> {
    discover().into_iter().map(info).collect()
}

#[derive(Serialize)]
pub struct Started {
    url: String,
    /// the plugin's settings file as base64url JSON, for the page to take as its defaults
    #[serde(skip_serializing_if = "Option::is_none")]
    settings: Option<String>,
}

/// The plugin's settings file (it may not exist yet).
fn settings_path(p: &Plugin) -> Option<PathBuf> {
    let side = p.manifest.sidecar.as_ref()?;
    let rel = side.settings.clone().or_else(|| side.theme.as_ref().map(|t| t.file.clone()))?;
    Some(user_data().join("plugin-data").join(&p.manifest.id).join(rel))
}

/// The settings file as the page gets it. Plain JSON only (a file with comments is skipped, and said so in the log).
fn settings_for_page(p: &Plugin) -> Option<String> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let raw = std::fs::read_to_string(settings_path(p)?).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let id = &p.manifest.id;
    let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw) else {
        log(id, "[settings] the settings file is not a plain JSON object (no comments or trailing commas), so the page does not get it");
        return None;
    };
    let compact = serde_json::to_string(&map).ok()?;
    if compact.len() > 64 * 1024 {
        log(id, "[settings] the settings file is larger than 64 KB, so the page does not get it");
        return None;
    }
    Some(URL_SAFE_NO_PAD.encode(compact))
}

/// Writes the light / dark choice into the plugin's settings file (only when it changes).
fn apply_theme(id: &str, t: &ThemeSpec, light: bool) -> Result<()> {
    let file = user_data().join("plugin-data").join(id).join(&t.file);
    let mut settings: serde_json::Map<String, Value> = match std::fs::read_to_string(&file) {
        Ok(raw) => serde_json::from_str(&raw).context("its settings file is not plain JSON, so the theme is not set")?,
        Err(_) => serde_json::Map::new(),
    };
    let want = if light { &t.light } else { &t.dark };
    if settings.get(&t.key).and_then(Value::as_str) == Some(want.as_str()) {
        return Ok(());
    }
    settings.insert(t.key.clone(), json!(want));
    std::fs::create_dir_all(file.parent().context("bad settings path")?)?;
    std::fs::write(&file, serde_json::to_string_pretty(&settings)?)?;
    Ok(())
}

/// A panel asks for its plugin's page (starting the sidecar the first time). `light` is the app's
/// theme now; the plugin's settings get it before the page loads (and the page follows a change).
#[tauri::command]
pub async fn plugin_start(id: String, light: Option<bool>) -> Res<Started> {
    let p = find(&id).ok_or_else(|| err(format!("no plugin \"{id}\"")))?;
    if !enabled(&id) {
        return Err(err(format!("{} is disabled (turn it on in Plugins)", p.manifest.name)));
    }
    let side = p.manifest.sidecar.clone().ok_or_else(|| err("this plugin has no page"))?;
    if let (Some(t), Some(light)) = (&side.theme, light)
        && let Err(e) = apply_theme(&id, t, light)
    {
        log(&id, format!("[theme] {e:#}"));
    }
    let (port, _) = ensure(&p).await.map_err(|e| err(format!("{e:#}")))?;
    Ok(Started { url: format!("http://127.0.0.1:{port}{}", side.url), settings: settings_for_page(&p) })
}

/// The path of a plugin's settings file, created (empty) when it is not there yet, for the palette to open.
#[tauri::command]
pub fn plugin_settings_file(id: String) -> Res<String> {
    let p = find(&id).ok_or_else(|| err(format!("no plugin \"{id}\"")))?;
    let file = settings_path(&p).ok_or_else(|| err("this plugin has no settings file"))?;
    if !file.exists() {
        if let Some(dir) = file.parent() {
            std::fs::create_dir_all(dir).map_err(|e| err(format!("could not create {}: {e}", dir.display())))?;
        }
        std::fs::write(&file, "{}\n").map_err(|e| err(format!("could not create {}: {e}", file.display())))?;
    }
    Ok(file.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn plugin_stop(id: String) -> Res<()> {
    find(&id).ok_or_else(|| err(format!("no plugin \"{id}\"")))?;
    stop(&id);
    ERRORS.lock().remove(&id);
    Ok(())
}

#[tauri::command]
pub async fn plugin_restart(id: String) -> Res<()> {
    let p = find(&id).ok_or_else(|| err(format!("no plugin \"{id}\"")))?;
    if !enabled(&id) {
        return Err(err(format!("{} is disabled", p.manifest.name)));
    }
    stop(&id);
    ensure(&p).await.map(|_| ()).map_err(|e| err(format!("{e:#}")))
}

/// Turn a plugin on or off, or choose whether it starts with the app.
#[tauri::command]
pub fn plugin_set(id: String, enabled: Option<bool>, autostart: Option<bool>) -> Res<()> {
    let p = find(&id).ok_or_else(|| err(format!("no plugin \"{id}\"")))?;
    update_prefs(|s| {
        let e = s.plugins.entry(id.clone()).or_default();
        if let Some(on) = enabled {
            e.disabled = !on;
        }
        if autostart.is_some() {
            e.autostart = autostart;
        }
    });
    if enabled == Some(false) {
        stop(&id);
        ERRORS.lock().remove(&id);
    }
    if enabled == Some(true) && p.available() && p.manifest.sidecar.is_some() && autostarts(&p) {
        tauri::async_runtime::spawn(async move {
            let _ = ensure(&p).await;
        });
    }
    Ok(())
}

/// What the sidecar printed (the last lines).
#[tauri::command]
pub fn plugin_logs(id: String) -> Vec<String> {
    LOGS.lock().get(&id).map(|q| q.iter().cloned().collect()).unwrap_or_default()
}

/// Install from a folder, a .zip / .tar.gz file, or an https link to one (checked against `sha256` when given).
/// Returns the plugin's id.
#[tauri::command]
pub async fn plugin_install(source: String, sha256: Option<String>) -> Res<String> {
    let source = source.trim().to_string();
    if source.is_empty() {
        return Err(err("give a folder, an archive or a link"));
    }
    let run = async {
        let id = if source.starts_with("http://") || source.starts_with("https://") {
            let tmp = user_data().join("tmp").join(uuid::Uuid::new_v4().to_string());
            std::fs::create_dir_all(&tmp)?;
            let r = async {
                let archive = download(&source, sha256.as_deref(), &tmp).await?;
                tokio::task::spawn_blocking(move || install_archive(&archive)).await?
            }
            .await;
            let _ = std::fs::remove_dir_all(&tmp);
            r?
        } else {
            let path = PathBuf::from(&source);
            tokio::task::spawn_blocking(move || -> Result<String> {
                if path.is_dir() {
                    install_dir(&path)
                } else if path.is_file() {
                    install_archive(&path)
                } else {
                    bail!("{} is not a folder or a file", path.display())
                }
            })
            .await??
        };
        Result::<String>::Ok(id)
    };
    let id = run.await.map_err(|e| err(format!("{e:#}")))?;
    // installing again brings back a plugin removed from the app
    update_prefs(|s| {
        if let Some(x) = s.plugins.get_mut(&id) {
            x.removed = false;
        }
    });
    // a fresh install comes up as it would at launch
    if let Some(p) = find(&id)
        && enabled(&id)
        && p.available()
        && p.manifest.sidecar.is_some()
        && autostarts(&p)
    {
        tauri::async_runtime::spawn(async move {
            let _ = ensure(&p).await;
        });
    }
    Ok(id)
}

/// Remove a plugin. One the user installed is deleted (`purge` also deletes its data folder). A shipped
/// or development one is only hidden from the app: its files stay, and installing it again brings it back.
#[tauri::command]
pub fn plugin_uninstall(id: String, purge: bool) -> Res<()> {
    let p = find(&id).ok_or_else(|| err(format!("no plugin \"{id}\"")))?;
    stop(&id);
    if p.source == Source::User && p.dir.starts_with(user_plugins()) {
        std::fs::remove_dir_all(&p.dir).map_err(|e| err(format!("could not remove it: {e}")))?;
        if purge {
            let _ = std::fs::remove_dir_all(user_data().join("plugin-data").join(&id));
        }
        update_prefs(|s| {
            s.plugins.remove(&id);
        });
    } else {
        update_prefs(|s| {
            s.plugins.entry(id.clone()).or_default().removed = true;
        });
    }
    ERRORS.lock().remove(&id);
    LOGS.lock().remove(&id);
    Ok(())
}

/// The plugins on offer, from the registry's index.json.
#[tauri::command]
pub async fn plugin_registry() -> Res<Registry> {
    let url = registry_url();
    let u = reqwest::Url::parse(&url).map_err(|_| err("the registry address is not a link"))?;
    if !https_or_local(&u) {
        return Err(err("the registry must be an https link"));
    }
    let resp = reqwest::Client::new().get(u).timeout(Duration::from_secs(15)).send().await.map_err(|e| err(format!("could not reach the registry: {e}")))?;
    if !resp.status().is_success() {
        return Err(err(format!("the registry answered {}", resp.status())));
    }
    let file: RegistryFile = resp.json().await.map_err(|e| err(format!("the registry is not a valid index.json: {e}")))?;
    let entries = file
        .plugins
        .into_iter()
        .filter(|e| valid_id(&e.id))
        .map(|mut e| {
            e.compatible = on_this_system(&e.platforms) && (e.min_app_version.is_empty() || !newer(&e.min_app_version, APP_VERSION));
            e
        })
        .collect();
    Ok(Registry { url, entries })
}

/// The registry address in use; an empty one goes back to the default.
#[tauri::command]
pub fn plugin_registry_url(set: Option<String>) -> String {
    if let Some(u) = set {
        update_prefs(|s| s.registry = Some(u.trim().to_string()).filter(|u| !u.is_empty()));
    }
    registry_url()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vibe-plugin-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn write_plugin(dir: &Path, manifest: &str) {
        std::fs::create_dir_all(dir.join("bin")).unwrap();
        std::fs::write(dir.join("plugin.json"), manifest).unwrap();
        std::fs::write(dir.join("bin/run"), "#!/bin/sh\n").unwrap();
    }

    #[test]
    fn versions_compare_by_number() {
        assert!(newer("1.2.10", "1.2.9"));
        assert!(newer("v2", "1.9.9"));
        assert!(!newer("1.0", "1.0.0"));
        assert!(!newer("0.6.72", "0.6.72"));
    }

    #[test]
    fn ids_are_plain() {
        assert!(valid_id("dbx"));
        assert!(valid_id("my-plugin_2"));
        for bad in ["", "../x", "A", "a b", "a/b"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn manifest_is_checked() {
        let d = scratch("manifest");
        write_plugin(&d, r#"{"id":"ok","name":"Ok","sidecar":{"command":"bin/run"}}"#);
        assert_eq!(check_manifest(&d).unwrap().id, "ok");
        write_plugin(&d, r#"{"id":"../evil","name":"Evil"}"#);
        assert!(check_manifest(&d).is_err());
        write_plugin(&d, r#"{"id":"esc","name":"Esc","sidecar":{"command":"../../bin/sh"}}"#);
        assert!(check_manifest(&d).is_err());
        write_plugin(&d, r#"{"id":"abs","name":"Abs","sidecar":{"command":"/bin/sh"}}"#);
        assert!(check_manifest(&d).is_err());
        write_plugin(&d, r#"{"id":"other","name":"Other","platforms":["plan9"]}"#);
        assert!(check_manifest(&d).is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    #[test]
    fn archives_unpack_and_find_their_root() {
        // .tar.gz with the plugin one folder down
        let d = scratch("tgz");
        let src = d.join("src/pack");
        write_plugin(&src, r#"{"id":"pack","name":"Pack"}"#);
        let tgz = d.join("p.tar.gz");
        let gz = flate2::write::GzEncoder::new(std::fs::File::create(&tgz).unwrap(), flate2::Compression::fast());
        let mut b = tar::Builder::new(gz);
        b.append_dir_all("pack", &src).unwrap();
        b.into_inner().unwrap().finish().unwrap();
        extract(&tgz, &d.join("out")).unwrap();
        let root = plugin_root(&d.join("out")).unwrap();
        assert_eq!(check_manifest(&root).unwrap().id, "pack");

        // .zip with plugin.json at the top
        let zp = d.join("p.zip");
        let mut z = zip::ZipWriter::new(std::fs::File::create(&zp).unwrap());
        z.start_file("plugin.json", zip::write::SimpleFileOptions::default()).unwrap();
        std::io::Write::write_all(&mut z, br#"{"id":"zipped","name":"Zipped"}"#).unwrap();
        z.finish().unwrap();
        extract(&zp, &d.join("outz")).unwrap();
        assert_eq!(check_manifest(&plugin_root(&d.join("outz")).unwrap()).unwrap().id, "zipped");

        // neither
        std::fs::write(d.join("junk"), "hello").unwrap();
        assert!(extract(&d.join("junk"), &d.join("outj")).is_err());
        std::fs::remove_dir_all(&d).ok();
    }

    /// Stopping a sidecar stops what it started too, not only the program itself.
    #[cfg(unix)]
    #[test]
    fn a_group_kill_takes_the_children_with_it() {
        use std::os::unix::process::CommandExt;
        use std::io::Read;
        let alive = |pid: i32| unsafe { libc::kill(pid, 0) == 0 };
        // a wrapper script that does not exec its program: the program is a child of the shell
        let mut sh = std::process::Command::new("sh")
            .args(["-c", "sleep 60 & echo $!; wait"])
            .process_group(0)
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut out = String::new();
        let mut buf = [0u8; 16];
        while !out.contains('\n') {
            let n = sh.stdout.as_mut().unwrap().read(&mut buf).unwrap();
            assert!(n > 0, "the shell printed nothing");
            out.push_str(&String::from_utf8_lossy(&buf[..n]));
        }
        let child: i32 = out.trim().parse().unwrap();
        assert!(alive(child));
        kill_group(sh.id());
        sh.wait().unwrap();
        // the sleeping child is reaped by init once its parent is gone; give that a moment
        for _ in 0..50 {
            if !alive(child) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(40));
        }
        // a zombie still answers signal 0: check its state instead
        let state = std::fs::read_to_string(format!("/proc/{child}/stat")).unwrap_or_default();
        assert!(state.is_empty() || state.contains(") Z"), "the child outlived its group: {state}");
    }

    #[test]
    fn folders_copy_with_their_files() {
        let d = scratch("copy");
        write_plugin(&d.join("a"), r#"{"id":"c","name":"C"}"#);
        copy_dir(&d.join("a"), &d.join("b")).unwrap();
        assert!(d.join("b/plugin.json").is_file() && d.join("b/bin/run").is_file());
        std::fs::remove_dir_all(&d).ok();
    }
}
