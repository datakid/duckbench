# Duckbench 2

A data-prep workbench that runs entirely in the browser, written in plain JavaScript. It cleans, reshapes, joins and exports CSV, TSV, Excel, JSON, JSONL and Parquet files. Data stays in the browser tab and is never uploaded.

## Architecture
- **No build step, no framework.** It uses native ES modules. Add `/fonts/files/*.woff2` from the v1 project (`fonts/fonts.css` points to them).
- **One engine.** A pure-JS columnar `Frame` engine runs in a module Web Worker (`js/engine/worker.js`). If workers are unavailable, it falls back to running inline on the main thread. This replaces v1's two engines, DuckDB-WASM and Arquero, so there are no longer differences between two engines to keep in sync.
- **Step cache.** Each step's output is cached under a hash of everything before it. Editing step N recomputes from step N onward only.
- **Cancel.** A running job is cancelled by terminating the worker. The engine then restarts and reloads its sources and queries.
- **Excel** runs in its own classic worker using the bundled `vendor/xlsx-0.20.3.full.min.js`.
- **Parquet** uses `hyparquet` and `hyparquet-writer`, loaded from jsDelivr only the first time Parquet is used.

## Files
| Path | Purpose |
|---|---|
| `index.html` | App shell (strict Content Security Policy) |
| `demo.html` | Opens the app with the sample data loaded (`index.html?demo`) |
| `css/app.css` | All styles: dark and light themes, responsive layout |
| `js/core/` | `types` (inference and conversion), `csv`, `frame`, `formula` (expression language), `normalize` (loose and Arabic matching), `profile`, `transforms` (the step registry), `util` |
| `js/engine/` | `engine.js` (pipeline, cache, export), `worker.js`, `client.js` (RPC, cancel, inline fallback), `parquet.js`, `xlsx-worker.js` |
| `js/io/xlsx-core.js` | Excel read and write, shared by the worker and the inline fallback |
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

## Visual identity: "field notebook"
- **Palette:** calm, low-chroma colour. Dark theme: pond ink `#101417` with verdigris `#86b8a6` and ochre `#d2a85e`. Light theme: linen `#f2eee5` with deep verdigris `#3d7566` and ochre `#9a6b1f`. Data types each get their own muted colour: text is verdigris, numbers are slate blue, dates are plum, true/false is ochre.
- **Type:** Fraunces (variable optical size, SOFT axis) for headlines and figures. IBM Plex Sans for the interface. Plex Mono, in small caps with wide letter spacing, for labels, codes and the status bar.
- **Motifs:** contour lines and crop marks on the import screen. A numbered thread connecting the applied steps. Type badges drawn as outlines. Thin rules instead of filled boxes. A faint film grain over everything.

## Self-test
`tests.html` (or `selftest.html`) runs 62 engine tests in the browser and currently shows **62/62**. They cover CSV and type parsing, every transform, conversion of v1 recipe steps, formulas, joins in all join types, references and circular-reference detection, row edits after sorting, the step cache, preview at an earlier step, and every export format.

## Batch apply
Available from the import screen or the command palette. Pick a recipe (or use the current query's steps), add files and choose an output format. Each file is processed and its result downloaded.

## Not yet done
- The guided tour.
- A Custom SQL step. This was removed together with DuckDB.
- Freezing columns and resizing panels.
- Downloading batch results as one ZIP file.

## Next steps
1. Add a ZIP option for batch downloads.
2. Add an optional DuckDB-WASM mode for SQL steps and files over about 1 GB.
3. Add the onboarding tour.
