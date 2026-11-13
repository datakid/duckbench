# Duckbench

A data-prep workbench that runs entirely on your machine. Clean, reshape, join and export CSV, Excel, JSON and Parquet files with visual steps or SQL. Nothing is uploaded: files are processed in the browser tab or in the desktop app.

![Duckbench showing a sales table, the ribbon and the applied steps](docs/screenshot.png)

**Try it:** https://duckbench2.vercel.app · **Desktop:** in preview, see [Desktop](#desktop)

Duckbench uses two engines. A fast JavaScript engine handles everyday files. [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) handles SQL and files too large for memory.

## What it does

**Visual steps**
- Filter, sort, remove duplicates or blank rows, keep a range or sample of rows
- Choose, remove, rename, move and duplicate columns
- Change type with lenient number parsing (currency, thousands separators, %, negatives in brackets) and flexible date parsing
- Text: split, merge, extract, replace, change case, trim and clean, pad
- Numbers and dates: math, rounding, date parts, date formatting
- Formula and conditional columns, index, rank, running total, percent of total
- Group by, pivot, unpivot, transpose
- Join and append queries, with exact, loose or Arabic-aware key matching

**Working with steps**
- Every change is a step you can click to preview, edit, disable or reorder
- Undo and redo for every edit
- Each step is cached, so editing late steps doesn't recompute early ones
- Recipes save the whole pipeline as JSON and can be applied to many files in one batch
- Each step shows how many rows and columns it added or removed
- After a file opens, up to three dismissible suggestions can offer to change a text column to numbers, trim padded text, or remove blank rows. They are computed once in the background on files that are open in memory, and each one adds a normal step you can undo
- The desktop app lists your ten most recent files on the start screen and opens them in one click
- Share a query's steps as a link. The link carries the steps only, never your file or its rows
- Copy a pipeline as SQL when the file is opened with DuckDB. The copied SQL reads the file by name, so it runs in DuckDB wherever that file exists (the in-app SQL console blocks direct file reads)

**SQL**
- SQL steps run DuckDB queries against the current data and any other query
- SQL console with a highlighting editor, autocomplete, query history and a pattern library
- EXPLAIN and EXPLAIN ANALYZE with an operator timing breakdown
- Summarize panel with DuckDB `SUMMARIZE` statistics over every row

**Large files**
- CSV files up to about 1 GB are streamed into memory
- Larger files, or any file opened with "Open with DuckDB", are queried in place
- On DuckDB-backed files, most visual steps are translated to SQL and run over the whole file: filters, sorts, column changes, type changes, replace, case, trim, split, merge, date parts, index/duplicate/move columns, fill empty values, group by, joins, pivots and unpivots
- Steps that can't be translated exactly run on a preview of the first 1,000,000 rows. Each step shows a `duck` badge when it ran in DuckDB and a `preview` badge when it ran on the preview. Exporting a result that contains preview-only steps asks you to confirm first.
- Full-file export to Parquet (ZSTD), CSV, JSON or JSONL

**Grid**
- Virtualised grid for millions of rows
- Frozen columns, search, column profiles and a fill-rate bar under each header
- Double-click a header to rename it or a cell to edit it

## Supported formats

| Format | Import | Export | Open with DuckDB |
|---|---|---|---|
| CSV / TSV | ✓ (delimiter and encoding detection) | ✓ | ✓ |
| Excel `.xlsx` | ✓ | ✓ | ✓ |
| Excel `.xls`, `.ods` | ✓ | — | — |
| JSON / JSONL | ✓ | ✓ | ✓ |
| Parquet | ✓ | ✓ | ✓ |

## What it does not do

- It does not upload files or call a server. The web app fetches its libraries from a CDN (see Privacy), and nothing else leaves the page.
- Excel `.xls` and `.ods` files can be imported but not exported, and cannot be opened with DuckDB.
- Extract text and window columns are not translated to SQL yet. Full and right joins, and loose key matching, are not in SQL yet.
- The desktop app is a preview.
- A step is never translated to SQL when SQL could give a different answer from the JavaScript engine.

## Privacy

Files never leave your device. The web app downloads DuckDB-WASM and the Parquet library from jsDelivr on first use. If you open an Excel file with DuckDB, it also downloads DuckDB's Excel extension from `extensions.duckdb.org`. No data is sent anywhere.

A share link contains a query's steps, including column names and any values typed into steps. It never contains the file or its rows.

Sessions are saved in the browser:
- Small files are stored in IndexedDB.
- Large files opened with DuckDB are remembered as file handles in Chromium-based browsers, and as private copies in the browser's own storage (OPFS) in Firefox and Safari.

## Built with

- **No framework, no build step for the web app.** Plain ES modules, a columnar `Frame` engine in a Web Worker, and self-hosted fonts.
- **DuckDB-WASM 1.32.0** for SQL and large files, loaded on demand from jsDelivr (bundled in the desktop app).
- **hyparquet 1**, **hyparquet-compressors 1** and **hyparquet-writer 0** for reading and writing Parquet, loaded from jsDelivr on first use.
- **SheetJS 0.20.3** for Excel and OpenDocument files, vendored in `vendor/`.
- **Fonts:** Geist and Geist Mono, with Instrument Sans and JetBrains Mono as fallbacks.
- **Desktop:** Tauri 2 (Rust 1.77.2 or newer) with the dialog, updater, process and window-state plugins. esbuild prepares the web files for it.

## Getting started

### Web

Duckbench is a static site with no build step. Serve the repository root with any static file server:

```bash
npx serve .
```

Then open `http://localhost:3000`.

| Page | Purpose |
|---|---|
| `index.html` | The app. `?demo` loads a sample project; `?notour` skips the tour |
| `demo.html` | Opens the sample project. Add `?theme=light` or `?tour` |
| `tests.html` | Engine self-test |
| `parity.html` | Checks that steps translated to SQL give the same results as the JavaScript engine |

To deploy on Vercel, use the "Other" framework preset with no build command. `vercel.json` sets security headers and caching, and `.vercelignore` keeps the desktop project out of web deploys.

### Desktop

The desktop app (Tauri 2) bundles every library, works offline and uses native file dialogs. Large files are read directly from disk without being copied into memory.

The desktop app is in preview.

Requirements:
- Node 18+
- Rust 1.77.2+
- The [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform

```bash
cd desktop
npm install
npm run dev
npm run build
```

`npm run dev` opens a development window. `npm run build` writes installers to `desktop/src-tauri/target/release/bundle/`. See [`desktop/README.md`](desktop/README.md) for signing and releases.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `⌘K` / `Ctrl K` | Command palette and add step |
| `⌘J` / `Ctrl J` | SQL console |
| `⌘Z` / `⌘⇧Z` | Undo / redo |
| `⌘S` | Save recipe |
| `?` | All shortcuts |

## Architecture

- **No framework.** Plain ES modules, self-hosted fonts.
- **JavaScript engine** (`js/core/`, `js/engine/engine.js`)
  - A columnar `Frame` engine running in a Web Worker
  - Every step's output is cached under a hash of the steps before it
- **DuckDB layer** (`js/engine/duck.js`, `js/app/sqlrunner.js`)
  - Loads DuckDB-WASM on demand and opens a work database in OPFS when available
  - Copies data into DuckDB tables only when a query needs them
  - Converts Arrow results back to columns
- **Step compiler** (`js/engine/compile.js`, `js/engine/compile-sql.js`)
  - Translates visual steps into a single SQL plan
  - Some steps first run a small check query against the data
  - A step is never translated when SQL could give a different answer from the JavaScript engine
- **Desktop shell** (`desktop/src-tauri/`)
  - Atomic file saves, and batch exports that never overwrite
  - A local file protocol that lets DuckDB read large files directly from disk
  - Auto-update and remembered window size

## Project structure

```
index.html            app
css/app.css           styles
js/core/              types, CSV parser, frame, formulas, transforms
js/engine/            worker engine, DuckDB layer, step compiler, Parquet
js/app/               app shell, store, SQL runner, file storage, tour
js/ui/                grid, forms, SQL editor, overlays, icons
js/io/                Excel worker core, ZIP
js/tests/             self-test and parity suites
vendor/               SheetJS
fonts/                Geist, Geist Mono (+ Instrument Sans, JetBrains Mono fallbacks)
desktop/              Tauri 2 project
```

## Testing

Open `tests.html` to run the engine self-test, and `parity.html` to compare SQL-translated steps against the JavaScript engine on real DuckDB-WASM. Desktop Rust tests run with:

```bash
cd desktop && cargo test --manifest-path src-tauri/Cargo.toml
```

## Roadmap

- Translate extract text and window columns to SQL
- Full and right joins, and loose key matching, in SQL
- Open `.xls` and `.ods` files with DuckDB

## License

MIT. See `LICENSE`. Bundled third-party components keep their own licences.
