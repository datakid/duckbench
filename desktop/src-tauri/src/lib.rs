use percent_encoding::percent_decode_str;
use std::path::{Path, PathBuf};
use tauri::ipc::{InvokeBody, Request};
use tauri_plugin_opener::OpenerExt;

fn header(request: &Request<'_>, name: &str) -> Result<String, String> {
    let raw = request
        .headers()
        .get(name)
        .ok_or_else(|| format!("missing {name}"))?
        .to_str()
        .map_err(|e| e.to_string())?;
    percent_decode_str(raw)
        .decode_utf8()
        .map(|s| s.into_owned())
        .map_err(|e| e.to_string())
}

fn body(request: &Request<'_>) -> Result<Vec<u8>, String> {
    match request.body() {
        InvokeBody::Raw(bytes) => Ok(bytes.clone()),
        InvokeBody::Json(_) => Err("expected raw bytes".into()),
    }
}

fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let dir = path.parent().ok_or("invalid path")?;
    if !dir.is_dir() {
        return Err(format!("folder does not exist: {}", dir.display()));
    }
    let name = path.file_name().ok_or("invalid file name")?.to_string_lossy();
    let tmp = dir.join(format!(".{name}.duckbench-partial"));
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    if let Err(e) = std::fs::rename(&tmp, path) {
        let _ = std::fs::remove_file(&tmp);
        std::fs::write(path, bytes).map_err(|w| format!("{e}; {w}"))?;
    }
    Ok(())
}

fn safe_name(name: &str) -> Result<String, String> {
    let cleaned: String = name
        .chars()
        .map(|c| if matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        return Err("empty file name".into());
    }
    Ok(trimmed)
}

fn unique_in(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    let mut n = 2;
    loop {
        let p = dir.join(format!("{stem} ({n}){ext}"));
        if !p.exists() {
            return p;
        }
        n += 1;
    }
}

#[tauri::command]
fn save_file(request: Request<'_>) -> Result<String, String> {
    let path = PathBuf::from(header(&request, "path")?);
    let bytes = body(&request)?;
    write_atomic(&path, &bytes)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn save_into_dir(request: Request<'_>) -> Result<String, String> {
    let dir = PathBuf::from(header(&request, "dir")?);
    let name = safe_name(&header(&request, "name")?)?;
    if !dir.is_dir() {
        return Err(format!("folder does not exist: {}", dir.display()));
    }
    let path = unique_in(&dir, &name);
    write_atomic(&path, &body(&request)?)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn reveal_path(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if p.is_dir() {
        app.opener().open_path(path, None::<&str>).map_err(|e| e.to_string())
    } else {
        app.opener().reveal_item_in_dir(p).map_err(|e| e.to_string())
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![save_file, save_into_dir, reveal_path])
        .run(tauri::generate_context!())
        .expect("error while running Duckbench");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_name_strips_separators() {
        assert_eq!(safe_name("../a/b:c.csv").unwrap(), "_a_b_c.csv");
        assert!(safe_name("..").is_err());
    }

    #[test]
    fn unique_in_adds_suffix() {
        let dir = std::env::temp_dir().join(format!("duckbench-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("a.csv"), b"x").unwrap();
        assert_eq!(unique_in(&dir, "a.csv"), dir.join("a (2).csv"));
        write_atomic(&dir.join("b.csv"), b"hello").unwrap();
        assert_eq!(std::fs::read(dir.join("b.csv")).unwrap(), b"hello");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
