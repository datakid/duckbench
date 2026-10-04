use percent_encoding::percent_decode_str;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use tauri::http::{header, Request, Response, StatusCode};

fn header_str(req: &tauri::ipc::Request, key: &str) -> Result<String, String> {
    let v = req.headers().get(key).ok_or(format!("missing {key}"))?;
    let s = v.to_str().map_err(|e| e.to_string())?;
    Ok(percent_decode_str(s).decode_utf8_lossy().into_owned())
}

fn body_bytes(req: &tauri::ipc::Request) -> Result<&[u8], String> {
    match req.body() {
        tauri::ipc::InvokeBody::Raw(b) => Ok(b),
        _ => Err("expected raw bytes".into()),
    }
}

pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("no parent folder")?;
    let name = path.file_name().ok_or("no file name")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.duckbench-tmp"));
    {
        let mut f = File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| { let _ = fs::remove_file(&tmp); e.to_string() })
}

pub fn safe_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n == "." || n == ".." || n.contains(['/', '\\', ':', '\0']) {
        return Err(format!("invalid file name: {name}"));
    }
    Ok(n.to_string())
}

pub fn write_new(dir: &Path, name: &str, bytes: &[u8]) -> Result<PathBuf, String> {
    let name = safe_name(name)?;
    let target = dir.join(&name);
    let mut f = OpenOptions::new().write(true).create_new(true).open(&target)
        .map_err(|e| if e.kind() == std::io::ErrorKind::AlreadyExists { format!("{name} already exists") } else { e.to_string() })?;
    f.write_all(bytes).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    Ok(target)
}

#[tauri::command]
fn save_file(request: tauri::ipc::Request) -> Result<(), String> {
    let path = PathBuf::from(header_str(&request, "path")?);
    write_atomic(&path, body_bytes(&request)?)
}

#[tauri::command]
fn save_into_dir(request: tauri::ipc::Request) -> Result<String, String> {
    let dir = PathBuf::from(header_str(&request, "dir")?);
    let name = header_str(&request, "name")?;
    write_new(&dir, &name, body_bytes(&request)?).map(|p| p.to_string_lossy().into_owned())
}

#[derive(serde::Serialize)]
struct FileMeta { size: u64 }

#[tauri::command]
fn file_meta(path: String) -> Result<FileMeta, String> {
    let m = fs::metadata(&path).map_err(|e| e.to_string())?;
    if !m.is_file() { return Err("not a file".into()); }
    Ok(FileMeta { size: m.len() })
}

#[tauri::command]
fn reveal_path(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    #[cfg(target_os = "macos")]
    let r = std::process::Command::new("open").arg("-R").arg(&p).spawn();
    #[cfg(target_os = "windows")]
    let r = std::process::Command::new("explorer").arg(format!("/select,{}", p.display())).spawn();
    #[cfg(all(unix, not(target_os = "macos")))]
    let r = std::process::Command::new("xdg-open").arg(p.parent().unwrap_or(&p)).spawn();
    r.map(|_| ()).map_err(|e| e.to_string())
}

pub fn parse_range(h: Option<&str>, len: u64) -> Option<(u64, u64)> {
    let s = h?.strip_prefix("bytes=")?;
    let (a, b) = s.split_once('-')?;
    if a.is_empty() {
        let n: u64 = b.parse().ok()?;
        if n == 0 || len == 0 { return None; }
        return Some((len.saturating_sub(n), len - 1));
    }
    let start: u64 = a.parse().ok()?;
    let end = if b.is_empty() { len.saturating_sub(1) } else { b.parse::<u64>().ok()?.min(len.saturating_sub(1)) };
    if start > end || start >= len { return None; }
    Some((start, end))
}

fn serve_file(req: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    let raw = req.uri().path().trim_start_matches('/');
    let path = PathBuf::from(percent_decode_str(raw).decode_utf8_lossy().into_owned());
    let resp = |code: StatusCode| Response::builder().status(code).header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*").body(Vec::new()).unwrap();
    let mut f = match File::open(&path) { Ok(f) => f, Err(_) => return resp(StatusCode::NOT_FOUND) };
    let len = match f.metadata() { Ok(m) if m.is_file() => m.len(), _ => return resp(StatusCode::NOT_FOUND) };
    let base = Response::builder()
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_EXPOSE_HEADERS, "Content-Length, Content-Range, Accept-Ranges")
        .header(header::ACCEPT_RANGES, "bytes");
    if req.method() == "HEAD" {
        return base.status(StatusCode::OK).header(header::CONTENT_LENGTH, len).body(Vec::new()).unwrap();
    }
    let range = req.headers().get(header::RANGE).and_then(|v| v.to_str().ok());
    match parse_range(range, len) {
        Some((s, e)) => {
            let mut buf = vec![0u8; (e - s + 1) as usize];
            if f.seek(SeekFrom::Start(s)).is_err() || f.read_exact(&mut buf).is_err() { return resp(StatusCode::INTERNAL_SERVER_ERROR); }
            base.status(StatusCode::PARTIAL_CONTENT).header(header::CONTENT_RANGE, format!("bytes {s}-{e}/{len}")).header(header::CONTENT_LENGTH, buf.len()).body(buf).unwrap()
        }
        None if range.is_some() => base.status(StatusCode::RANGE_NOT_SATISFIABLE).header(header::CONTENT_RANGE, format!("bytes */{len}")).body(Vec::new()).unwrap(),
        None => {
            if len > 256 * 1024 * 1024 { return resp(StatusCode::RANGE_NOT_SATISFIABLE); }
            let mut buf = Vec::with_capacity(len as usize);
            if f.read_to_end(&mut buf).is_err() { return resp(StatusCode::INTERNAL_SERVER_ERROR); }
            base.status(StatusCode::OK).header(header::CONTENT_LENGTH, buf.len()).body(buf).unwrap()
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .register_uri_scheme_protocol("dbfile", |_ctx, req| serve_file(&req))
        .invoke_handler(tauri::generate_handler![save_file, save_into_dir, file_meta, reveal_path])
        .run(tauri::generate_context!())
        .expect("error while running Duckbench");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ranges() {
        assert_eq!(parse_range(Some("bytes=0-9"), 100), Some((0, 9)));
        assert_eq!(parse_range(Some("bytes=90-"), 100), Some((90, 99)));
        assert_eq!(parse_range(Some("bytes=-10"), 100), Some((90, 99)));
        assert_eq!(parse_range(Some("bytes=50-500"), 100), Some((50, 99)));
        assert_eq!(parse_range(Some("bytes=100-"), 100), None);
        assert_eq!(parse_range(None, 100), None);
    }

    #[test]
    fn names() {
        assert!(safe_name("a.csv").is_ok());
        for bad in ["", "..", "a/b", "a\\b", "c:x"] { assert!(safe_name(bad).is_err(), "{bad}"); }
    }

    #[test]
    fn atomic_and_new() {
        let d = tempfile::tempdir().unwrap();
        let p = d.path().join("x.csv");
        write_atomic(&p, b"one").unwrap();
        write_atomic(&p, b"two").unwrap();
        assert_eq!(fs::read(&p).unwrap(), b"two");
        assert!(write_new(d.path(), "x.csv", b"3").is_err(), "never overwrite in batch mode");
        assert!(write_new(d.path(), "y.csv", b"3").is_ok());
    }
}
