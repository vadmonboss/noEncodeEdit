//! Tiny localhost HTTP server with Range support.
//!
//! The WebView plays local media through it: Chromium's network stack streams
//! and seeks large files over HTTP far more reliably than through a custom
//! protocol. Only files explicitly registered by the app are served, each under
//! an unguessable token.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::fs::File;
use std::hash::{BuildHasher, Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[derive(Clone)]
pub struct MediaServer {
    port: u16,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
    counter: Arc<AtomicU64>,
    salt: RandomState,
}

impl MediaServer {
    pub fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let port = listener.local_addr()?.port();
        let files: Arc<Mutex<HashMap<String, PathBuf>>> = Arc::new(Mutex::new(HashMap::new()));
        let shared = files.clone();
        std::thread::Builder::new()
            .name("media-server".into())
            .spawn(move || {
                for stream in listener.incoming().flatten() {
                    let files = shared.clone();
                    let _ = std::thread::Builder::new()
                        .name("media-conn".into())
                        .spawn(move || {
                            let _ = handle_connection(stream, files);
                        });
                }
            })?;
        Ok(Self {
            port,
            files,
            counter: Arc::new(AtomicU64::new(1)),
            salt: RandomState::new(),
        })
    }

    /// Registers `path` (if needed) and returns the URL it is served under.
    pub fn url_for(&self, path: &Path) -> String {
        let mut map = self.files.lock().unwrap();
        if let Some((token, _)) = map.iter().find(|(_, p)| p.as_path() == path) {
            return self.make_url(token, path);
        }
        let n = self.counter.fetch_add(1, Ordering::SeqCst);
        let mut h = self.salt.build_hasher();
        n.hash(&mut h);
        path.hash(&mut h);
        let token = format!("{:016x}{:x}", h.finish(), n);
        map.insert(token.clone(), path.to_path_buf());
        self.make_url(&token, path)
    }

    fn make_url(&self, token: &str, path: &Path) -> String {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(|e| e.to_ascii_lowercase())
            .filter(|e| e.chars().all(|c| c.is_ascii_alphanumeric()))
            .unwrap_or_else(|| "bin".into());
        format!("http://127.0.0.1:{}/m/{}.{}", self.port, token, ext)
    }
}

fn content_type(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "mp4" | "m4v" | "mov" | "3gp" => "video/mp4",
        "mkv" | "mk3d" => "video/x-matroska",
        "webm" => "video/webm",
        "mka" => "audio/x-matroska",
        "m4a" | "m4b" => "audio/mp4",
        "mp3" => "audio/mpeg",
        "aac" => "audio/aac",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "ogg" | "oga" | "opus" => "audio/ogg",
        _ => "application/octet-stream",
    }
}

/// Parses a single `bytes=` range. Returns inclusive (start, end).
fn parse_range(value: &str, size: u64) -> Option<(u64, u64)> {
    let spec = value.trim().strip_prefix("bytes=")?;
    let first = spec.split(',').next()?.trim();
    let (a, b) = first.split_once('-')?;
    let (a, b) = (a.trim(), b.trim());
    if size == 0 {
        return None;
    }
    if a.is_empty() {
        let suffix: u64 = b.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        let start = size.saturating_sub(suffix);
        return Some((start, size - 1));
    }
    let start: u64 = a.parse().ok()?;
    if start >= size {
        return None;
    }
    let end = if b.is_empty() {
        size - 1
    } else {
        b.parse::<u64>().ok()?.min(size - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

fn write_simple(stream: &mut TcpStream, status: &str) -> std::io::Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\nConnection: keep-alive\r\n\r\n"
    )
}

fn handle_connection(
    stream: TcpStream,
    files: Arc<Mutex<HashMap<String, PathBuf>>>,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(60)))?;
    stream.set_nodelay(true)?;
    let mut out = stream.try_clone()?;
    let mut reader = BufReader::new(stream);

    loop {
        let mut request_line = String::new();
        if reader.read_line(&mut request_line)? == 0 {
            return Ok(());
        }
        let mut range: Option<String> = None;
        loop {
            let mut header = String::new();
            if reader.read_line(&mut header)? == 0 {
                return Ok(());
            }
            let header = header.trim_end();
            if header.is_empty() {
                break;
            }
            if let Some((k, v)) = header.split_once(':') {
                if k.trim().eq_ignore_ascii_case("range") {
                    range = Some(v.trim().to_string());
                }
            }
        }

        let mut parts = request_line.split_whitespace();
        let method = parts.next().unwrap_or("").to_ascii_uppercase();
        let target = parts.next().unwrap_or("");

        if method == "OPTIONS" {
            write!(
                out,
                "HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: Range\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n"
            )?;
            continue;
        }
        if method != "GET" && method != "HEAD" {
            write_simple(&mut out, "405 Method Not Allowed")?;
            continue;
        }

        let token = target
            .strip_prefix("/m/")
            .map(|t| t.split(['.', '?']).next().unwrap_or(""))
            .unwrap_or("");
        let path = files.lock().unwrap().get(token).cloned();
        let Some(path) = path else {
            write_simple(&mut out, "404 Not Found")?;
            continue;
        };
        let Ok(mut file) = File::open(&path) else {
            write_simple(&mut out, "404 Not Found")?;
            continue;
        };
        let size = file.metadata()?.len();

        let (status, start, end) = match &range {
            Some(r) => match parse_range(r, size) {
                Some((s, e)) => ("206 Partial Content", s, e),
                None => {
                    write!(
                        out,
                        "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{size}\r\nContent-Length: 0\r\nConnection: keep-alive\r\n\r\n"
                    )?;
                    continue;
                }
            },
            None => ("200 OK", 0, size.saturating_sub(1)),
        };
        let len = if size == 0 { 0 } else { end - start + 1 };

        let mut head = format!(
            "HTTP/1.1 {status}\r\nContent-Type: {}\r\nContent-Length: {len}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nAccess-Control-Allow-Origin: *\r\nConnection: keep-alive\r\n",
            content_type(&path)
        );
        if range.is_some() {
            head.push_str(&format!("Content-Range: bytes {start}-{end}/{size}\r\n"));
        }
        head.push_str("\r\n");
        out.write_all(head.as_bytes())?;
        if method == "HEAD" || len == 0 {
            continue;
        }

        file.seek(SeekFrom::Start(start))?;
        let mut remaining = len;
        let mut buf = vec![0u8; 256 * 1024];
        while remaining > 0 {
            let want = remaining.min(buf.len() as u64) as usize;
            let n = file.read(&mut buf[..want])?;
            if n == 0 {
                // File shrank while serving; the response is now broken.
                return Ok(());
            }
            // A write error means the player cancelled the request (seek).
            out.write_all(&buf[..n])?;
            remaining -= n as u64;
        }
        out.flush()?;
    }
}
