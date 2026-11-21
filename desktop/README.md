# Duckbench desktop

The Duckbench desktop app, built with Tauri 2. It runs the same code as the web app. `scripts/prepare.mjs` copies the web app into `dist/` and changes it for desktop:

- **Offline libraries.** DuckDB-WASM, hyparquet and DuckDB's Excel, Parquet and JSON extensions are bundled. The app never contacts a CDN.
- **Native files.**
  - Open, Save and Choose-folder use system dialogs.
  - Large files are served to DuckDB through a local `dbfile://` protocol and read directly from disk, without copying.
  - Saves are atomic, and batch exports never overwrite existing files.
- **Updates.** Not enabled yet. The update check stays off until signing keys and an update endpoint are set up (see Signing and updates below).
- **Window state.** Window size and position are remembered between launches.

## Requirements

- Node 18+
- Rust 1.77.2+
- Platform prerequisites: https://v2.tauri.app/start/prerequisites/
  - Linux: `libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev libssl-dev libxdo-dev patchelf`
  - Windows: WebView2 (the installer downloads it if missing)

## Linux

Releases include two x86_64 packages. There is no ARM, 32-bit, `.rpm`, Flatpak or Snap build.

| | `.deb` | `.AppImage` |
|---|---|---|
| For | Debian, Ubuntu and derivatives | Any other x86_64 distribution |
| Needs | `libwebkit2gtk-4.1-0` and `libgtk-3-0` from the distribution, glibc 2.34 or newer | glibc 2.35 or newer. It bundles WebKitGTK 4.1 and GTK (about 90 MB, 259 MB unpacked) and needs FUSE to mount, or `--appimage-extract-and-run` |

```bash
sudo apt install ./Duckbench_*_amd64.deb
chmod +x Duckbench_*_amd64.AppImage && ./Duckbench_*_amd64.AppImage
```

Both are built on Ubuntu 22.04, which sets those glibc floors.

- **Tested by CI on every release:** Ubuntu 22.04, with WebKitGTK 2.50 on a virtual X11 display (Xvfb, software rendering). CI installs the `.deb`, starts the app with the network blocked, and checks the DuckDB engine, the bundled Parquet, JSON and Excel extensions, and reading a 250,000-row CSV and Parquet file from disk. The AppImage was tested the same way in extract-and-run mode.
- **Also tested for v2.4.0-alpha.4:** Ubuntu 24.04 (glibc 2.39, WebKitGTK 2.52) and Ubuntu 26.04 (glibc 2.43, WebKitGTK 2.52), both the `.deb` and the AppImage, with the same checks. Run the *Linux compatibility* workflow (Actions tab, with a release tag) to repeat this for another release; it is not part of the release pipeline.
- **Expected to work, never run:** Debian 12 (`.deb`); Fedora 36 or newer, openSUSE and Arch (AppImage).
- **Not supported:** Ubuntu 20.04, Debian 11 and older, RHEL, Rocky and AlmaLinux 9 and older, 32-bit systems, ARM.
- **Not tested at all:** real hardware or GPU rendering, Wayland, the native Open and Save dialogs, drag and drop, and large-file speed.
- The Linux web view has no OPFS, so DuckDB works in memory. Files are still read in place from disk, but very large sorts or group-bys are limited by free memory.
- Linux builds are unsigned and have no auto-update.
- The release notes are generated from the text in `.github/workflows/release.yml`. Keep the two in step.

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

### CI

`.github/workflows/ci.yml` runs on every push to `main`, every pull request, and on demand:
- **Web self-tests:** the browser test suite (`tests.html`) runs in headless Chromium.
- **Desktop packages (Linux):** runs `npm run check`, builds the `.deb` and `.AppImage`, installs the `.deb` and smoke-tests the installed app (`.github/scripts/desktop_smoke_linux.py`).
- **Desktop installer (Windows):** runs `npm run check` (bundle preparation and the Rust tests), then builds the NSIS installer and uploads it as the `duckbench-windows-installer` artifact (kept 14 days).

CI builds use `src-tauri/tauri.ci.conf.json`, which turns off update artifacts so no signing key is needed.

### Pre-alpha releases

`.github/workflows/release.yml` builds the Windows installer and publishes it on the Releases page with a SHA-256 file. A second job then builds the Linux `.deb` and `.AppImage` and attaches them to the same release. Push a tag to start one:

```bash
git tag v2.3.0-alpha.1
git push origin v2.3.0-alpha.1
```

- The version in the tag is written into the installer, so version numbers don't need editing by hand.
- A tag with a suffix (`-alpha.1`, `-beta.1`) is published as a **pre-release**. A plain tag such as `v2.3.0` is a normal release.
- It can also be started from the Actions tab (**Run workflow**) with a tag name.
- These builds are unsigned and have no auto-update. macOS builds are not part of the workflow yet.

### Signing and updates (not enabled yet)

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
