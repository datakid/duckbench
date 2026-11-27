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

- **Tested before a release publishes the Linux packages:** Ubuntu 22.04, 24.04 and 26.04, both the `.deb` and the AppImage. The packages are built in an Ubuntu 22.04 container, which sets the glibc floor. The tests use WebKitGTK on a virtual X11 display (Xvfb, software rendering). They install the `.deb`, start the app with the network blocked, and check the DuckDB engine, the bundled Parquet, JSON and Excel extensions, and reading a 250,000-row CSV and Parquet file from disk. The AppImage is started in extract-and-run mode. If a required test fails, the Linux packages are not published.
- **How the environments run:** Ubuntu 24.04 and 26.04 on real runner VMs. Ubuntu 22.04 inside a container with the WebKit sandbox switched off, because GitHub is retiring its 22.04 runner image. Ubuntu 26.10 also runs in a container, but a failure there does not block publishing.
- **Run it by hand:** the *Linux compatibility* workflow (Actions tab) repeats these tests on the packages of any existing release tag.
- **Expected to work, never run:** Debian 12 (`.deb`); Fedora 36 or newer, openSUSE and Arch (AppImage).
- **Not supported:** Ubuntu 20.04, Debian 11 and older, RHEL, Rocky and AlmaLinux 9 and older, 32-bit systems, ARM.
- **Not tested at all:** real hardware or GPU rendering, Wayland, the native Open and Save dialogs, drag and drop, and large-file speed.
- The Linux web view has no OPFS, so DuckDB works in memory. Files are still read in place from disk, but very large sorts or group-bys are limited by free memory.
- Linux builds are unsigned and have no auto-update.
- The release notes are generated from the text in `.github/workflows/release.yml`. Keep the two in step.

## Native DuckDB build (Windows)

A second build of the same app, **Duckbench Native**, runs DuckDB as a native engine in the app process instead of DuckDB-WASM in the web view. It is built from the same source with the `native-duckdb` Cargo feature, a second Tauri config and `prepare.mjs --native`. The standard build does not change: without the feature no DuckDB code is compiled, and the web files behave as before.

| | Standard build | Native build |
|---|---|---|
| Engine | DuckDB-WASM 1.33.1-dev114.0 (DuckDB 2.0.0) in a web worker | DuckDB 2.0.0 through the `duckdb` Rust crate 1.20000.2 (bundled build, Parquet and JSON built in) |
| Memory | Limited by the web view | Limited by the machine; the work database is on disk |
| Large files | Served to WASM through the `dbfile://` protocol | Opened by path, read by DuckDB directly |
| Full-file export | Through browser storage (OPFS) or memory, then saved | Written to disk by DuckDB, then moved to the chosen path |
| Cancel | `cancelSent` on the WASM connection | `duckdb_interrupt` on the native connection |
| Excel with DuckDB | Extension mirrored into the bundle | Extension binary for `windows_amd64` downloaded at build time and bundled as a resource |
| Product name, identifier | Duckbench, `app.duckbench.desktop` | Duckbench Native, `app.duckbench.desktop.native` |
| Platforms | Windows, Linux | Windows installer is published. The code also builds on Linux, which is how it is tested |

### How it works

- **One switch.** `js/engine/libs.js` declares `NATIVE_DUCK = false`. `prepare.mjs --native` rewrites it to `true` in `dist/`. When it is true, each runtime function of `js/engine/duck.js` (start, register file, run query, schema, count, explain, copy, cancel, put columns) hands over to `js/engine/duck-native.js`, which calls Tauri commands. The pure SQL helpers (`validateSql`, `withInput`, `readerFor`, `qi`) are shared, so compiled SQL, SQL steps and the SQL console are identical in both builds.
- **Rust engine** (`src-tauri/src/native/`):
  - `engine.rs` holds one DuckDB connection behind a lock, an interrupt handle that is used without the lock, the registry of files, and exports. The work database, staged files and exports live in a per-run folder under the system temp folder and are removed when the app exits. Folders left by a crash are removed after seven days.
  - `rewrite.rs` replaces the virtual file names the interface uses (`sales.csv`) with the real path, only where a name is the first argument of a `read_*` function, and never inside other literals, comments or identifiers. This keeps local paths out of the SQL the app stores, copies and shares.
  - `convert.rs` turns Arrow record batches into the column JSON the interface already consumes. It follows the web engine: integers that do not fit in 53 bits make the whole column exact text, decimals and huge integers become numbers, dates and timestamps are milliseconds with millisecond precision, times and intervals are text, nested values are JSON text, NaN and infinity are null.
  - `mod.rs` has the Tauri commands. Queries run on blocking threads so the window stays responsive; results come back as raw bytes, not as a JSON string inside JSON.
- **Files without a path** (for example a file dropped in from a browser source) are streamed to a staged file in 32 MB pieces and registered under their name.
- **Exports** are written by `COPY` into the run folder. `saveNative` then asks Rust to move the file to the path chosen in the Save dialog, by rename or by copy when the destination is on another drive. Only files in the current run's export folder can be moved this way. Only the latest export is kept.
- **Excel.** The Excel extension is a loadable DuckDB extension. `prepare.mjs --native` downloads `excel.duckdb_extension` for DuckDB 2.0.0 from `extensions.duckdb.org` into `src-tauri/native-resources/` (ignored by git), and the native config bundles it under `extensions/`. The engine loads it from there, and falls back to a normal `INSTALL excel` only if the file is missing. The build fails if the download fails.
- **Self-check.** `duckbench --selfcheck <report.json> [book.xlsx]` starts the engine without a window, checks the version, a Parquet export, a sample query with Arabic text and a large integer, loading the bundled Excel extension and optionally reading a workbook, then writes a JSON report and exits with 0 or 1.

### Build and test

Needs Rust 1.88 or newer, because the `duckdb` crate requires it. The first build compiles DuckDB from source and takes several minutes.

```bash
npm install
npm run build:native
npm run dev:native
npm run check:native
npm run test:native-js
```

| Command | Result |
|---|---|
| `npm run build:native` | Builds the native installer (`tauri build --features native-duckdb --config src-tauri/tauri.native.conf.json`) |
| `npm run dev:native` | Opens a development window on the native engine |
| `npm run check:native` | Prepares the native bundle, runs the adapter tests, then the Rust tests with the real DuckDB |
| `npm run test:native-js` | Only the JavaScript adapter tests (`scripts/native-adapter.test.mjs`) |

The Excel test inside `cargo test` needs `DUCKBENCH_TEST_EXCEL_EXT` (path of the extension file) and `DUCKBENCH_TEST_XLSX` (`src-tauri/tests/fixtures/book.xlsx`). Without them that one test reports that it was skipped and passes.

### Native workflow and releases

`.github/workflows/native-release.yml` builds, tests and, when asked, attaches the Windows installer to an **existing** release. It never creates or moves a tag and never touches the other assets of the release: it refuses to upload any file whose name does not start with `Duckbench-Native_`, and it appends one section to the release notes only if that section is not there yet.

| Job | What it does |
|---|---|
| Check the tag | Resolves the tag (the latest release if none is given), checks that the release exists and whether to publish |
| Adapter tests | `node --test` on the JavaScript adapter with a mocked Tauri bridge |
| Engine tests (Linux) | `cargo test --features native-duckdb` against the real DuckDB, including the bundled Excel extension and a read of an `.xlsx` file, then `cargo test` without the feature to prove the standard build is unaffected |
| Packaged app smoke test (Linux) | Builds the `.deb`, checks that it contains the Excel extension, installs it, runs `--selfcheck`, then drives the installed app with WebDriver (`.github/scripts/native_smoke_linux.py`) on 250,000-row CSV, Parquet and JSON Lines files with the network blocked: types, exports, Excel, group by, a join, preview truncation, put columns, explain, summarize, cancel, a native export file, a staged browser file, Arabic text and error messages |
| Native installer (Windows) | Runs the Rust tests on Windows, builds the NSIS installer, installs it silently on the runner, and runs `--selfcheck` on the installed app (this proves the bundled Excel extension and the engine load from the installed folder) |
| Attach to the release | Only when publishing. Uploads `Duckbench-Native_<version>_x64-setup.exe` and its `.sha256` and adds the release-notes section |

How to start it:
- **Test only:** push to the `native-duckdb` branch, or run the workflow from the Actions tab with *publish* off.
- **Publish:** run the workflow from the Actions tab with a tag and *publish* on (once the workflow is on the default branch), or push a commit to `native-duckdb` whose message contains `[publish-native]`. The latest release is used when no tag is given.

Not covered by any test: clicking through the Windows window, the native Open and Save dialogs on Windows, drag and drop, and speed on multi-gigabyte files. The Windows installer is unsigned.

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
- **Desktop packages (Linux):** builds the `.deb` and `.AppImage` in an Ubuntu 22.04 container (so the packages keep a glibc 2.35 floor after GitHub retires its 22.04 runners), then the *Linux compatibility* workflow installs and smoke-tests them on Ubuntu 22.04, 24.04, 26.04 and 26.10 (`.github/scripts/desktop_smoke_linux.py`).
- **Desktop installer (Windows):** runs `npm run check` (bundle preparation and the Rust tests), then builds the NSIS installer and uploads it as the `duckbench-windows-installer` artifact (kept 14 days).

CI builds use `src-tauri/tauri.ci.conf.json`, which turns off update artifacts so no signing key is needed.

### Pre-alpha releases

`.github/workflows/release.yml` builds the Windows installer and publishes it on the Releases page with a SHA-256 file. A second set of jobs builds the Linux `.deb` and `.AppImage`, tests them with the *Linux compatibility* workflow, and attaches them to the same release only if the required tests pass. Push a tag to start one:

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
| `src-tauri/src/native/` | The native DuckDB engine (feature `native-duckdb`): `engine.rs`, `convert.rs`, `rewrite.rs` and the Tauri commands in `mod.rs` |
| `src-tauri/tauri.native.conf.json` | Product name, identifier, window and bundled Excel extension of the native build |
| `src-tauri/tests/fixtures/book.xlsx` | Workbook used by the Excel tests |
| `scripts/native-adapter.test.mjs` | Tests of the JavaScript side of the native engine |
| `src-tauri/tauri.conf.json` | Window, bundle, updater and build settings |
| `src-tauri/capabilities/default.json` | Permissions: dialogs, updater, window state, restart |
| `app-icon.svg` | Source icon |
