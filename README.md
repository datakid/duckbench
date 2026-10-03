# Duckbench 2.2

A data-prep workbench that runs entirely in the browser or as a desktop app, written in plain JavaScript. It cleans, reshapes, joins and exports CSV, TSV, Excel, JSON, JSONL and Parquet files. Visual steps cover everyday work; DuckDB-WASM handles SQL, large files and fast exports. Data stays in the browser tab and is never uploaded.

## Entry points
| Path | Purpose |
|---|---|
| `index.html` | The app. `?demo` loads the sample project, `?notour` skips the tour |
| `demo.html` | Opens the demo. `?theme=light` and `?tour` are optional |
| `tests.html` / `selftest.html` | Self-test suite (**88/88** passing) |

No backend, no build step, no data tables. Hosting is static.

## Two targets, one codebase
| Target | Where | Libraries | Saving files |
|---|---|---|---|
| **Web** | Repo root, deployed as-is (Vercel, any static host) | DuckDB-WASM and hyparquet from jsDelivr on first use | Browser downloads |
| **Desktop** | `desktop/` (Tauri 2), see [`desktop/README.md`](desktop/README.md) | Bundled into the app, works offline | Native Save and Choose-folder dialogs |

`js/app/platform.js` detects the desktop shell (`window.__TAURI__`). `js/engine/libs.js` switches library URLs. Both builds share every other file.

### Deploying the web app
- `.vercelignore` excludes `desktop/`, `.github/` and `images/`, so the Tauri project is never uploaded.
- `vercel.json` sets security headers and caching, plus `Cross-Origin-Opener-Policy: same-origin`.
- No build command or output directory is needed: the framework preset is "Other" and the root is the output.

### Building the desktop app
```bash
cd desktop && npm install && npm run build
```
Pushing a `v*` tag builds macOS, Windows and Linux installers in GitHub Actions (`.github/workflows/desktop.yml`).

## Architecture
- **Native ES modules, no framework.** Fonts are self-hosted in `fonts/files/`.
- **Two engines, one cache.**
  - A pure-JS columnar `Frame` engine in a module Web Worker runs the visual steps. Each step is cached under a hash of everything before it.
  - **DuckDB-WASM 1.32** (version 1.29.2 is blocked) runs SQL steps, the SQL console, Summarize, large files and DuckDB exports. It loads from jsDelivr on first use.
  - SQL results are written back into the step cache, so any visual steps after a SQL step stay cached.
- **The CSP now allows `'wasm-unsafe-eval'`.** Without it the browser refuses to compile DuckDB's WebAssembly, so DuckDB could never start. This was a latent bug in the previous version.
- **Cancel** terminates the worker, interrupts DuckDB (`cancelSent`), drops DuckDB temp tables, then replays sources.

## How DuckDB is used
- **Single pass.** SQL results are capped with a `LIMIT n+1` probe. The old version ran `COUNT(*)` and then the full query, which executed every query twice.
- **Table reuse.** A step's input and the queries it references are materialised into DuckDB once, keyed by the step-cache hash. The 8 most recent are kept (LRU), so editing a SQL step doesn't re-copy its data.
- **Pushdown chains.**
  - On a DuckDB-backed file, every leading SQL step (not just the first) is composed into one CTE chain and runs against the whole file.
  - Visual steps run on a slice of the first 1,000,000 rows.
- **Correct type mapping.** DECIMAL (128-bit words with scale), BIGINT, TIMESTAMP units (s/ms/µs/ns), DATE32, TIME, STRUCT/LIST/MAP (as JSON) and BLOB all convert correctly. Integer columns with values outside JS's safe range fall back to DOUBLE when sent to DuckDB.
- **SQL console** (`⌘J`):
  - Ad-hoc read-only queries over `input` (the active query at the previewed step) and every other query, exposed by name.
  - Only tables the query actually references are copied into DuckDB.
  - Results appear in a table. You can download them as CSV, Parquet, JSONL or JSON via DuckDB `COPY`, or turn the query into a step.
  - Query history (last 20) and a pattern library: QUALIFY top-N, DISTINCT ON, PIVOT/UNPIVOT, SUMMARIZE, window running totals, fuzzy joins.
- **Summarize panel.** DuckDB `SUMMARIZE` over every row. Click a row to open the detailed profile.
- **Exports.**
  - "Parquet via DuckDB (ZSTD)" from the Export menu.
  - Full-file DuckDB export writes Parquet, CSV, JSONL or JSON.
- **Large files.**
  - Files over 1 GB, or any file opened with "Open with DuckDB", are queried in place.
  - Import options (delimiter, header, skip rows, all-text) are passed to `read_csv`.
- **Remembered files.** With the File System Access API (Chromium), DuckDB files are stored as handles and reconnected on resume after a single permission prompt. Other browsers use "Locate file…".
- **Validator.**
  - Read-only, one statement.
  - Now also allows `SUMMARIZE` and `DESCRIBE`.
  - Now also rejects `FROM 'file.csv'`, quoted file paths, `query()`, `query_table()`, `getenv()` and `parquet_metadata()`.

## SQL editor
- A highlighted overlay editor with line numbers. It colours keywords, functions, strings, numbers, comments, tables and known columns.
- Autocomplete (and `Ctrl Space`) suggests columns with their type, tables, about 110 DuckDB functions with signatures, and keywords.
- `⌘↵` runs, `⌘/` toggles comments, Tab indents, and Enter keeps the current indentation.
- Used in SQL steps (the inspector widens to 520 px) and in the console.

## New in 2.2
- **Visual steps run in DuckDB over the whole file.**
  - On DuckDB-backed files, leading steps are compiled to SQL (`js/engine/compile.js`) and composed with any SQL steps into one plan. Supported steps:
    - filter by conditions or picked values
    - sort (stable)
    - choose, remove and rename columns
    - first N rows, range, remove first N
    - remove blank rows
    - exact duplicate removal (first, last or lowest)
    - group by with count, non-empty, distinct, sum, avg, median, std, min and max
  - These steps get a `duck` badge. Steps after the first one that can't compile run in JS on the preview slice.
  - Anything that would give a different answer in SQL is never compiled: formulas, regex, loose/Arabic matching, sampling, text min/max, or literals that don't parse.
  - Compiled output was checked row-for-row against the JS engine on real DuckDB-WASM for 13 representative steps.
  - The column schema is read once with `LIMIT 0` and cached.
  - Full-file export now covers every compiled step. It only refuses when a step can't run in DuckDB, and the message names that step.
- **OPFS storage.**
  - Where the Origin Private File System is available, DuckDB opens a fresh `opfs://duckbench_work_*.db` database, so large intermediate tables spill to disk instead of memory.
  - Old work files are cleared on start, and DuckDB falls back to memory if OPFS fails.
  - Toggle it from the DuckDB menu (stored in `duckbench2.duckOpfs`). The menu shows the active storage.
- **EXPLAIN and timing in the SQL console.**
  - **Explain** shows the plan.
  - **Analyze** runs `EXPLAIN (ANALYZE, FORMAT JSON)` and shows the operator tree with row counts and times, plus the slowest operators as chips. It falls back to the text plan.
  - Every Run, Explain and Analyze shows a timing bar split into DuckDB load, input preparation and query time.
- **Desktop app** (Tauri 2) with offline libraries, native save dialogs, a folder target for batch output, "Show in folder" after saving, and remembered window size.

## Other additions
- **Streaming CSV reader.**
  - CSV/TSV files are streamed into the worker with `File.stream()` through a chunk-safe state-machine parser (`CsvStream`).
  - The whole file is never held as one string, so files up to about 1 GB load without DuckDB.
  - The job bar shows progress.
  - Encoding detection is safe across UTF-8 boundaries.
- **Freeze columns** from the toolbar, the header menu, the View tab or the palette. Remembered per query.
- **Resizable side panels.** Drag, use the arrow keys, or double-click to reset. Widths are remembered.

## Visual system: Raycast neutrals + coral
- **One accent.** Coral `#F76061` marks primary actions, the selection, the active step and errors. Nothing else uses it.
- **Neutrals.**
  - Dark: `#111111` canvas, `#1a1a1a` panels, `#F7F7F7` text.
  - Light: `#F7F7F7` canvas, `#ffffff` panels, `#1b1b1b` text.
- **Data colours** are low-chroma, so the grid stays calm:
  - numbers: mist blue `#9dbbe0`
  - dates and SQL/DuckDB: lavender `#c9b7e6`
  - true: sage `#a3d1b0`
  - changed cells, untrimmed text and warnings: sand `#e3b98f`
- **No glows, gradients or display type.** Instrument Sans for UI, JetBrains Mono for data and code. Labels are sentence case.
- **Copy** is short and functional: labels name the thing, with no taglines.
- **Logo and favicon:** the duck mark in `#F7F7F7` on a coral `#F76061` tile.
- **Icons:** neutral grey at rest; coral on hover and when active. Data-type colours appear only on type badges and cell values.

## Files
| Path | Purpose |
|---|---|
| `css/app.css` | All styles |
| `js/core/` | types, csv (+ `CsvStream`), frame, formula, normalize, profile, transforms, util |
| `js/engine/` | `engine.js` (pipeline, cache, `loadFile`, `queryData`), `worker.js` (progress messages), `client.js`, `parquet.js`, `xlsx-worker.js`, `duck.js` (loader, status events, Arrow conversion, single-pass `runQuery`, `COPY`, validator) |
| `js/app/sqlrunner.js` | DuckDB orchestration: serialised jobs, materialisation LRU, schema and source resolution, console, EXPLAIN, summarize, exports |
| `js/engine/compile.js` | Visual step to DuckDB SQL compiler |
| `js/engine/libs.js` | CDN or bundled library URLs (`LOCAL_LIBS`) |
| `js/app/platform.js` | Desktop detection and native save, folder and reveal calls |
| `vendor/xlsx-0.20.3.full.min.js` | SheetJS (Excel read/write) |
| `fonts/files/` | Self-hosted Instrument Sans, Bricolage Grotesque, JetBrains Mono |
| `desktop/` | Tauri 2 project (excluded from web deploys) |
| `vercel.json`, `.vercelignore` | Web deploy settings |
| `js/ui/sqleditor.js` | SQL editor, highlighter, function and pattern catalog |
| `js/ui/` | grid (virtual, frozen columns), forms, overlay, dom, icons |
| `js/tests/` | Self-test suite (the folder was previously misnamed `js/test/`, so `tests.html` failed to load) |

## Not yet done
- Compiling the remaining visual steps (change type, replace values, split, joins, pivot) to SQL.
- Persisting DuckDB-backed files in Firefox and Safari (no File System Access API).
- Opening Excel files with DuckDB (requires the `excel` extension).
- Code signing and auto-update for the desktop app.
- On desktop, opening files by native path (files are still read through the WebView file picker).

## Next steps
1. Compile `change_type`, `replace_values`, `change_case`/`trim` and `join` to SQL, with a row-for-row DuckDB parity test for each.
2. Add signing secrets to the desktop workflow and enable the Tauri updater.
3. On desktop, register large files with DuckDB by path for zero-copy reads, and remember recent files.
