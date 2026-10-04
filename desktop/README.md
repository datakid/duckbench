# Duckbench desktop

The Duckbench desktop app, built with Tauri 2. It runs the same code as the web app. `scripts/prepare.mjs` copies the web app into `dist/` and changes it for desktop:

- **Offline libraries.** DuckDB-WASM, hyparquet and DuckDB's Excel extension are bundled. The app never contacts a CDN.
- **Native files.**
  - Open, Save and Choose-folder use system dialogs.
  - Large files are served to DuckDB through a local `dbfile://` protocol and read directly from disk, without copying.
  - Saves are atomic, and batch exports never overwrite existing files.
- **Updates.** The app checks for new releases and installs them on restart.
- **Window state.** Window size and position are remembered between launches.

## Requirements

- Node 18+
- Rust 1.77.2+
- Platform prerequisites: https://v2.tauri.app/start/prerequisites/
  - Linux: `libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf`
  - Windows: WebView2 (the installer downloads it if missing)

## Commands

```bash
npm install
npm run dev
npm run build
npm run check
npm run icons
```

| Command | Result |
|---|---|
| `npm run dev` | Prepares `dist/` and opens a development window |
| `npm run build` | Builds installers in `src-tauri/target/release/bundle/` |
| `npm run check` | Prepares `dist/` and runs the Rust tests |
| `npm run icons` | Regenerates icons from `app-icon.svg` |

## Releases

Pushing a `v*` tag runs `.github/workflows/desktop.yml`, which:
- builds macOS (Apple Silicon and Intel), Windows and Linux
- runs the Rust tests
- attaches the installers and the update manifest (`latest.json`) to a draft GitHub release

### Signing and updates

| Secret / setting | Purpose |
|---|---|
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Signs update bundles. Create the key with `npx tauri signer generate` |
| `plugins.updater.pubkey` and `endpoints` in `tauri.conf.json` | The matching public key and the release URL |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | macOS signing and notarization |
| `bundle.windows.certificateThumbprint` | Windows Authenticode signing |

Unsigned builds work but show a warning on first launch.

## Layout

| Path | Purpose |
|---|---|
| `scripts/prepare.mjs` | Builds `dist/` from the web app and bundles libraries |
| `src-tauri/src/lib.rs` | Commands (`save_file`, `save_into_dir`, `file_meta`, `reveal_path`), the `dbfile://` protocol, plugins and tests |
| `src-tauri/tauri.conf.json` | Window, bundle, updater and build settings |
| `src-tauri/capabilities/default.json` | Permissions: dialogs, updater, window state, restart |
| `app-icon.svg` | Source icon |
