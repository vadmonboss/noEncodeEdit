mod ff;
mod media_server;

use ff::{ExportSpec, FfPaths, Jobs};
use media_server::MediaServer;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

struct Inner {
    ff: FfPaths,
    jobs: Jobs,
    server: MediaServer,
    temp: PathBuf,
    launch_file: Option<String>,
}

#[derive(Clone)]
struct AppState(Arc<Inner>);

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JobProgress {
    job_id: String,
    progress: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct WaveChunk {
    job_id: String,
    offset: usize,
    peaks: Vec<u8>,
    progress: f64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ExportProgressEvent {
    job_id: String,
    index: usize,
    fraction: f64,
    overall: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AppInfo {
    ffmpeg_path: String,
    ffmpeg_version: String,
    temp_dir: String,
    launch_file: Option<String>,
    version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PreparedMedia {
    path: String,
    url: String,
}

async fn blocking<T: Send + 'static>(
    f: impl FnOnce() -> Result<T, String> + Send + 'static,
) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
async fn app_info(state: State<'_, AppState>, app: AppHandle) -> Result<AppInfo, String> {
    let s = state.0.clone();
    let version = app.package_info().version.to_string();
    blocking(move || {
        Ok(AppInfo {
            ffmpeg_path: s.ff.ffmpeg.to_string_lossy().to_string(),
            ffmpeg_version: ff::version(&s.ff),
            temp_dir: s.temp.to_string_lossy().to_string(),
            launch_file: s.launch_file.clone(),
            version,
        })
    })
    .await
}

#[tauri::command]
async fn probe(state: State<'_, AppState>, path: String) -> Result<serde_json::Value, String> {
    let s = state.0.clone();
    blocking(move || ff::probe(&s.ff, &path)).await
}

#[tauri::command]
async fn media_url(state: State<'_, AppState>, path: String) -> Result<String, String> {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("Файл не найден / File not found: {path}"));
    }
    Ok(state.0.server.url_for(&p))
}

#[tauri::command]
async fn scan_keyframes(
    state: State<'_, AppState>,
    app: AppHandle,
    job_id: String,
    path: String,
    stream_index: u32,
    duration: f64,
) -> Result<Vec<f64>, String> {
    let s = state.0.clone();
    blocking(move || {
        let job = s.jobs.create(&job_id);
        let res = ff::scan_keyframes(&s.ff, &job, &path, stream_index, duration, |p| {
            let _ = app.emit("job-progress", JobProgress { job_id: job_id.clone(), progress: p });
        });
        s.jobs.finish(&job_id);
        res
    })
    .await
}

#[tauri::command]
async fn keyframes_around(
    state: State<'_, AppState>,
    path: String,
    stream_index: u32,
    time: f64,
    before: f64,
    after: f64,
) -> Result<Vec<f64>, String> {
    let s = state.0.clone();
    blocking(move || ff::keyframes_around(&s.ff, &path, stream_index, time, before, after)).await
}

#[tauri::command]
async fn waveform(
    state: State<'_, AppState>,
    app: AppHandle,
    job_id: String,
    path: String,
    stream_index: u32,
    duration: f64,
) -> Result<ff::Waveform, String> {
    let s = state.0.clone();
    blocking(move || {
        let job = s.jobs.create(&job_id);
        let res = ff::waveform(&s.ff, &job, &path, stream_index, duration, |offset, peaks, progress| {
            let _ = app.emit(
                "waveform-chunk",
                WaveChunk { job_id: job_id.clone(), offset, peaks: peaks.to_vec(), progress },
            );
        });
        s.jobs.finish(&job_id);
        res
    })
    .await
}

#[tauri::command]
async fn prepare_audio_preview(
    state: State<'_, AppState>,
    app: AppHandle,
    job_id: String,
    path: String,
    stream_index: u32,
    codec: String,
    duration: f64,
) -> Result<PreparedMedia, String> {
    let s = state.0.clone();
    blocking(move || {
        let job = s.jobs.create(&job_id);
        let res = ff::audio_preview(&s.ff, &job, &s.temp, &path, stream_index, &codec, duration, |p| {
            let _ = app.emit("job-progress", JobProgress { job_id: job_id.clone(), progress: p });
        });
        s.jobs.finish(&job_id);
        let out = res?;
        Ok(PreparedMedia { url: s.server.url_for(&out), path: out.to_string_lossy().to_string() })
    })
    .await
}

#[tauri::command]
async fn prepare_video_preview(
    state: State<'_, AppState>,
    app: AppHandle,
    job_id: String,
    path: String,
    stream_index: u32,
    codec: String,
    mode: String,
    duration: f64,
) -> Result<PreparedMedia, String> {
    let s = state.0.clone();
    blocking(move || {
        let job = s.jobs.create(&job_id);
        let res = ff::video_preview(&s.ff, &job, &s.temp, &path, stream_index, &codec, &mode, duration, |p| {
            let _ = app.emit("job-progress", JobProgress { job_id: job_id.clone(), progress: p });
        });
        s.jobs.finish(&job_id);
        let out = res?;
        Ok(PreparedMedia { url: s.server.url_for(&out), path: out.to_string_lossy().to_string() })
    })
    .await
}

#[tauri::command]
async fn export_fragments(
    state: State<'_, AppState>,
    app: AppHandle,
    job_id: String,
    spec: ExportSpec,
) -> Result<ff::ExportResult, String> {
    let s = state.0.clone();
    blocking(move || {
        let job = s.jobs.create(&job_id);
        let res = ff::export(&s.ff, &job, &spec, |p| {
            let _ = app.emit(
                "export-progress",
                ExportProgressEvent { job_id: job_id.clone(), index: p.index, fraction: p.fraction, overall: p.overall },
            );
        });
        s.jobs.finish(&job_id);
        res
    })
    .await
}

#[tauri::command]
async fn test_compat(
    state: State<'_, AppState>,
    spec: ExportSpec,
    extension: String,
) -> Result<ff::CompatResult, String> {
    let s = state.0.clone();
    blocking(move || Ok(ff::test_compat(&s.ff, &spec, &s.temp, &extension))).await
}

#[tauri::command]
fn cancel_job(state: State<'_, AppState>, job_id: String) {
    state.0.jobs.cancel(&job_id);
}

#[tauri::command]
async fn paths_exist(paths: Vec<String>) -> Result<Vec<bool>, String> {
    Ok(paths.iter().map(|p| Path::new(p).exists()).collect())
}

#[tauri::command]
async fn read_text(path: String) -> Result<String, String> {
    blocking(move || std::fs::read_to_string(&path).map_err(|e| format!("{path}: {e}"))).await
}

#[tauri::command]
async fn write_text(path: String, content: String) -> Result<(), String> {
    blocking(move || std::fs::write(&path, content).map_err(|e| format!("{path}: {e}"))).await
}

#[tauri::command]
async fn reveal_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    let mut cmd = std::process::Command::new("explorer.exe");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        if p.is_file() {
            cmd.raw_arg(format!("/select,\"{}\"", path));
        } else {
            cmd.raw_arg(format!("\"{}\"", path));
        }
    }
    #[cfg(not(windows))]
    cmd.arg(&p);
    cmd.spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") || url.chars().any(|c| c.is_whitespace() || c == '"') {
        return Err("Unsupported URL".into());
    }
    std::process::Command::new("explorer.exe")
        .arg(&url)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

fn prepare_temp_dir() -> PathBuf {
    let base = std::env::temp_dir().join("noEncodeEdit");
    // Remove leftovers of previous sessions older than 12 hours.
    if let Ok(entries) = std::fs::read_dir(&base) {
        for e in entries.flatten() {
            let old = e
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| SystemTime::now().duration_since(t).ok())
                .map(|d| d > Duration::from_secs(12 * 3600))
                .unwrap_or(false);
            if old {
                let _ = std::fs::remove_dir_all(e.path());
            }
        }
    }
    let dir = base.join(format!("session-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn launch_file() -> Option<String> {
    std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let ff = ff::locate(app.path().resource_dir().ok());
            let server = MediaServer::start().expect("media server");
            app.manage(AppState(Arc::new(Inner {
                ff,
                jobs: Jobs::default(),
                server,
                temp: prepare_temp_dir(),
                launch_file: launch_file(),
            })));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_info,
            probe,
            media_url,
            scan_keyframes,
            keyframes_around,
            waveform,
            prepare_audio_preview,
            prepare_video_preview,
            export_fragments,
            test_compat,
            cancel_job,
            paths_exist,
            read_text,
            write_text,
            reveal_path,
            open_url,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                state.0.jobs.cancel_all();
                std::thread::sleep(Duration::from_millis(150));
                let _ = std::fs::remove_dir_all(&state.0.temp);
            }
        }
    });
}
