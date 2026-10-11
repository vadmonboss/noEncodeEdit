//! Everything that talks to ffmpeg / ffprobe.
//!
//! All edits are stream copies (`-c copy`). The only transcoding done here is
//! for *preview proxies* (when the WebView cannot play a codec) — those files
//! live in the temp folder and never end up in exported results.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const CANCELLED: &str = "__cancelled__";

/// Seeking with `-ss T` lands on the last keyframe with pts <= T. Keyframe
/// times from ffprobe are rounded to microseconds, so a cut placed exactly on
/// a keyframe gets nudged forward a hair to never fall back a whole GOP.
const KEYFRAME_EPS: f64 = 0.0005;

// ---------------------------------------------------------------------------
// Locating binaries & spawning
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub struct FfPaths {
    pub ffmpeg: PathBuf,
    pub ffprobe: PathBuf,
}

pub fn locate(resource_dir: Option<PathBuf>) -> FfPaths {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(d) = exe.parent() {
            dirs.push(d.join("ffmpeg"));
            dirs.push(d.join("resources").join("ffmpeg"));
        }
    }
    if let Some(r) = resource_dir {
        dirs.push(r.join("ffmpeg"));
        dirs.push(r.join("resources").join("ffmpeg"));
    }
    #[cfg(debug_assertions)]
    dirs.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join("ffmpeg"));

    for d in dirs {
        let (ff, fp) = (d.join("ffmpeg.exe"), d.join("ffprobe.exe"));
        if ff.is_file() && fp.is_file() {
            return FfPaths { ffmpeg: ff, ffprobe: fp };
        }
    }
    // Last resort: whatever is on PATH.
    FfPaths { ffmpeg: "ffmpeg".into(), ffprobe: "ffprobe".into() }
}

pub fn command(bin: &Path) -> Command {
    let mut c = Command::new(bin);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c.stdin(Stdio::null());
    c
}

// ---------------------------------------------------------------------------
// Cancellable jobs
// ---------------------------------------------------------------------------

#[derive(Clone, Default)]
pub struct Job {
    cancelled: Arc<AtomicBool>,
    child: Arc<Mutex<Option<Child>>>,
}

impl Job {
    pub fn is_cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    pub fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Some(c) = self.child.lock().unwrap().as_mut() {
            let _ = c.kill();
        }
    }
}

#[derive(Default)]
pub struct Jobs(Mutex<HashMap<String, Job>>);

impl Jobs {
    pub fn create(&self, id: &str) -> Job {
        let job = Job::default();
        if let Some(old) = self.0.lock().unwrap().insert(id.to_string(), job.clone()) {
            old.cancel();
        }
        job
    }
    pub fn cancel(&self, id: &str) {
        if let Some(j) = self.0.lock().unwrap().get(id) {
            j.cancel();
        }
    }
    pub fn finish(&self, id: &str) {
        self.0.lock().unwrap().remove(id);
    }
    pub fn cancel_all(&self) {
        for j in self.0.lock().unwrap().values() {
            j.cancel();
        }
    }
}

/// Runs a process, streaming stdout chunks to `on_chunk`. Returns stderr on
/// success, a readable error otherwise (or `CANCELLED`).
pub fn run_streaming(
    job: &Job,
    mut cmd: Command,
    mut on_chunk: impl FnMut(&[u8]),
) -> Result<String, String> {
    if job.is_cancelled() {
        return Err(CANCELLED.into());
    }
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Не удалось запустить FFmpeg / Failed to start FFmpeg: {e}"))?;
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();
    *job.child.lock().unwrap() = Some(child);
    if job.is_cancelled() {
        job.cancel();
    }

    let err_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stderr.read_to_end(&mut buf);
        String::from_utf8_lossy(&buf).to_string()
    });

    let mut buf = vec![0u8; 64 * 1024];
    loop {
        match stdout.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => on_chunk(&buf[..n]),
        }
    }

    let status = loop {
        let polled = {
            let mut guard = job.child.lock().unwrap();
            match guard.as_mut() {
                Some(c) => c.try_wait(),
                None => break None,
            }
        };
        match polled {
            Ok(Some(st)) => break Some(st),
            Ok(None) => std::thread::sleep(Duration::from_millis(15)),
            Err(_) => break None,
        }
    };
    *job.child.lock().unwrap() = None;
    let stderr = err_thread.join().unwrap_or_default();

    if job.is_cancelled() {
        return Err(CANCELLED.into());
    }
    match status {
        Some(st) if st.success() => Ok(stderr),
        Some(st) => Err(clean_error(&stderr, st.code())),
        None => Err(clean_error(&stderr, None)),
    }
}

/// Line-oriented wrapper around [`run_streaming`].
pub fn run_lines(job: &Job, cmd: Command, mut on_line: impl FnMut(&str)) -> Result<String, String> {
    let mut pending: Vec<u8> = Vec::new();
    let res = run_streaming(job, cmd, |chunk| {
        pending.extend_from_slice(chunk);
        while let Some(pos) = pending.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = pending.drain(..=pos).collect();
            let s = String::from_utf8_lossy(&line);
            on_line(s.trim_end_matches(['\r', '\n']));
        }
    });
    if !pending.is_empty() {
        let s = String::from_utf8_lossy(&pending).to_string();
        on_line(s.trim_end_matches(['\r', '\n']));
    }
    res
}

/// Drops ffmpeg's "[webm @ 000001F…] " / "[out#0/mp4 @ …] " context prefixes.
fn strip_context(line: &str) -> &str {
    let mut l = line.trim();
    while l.starts_with('[') {
        match l.find("] ") {
            Some(i) if l[..i].contains(" @ ") || l[..i].starts_with("[out#") || l[..i].starts_with("[in#") => {
                l = l[i + 2..].trim_start();
            }
            _ => break,
        }
    }
    l
}

fn clean_error(stderr: &str, code: Option<i32>) -> String {
    let all: Vec<&str> = stderr
        .lines()
        .map(strip_context)
        .filter(|l| !l.is_empty())
        .collect();
    // Generic follow-up lines only repeat that something failed.
    let generic = |l: &&str| {
        l.starts_with("Could not write header")
            || l.starts_with("Error opening output file")
            || l.starts_with("Error opening output files")
            || l.starts_with("Conversion failed")
            || l.starts_with("Nothing was written")
    };
    let specific: Vec<&str> = all.iter().copied().filter(|l| !generic(l)).collect();
    let lines = if specific.is_empty() { all } else { specific };
    let tail = if lines.len() > 8 { &lines[lines.len() - 8..] } else { &lines[..] };
    let mut msg = tail.join("\n");
    if msg.chars().count() > 1500 {
        msg = msg.chars().rev().take(1500).collect::<Vec<_>>().into_iter().rev().collect();
    }
    if msg.is_empty() {
        msg = format!("FFmpeg exited with code {}", code.map(|c| c.to_string()).unwrap_or("?".into()));
    }
    msg
}

fn secs(v: f64) -> String {
    format!("{:.6}", v.max(0.0))
}

fn signed_secs(v: f64) -> String {
    format!("{:.6}", v)
}

/// Parses `out_time_us=` / `out_time_ms=` (both are microseconds) from `-progress`.
fn progress_time(line: &str) -> Option<f64> {
    let v = line
        .strip_prefix("out_time_us=")
        .or_else(|| line.strip_prefix("out_time_ms="))?;
    let us: f64 = v.trim().parse().ok()?;
    Some(us / 1_000_000.0)
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

pub fn probe(paths: &FfPaths, path: &str) -> Result<serde_json::Value, String> {
    let out = command(&paths.ffprobe)
        .args(["-v", "error", "-hide_banner", "-print_format", "json", "-show_format", "-show_streams"])
        .arg(path)
        .output()
        .map_err(|e| format!("Не удалось запустить ffprobe / Failed to start ffprobe: {e}"))?;
    if !out.status.success() {
        return Err(clean_error(&String::from_utf8_lossy(&out.stderr), out.status.code()));
    }
    serde_json::from_slice(&out.stdout).map_err(|e| format!("ffprobe JSON: {e}"))
}

/// Keyframe pts (absolute seconds) of a stream; scans the whole file.
pub fn scan_keyframes(
    paths: &FfPaths,
    job: &Job,
    path: &str,
    stream_index: u32,
    duration: f64,
    mut on_progress: impl FnMut(f64),
) -> Result<Vec<f64>, String> {
    let mut cmd = command(&paths.ffprobe);
    cmd.args(["-v", "error", "-select_streams"])
        .arg(stream_index.to_string())
        .args(["-show_entries", "packet=pts_time,flags", "-of", "csv=p=0"])
        .arg(path);
    let mut kf: Vec<f64> = Vec::new();
    let mut last_emit = Instant::now();
    run_lines(job, cmd, |line| {
        let mut it = line.split(',');
        let (Some(t), Some(flags)) = (it.next(), it.next()) else { return };
        let Ok(t) = t.parse::<f64>() else { return };
        if flags.starts_with('K') {
            kf.push(t);
        }
        if duration > 0.0 && last_emit.elapsed() > Duration::from_millis(250) {
            last_emit = Instant::now();
            on_progress((t / duration).clamp(0.0, 1.0));
        }
    })?;
    kf.sort_by(|a, b| a.partial_cmp(b).unwrap());
    kf.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    Ok(kf)
}

/// Keyframes near `abs_time` (fast: seeks instead of scanning everything).
pub fn keyframes_around(
    paths: &FfPaths,
    path: &str,
    stream_index: u32,
    abs_time: f64,
    before: f64,
    after: f64,
) -> Result<Vec<f64>, String> {
    let from = (abs_time - before).max(0.0);
    let to = abs_time + after;
    let out = command(&paths.ffprobe)
        .args(["-v", "error", "-select_streams"])
        .arg(stream_index.to_string())
        .args(["-read_intervals", &format!("{}%{}", secs(from), secs(to))])
        .args(["-show_entries", "packet=pts_time,flags", "-of", "csv=p=0"])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(clean_error(&String::from_utf8_lossy(&out.stderr), out.status.code()));
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mut kf: Vec<f64> = text
        .lines()
        .filter_map(|l| {
            let mut it = l.split(',');
            let t = it.next()?.trim().parse::<f64>().ok()?;
            it.next()?.starts_with('K').then_some(t)
        })
        .collect();
    kf.sort_by(|a, b| a.partial_cmp(b).unwrap());
    kf.dedup_by(|a, b| (*a - *b).abs() < 1e-6);
    Ok(kf)
}

// ---------------------------------------------------------------------------
// Waveform
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Waveform {
    pub pps: u32,
    pub peaks: Vec<u8>,
}

const WAVE_RATE: u32 = 8000;

pub fn peaks_per_second(duration: f64) -> u32 {
    // Divisors of WAVE_RATE so every bucket has the same number of samples.
    let target = if duration > 0.0 { 160_000.0 / duration } else { 100.0 };
    let options = [10u32, 16, 20, 25, 32, 40, 50, 80, 100];
    *options
        .iter()
        .rev()
        .find(|&&p| (p as f64) <= target)
        .unwrap_or(&10)
}

pub fn waveform(
    paths: &FfPaths,
    job: &Job,
    path: &str,
    stream_index: u32,
    duration: f64,
    mut on_chunk: impl FnMut(usize, &[u8], f64),
) -> Result<Waveform, String> {
    let pps = peaks_per_second(duration);
    let spb = (WAVE_RATE / pps) as usize; // samples per bucket
    let mut cmd = command(&paths.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-v", "error", "-i"])
        .arg(path)
        .args(["-map", &format!("0:{stream_index}")])
        .args(["-vn", "-sn", "-dn", "-ac", "1"])
        .args(["-af", &format!("aresample={WAVE_RATE}:async=1:first_pts=0")])
        .args(["-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"]);

    let mut peaks: Vec<u8> = Vec::new();
    let mut odd: Option<u8> = None;
    let mut cur_max: i32 = 0;
    let mut cur_n: usize = 0;
    let mut emitted = 0usize;
    let mut last_emit = Instant::now();

    let push_sample = |s: i16, peaks: &mut Vec<u8>, cur_max: &mut i32, cur_n: &mut usize| {
        let a = (s as i32).abs();
        if a > *cur_max {
            *cur_max = a;
        }
        *cur_n += 1;
        if *cur_n == spb {
            peaks.push(((*cur_max as f64 / 32768.0) * 255.0).round().min(255.0) as u8);
            *cur_max = 0;
            *cur_n = 0;
        }
    };

    run_streaming(job, cmd, |chunk| {
        let mut i = 0;
        if let Some(lo) = odd.take() {
            if !chunk.is_empty() {
                push_sample(i16::from_le_bytes([lo, chunk[0]]), &mut peaks, &mut cur_max, &mut cur_n);
                i = 1;
            }
        }
        while i + 1 < chunk.len() {
            push_sample(i16::from_le_bytes([chunk[i], chunk[i + 1]]), &mut peaks, &mut cur_max, &mut cur_n);
            i += 2;
        }
        if i < chunk.len() {
            odd = Some(chunk[i]);
        }
        if peaks.len() - emitted >= 2000 || (last_emit.elapsed() > Duration::from_millis(300) && peaks.len() > emitted) {
            let progress = if duration > 0.0 { peaks.len() as f64 / pps as f64 / duration } else { 0.0 };
            on_chunk(emitted, &peaks[emitted..], progress.clamp(0.0, 1.0));
            emitted = peaks.len();
            last_emit = Instant::now();
        }
    })?;
    if cur_n > 0 {
        peaks.push(((cur_max as f64 / 32768.0) * 255.0).round().min(255.0) as u8);
    }
    Ok(Waveform { pps, peaks })
}

// ---------------------------------------------------------------------------
// Preview proxies (playback only — never used for export)
// ---------------------------------------------------------------------------

pub fn cache_name(path: &str, stream_index: u32, tag: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut h);
    stream_index.hash(&mut h);
    tag.hash(&mut h);
    if let Ok(m) = std::fs::metadata(path) {
        m.len().hash(&mut h);
        if let Ok(t) = m.modified() {
            t.hash(&mut h);
        }
    }
    format!("{:016x}", h.finish())
}

/// Audio proxy: `copy` remuxes codecs the WebView can play, otherwise AAC.
pub fn audio_preview(
    paths: &FfPaths,
    job: &Job,
    temp: &Path,
    path: &str,
    stream_index: u32,
    codec: &str,
    duration: f64,
    mut on_progress: impl FnMut(f64),
) -> Result<PathBuf, String> {
    let (ext, fmt, copy) = match codec {
        "aac" => ("m4a", "mp4", true),
        "mp3" => ("mp3", "mp3", true),
        "opus" | "vorbis" => ("ogg", "ogg", true),
        "flac" => ("flac", "flac", true),
        _ => ("m4a", "mp4", false),
    };
    let out = temp.join(format!("a_{}.{ext}", cache_name(path, stream_index, if copy { "copy" } else { "aac" })));
    if out.is_file() {
        return Ok(out);
    }
    let part = out.with_extension(format!("part.{ext}"));
    let mut cmd = command(&paths.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats", "-i"])
        .arg(path)
        .args(["-map", &format!("0:{stream_index}"), "-vn", "-sn", "-dn"]);
    if copy {
        cmd.args(["-c:a", "copy"]);
    } else {
        cmd.args(["-c:a", "aac", "-b:a", "192k", "-ac", "2"]);
    }
    cmd.args(["-f", fmt]).arg(&part);
    let res = run_lines(job, cmd, |line| {
        if let Some(t) = progress_time(line) {
            if duration > 0.0 {
                on_progress((t / duration).clamp(0.0, 1.0));
            }
        }
    });
    match res {
        Ok(_) => {
            std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
            Ok(out)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// Video proxy without audio: `remux` copies the stream into MP4/MKV,
/// `transcode` makes a light 540p H.264 file.
pub fn video_preview(
    paths: &FfPaths,
    job: &Job,
    temp: &Path,
    path: &str,
    stream_index: u32,
    codec: &str,
    mode: &str,
    duration: f64,
    mut on_progress: impl FnMut(f64),
) -> Result<PathBuf, String> {
    let remux = mode == "remux";
    let ext = if remux && !matches!(codec, "h264" | "hevc" | "av1" | "vp9") { "mkv" } else { "mp4" };
    let out = temp.join(format!("v_{}.{ext}", cache_name(path, stream_index, mode)));
    if out.is_file() {
        return Ok(out);
    }
    let part = out.with_extension(format!("part.{ext}"));
    let mut cmd = command(&paths.ffmpeg);
    cmd.args(["-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"]);
    if !remux {
        cmd.args(["-hwaccel", "auto"]);
    }
    let lower = path.to_ascii_lowercase();
    if [".avi", ".divx", ".mpg", ".mpeg", ".vob"].iter().any(|e| lower.ends_with(e)) {
        cmd.args(["-fflags", "+genpts"]);
    }
    cmd.arg("-i").arg(path).args(["-map", &format!("0:{stream_index}"), "-an", "-sn", "-dn"]);
    if remux {
        cmd.args(["-c:v", "copy"]);
        if codec == "hevc" {
            cmd.args(["-tag:v", "hvc1"]);
        }
    } else {
        cmd.args([
            "-vf", "scale=-2:'min(540,ih)':flags=fast_bilinear,format=yuv420p",
            "-c:v", "libx264", "-preset", "ultrafast", "-tune", "fastdecode",
            "-crf", "28", "-g", "24",
        ]);
    }
    cmd.args(["-f", if ext == "mkv" { "matroska" } else { "mp4" }]).arg(&part);
    let res = run_lines(job, cmd, |line| {
        if let Some(t) = progress_time(line) {
            if duration > 0.0 {
                on_progress((t / duration).clamp(0.0, 1.0));
            }
        }
    });
    match res {
        Ok(_) => {
            std::fs::rename(&part, &out).map_err(|e| e.to_string())?;
            Ok(out)
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

// ---------------------------------------------------------------------------
// Export (stream copy)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackSpec {
    /// Index into `ExportSpec::inputs` (0 = the main source file).
    pub input: usize,
    pub stream_index: u32,
    /// "video" | "audio" | "subtitle"
    pub kind: String,
    /// Where the external file's 0:00 sits on the source timeline (seconds).
    #[serde(default)]
    pub offset: f64,
    #[serde(default)]
    pub language: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub default: bool,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct FragmentSpec {
    /// In point (relative seconds).
    pub start: f64,
    /// Out point (relative seconds).
    pub end: f64,
    /// Where the video really starts: the keyframe at or before `start`.
    pub video_start: f64,
    pub out_path: String,
    /// Combined seeking only: how far before the keyframe to start accepting
    /// packets (covers B-frame decode delay, stays below half a GOP).
    #[serde(default)]
    pub seek_margin: f64,
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportSpec {
    /// inputs[0] is the source file, the rest are external audio files.
    pub inputs: Vec<String>,
    pub tracks: Vec<TrackSpec>,
    pub fragments: Vec<FragmentSpec>,
    /// ffmpeg muxer name, e.g. "mp4", "matroska", "mov", "webm", "ipod", "mp3".
    pub format: String,
    #[serde(default)]
    pub faststart: bool,
    /// When set, fragments are concatenated into this single file.
    #[serde(default)]
    pub merge_path: Option<String>,
    /// ffmpeg moves `-ss` back by 3/23 s for B-frame video in containers that
    /// can't seek by pts (MKV, FLV, AVI…). Adding it back keeps the cut on the
    /// intended keyframe instead of the previous one.
    #[serde(default)]
    pub seek_preroll: f64,
    /// Regenerate missing pts (AVI / MPEG-PS with B-frames).
    #[serde(default)]
    pub genpts: bool,
    /// MPEG-TS/PS demuxers can't seek onto a keyframe. For those, seek coarsely
    /// on input and let ffmpeg pick the keyframe by timestamp (output `-ss`).
    #[serde(default)]
    pub combined_seek: bool,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExportResult {
    pub files: Vec<String>,
}

fn fragment_args(spec: &ExportSpec, frag: &FragmentSpec, out_path: &Path, with_progress: bool) -> Vec<String> {
    let mut a: Vec<String> = vec!["-hide_banner".into(), "-nostdin".into(), "-y".into(), "-v".into(), "error".into()];
    if with_progress {
        a.extend(["-progress".into(), "pipe:1".into(), "-nostats".into()]);
    }

    let has_video = spec.tracks.iter().any(|t| t.kind == "video");
    // Audio-only cuts drop everything before `seek` anyway, so no compensation.
    let preroll = if has_video { spec.seek_preroll.max(0.0) } else { 0.0 };
    // Content really begins at the keyframe; external audio has to cover it too.
    let content_start = frag.video_start.min(frag.start).max(0.0);
    // `seek` is the input -ss (origin of output timestamps); `out_ss` an optional
    // output -ss measured from it.
    let (seek, out_ss) = if spec.combined_seek && has_video && content_start > 0.0005 {
        let first = (content_start - frag.seek_margin.max(0.0)).max(0.0);
        let coarse = (first - 3.0).max(0.0);
        (coarse, Some(first - coarse))
    } else if frag.start > 0.0005 {
        (frag.start + KEYFRAME_EPS + preroll, None)
    } else {
        (0.0, None)
    };
    let region_start = match out_ss {
        Some(o) => seek + o,
        None => content_start,
    };

    // Input 0: the source.
    if spec.genpts {
        a.extend(["-fflags".into(), "+genpts".into()]);
    }
    if seek > 0.0 {
        a.extend(["-ss".into(), secs(seek)]);
    }
    a.extend(["-i".into(), spec.inputs[0].clone()]);

    // One ffmpeg input per external track so each can carry its own offset.
    let mut input_of_track: Vec<usize> = Vec::with_capacity(spec.tracks.len());
    let mut next_input = 1usize;
    for t in &spec.tracks {
        if t.input == 0 {
            input_of_track.push(0);
            continue;
        }
        // Output timestamps must match the source's: (source_time - seek).
        // External time `x` sits at source time `x + offset`.
        let ext_seek = (region_start - t.offset).max(0.0);
        let itsoffset = ext_seek + t.offset - seek;
        if ext_seek > 0.0005 {
            a.extend(["-ss".into(), secs(ext_seek)]);
        }
        if itsoffset.abs() > 1e-6 {
            a.extend(["-itsoffset".into(), signed_secs(itsoffset)]);
        }
        a.extend(["-i".into(), spec.inputs[t.input].clone()]);
        input_of_track.push(next_input);
        next_input += 1;
    }

    for (i, t) in spec.tracks.iter().enumerate() {
        a.extend(["-map".into(), format!("{}:{}", input_of_track[i], t.stream_index)]);
    }
    a.extend(["-c".into(), "copy".into()]);
    if seek > 0.0 && !has_video {
        // Audio-only result: cut exactly at In. Without this, containers that
        // seek by video keyframes (MKV) would start at the previous keyframe.
        a.extend(["-copypriorss:a".into(), "0".into()]);
    }
    if let Some(o) = out_ss {
        a.extend(["-ss".into(), secs(o)]);
    }
    a.extend(["-t".into(), secs(frag.end - seek - out_ss.unwrap_or(0.0))]);
    a.extend(["-avoid_negative_ts".into(), "make_zero".into()]);
    a.extend(["-map_metadata".into(), "0".into(), "-map_chapters".into(), "-1".into()]);

    for (o, t) in spec.tracks.iter().enumerate() {
        if let Some(lang) = t.language.as_ref().filter(|s| !s.trim().is_empty()) {
            a.extend([format!("-metadata:s:{o}"), format!("language={}", lang.trim())]);
        }
        if let Some(title) = t.title.as_ref() {
            a.extend([format!("-metadata:s:{o}"), format!("title={}", title.trim())]);
        }
        if t.kind == "audio" {
            a.extend([format!("-disposition:{o}"), if t.default { "default".into() } else { "0".into() }]);
        }
    }
    if spec.faststart && matches!(spec.format.as_str(), "mp4" | "mov" | "ipod") {
        a.extend(["-movflags".into(), "+faststart".into()]);
    }
    a.extend(["-f".into(), spec.format.clone()]);
    a.push(out_path.to_string_lossy().to_string());
    a
}

pub struct ExportProgress {
    /// Fragment index currently processed; `fragments.len()` = merging.
    pub index: usize,
    pub fraction: f64,
    pub overall: f64,
}

pub fn export(
    paths: &FfPaths,
    job: &Job,
    spec: &ExportSpec,
    mut on_progress: impl FnMut(ExportProgress),
) -> Result<ExportResult, String> {
    let n = spec.fragments.len();
    if n == 0 {
        return Err("Нет фрагментов для экспорта / No fragments to export".into());
    }
    let lengths: Vec<f64> = spec
        .fragments
        .iter()
        .map(|f| (f.end - f.video_start.min(f.start)).max(0.001))
        .collect();
    let merge = spec.merge_path.as_ref().map(PathBuf::from);
    // Merging costs roughly another pass over the data.
    let total: f64 = lengths.iter().sum::<f64>() * if merge.is_some() { 2.0 } else { 1.0 };

    let tmp_dir = merge.as_ref().map(|m| {
        m.parent()
            .unwrap_or(Path::new("."))
            .join(format!(".noEncodeEdit-tmp-{}", std::process::id()))
    });
    if let Some(d) = &tmp_dir {
        std::fs::create_dir_all(d).map_err(|e| format!("{}: {e}", d.display()))?;
    }
    let cleanup = |d: &Option<PathBuf>| {
        if let Some(d) = d {
            let _ = std::fs::remove_dir_all(d);
        }
    };

    let ext = merge
        .as_ref()
        .and_then(|m| m.extension().map(|e| e.to_string_lossy().to_string()))
        .unwrap_or_else(|| "mkv".into());

    let mut files = Vec::new();
    let mut done = 0.0;
    for (i, frag) in spec.fragments.iter().enumerate() {
        let out = match &tmp_dir {
            Some(d) => d.join(format!("part_{:04}.{ext}", i + 1)),
            None => PathBuf::from(&frag.out_path),
        };
        if out.as_os_str().is_empty() {
            cleanup(&tmp_dir);
            return Err("Пустой путь вывода / Empty output path".into());
        }
        let args = fragment_args(spec, frag, &out, true);
        let mut cmd = command(&paths.ffmpeg);
        cmd.args(&args);
        let len = lengths[i];
        let res = run_lines(job, cmd, |line| {
            if let Some(t) = progress_time(line) {
                let f = (t / len).clamp(0.0, 1.0);
                on_progress(ExportProgress { index: i, fraction: f, overall: ((done + f * len) / total).clamp(0.0, 1.0) });
            }
        });
        if let Err(e) = res {
            if tmp_dir.is_none() {
                let _ = std::fs::remove_file(&out);
            }
            cleanup(&tmp_dir);
            return Err(if e == CANCELLED { e } else { format!("#{}: {e}", i + 1) });
        }
        done += len;
        on_progress(ExportProgress { index: i, fraction: 1.0, overall: (done / total).clamp(0.0, 1.0) });
        files.push(out.to_string_lossy().to_string());
    }

    if let (Some(merge_path), Some(dir)) = (&merge, &tmp_dir) {
        let list_path = dir.join("list.txt");
        let mut list = String::new();
        for f in &files {
            // concat demuxer quoting: close quote, escaped quote, reopen.
            list.push_str(&format!("file '{}'\n", f.replace('\'', "'\\''")));
        }
        std::fs::write(&list_path, list).map_err(|e| e.to_string())?;
        let mut cmd = command(&paths.ffmpeg);
        cmd.args(["-hide_banner", "-nostdin", "-y", "-v", "error", "-progress", "pipe:1", "-nostats"])
            .args(["-f", "concat", "-safe", "0", "-i"])
            .arg(&list_path)
            .args(["-map", "0", "-c", "copy"]);
        if spec.faststart && matches!(spec.format.as_str(), "mp4" | "mov" | "ipod") {
            cmd.args(["-movflags", "+faststart"]);
        }
        cmd.args(["-f", &spec.format]).arg(merge_path);
        let merged_len: f64 = lengths.iter().sum();
        let res = run_lines(job, cmd, |line| {
            if let Some(t) = progress_time(line) {
                let f = (t / merged_len).clamp(0.0, 1.0);
                on_progress(ExportProgress { index: n, fraction: f, overall: ((done + f * merged_len) / total).clamp(0.0, 1.0) });
            }
        });
        cleanup(&tmp_dir);
        if let Err(e) = res {
            let _ = std::fs::remove_file(merge_path);
            return Err(e);
        }
        on_progress(ExportProgress { index: n, fraction: 1.0, overall: 1.0 });
        return Ok(ExportResult { files: vec![merge_path.to_string_lossy().to_string()] });
    }
    Ok(ExportResult { files })
}

// ---------------------------------------------------------------------------
// Compatibility dry-run
// ---------------------------------------------------------------------------

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrackCompat {
    pub ok: bool,
    pub error: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CompatResult {
    pub ok: bool,
    pub error: Option<String>,
    /// Per track, only filled when the combined test failed.
    pub tracks: Vec<TrackCompat>,
}

fn dry_run(paths: &FfPaths, spec: &ExportSpec, temp: &Path, ext: &str, tag: &str) -> Result<(), String> {
    let out = temp.join(format!("compat_{tag}.{ext}"));
    let frag = FragmentSpec { start: 0.0, end: 0.4, video_start: 0.0, out_path: String::new(), seek_margin: 0.0 };
    let mut s = spec.clone();
    s.faststart = false;
    let args = fragment_args(&s, &frag, &out, false);
    let res = command(&paths.ffmpeg).args(&args).stdout(Stdio::null()).output();
    let _ = std::fs::remove_file(&out);
    match res {
        Ok(o) if o.status.success() => Ok(()),
        Ok(o) => Err(clean_error(&String::from_utf8_lossy(&o.stderr), o.status.code())),
        Err(e) => Err(e.to_string()),
    }
}

pub fn test_compat(paths: &FfPaths, spec: &ExportSpec, temp: &Path, ext: &str) -> CompatResult {
    match dry_run(paths, spec, temp, ext, "all") {
        Ok(()) => CompatResult { ok: true, error: None, tracks: vec![] },
        Err(e) => {
            let tracks = spec
                .tracks
                .iter()
                .enumerate()
                .map(|(i, t)| {
                    let mut single = spec.clone();
                    single.tracks = vec![t.clone()];
                    match dry_run(paths, &single, temp, ext, &format!("t{i}")) {
                        Ok(()) => TrackCompat { ok: true, error: None },
                        Err(err) => TrackCompat { ok: false, error: Some(err) },
                    }
                })
                .collect();
            CompatResult { ok: false, error: Some(e), tracks }
        }
    }
}

pub fn version(paths: &FfPaths) -> String {
    command(&paths.ffmpeg)
        .args(["-hide_banner", "-version"])
        .output()
        .ok()
        .and_then(|o| String::from_utf8_lossy(&o.stdout).lines().next().map(|l| l.to_string()))
        .unwrap_or_default()
}
