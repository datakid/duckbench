# Duckbench 2

A data-prep workbench that runs entirely in the browser, written in plain JavaScript. It cleans, reshapes, joins and exports CSV, TSV, Excel, JSON, JSONL and Parquet files. Data stays in the browser tab and is never uploaded.

## Architecture
- **No build step, no framework.** It uses native ES modules. Add `/fonts/files/*.woff2` from the v1 project (`fonts/fonts.css` points to them).
- **One engine.** A pure-JS columnar `Frame` engine runs in a module Web Worker (`js/engine/worker.js`). If workers are unavailable, it falls back to running inline on the main thread. This replaces v1's two engines, DuckDB-WASM and Arquero, so there are no longer differences between two engines to keep in sync.
- **Step cache.** Each step's output is cached under a hash of everything before it. Editing step N recomputes from step N onward only.
- **Cancel.** A running job is cancelled by terminating the worker. The engine then restarts and reloads its sources and queries.
- **Excel** runs in its own classic worker using the bundled `vendor/xlsx-0.20.3.full.min.js`.
- **Parquet** uses `hyparquet` and `hyparquet-writer`, loaded from jsDelivr only the first time Parquet is used.
- **DuckDB is optional.** `@duckdb/duckdb-wasm@1.32.0` (version 1.29.2 is blocked) is loaded from jsDelivr only when a SQL step runs or a file is opened with DuckDB. The engine reports a SQL step as `needsSql` along with a cache key. `js/app/sqlrunner.js` then copies the step's input into DuckDB, runs the query, and stores the result in the engine under that key. Any steps after it keep using the normal engine and cache.

## Files
| Path | Purpose |
|---|---|
| `index.html` | App shell (strict Content Security Policy) |
| `demo.html` | Opens the app with the sample data loaded (`index.html?demo`) |
| `css/app.css` | All styles: dark and light themes, responsive layout |
| `js/core/` | `types` (inference and conversion), `csv`, `frame`, `formula` (expression language), `normalize` (loose and Arabic matching), `profile`, `transforms` (the step registry), `util` |
| `js/engine/` | `engine.js` (pipeline, cache, export), `worker.js`, `client.js` (RPC, cancel, inline fallback), `parquet.js`, `xlsx-worker.js`, `duck.js` (DuckDB loader, SQL validator, table loading, export via `COPY`) |
| `js/io/` | `xlsx-core.js` (Excel read and write), `zip.js` (ZIP writer and reader, CRC-32, deflate via `CompressionStream`) |
| `js/app/sqlrunner.js` | Runs SQL steps and DuckDB-backed file sources |
| `js/app/tour.js` | Six-step onboarding tour |
| `tests.html`, `js/tests/` | Self-test suite |
| `js/ui/` | `grid` (virtual grid), `forms` (inspector built from step parameter definitions), `overlay` (modal, menu, toast), `dom`, `icons` |
| `js/app/` | `main.js` (wires everything together), `store.js` (state, undo/redo, IndexedDB), `samples.js` |

## Features
- **Import:** several files at once, drag-and-drop anywhere, an options dialog (delimiter, encoding, rows to skip, header row, type detection), a sheet picker for Excel, and nested JSON flattened into columns.
- **Queries:** multiple queries per project. Each can be duplicated, renamed or deleted, or used as the starting point of a new query ("Reference"). Circular references are detected. You can swap in a new data file and keep the steps, or reconnect a missing file with "Locate file…".
- **Steps (about 45):**
  - Rows: filter (multiple conditions with AND/OR, pick values, or a formula), multi-column sort, remove duplicates (exact, loose or Arabic matching; keep first or last), remove blank rows, keep/remove rows (top, bottom, range, every Nth, seeded sample).
  - Table: promote/demote headers, transpose.
  - Columns: choose, remove, rename (several at once), move, duplicate, change type (lenient number parsing, day-first or month-first dates, Excel date serials), detect types, fill down/up, replace empty values.
  - Text: split (by delimiter, positions or digit/letter boundary; into columns or rows), merge, extract, replace (whole value, part of text, regex), change case, trim and clean, pad.
  - Numbers and dates: math, round, date parts (about 20), format date.
  - New columns: formula column, conditional column, index column (optionally restarting per group), rank, running total, percent of total.
  - Summarize, reshape and combine: group by (12 aggregations), pivot, unpivot (or unpivot the other columns), join (7 join types, several key pairs, loose matching, match count), append several queries.
  - Grid edits are recorded as steps: cell edits and row deletes.
- **Formula language:** `[Column]` references, arithmetic and text operators, about 60 functions, and autocomplete for column and function names.
- **Grid:** virtualized rows and columns, cell, range, column and row selection, keyboard navigation, copy as TSV, inline editing, column resizing (double-click to auto-fit), a fill-rate bar under each header, highlighting of changed columns, and find in preview.
- **Column profile:** fill rate, distinct and unique counts, min/max/mean/median/std, a histogram, and the most common values (click a value to filter to it). It covers every row, not a sample.
- **Steps panel:** per-step row change, duration, cache indicator, errors and warnings, preview at any step, drag to reorder, disable, duplicate, notes, and an action to delete everything after a step.
- **Command palette** (⌘K), a ribbon with Home, Transform, Add column and View tabs, header and cell context menus, and keyboard shortcuts (press `?`).
- **Undo/redo** covers every change, up to 150 steps.
- **Session:** saved automatically to IndexedDB, including the data files, and offered for resume on the next visit.
- **Export:** CSV or TSV (with BOM and protection against spreadsheet formula injection), Excel (one query, or every query as its own sheet), Parquet, JSON, JSONL, Markdown and SQL INSERT. You can choose columns and a row range, and export from the step you are previewing.
- **Recipes:** v2 recipes (`.duckbench.json`) store all queries. Duckbench 1 recipes can be opened, and their steps are converted to v2 steps.

## Visual system: Slate & Lichen
- **Dark theme:** a graphite canvas `#131417`, panels `#1a1b1f`, and a pale lichen accent `#c3c992`.
- **Light theme:** a fog canvas `#e9e8e2`, panels `#f8f7f3`, and a moss accent `#5c6a2d`.
- **Data colours:** mist blue for numbers, heather for dates, clay for true/false. Clay also marks changed cells, empty values and warnings.
- **Layout:** panels float on the canvas with rounded corners and 6 px gaps. The interface uses IBM Plex Sans, and numbers use Plex Mono with tabular figures. No display typeface, no textures, no marketing copy.

## SQL and large files
- **SQL step:** Transform → SQL. It's a read-only SELECT over `input`, plus any other queries you select, which appear as tables. One statement only. Writes, `COPY`, `ATTACH`, `INSTALL`, `PRAGMA` and direct file reads are rejected. Results are capped at 2 million rows. Duckbench 1 `raw_sql` steps are converted to this step.
- **Files over 1 GB** (or any file, by ticking "Open with DuckDB" in Import with options) are registered with DuckDB without being read into memory.
  - If the first step is a SQL step, it runs directly against the whole file.
  - Other steps work on the first 1,000,000 rows, and a banner says so.
  - "Export full file via DuckDB" runs a chain of SQL-only steps over every row and writes Parquet, CSV or JSON.
  - Files opened this way must be located again after a reload.

## Batch apply
Available from the import screen or the command palette. Choose a recipe (with a query picker for multi-query recipes) or use the current query's steps. Add files, pick an output format, and download one ZIP or the individual files. Steps that join or append other queries are flagged before the run.

## Onboarding tour
Six spotlight steps covering Queries, Applied steps, the ribbon, the preview grid, Actions (⌘K) and Export. It runs once automatically, and can be started again from the masthead or the import screen. Keyboard: arrow keys, Enter, Esc. `?notour` skips it.

## Self-test
`tests.html` (or `selftest.html`) runs **72/72** tests. In addition to the transform, migration, formula, join, cache and export tests, it covers:
- the SQL validator
- how `WITH` clauses are combined
- DuckDB table naming
- the full SQL-step lifecycle: pending → resolved → error, including cache invalidation
- pushdown to DuckDB-backed sources and the row-slice fallback
- batch queries surviving a `setQueries` call
- a ZIP round trip with CRC-32 checks
- undo/redo and the step cursor

The DuckDB-WASM download itself is not covered by tests.

## Not yet done
- Freezing columns and resizing panels.
- A SQL editor with syntax highlighting.
- Remembering large DuckDB-backed files across reloads.

## Next steps
1. Add a column-freeze option and resizable side panels.
2. Add a SQL editor with highlighting and column autocomplete.
3. Add a streaming CSV reader, so files around 300 MB to 1 GB don't need DuckDB.
