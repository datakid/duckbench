mod convert;
mod engine;
mod rewrite;

pub use engine::Engine;

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};
use tauri::ipc::Response;
use tauri::{AppHandle, Manager, State};

type Eng<'a> = State<'a, Arc<Engine>>;

const STALE_AFTER: Duration = Duration::from_secs(7 * 24 * 3600);

fn sweep_stale(base: &Path) {
    let Ok(entries) = fs::read_dir(base) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let is_run = path.file_name().map(|n| n.to_string_lossy().starts_with("run-")).unwrap_or(false);
        if !is_run {
            continue;
        }
        let touched = fs::metadata(path.join("work.duckdb"))
            .or_else(|_| fs::metadata(&path))
            .and_then(|m| m.modified())
            .unwrap_or_else(|_| SystemTime::now());
        if SystemTime::now().duration_since(touched).map(|age| age > STALE_AFTER).unwrap_or(false) {
            let _ = fs::remove_dir_all(&path);
        }
    }
}

pub fn new_engine() -> Arc<Engine> {
    let base = std::env::temp_dir().join("duckbench-native");
    sweep_stale(&base);
    let stamp = SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    Arc::new(Engine::new(base.join(format!("run-{}-{stamp}", std::process::id()))))
}

pub fn shutdown(app: &AppHandle) {
    if let Some(engine) = app.try_state::<Arc<Engine>>() {
        engine.shutdown();
    }
}

fn base_extension_dirs() -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = std::env::var("DUCKBENCH_EXTENSION_DIR") {
        dirs.push(PathBuf::from(dir));
    }
    if let Some(dir) = std::env::current_exe().ok().and_then(|p| p.parent().map(|d| d.to_path_buf())) {
        dirs.push(dir.join("extensions"));
        dirs.push(dir);
    }
    dirs
}

fn extension_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Ok(dir) = app.path().resource_dir() {
        dirs.push(dir.join("extensions"));
        dirs.push(dir);
    }
    dirs.extend(base_extension_dirs());
    dirs
}

struct Report {
    map: serde_json::Map<String, serde_json::Value>,
    ok: bool,
}

impl Report {
    fn note(&mut self, key: &str, value: serde_json::Value, good: bool) {
        self.map.insert(key.to_string(), value);
        self.ok &= good;
    }
}

pub fn selfcheck(args: &[String]) -> i32 {
    let mut report = Report { map: serde_json::Map::new(), ok: true };
    let engine = new_engine();
    match engine.init() {
        Ok(version) => report.note("version", version.into(), true),
        Err(e) => report.note("init_error", e.into(), false),
    }
    match engine.export_bytes("SELECT range AS a, 'x' AS b FROM range(100)", "parquet") {
        Ok(bytes) if bytes.starts_with(b"PAR1") => report.note("parquet", "ok".into(), true),
        Ok(_) => report.note("parquet", "bad header".into(), false),
        Err(e) => report.note("parquet", e.into(), false),
    }
    match engine.query("SELECT 'مرحبا' AS s, 9007199254740993::BIGINT AS big", None) {
        Ok(bytes) => {
            let value: serde_json::Value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
            report.note("sample", value["columns"].clone(), value["columns"] == serde_json::json!([["مرحبا"], ["9007199254740993"]]));
        }
        Err(e) => report.note("sample", e.into(), false),
    }
    match engine.load_excel(&base_extension_dirs()) {
        Ok(()) => report.note("excel", "ok".into(), true),
        Err(e) => report.note("excel", e.into(), false),
    }
    if let Some(book) = args.get(1) {
        let rows = engine
            .register("book.xlsx", Path::new(book))
            .and_then(|_| engine.count("SELECT * FROM read_xlsx('book.xlsx', ignore_errors=true, empty_as_varchar=true)"));
        match rows {
            Ok(n) => report.note("excel_rows", n.into(), n == 3),
            Err(e) => report.note("excel_rows", e.into(), false),
        }
    }
    engine.shutdown();
    let passed = report.ok;
    report.note("passed", passed.into(), passed);
    let text = serde_json::to_string_pretty(&serde_json::Value::Object(report.map)).unwrap_or_default();
    match args.first() {
        Some(out) => {
            let _ = fs::write(out, &text);
        }
        None => println!("{text}"),
    }
    if passed {
        0
    } else {
        1
    }
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[derive(serde::Serialize)]
pub struct DuckInfo {
    version: String,
}

#[derive(serde::Serialize)]
pub struct ExportInfo {
    path: String,
    size: u64,
}

#[tauri::command]
pub async fn duck_init(engine: Eng<'_>) -> Result<DuckInfo, String> {
    let e = engine.inner().clone();
    blocking(move || e.init().map(|version| DuckInfo { version })).await
}

#[tauri::command]
pub async fn duck_query(engine: Eng<'_>, sql: String, max_rows: Option<u64>) -> Result<Response, String> {
    let e = engine.inner().clone();
    blocking(move || e.query(&sql, max_rows)).await.map(Response::new)
}

#[tauri::command]
pub async fn duck_schema(engine: Eng<'_>, sql: String) -> Result<Response, String> {
    let e = engine.inner().clone();
    blocking(move || e.schema(&sql)).await.map(Response::new)
}

#[tauri::command]
pub async fn duck_count(engine: Eng<'_>, sql: String) -> Result<i64, String> {
    let e = engine.inner().clone();
    blocking(move || e.count(&sql)).await
}

#[tauri::command]
pub async fn duck_plan(engine: Eng<'_>, sql: String) -> Result<Vec<String>, String> {
    let e = engine.inner().clone();
    blocking(move || e.plan(&sql)).await
}

#[tauri::command]
pub async fn duck_exec(engine: Eng<'_>, sql: String) -> Result<(), String> {
    let e = engine.inner().clone();
    blocking(move || e.exec(&sql)).await
}

#[tauri::command]
pub async fn duck_register(engine: Eng<'_>, name: String, path: String) -> Result<(), String> {
    let e = engine.inner().clone();
    blocking(move || e.register(&name, Path::new(&path))).await
}

#[tauri::command]
pub async fn duck_drop_file(engine: Eng<'_>, name: String) -> Result<(), String> {
    let e = engine.inner().clone();
    blocking(move || {
        e.drop_file(&name);
        Ok(())
    })
    .await
}

#[tauri::command(async)]
pub fn duck_stage(engine: Eng<'_>, request: tauri::ipc::Request<'_>) -> Result<(), String> {
    let name = crate::header_str(&request, "name")?;
    let append = crate::header_str(&request, "append")? == "1";
    engine.stage(&name, crate::body_bytes(&request)?, append)
}

#[tauri::command]
pub async fn duck_copy_bytes(engine: Eng<'_>, sql: String, format: String) -> Result<Response, String> {
    let e = engine.inner().clone();
    blocking(move || e.export_bytes(&sql, &format)).await.map(Response::new)
}

#[tauri::command]
pub async fn duck_copy_file(engine: Eng<'_>, sql: String, format: String) -> Result<ExportInfo, String> {
    let e = engine.inner().clone();
    blocking(move || e.export(&sql, &format).map(|(path, size)| ExportInfo { path: path.to_string_lossy().into_owned(), size })).await
}

#[tauri::command]
pub async fn duck_cancel(engine: Eng<'_>) -> Result<bool, String> {
    Ok(engine.cancel())
}

#[tauri::command]
pub async fn duck_load_excel(app: AppHandle, engine: Eng<'_>) -> Result<(), String> {
    let e = engine.inner().clone();
    let dirs = extension_dirs(&app);
    blocking(move || e.load_excel(&dirs)).await
}

#[tauri::command]
pub async fn native_move_file(engine: Eng<'_>, from: String, to: String) -> Result<(), String> {
    let e = engine.inner().clone();
    blocking(move || e.move_export(Path::new(&from), Path::new(&to))).await
}
