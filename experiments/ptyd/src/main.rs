//! ptyd: holds one PTY (and the program in it) and lets clients attach and detach.
//!
//!   ptyd <socket> <cols> <rows> -- <program> [args…]
//!
//! The daemon feeds everything the program prints to a terminal emulator (vt100), so it always
//! knows what the screen looks like. A client that attaches first gets that screen as one chunk of
//! escape sequences (`S`), then the live output (`D`). Frames, both ways: 1 byte kind, 4 bytes
//! big-endian length, payload.
//!
//!   client → daemon   A cols:u16 rows:u16   attach (and resize to this size)
//!                     I bytes               keystrokes
//!                     R cols:u16 rows:u16   resize
//!   daemon → client   S bytes               the screen now
//!                     D bytes               output
//!                     X code:i32            the program ended
//!
//! Closing a client does nothing to the program: that is the point.

use std::{
    io::{Read, Write},
    num::NonZeroU16,
    os::unix::net::{UnixListener, UnixStream},
    sync::{Arc, Mutex},
    time::Duration,
};

use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

struct Client {
    id: u64,
    stream: UnixStream,
}

struct Shared {
    screen: vt100::Parser,
    clients: Vec<Client>,
    /// the program's exit code once it has ended: the session then stays until someone has looked
    /// at its last screen (the app shows a chat that ended, with its output)
    exited: Option<i32>,
}

fn frame(kind: u8, payload: &[u8]) -> Vec<u8> {
    let mut v = Vec::with_capacity(5 + payload.len());
    v.push(kind);
    v.extend((payload.len() as u32).to_be_bytes());
    v.extend(payload);
    v
}

fn read_frame(s: &mut UnixStream) -> Option<(u8, Vec<u8>)> {
    let mut head = [0u8; 5];
    s.read_exact(&mut head).ok()?;
    let mut body = vec![0u8; u32::from_be_bytes([head[1], head[2], head[3], head[4]]) as usize];
    s.read_exact(&mut body).ok()?;
    Some((head[0], body))
}

fn nz(n: u16) -> NonZeroU16 {
    NonZeroU16::new(n.max(1)).unwrap()
}

fn size(body: &[u8]) -> Option<(u16, u16)> {
    (body.len() == 4).then(|| (u16::from_be_bytes([body[0], body[1]]), u16::from_be_bytes([body[2], body[3]])))
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let Some(split) = args.iter().position(|a| a == "--") else {
        eprintln!("usage: ptyd <socket> <cols> <rows> -- <program> [args…]");
        std::process::exit(2);
    };
    let (sock, cols, rows) = (args[1].clone(), args[2].parse::<u16>().unwrap(), args[3].parse::<u16>().unwrap());
    let program = &args[split + 1..];

    let pair = native_pty_system().openpty(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 }).expect("openpty");
    let mut cmd = CommandBuilder::new(&program[0]);
    cmd.args(&program[1..]);
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    if let Ok(cwd) = std::env::current_dir() {
        cmd.cwd(cwd);
    }
    let mut child = pair.slave.spawn_command(cmd).expect("spawn");
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().expect("reader");
    let writer = Arc::new(Mutex::new(pair.master.take_writer().expect("writer")));
    let master: Arc<Mutex<Box<dyn MasterPty + Send>>> = Arc::new(Mutex::new(pair.master));

    let shared = Arc::new(Mutex::new(Shared { screen: vt100::Parser::new(nz(rows), nz(cols), 0), clients: Vec::new(), exited: None }));

    // the program's output: into the emulator, and to everyone attached
    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            let mut buf = vec![0u8; 64 * 1024];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut sh = shared.lock().unwrap();
                        sh.screen.process(&buf[..n]);
                        let msg = frame(b'D', &buf[..n]);
                        sh.clients.retain_mut(|c| c.stream.write_all(&msg).is_ok());
                    }
                }
            }
        });
    }

    // the program ends: tell the clients. The daemon stays for whoever looks at the last screen next,
    // and ends when the last one leaves (or after ten minutes with no one)
    {
        let shared = shared.clone();
        std::thread::spawn(move || {
            let code = child.wait().map(|s| s.exit_code() as i32).unwrap_or(-1);
            std::thread::sleep(Duration::from_millis(100));
            let msg = frame(b'X', &code.to_be_bytes());
            let mut sh = shared.lock().unwrap();
            sh.exited = Some(code);
            for c in sh.clients.iter_mut() {
                let _ = c.stream.write_all(&msg);
            }
            drop(sh);
            std::thread::sleep(Duration::from_secs(600));
            std::process::exit(0);
        });
    }

    let _ = std::fs::remove_file(&sock);
    let listener = UnixListener::bind(&sock).expect("bind");
    eprintln!("ptyd: {} on {sock} ({cols}x{rows})", program.join(" "));
    let mut next_id = 0u64;
    for conn in listener.incoming().flatten() {
        next_id += 1;
        let (id, shared, writer, master) = (next_id, shared.clone(), writer.clone(), master.clone());
        std::thread::spawn(move || {
            let mut conn = conn;
            let _ = conn.set_write_timeout(Some(Duration::from_secs(2)));
            while let Some((kind, body)) = read_frame(&mut conn) {
                match kind {
                    b'A' => {
                        let Some((c, r)) = size(&body) else { continue };
                        let _ = master.lock().unwrap().resize(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 });
                        let mut sh = shared.lock().unwrap();
                        sh.screen.set_size(nz(r), nz(c));
                        // the screen as it is now, then (under the same lock, so nothing is lost or
                        // doubled) this client joins the live output
                        // a program on the alternate screen (less, top, vim) must still be on it when
                        // it leaves: the snapshot enters it first, which the formatted state does not
                        let mut state: Vec<u8> = Vec::new();
                        if sh.screen.screen().alternate_screen() {
                            state.extend(b"\x1b[?1049h\x1b[2J\x1b[H");
                        }
                        state.extend(sh.screen.screen().state_formatted().as_bytes());
                        let snap = frame(b'S', &state);
                        let Ok(out) = conn.try_clone() else { return };
                        let mut out = out;
                        if out.write_all(&snap).is_err() {
                            return;
                        }
                        if let Some(code) = sh.exited {
                            let _ = out.write_all(&frame(b'X', &code.to_be_bytes()));
                        }
                        sh.clients.push(Client { id, stream: out });
                    }
                    b'I' => {
                        let mut w = writer.lock().unwrap();
                        let _ = w.write_all(&body).and_then(|_| w.flush());
                    }
                    b'R' => {
                        let Some((c, r)) = size(&body) else { continue };
                        let _ = master.lock().unwrap().resize(PtySize { rows: r, cols: c, pixel_width: 0, pixel_height: 0 });
                        shared.lock().unwrap().screen.set_size(nz(r), nz(c));
                    }
                    _ => {}
                }
            }
            let mut sh = shared.lock().unwrap();
            sh.clients.retain(|c| c.id != id);
            // the program has ended and the last one who was looking has gone
            if sh.exited.is_some() && sh.clients.is_empty() {
                std::process::exit(0);
            }
        });
    }
}
