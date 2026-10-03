# Duckbench 2.1

A data-prep workbench that runs entirely in the browser, written in plain JavaScript. It cleans, reshapes, joins and exports CSV, TSV, Excel, JSON, JSONL and Parquet files. Visual steps cover everyday work; DuckDB-WASM handles SQL, large files and fast exports. Data stays in the browser tab and is never uploaded.

## Entry points
| Path | Purpose |
|---|---|
| `index.html` | The app. `?demo` loads the sample project, `?notour` skips the tour |
| `demo.html` | Opens the demo. `?theme=light` and `?tour` are optional |
| `tests.html` / `selftest.html` | Self-test suite (**81/81** passing) |

No backend, no build step, no data tables. Hosting is static.

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

## Other additions
- **Streaming CSV reader.**
  - CSV/TSV files are streamed into the worker with `File.stream()` through a chunk-safe state-machine parser (`CsvStream`).
  - The whole file is never held as one string, so files up to about 1 GB load without DuckDB.
  - The job bar shows progress.
  - Encoding detection is safe across UTF-8 boundaries.
- **Freeze columns** from the toolbar, the header menu, the View tab or the palette. Remembered per query.
- **Resizable side panels.** Drag, use the arrow keys, or double-click to reset. Widths are remembered.

## Visual system: "Night Moss & Bill"
- **Dark.** Near-black olive surfaces (`#0c0d0b` canvas, `#151713` panels). A chartreuse accent `#d2e46e` that echoes the sage logo tile, but with more energy. A warm duck-bill orange `#f2a65a` marks SQL/DuckDB, changes and warnings. Sky, orchid and mint distinguish numbers, dates and true/false.
- **Light.** Warm paper `#ecebe3` with a deep moss accent `#4f6a12` and burnt-orange `#c4621a`.
- **Type.** Bricolage Grotesque for display, Instrument Sans for UI, JetBrains Mono for data and code.
- **Surfaces.** Soft radial glows, layered shadows, 14–20 px radii, uppercase mono section labels, and a centred command bar.
- **Logo.** The uploaded sage duck tile is used as both logo and favicon.
- **Start screen.** A hero with the drop zone and quick actions, plus side cards for resume, recipes/batch/console and DuckDB.

## Files
| Path | Purpose |
|---|---|
| `css/app.css` | All styles |
| `js/core/` | types, csv (+ `CsvStream`), frame, formula, normalize, profile, transforms, util |
| `js/engine/` | `engine.js` (pipeline, cache, `loadFile`, `queryData`), `worker.js` (progress messages), `client.js`, `parquet.js`, `xlsx-worker.js`, `duck.js` (loader, status events, Arrow conversion, single-pass `runQuery`, `COPY`, validator) |
| `js/app/sqlrunner.js` | DuckDB orchestration: serialised jobs, materialisation LRU, pushdown, console, summarize, exports |
| `js/ui/sqleditor.js` | SQL editor, highlighter, function and pattern catalog |
| `js/ui/` | grid (virtual, frozen columns), forms, overlay, dom, icons |
| `js/tests/` | Self-test suite (the folder was previously misnamed `js/test/`, so `tests.html` failed to load) |

## Not yet done
- DuckDB-side execution of visual steps (translating steps to SQL) for whole-file previews.
- Persisting DuckDB-backed files in Firefox and Safari (no File System Access API).
- Opening Excel files with DuckDB (requires the `excel` extension).

## Next steps
1. Compile common visual steps (filter, sort, group by, select) to SQL so DuckDB files can be cleaned without the 1M-row slice.
2. Use DuckDB OPFS storage for very large intermediate results.
3. Add an EXPLAIN view and a query-time breakdown in the console.
