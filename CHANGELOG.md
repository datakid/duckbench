# Changelog

## Unreleased — Show your work

- **Preview you can trust.** On DuckDB-backed files, steps that ran on the first 1,000,000 rows now carry a `preview` badge, the grid shows a warning naming the first such step, and exporting a result that includes one asks for confirmation (Cancel is focused). Exports of results that ran entirely in DuckDB are unchanged.
- **Step deltas.** Each step shows rows and columns added or removed (`−1,204 rows · +2 cols`), or `no change` when the shape is the same. Counts on a preview are labelled as such.
- **Copy as SQL.** The steps menu and palette can copy the pipeline up to the selected step as one DuckDB statement with a short header. If a later step has no SQL equivalent, the SQL for the steps before it is copied and the step is named. In-memory files show a short explanation instead.
- **Share as a link.** Copy a query's steps as a link (`#r=…`, compressed, no server). Opening a link shows what it contains and applies nothing until you confirm and a file is open. Links never contain the file, its rows or its name. Oversized links, queries that use other queries, and browsers without compression streams fall back to the recipe file.
- **Start screen.** A Recipe link action sits next to Open recipe. The browser title shows the project name.
- **Engine download feedback.** The first DuckDB load on the web says what it is doing and offers Retry if the download fails.
- **No native browser UI.** Tooltips, selects (including on touch devices), the formula reference disclosure, field context menus, number spinners, search-field chrome, spellcheck and autofill are all drawn or controlled by Duckbench. Shift+right-click still opens the browser menu for developers. The operating system's file chooser is the one exception, because browsers provide no other way to pick a local file.
- **Error wording.** The step error banner now names the failing step.

## 2.3.0 — Interface

The 2.3 release is a full UI overhaul. The engine, steps, recipes and file formats are unchanged.

- **Shell.** A full-height sidebar holds the brand, queries and applied steps. The workspace on the right has floating cards for the ribbon and the data grid, with a minimal status line underneath. The inspector is a separate floating panel on the right.
- **Launch screen.** A centred hero, a large drop zone, a resume banner for saved sessions, and a four-card grid (recipe, batch, SQL console, large file).
- **Palette.** The same coral accent and supporting hues as before, at lower chroma: warm-neutral greys, a softened coral `#f26a68` (dark) / `#e85f5d` (light), and muted sky, orchid, mint and sand for types and states.
- **Type.** Geist and Geist Mono, self-hosted, with Instrument Sans and JetBrains Mono as fallbacks.
- **Details.** Underline ribbon tabs, pill step codes on a timeline, taller grid rows (30 px), pill toolbar toggles, frosted menus, toasts and job bar.

### Fixes
- `listSheets` (sheet picker for large `.xlsx` files opened with DuckDB) used to read the whole workbook into memory. It now reads only the ZIP central directory and `xl/workbook.xml`.
- The grid toolbar now refreshes when a step fails, so the title and shape no longer show stale values.
- Removed a row-menu item ("Keep rows above") that was always disabled.
- Added the missing `favicon.svg`, which every page linked to.
- The version shown on the launch screen and in `window.duckbench` now matches the package version (2.3.0).
