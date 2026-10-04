# Duckbench

A data-prep workbench that runs entirely on your machine. Clean, reshape, join and export CSV, Excel, JSON and Parquet files with visual steps or SQL. Nothing is uploaded: files are processed in the browser tab or in the desktop app.

Duckbench uses two engines. A fast JavaScript engine handles everyday files. [DuckDB-WASM](https://duckdb.org/docs/api/wasm/overview) handles SQL and files too large for memory.

## Features

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

**SQL**
- SQL steps run DuckDB queries against the current data and any other query
- SQL console with a highlighting editor, autocomplete, query history and a pattern library
- EXPLAIN and EXPLAIN ANALYZE with an operator timing breakdown
- Summarize panel with DuckDB `SUMMARIZE` statistics over every row

**Large files**
- CSV files up to about 1 GB are streamed into memory
- Larger files, or any file opened with "Open with DuckDB", are queried in place
- On DuckDB-backed files, most visual steps are translated to SQL and run over the whole file: filters, sorts, column changes, type changes, replace, case, trim, split, group by, joins and pivots
- Steps that can't be translated exactly run on a preview of the first 1,000,000 rows. Each step shows a `duck` badge when it ran in DuckDB.
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

## Privacy

Files never leave your device. The web app downloads DuckDB-WASM and the Parquet library from jsDelivr on first use. If you open an Excel file with DuckDB, it also downloads DuckDB's Excel extension from `extensions.duckdb.org`. No data is sent anywhere.

Sessions are saved in the browser:
- Small files are stored in IndexedDB.
- Large files opened with DuckDB are remembered as file handles in Chromium-based browsers, and as private copies in the browser's own storage (OPFS) in Firefox and Safari.

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
fonts/                Instrument Sans, JetBrains Mono
desktop/              Tauri 2 project
```

## Testing

Open `tests.html` to run the engine self-test, and `parity.html` to compare SQL-translated steps against the JavaScript engine on real DuckDB-WASM. Desktop Rust tests run with:

```bash
cd desktop && cargo test --manifest-path src-tauri/Cargo.toml
```

## Roadmap

- Translate unpivot, merge columns, extract text and date parts to SQL
- Full and right joins, and loose key matching, in SQL
- Open `.xls` and `.ods` files with DuckDB
- Recent files on desktop
