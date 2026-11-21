//! ptyd: a process of its own that owns the terminals, so that closing the app does not end the
//! chats running in them. The app (pty.rs) is a client: it asks ptyd to start a terminal, sends keys
//! and a size, and shows the output; when it quits, comes back, or reloads its page, it attaches to
//! the terminals that are still there. See experiments/ptyd for how the screen is restored.
//!
//! ptyd is this same executable started with `--ptyd`. It listens on 127.0.0.1 (a random port) and
//! writes `<userData>/ptyd.json` with the port and a token: every connection starts with that token.
//!
//! Every terminal is fed to a terminal emulator (vt100), so ptyd always knows the screen. A client
//! that attaches first gets that screen as one chunk of escape sequences, then the live output.
//!
//! Terminals are `persist`ent (a chat: kept when the app goes away) or not (a shell: stopped when
//! the connection that started it closes, and when the page is reset).
//!
//! Frames, both ways: 1 byte kind, 4 bytes big-endian length, payload. A payload that is "for a
//! terminal" starts with 1 byte id length and the id.
//!
//!   client → ptyd   H hello {version, token}      N new {NewSession}        I id+keys
//!                   R {id, cols, rows}            K id (stop it)            Z list
//!                   W wipe: stop the terminals that are not persistent, forget who is attached
//!                   Q quit, when nothing is running
//!   ptyd → client   H ready {version, sessions}   S id+screen               D id+output
//!                   X id+code:i32 (it ended)      E {id, message}           L {sessions}

use std::{
    collections::HashMap,
    io::{self, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    num::NonZeroU16,
    path::PathBuf,
    sync::{
        Arc, mpsc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};

use parking_lot::Mutex;
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::core::user_data;

/// Bumped when the frames change: an older ptyd that still holds chats is kept, a newer app copes.
pub const VERSION: u32 = 1;

/* ---------------- frames ---------------- */

const MAX_FRAME: usize = 64 * 1024 * 1024;

pub fn write_frame(w: &mut impl Write, kind: u8, payload: &[u8]) -> io::Result<()> {
    let mut buf = Vec::with_capacity(5 + payload.len());
    buf.push(kind);
    buf.extend((payload.len() as u32).to_be_bytes());
    buf.extend(payload);
    w.write_all(&buf)
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut buf = Vec::with_capacity(5 + payload.len());
    write_frame(&mut buf, kind, payload).unwrap();
    buf
}

pub fn read_frame(r: &mut impl Read) -> io::Result<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    r.read_exact(&mut head)?;
    let len = u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize;
    if len > MAX_FRAME {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "frame too large"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body)?;
    Ok((head[0], body))
}

/// `id` then `data`, as one payload.
fn for_id(id: &str, data: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(1 + id.len() + data.len());
    v.push(id.len().min(255) as u8);
    v.extend(&id.as_bytes()[..id.len().min(255)]);
    v.extend(data);
    v
}

fn split_id(p: &[u8]) -> Option<(String, &[u8])> {
    let n = *p.first()? as usize;
    let id = std::str::from_utf8(p.get(1..1 + n)?).ok()?;
    Some((id.to_owned(), &p[1 + n..]))
}

#[derive(Clone, Serialize, Deserialize)]
pub struct NewSession {
    pub id: String,
    /// kept when the connection that started it goes away
    pub persist: bool,
    /// the terminal already exists: attach to it instead of starting another
    pub reuse: bool,
    pub cwd: String,
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct SessionInfo {
    pub id: String,
    pub persist: bool,
    /// the exit code, once the program has ended
    pub exited: Option<i32>,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Serialize, Deserialize)]
struct Hello {
    version: u32,
    token: String,
}

#[derive(Serialize, Deserialize)]
struct Ready {
    version: u32,
    sessions: Vec<SessionInfo>,
}

#[derive(Serialize, Deserialize)]
struct Resize {
    id: String,
    cols: u16,
    rows: u16,
}

/// Where the running ptyd says how to reach it.
#[derive(Clone, Serialize, Deserialize)]
pub struct Info {
    pub port: u16,
    pub token: String,
    pub pid: u32,
    pub version: u32,
}

pub fn info_path() -> PathBuf {
    user_data().join("ptyd.json")
}

fn nz(n: u16) -> NonZeroU16 {
    NonZeroU16::new(n.max(2)).unwrap()
}

/* ---------------- the daemon ---------------- */

struct Session {
    generation: u64,
    owner: u64,
    persist: bool,
    cols: u16,
    rows: u16,
    /// keys go to a writer thread: a ConPTY input pipe whose process isn't reading blocks
    input: mpsc::Sender<Vec<u8>>,
    master: Box<dyn MasterPty + Send>,
    killer: Box<dyn ChildKiller + Send + Sync>,
    screen: vt100::Parser,
    /// the connection that is shown this terminal now
    attached: Option<u64>,
    exited: Option<i32>,
}

#[derive(Default)]
struct Server {
    sessions: HashMap<String, Session>,
    conns: HashMap<u64, mpsc::Sender<Vec<u8>>>,
}

type Shared = Arc<Mutex<Server>>;

static GENERATION: AtomicU64 = AtomicU64::new(1);

fn stop_later(mut s: Session) {
    // closing a ConPTY can stall: never under the lock
    std::thread::spawn(move || {
        let _ = s.killer.kill();
        drop(s);
    });
}

/// The screen as escape sequences, for a terminal that has seen nothing yet.
fn snapshot(s: &Session) -> Vec<u8> {
    let mut state: Vec<u8> = Vec::new();
    // a program on the alternate screen (less, vim) must still be on it when it leaves: the snapshot
    // enters it first, which the formatted state does not
    if s.screen.screen().alternate_screen() {
        state.extend(b"\x1b[?1049h\x1b[2J\x1b[H");
    }
    state.extend(s.screen.screen().state_formatted().as_bytes());
    state
}

fn attach(id: &str, s: &mut Session, conn: u64, out: &mpsc::Sender<Vec<u8>>, cols: u16, rows: u16) {
    if (cols, rows) != (s.cols, s.rows) {
        let _ = s.master.resize(PtySize { rows: rows.max(2), cols: cols.max(2), pixel_width: 0, pixel_height: 0 });
        s.screen.set_size(nz(rows), nz(cols));
        s.cols = cols;
        s.rows = rows;
    }
    s.attached = Some(conn);
    let _ = out.send(frame(b'S', &for_id(id, &snapshot(s))));
    if let Some(code) = s.exited {
        let _ = out.send(frame(b'X', &for_id(id, &code.to_be_bytes())));
    }
}

fn spawn_session(shared: &Shared, conn: u64, req: NewSession) -> Result<(), String> {
    let (cols, rows) = (req.cols.max(2), req.rows.max(2));
    let mut cmd = CommandBuilder::new(&req.program);
    cmd.args(&req.args);
    cmd.cwd(&req.cwd);
    cmd.env_clear();
    for (k, v) in &req.env {
        cmd.env(k, v);
    }
    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).map_err(|e| e.to_string())?;
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let killer = child.clone_killer();

    let (input, keys) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(mut data) = keys.recv() {
            // a paste arrives as many pieces: write what has queued up in one go
            while let Ok(more) = keys.try_recv() {
                data.extend(more);
            }
            if writer.write_all(&data).and_then(|_| writer.flush()).is_err() {
                break;
            }
        }
    });

    let generation = GENERATION.fetch_add(1, Ordering::Relaxed);
    let session = Session {
        generation,
        owner: conn,
        persist: req.persist,
        cols,
        rows,
        input,
        master: pair.master,
        killer,
        screen: vt100::Parser::new(nz(rows), nz(cols), 0),
        attached: Some(conn),
        exited: None,
    };
    shared.lock().sessions.insert(req.id.clone(), session);

    // the program's output: into the emulator, and to whoever is shown the terminal
    {
        let (shared, id) = (shared.clone(), req.id.clone());
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut sv = shared.lock();
                        let Some(s) = sv.sessions.get_mut(&id).filter(|s| s.generation == generation) else { break };
                        s.screen.process(&buf[..n]);
                        let attached = s.attached;
                        if let Some(tx) = attached.and_then(|c| sv.conns.get(&c)) {
                            let _ = tx.send(frame(b'D', &for_id(&id, &buf[..n])));
                        }
                    }
                }
            }
        });
    }
    // the program ends: whoever is shown it is told, a terminal that is not persistent goes
    {
        let (shared, id, persist) = (shared.clone(), req.id, req.persist);
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            // the last output may still be on its way (ConPTY keeps the pipe open until closed)
            std::thread::sleep(Duration::from_millis(40));
            let mut sv = shared.lock();
            let Some(s) = sv.sessions.get_mut(&id).filter(|s| s.generation == generation) else { return };
            s.exited = Some(code);
            let attached = s.attached;
            if let Some(tx) = attached.and_then(|c| sv.conns.get(&c)) {
                let _ = tx.send(frame(b'X', &for_id(&id, &code.to_be_bytes())));
            }
            if !persist && let Some(s) = sv.sessions.remove(&id) {
                drop(sv);
                stop_later(s);
            }
        });
    }
    Ok(())
}

fn on_new(shared: &Shared, conn: u64, out: &mpsc::Sender<Vec<u8>>, req: NewSession) {
    {
        let mut sv = shared.lock();
        if sv.sessions.contains_key(&req.id) {
            if req.reuse {
                let s = sv.sessions.get_mut(&req.id).unwrap();
                attach(&req.id, s, conn, out, req.cols.max(2), req.rows.max(2));
                return;
            }
            // started again under the same id (a restart): the old one goes, without a word
            if let Some(old) = sv.sessions.remove(&req.id) {
                stop_later(old);
            }
        }
    }
    if let Err(message) = spawn_session(shared, conn, req.clone()) {
        let _ = out.send(frame(b'E', json!({ "id": req.id, "message": message }).to_string().as_bytes()));
    }
}

fn infos(sv: &Server) -> Vec<SessionInfo> {
    sv.sessions.iter().map(|(id, s)| SessionInfo { id: id.clone(), persist: s.persist, exited: s.exited, cols: s.cols, rows: s.rows }).collect()
}

fn handle(mut stream: TcpStream, shared: Shared, conn: u64, token: String, quit: Arc<dyn Fn() + Send + Sync>) {
    let _ = stream.set_nodelay(true);
    // hello first, with the right token
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let ok = matches!(read_frame(&mut stream), Ok((b'H', b)) if serde_json::from_slice::<Hello>(&b).is_ok_and(|h| h.token == token));
    if !ok {
        return;
    }
    let _ = stream.set_read_timeout(None);
    let (out, rx) = mpsc::channel::<Vec<u8>>();
    let Ok(mut writer) = stream.try_clone() else { return };
    std::thread::spawn(move || {
        while let Ok(buf) = rx.recv() {
            if writer.write_all(&buf).is_err() {
                break;
            }
        }
        let _ = writer.shutdown(Shutdown::Both);
    });
    {
        let mut sv = shared.lock();
        let ready = serde_json::to_vec(&Ready { version: VERSION, sessions: infos(&sv) }).unwrap();
        let _ = out.send(frame(b'H', &ready));
        sv.conns.insert(conn, out.clone());
    }

    while let Ok((kind, body)) = read_frame(&mut stream) {
        match kind {
            b'N' => {
                if let Ok(req) = serde_json::from_slice::<NewSession>(&body) {
                    on_new(&shared, conn, &out, req);
                }
            }
            b'I' => {
                if let Some((id, keys)) = split_id(&body)
                    && let Some(s) = shared.lock().sessions.get(&id)
                {
                    let _ = s.input.send(keys.to_vec());
                }
            }
            b'R' => {
                if let Ok(r) = serde_json::from_slice::<Resize>(&body)
                    && let Some(s) = shared.lock().sessions.get_mut(&r.id)
                {
                    let _ = s.master.resize(PtySize { rows: r.rows.max(2), cols: r.cols.max(2), pixel_width: 0, pixel_height: 0 });
                    s.screen.set_size(nz(r.rows), nz(r.cols));
                    s.cols = r.cols.max(2);
                    s.rows = r.rows.max(2);
                }
            }
            b'K' => {
                let id = String::from_utf8_lossy(&body).into_owned();
                let gone = shared.lock().sessions.remove(&id);
                if let Some(s) = gone {
                    stop_later(s);
                }
            }
            b'W' => {
                let mut sv = shared.lock();
                let transient: Vec<String> = sv.sessions.iter().filter(|(_, s)| !s.persist).map(|(id, _)| id.clone()).collect();
                let gone: Vec<Session> = transient.iter().filter_map(|id| sv.sessions.remove(id)).collect();
                for s in sv.sessions.values_mut() {
                    s.attached = None;
                }
                drop(sv);
                gone.into_iter().for_each(stop_later);
            }
            b'Z' => {
                let list = serde_json::to_vec(&infos(&shared.lock())).unwrap();
                let _ = out.send(frame(b'L', &list));
            }
            b'Q' => {
                if shared.lock().sessions.values().all(|s| !s.persist) {
                    quit();
                }
            }
            _ => {}
        }
    }

    // the connection went away: what it showed is shown to no one, what it started and is not
    // persistent stops
    let mut sv = shared.lock();
    sv.conns.remove(&conn);
    let mine: Vec<String> = sv.sessions.iter().filter(|(_, s)| s.owner == conn && !s.persist).map(|(id, _)| id.clone()).collect();
    let gone: Vec<Session> = mine.iter().filter_map(|id| sv.sessions.remove(id)).collect();
    for s in sv.sessions.values_mut().filter(|s| s.attached == Some(conn)) {
        s.attached = None;
    }
    drop(sv);
    gone.into_iter().for_each(stop_later);
}

/// Serves on `listener` until `quit` is called. `idle`: ends the daemon when nothing has run and
/// nobody has been connected for this long.
pub fn serve(listener: TcpListener, token: String, idle: Duration, quit: Arc<dyn Fn() + Send + Sync>) {
    let shared: Shared = Arc::new(Mutex::new(Server::default()));
    {
        let (shared, quit) = (shared.clone(), quit.clone());
        std::thread::spawn(move || {
            let mut quiet_since: Option<Instant> = None;
            loop {
                std::thread::sleep(Duration::from_millis(500).min(idle));
                let empty = {
                    let sv = shared.lock();
                    sv.sessions.is_empty() && sv.conns.is_empty()
                };
                match (empty, quiet_since) {
                    (true, Some(t)) if t.elapsed() >= idle => return quit(),
                    (true, None) => quiet_since = Some(Instant::now()),
                    (false, _) => quiet_since = None,
                    _ => {}
                }
            }
        });
    }
    let next = AtomicU64::new(1);
    for stream in listener.incoming().flatten() {
        let (shared, token, quit) = (shared.clone(), token.clone(), quit.clone());
        let conn = next.fetch_add(1, Ordering::Relaxed);
        std::thread::spawn(move || handle(stream, shared, conn, token, quit));
    }
}

/// `vibe-code --ptyd`: the daemon. Returns when it is told to quit or has been idle.
pub fn run() {
    // another ptyd already answers: it is the one
    if let Some(info) = read_info()
        && Daemon::connect(&info, |_| {}).is_ok()
    {
        return;
    }
    let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) else { return };
    let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
    let token: String = {
        use rand::RngExt;
        let b: [u8; 24] = rand::rng().random();
        b.iter().map(|x| format!("{x:02x}")).collect()
    };
    let info = Info { port, token: token.clone(), pid: std::process::id(), version: VERSION };
    let path = info_path();
    let tmp = path.with_extension("tmp");
    if std::fs::write(&tmp, serde_json::to_vec(&info).unwrap()).is_err() {
        return;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600));
    }
    if std::fs::rename(&tmp, &path).is_err() {
        return;
    }
    let (done_tx, done_rx) = mpsc::channel::<()>();
    let quit: Arc<dyn Fn() + Send + Sync> = {
        let done_tx = Mutex::new(done_tx);
        Arc::new(move || {
            let _ = done_tx.lock().send(());
        })
    };
    let q = quit.clone();
    std::thread::spawn(move || serve(listener, token, Duration::from_secs(60), q));
    let _ = done_rx.recv();
    // only remove what is ours
    if read_info().is_some_and(|i| i.pid == std::process::id()) {
        let _ = std::fs::remove_file(&path);
    }
}

/* ---------------- the client ---------------- */

pub fn read_info() -> Option<Info> {
    serde_json::from_slice(&std::fs::read(info_path()).ok()?).ok()
}

pub enum Event {
    Snapshot(String, Vec<u8>),
    Data(String, Vec<u8>),
    Exit(String, i32),
    Error(String, String),
    /// the connection ended (ptyd stopped, or it was closed here)
    Closed,
}

pub struct Daemon {
    out: mpsc::Sender<Vec<u8>>,
    socket: TcpStream,
    lists: Arc<Mutex<Vec<mpsc::Sender<Vec<SessionInfo>>>>>,
    pub version: u32,
    /// what was running when this connection was made
    pub sessions: Vec<SessionInfo>,
}

impl Daemon {
    /// Connects and says hello; `on_event` is called, from a thread of its own, for what ptyd sends.
    pub fn connect(info: &Info, on_event: impl Fn(Event) + Send + 'static) -> io::Result<Daemon> {
        let mut stream = TcpStream::connect_timeout(&([127, 0, 0, 1], info.port).into(), Duration::from_secs(2))?;
        let _ = stream.set_nodelay(true);
        write_frame(&mut stream, b'H', &serde_json::to_vec(&Hello { version: VERSION, token: info.token.clone() }).unwrap())?;
        stream.set_read_timeout(Some(Duration::from_secs(5)))?;
        let (kind, body) = read_frame(&mut stream)?;
        stream.set_read_timeout(None)?;
        let ready: Ready = match (kind, serde_json::from_slice(&body)) {
            (b'H', Ok(r)) => r,
            _ => return Err(io::Error::new(io::ErrorKind::InvalidData, "not a ptyd")),
        };

        let (out, rx) = mpsc::channel::<Vec<u8>>();
        let mut writer = stream.try_clone()?;
        std::thread::spawn(move || {
            while let Ok(buf) = rx.recv() {
                if writer.write_all(&buf).is_err() {
                    break;
                }
            }
        });
        let lists: Arc<Mutex<Vec<mpsc::Sender<Vec<SessionInfo>>>>> = Arc::default();
        let (mut reader, waiters) = (stream.try_clone()?, lists.clone());
        std::thread::spawn(move || {
            while let Ok((kind, body)) = read_frame(&mut reader) {
                match kind {
                    b'S' | b'D' => {
                        if let Some((id, data)) = split_id(&body) {
                            let data = data.to_vec();
                            on_event(if kind == b'S' { Event::Snapshot(id, data) } else { Event::Data(id, data) });
                        }
                    }
                    b'X' => {
                        if let Some((id, c)) = split_id(&body)
                            && c.len() == 4
                        {
                            on_event(Event::Exit(id, i32::from_be_bytes([c[0], c[1], c[2], c[3]])));
                        }
                    }
                    b'E' => {
                        if let Ok(v) = serde_json::from_slice::<serde_json::Value>(&body) {
                            on_event(Event::Error(v["id"].as_str().unwrap_or_default().into(), v["message"].as_str().unwrap_or_default().into()));
                        }
                    }
                    b'L' => {
                        if let Ok(list) = serde_json::from_slice::<Vec<SessionInfo>>(&body)
                            && !waiters.lock().is_empty()
                        {
                            let _ = waiters.lock().remove(0).send(list);
                        }
                    }
                    _ => {}
                }
            }
            on_event(Event::Closed);
        });
        Ok(Daemon { out, socket: stream, lists, version: ready.version, sessions: ready.sessions })
    }

    /// false when the connection is gone.
    pub fn send(&self, kind: u8, payload: &[u8]) -> bool {
        self.out.send(frame(kind, payload)).is_ok()
    }

    pub fn spawn(&self, req: &NewSession) -> bool {
        self.send(b'N', &serde_json::to_vec(req).unwrap())
    }

    pub fn input(&self, id: &str, keys: &[u8]) -> bool {
        self.send(b'I', &for_id(id, keys))
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> bool {
        self.send(b'R', &serde_json::to_vec(&Resize { id: id.into(), cols, rows }).unwrap())
    }

    pub fn kill(&self, id: &str) -> bool {
        self.send(b'K', id.as_bytes())
    }

    /// Stops the terminals that are not persistent and forgets who is attached (the page was reset).
    pub fn wipe(&self) -> bool {
        self.send(b'W', &[])
    }

    pub fn quit_if_idle(&self) -> bool {
        self.send(b'Q', &[])
    }

    pub fn list(&self) -> Vec<SessionInfo> {
        let (tx, rx) = mpsc::channel();
        self.lists.lock().push(tx);
        if !self.send(b'Z', &[]) {
            return Vec::new();
        }
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or_default()
    }

    /// Ends the connection: ptyd stops what this app started and is not persistent.
    pub fn close(&self) {
        let _ = self.socket.shutdown(Shutdown::Both);
    }
}

/// Connects to the running ptyd, starting one first when there is none (or it does not answer).
pub fn connect_or_start(on_event: impl Fn(Event) + Send + Clone + 'static) -> io::Result<Daemon> {
    if let Some(info) = read_info()
        && let Ok(d) = Daemon::connect(&info, on_event.clone())
    {
        return Ok(d);
    }
    start_process()?;
    let mut last = io::Error::other("ptyd did not start");
    for _ in 0..60 {
        std::thread::sleep(Duration::from_millis(100));
        if let Some(info) = read_info() {
            match Daemon::connect(&info, on_event.clone()) {
                Ok(d) => return Ok(d),
                Err(e) => last = e,
            }
        }
    }
    Err(last)
}

/// This executable again, as `--ptyd`, in a session of its own so that it outlives the app.
fn start_process() -> io::Result<()> {
    // VIBE_PTYD_EXE: another executable to run, for the test that starts the real thing
    let exe = std::env::var_os("VIBE_PTYD_EXE").map(PathBuf::from).map_or_else(std::env::current_exe, Ok)?;
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("--ptyd").stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // SAFETY: setsid between fork and exec; a new session means no controlling terminal and no
        // signal meant for the app's group reaches it.
        unsafe {
            cmd.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW
        cmd.creation_flags(0x0000_0008 | 0x0000_0200 | 0x0800_0000);
    }
    cmd.spawn().map(drop)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn daemon() -> (Info, Arc<Mutex<bool>>) {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let info = Info { port: listener.local_addr().unwrap().port(), token: "t0k3n".into(), pid: 0, version: VERSION };
        let quit = Arc::new(Mutex::new(false));
        let q = quit.clone();
        let token = info.token.clone();
        std::thread::spawn(move || serve(listener, token, Duration::from_secs(3600), Arc::new(move || *q.lock() = true)));
        (info, quit)
    }

    fn request(id: &str, persist: bool, reuse: bool, script: &str) -> NewSession {
        NewSession {
            id: id.into(),
            persist,
            reuse,
            cwd: "/tmp".into(),
            program: "sh".into(),
            args: vec!["-c".into(), script.into()],
            env: vec![("TERM".into(), "xterm-256color".into()), ("PATH".into(), "/usr/bin:/bin".into())],
            cols: 80,
            rows: 24,
        }
    }

    /// Everything a connection hears, as text, with a way to wait for some of it.
    struct Hear(mpsc::Receiver<Event>, String);
    impl Hear {
        fn until(&mut self, what: &str) -> bool {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !self.1.contains(what) && Instant::now() < deadline {
                match self.0.recv_timeout(Duration::from_millis(100)) {
                    Ok(Event::Snapshot(_, b)) | Ok(Event::Data(_, b)) => self.1.push_str(&String::from_utf8_lossy(&b)),
                    Ok(Event::Exit(id, code)) => self.1.push_str(&format!("<exit {id} {code}>")),
                    Ok(_) | Err(_) => {}
                }
            }
            self.1.contains(what)
        }
    }

    fn connect(info: &Info) -> (Daemon, Hear) {
        let (tx, rx) = mpsc::channel();
        let tx = Mutex::new(tx);
        let d = Daemon::connect(info, move |e| {
            let _ = tx.lock().send(e);
        })
        .unwrap();
        (d, Hear(rx, String::new()))
    }

    #[test]
    fn a_wrong_token_is_refused() {
        let (info, _) = daemon();
        let bad = Info { token: "nope".into(), ..info };
        assert!(Daemon::connect(&bad, |_| {}).is_err());
    }

    #[test]
    fn a_persistent_terminal_outlives_the_connection_and_comes_back_with_its_screen() {
        let (info, _) = daemon();
        let (a, mut heard) = connect(&info);
        a.spawn(&request("chat-1", true, false, "echo first; sleep 1; echo while-away; sleep 30"));
        assert!(heard.until("first"));
        a.close(); // the app is closed
        std::thread::sleep(Duration::from_millis(1500)); // the program keeps going without anyone

        let (b, mut again) = connect(&info);
        assert!(b.sessions.iter().any(|s| s.id == "chat-1" && s.persist), "it is listed");
        b.spawn(&request("chat-1", true, true, "never-run"));
        assert!(again.until("while-away"), "the screen has what was printed in between: {}", again.1);
        assert!(again.1.contains("first"));
        // and keys reach it
        b.input("chat-1", b"\x03"); // ctrl-c ends `sleep 30`; the shell then exits
        assert!(again.until("<exit chat-1"), "it ends: {}", again.1);
        b.kill("chat-1");
    }

    #[test]
    fn a_shell_stops_with_the_connection_that_started_it() {
        let (info, _) = daemon();
        let (a, _) = connect(&info);
        a.spawn(&request("sh-1", false, false, "sleep 30"));
        a.spawn(&request("chat-2", true, false, "sleep 30"));
        std::thread::sleep(Duration::from_millis(300));
        a.close();
        std::thread::sleep(Duration::from_millis(300));
        let (b, _) = connect(&info);
        let ids: Vec<String> = b.list().into_iter().map(|s| s.id).collect();
        assert!(ids.contains(&"chat-2".to_string()) && !ids.contains(&"sh-1".to_string()), "{ids:?}");
        b.kill("chat-2");
    }

    #[test]
    fn starting_under_the_same_id_replaces_the_terminal() {
        let (info, _) = daemon();
        let (a, mut heard) = connect(&info);
        a.spawn(&request("chat-3", true, false, "echo old; sleep 30"));
        assert!(heard.until("old"));
        a.spawn(&request("chat-3", true, false, "echo new; sleep 30"));
        assert!(heard.until("new"));
        assert!(!heard.1.contains("<exit"), "a restart is not an exit: {}", heard.1);
        a.kill("chat-3");
    }

    /// The real thing: the app starts its own executable as ptyd, a chat's terminal outlives the
    /// connection, and a later connection finds the same ptyd. Not run by default: it needs the built
    /// app (`cargo build`) and, where the app links shared libraries, them on LD_LIBRARY_PATH.
    ///   cargo test --lib ptyd_process -- --ignored
    #[test]
    #[ignore = "starts the built executable"]
    fn ptyd_process_is_started_by_the_app_and_found_again() {
        let dir = std::env::temp_dir().join(format!("vibe-ptyd-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let exe = std::env::current_exe().unwrap().parent().unwrap().parent().unwrap().join("vibe-code");
        assert!(exe.is_file(), "build the app first: {}", exe.display());
        // SAFETY: set before anything reads them, in a test that runs alone (it is ignored by default)
        unsafe {
            std::env::set_var("STUDIO_USER_DATA", &dir);
            std::env::set_var("VIBE_PTYD_EXE", &exe);
        }
        let (tx, rx) = mpsc::channel();
        let tx = Arc::new(Mutex::new(tx));
        let first = connect_or_start(move |e| {
            let _ = tx.lock().send(e);
        })
        .expect("ptyd starts");
        let info = read_info().expect("ptyd wrote its address");
        first.spawn(&request("chat-real", true, false, "echo from-the-real-ptyd; sleep 60"));
        let mut heard = Hear(rx, String::new());
        assert!(heard.until("from-the-real-ptyd"));
        first.close(); // the app quits

        let second = connect_or_start(|_| {}).expect("the same ptyd answers");
        assert_eq!(read_info().unwrap().pid, info.pid, "no second ptyd was started");
        assert!(second.sessions.iter().any(|s| s.id == "chat-real"), "the chat is still running");
        second.kill("chat-real");
        #[cfg(unix)]
        unsafe {
            libc::kill(info.pid as i32, libc::SIGKILL);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_terminal_that_ended_while_nobody_looked_shows_its_last_screen_and_code() {
        let (info, _) = daemon();
        let (a, _) = connect(&info);
        a.spawn(&request("chat-4", true, false, "echo goodbye; exit 7"));
        std::thread::sleep(Duration::from_millis(500));
        a.close();
        let (b, mut again) = connect(&info);
        b.spawn(&request("chat-4", true, true, "unused"));
        assert!(again.until("<exit chat-4 7>"), "{}", again.1);
        assert!(again.1.contains("goodbye"));
        b.kill("chat-4");
    }
}
