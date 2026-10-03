# Duckbench desktop (Tauri 2)

A native wrapper for the Duckbench web app. The app code is the web app in the parent folder; `scripts/prepare.mjs` copies it into `dist/` and changes three things:

1. **Offline libraries.** DuckDB-WASM 1.32 and hyparquet are bundled into `dist/vendor/` with esbuild, and `js/engine/libs.js` is set to `LOCAL_LIBS = true`. The app never contacts a CDN.
2. **CSP.** `cdn.jsdelivr.net` is removed and Tauri IPC is allowed.
3. **Icons.** Generated from `app-icon.svg` if they don't already exist.

Exports, recipes and batch output use native Save / Choose-folder dialogs. Files are written by the Rust commands `save_file` and `save_into_dir`, which write atomically and never overwrite in batch mode. Window size and position are remembered.

## Requirements
- Node 18+
- Rust (stable, 1.77.2 or newer)
- Platform prerequisites: https://v2.tauri.app/start/prerequisites/
  - Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
  - Windows: WebView2 (the installer downloads it if missing)

## Commands
```bash
cd desktop
npm install
npm run dev
npm run build
npm run check
```

| Command | Result |
|---|---|
| `npm run dev` | Prepares `dist/` and opens the app in a dev window |
| `npm run build` | Builds installers in `src-tauri/target/release/bundle/` (`.dmg`/`.app`, `.msi`/`.exe`, `.deb`/`.rpm`/`.AppImage`) |
| `npm run check` | Prepares `dist/` and runs the Rust unit tests |
| `npm run icons` | Regenerates every icon size from `app-icon.svg` |

After `npm run dev`, open `tests.html` in the window (or press the "Self-test" link) to run the suite against the bundled libraries.

## Release
Push a tag such as `v2.2.0`. `.github/workflows/desktop.yml` builds macOS (Apple Silicon and Intel), Windows and Linux, runs `cargo test`, and attaches the installers to a draft GitHub release.

Code signing is not configured. Unsigned builds work but show a warning on first launch. To sign:
- **macOS:** add `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` as repository secrets and pass them as env to `tauri-action`.
- **Windows:** set `bundle.windows.certificateThumbprint` or use a signing service.

## Layout
| Path | Purpose |
|---|---|
| `scripts/prepare.mjs` | Builds `dist/` from the web app |
| `src-tauri/src/lib.rs` | Commands: `save_file`, `save_into_dir`, `reveal_path` |
| `src-tauri/tauri.conf.json` | Window, bundle and build settings |
| `src-tauri/capabilities/default.json` | Allows only save and open dialogs |
| `app-icon.svg` | Source icon |
