# Changelog

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
