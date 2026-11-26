use super::{convert, rewrite};
use duckdb::{Config, Connection, InterruptHandle};
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

const NOT_RUNNING: &str = "The native DuckDB engine is not running.";

fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn text<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn safe_part(name: &str) -> String {
    name.chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect()
}

pub fn copy_options(format: &str) -> Result<(&'static str, &'static str), String> {
    match format {
        "parquet" => Ok(("(FORMAT PARQUET, COMPRESSION ZSTD, ROW_GROUP_SIZE 122880)", "parquet")),
        "csv" => Ok(("(FORMAT CSV, HEADER)", "csv")),
        "json" => Ok(("(FORMAT JSON, ARRAY true)", "json")),
        "jsonl" => Ok(("(FORMAT JSON)", "jsonl")),
        other => Err(format!("DuckDB can’t write {other}.")),
    }
}

pub struct Engine {
    run_dir: PathBuf,
    conn: Mutex<Option<Connection>>,
    interrupt: Mutex<Option<Arc<InterruptHandle>>>,
    files: Mutex<HashMap<String, PathBuf>>,
    staged: Mutex<HashMap<String, PathBuf>>,
    excel: Mutex<bool>,
    seq: AtomicU64,
}

impl Engine {
    pub fn new(run_dir: PathBuf) -> Self {
        Engine {
            run_dir,
            conn: Mutex::new(None),
            interrupt: Mutex::new(None),
            files: Mutex::new(HashMap::new()),
            staged: Mutex::new(HashMap::new()),
            excel: Mutex::new(false),
            seq: AtomicU64::new(1),
        }
    }

    pub fn run_dir(&self) -> &Path {
        &self.run_dir
    }

    pub fn init(&self) -> Result<String, String> {
        let mut guard = lock(&self.conn);
        if guard.is_none() {
            fs::create_dir_all(&self.run_dir).map_err(text)?;
            let db = self.run_dir.join("work.duckdb");
            let _ = fs::remove_file(&db);
            let _ = fs::remove_file(self.run_dir.join("work.duckdb.wal"));
            let conn = Connection::open_with_flags(&db, Config::default()).map_err(text)?;
            conn.execute_batch("SET autoinstall_known_extensions = false;").map_err(text)?;
            *lock(&self.interrupt) = Some(conn.interrupt_handle());
            *guard = Some(conn);
        }
        let conn = guard.as_ref().ok_or(NOT_RUNNING)?;
        conn.query_row("SELECT version()", [], |r| r.get::<_, String>(0)).map_err(text)
    }

    pub fn shutdown(&self) {
        *lock(&self.interrupt) = None;
        *lock(&self.conn) = None;
        let _ = fs::remove_dir_all(&self.run_dir);
    }

    pub fn cancel(&self) -> bool {
        match lock(&self.interrupt).as_ref() {
            Some(handle) => {
                handle.interrupt();
                true
            }
            None => false,
        }
    }

    fn resolve(&self, sql: &str) -> String {
        rewrite::resolve_files(sql, &lock(&self.files))
    }

    fn run(&self, sql: &str, limit: Option<u64>) -> Result<Vec<u8>, String> {
        let started = Instant::now();
        let guard = lock(&self.conn);
        let conn = guard.as_ref().ok_or(NOT_RUNNING)?;
        let mut stmt = conn.prepare(sql).map_err(text)?;
        let stream = stmt.stream_arrow([]).map_err(text)?;
        let schema = stream.get_schema();
        let mut builder = convert::Builder::new(&schema, limit);
        for batch in stream {
            let batch = batch.map_err(text)?;
            builder.push(&batch)?;
            if builder.truncated() {
                break;
            }
        }
        Ok(builder.finish(started.elapsed().as_secs_f64() * 1000.0))
    }

    pub fn query(&self, sql: &str, max_rows: Option<u64>) -> Result<Vec<u8>, String> {
        let sql = self.resolve(sql);
        match max_rows {
            Some(n) => self.run(&format!("SELECT * FROM ({sql}\n) LIMIT {}", n.saturating_add(1)), Some(n)),
            None => self.run(&sql, None),
        }
    }

    pub fn schema(&self, sql: &str) -> Result<Vec<u8>, String> {
        let sql = self.resolve(sql);
        self.run(&format!("SELECT * FROM ({sql}\n) LIMIT 0"), Some(0))
    }

    pub fn count(&self, sql: &str) -> Result<i64, String> {
        let sql = self.resolve(sql);
        let guard = lock(&self.conn);
        let conn = guard.as_ref().ok_or(NOT_RUNNING)?;
        conn.query_row(&format!("SELECT COUNT(*) AS n FROM ({sql}\n)"), [], |r| r.get::<_, i64>(0)).map_err(text)
    }

    pub fn plan(&self, sql: &str) -> Result<Vec<String>, String> {
        let sql = self.resolve(sql);
        let guard = lock(&self.conn);
        let conn = guard.as_ref().ok_or(NOT_RUNNING)?;
        let mut stmt = conn.prepare(&sql).map_err(text)?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(1)).map_err(text)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(text)
    }

    pub fn exec(&self, sql: &str) -> Result<(), String> {
        let sql = self.resolve(sql);
        let guard = lock(&self.conn);
        let conn = guard.as_ref().ok_or(NOT_RUNNING)?;
        conn.execute_batch(&sql).map_err(text)
    }

    pub fn register(&self, name: &str, path: &Path) -> Result<(), String> {
        let meta = fs::metadata(path).map_err(|e| format!("Can’t open {}: {e}", path.display()))?;
        if !meta.is_file() {
            return Err(format!("{} is not a file.", path.display()));
        }
        lock(&self.files).insert(name.to_string(), path.to_path_buf());
        Ok(())
    }

    pub fn drop_file(&self, name: &str) {
        lock(&self.files).remove(name);
        if let Some(path) = lock(&self.staged).remove(name) {
            let _ = fs::remove_file(path);
        }
    }

    pub fn stage(&self, name: &str, bytes: &[u8], append: bool) -> Result<(), String> {
        let path = {
            let mut staged = lock(&self.staged);
            staged
                .entry(name.to_string())
                .or_insert_with(|| {
                    let n = self.seq.fetch_add(1, Ordering::Relaxed);
                    self.run_dir.join("staged").join(format!("{n}-{}", safe_part(name)))
                })
                .clone()
        };
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).map_err(text)?;
        }
        let mut file: File = if append {
            OpenOptions::new().create(true).append(true).open(&path).map_err(text)?
        } else {
            File::create(&path).map_err(text)?
        };
        file.write_all(bytes).map_err(text)?;
        lock(&self.files).insert(name.to_string(), path);
        Ok(())
    }

    pub fn export(&self, sql: &str, format: &str) -> Result<(PathBuf, u64), String> {
        let (options, ext) = copy_options(format)?;
        let dir = self.run_dir.join("exports");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).map_err(text)?;
        let dest = dir.join(format!("export-{}.{ext}", self.seq.fetch_add(1, Ordering::Relaxed)));
        let sql = self.resolve(sql);
        let target = dest.to_string_lossy().replace('\'', "''");
        {
            let guard = lock(&self.conn);
            let conn = guard.as_ref().ok_or(NOT_RUNNING)?;
            if let Err(e) = conn.execute_batch(&format!("COPY ({sql}\n) TO '{target}' {options}")) {
                let _ = fs::remove_file(&dest);
                return Err(text(e));
            }
        }
        let size = fs::metadata(&dest).map_err(text)?.len();
        Ok((dest, size))
    }

    pub fn export_bytes(&self, sql: &str, format: &str) -> Result<Vec<u8>, String> {
        let (path, _) = self.export(sql, format)?;
        let bytes = fs::read(&path).map_err(text);
        let _ = fs::remove_file(&path);
        bytes
    }

    pub fn move_export(&self, from: &Path, to: &Path) -> Result<(), String> {
        let exports = fs::canonicalize(self.run_dir.join("exports")).map_err(text)?;
        let source = fs::canonicalize(from).map_err(text)?;
        if !source.starts_with(&exports) || !source.is_file() {
            return Err("That file is not an export of this session.".to_string());
        }
        if fs::rename(&source, to).is_ok() {
            return Ok(());
        }
        let partial = PathBuf::from(format!("{}.partial", to.display()));
        let copied = fs::copy(&source, &partial).map_err(text).and_then(|_| fs::rename(&partial, to).map_err(text));
        if let Err(e) = copied {
            let _ = fs::remove_file(&partial);
            return Err(e);
        }
        let _ = fs::remove_file(&source);
        Ok(())
    }

    pub fn load_excel(&self, dirs: &[PathBuf]) -> Result<(), String> {
        let mut loaded = lock(&self.excel);
        if *loaded {
            return Ok(());
        }
        let guard = lock(&self.conn);
        let conn = guard.as_ref().ok_or(NOT_RUNNING)?;
        let mut failures: Vec<String> = Vec::new();
        if let Some(path) = dirs.iter().map(|d| d.join("excel.duckdb_extension")).find(|p| p.is_file()) {
            let literal = path.to_string_lossy().replace('\'', "''");
            match conn.execute_batch(&format!("LOAD '{literal}'")) {
                Ok(()) => {
                    *loaded = true;
                    return Ok(());
                }
                Err(e) => failures.push(format!("bundled extension: {e}")),
            }
        }
        match conn.execute_batch("INSTALL excel; LOAD excel;") {
            Ok(()) => {
                *loaded = true;
                Ok(())
            }
            Err(e) => {
                failures.push(format!("download: {e}"));
                Err(failures.join("; "))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn engine() -> (Arc<Engine>, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let e = Arc::new(Engine::new(dir.path().join("run")));
        e.init().unwrap();
        (e, dir)
    }

    fn rows(e: &Engine, sql: &str) -> Value {
        serde_json::from_slice(&e.query(sql, None).unwrap()).unwrap()
    }

    fn types(v: &Value) -> Vec<String> {
        v["fields"].as_array().unwrap().iter().map(|f| f["type"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn reports_a_two_point_zero_engine() {
        let (e, _d) = engine();
        assert!(e.init().unwrap().starts_with("v2."));
    }

    #[test]
    fn values_follow_the_conventions_of_the_web_engine() {
        let (e, _d) = engine();
        let v = rows(
            &e,
            "SELECT 1::TINYINT AS i8, 300::SMALLINT AS i16, 70000::INTEGER AS i32, 5::BIGINT AS i64, 255::UTINYINT AS u8, \
             1.5::DOUBLE AS f, 2.25::DECIMAL(10,2) AS dec, true AS b, DATE '2024-03-05' AS d, \
             TIMESTAMP '2024-03-05 10:20:30.123' AS ts, TIME '01:02:03.5' AS t, INTERVAL '1 year 2 months 3 days 4 hours' AS iv, \
             'héllo' AS s, '\\x41\\x42'::BLOB AS bl, [1,2,3] AS l, {'a': 1, 'b': 'x'} AS st, MAP {'k': 1} AS m, NULL::VARCHAR AS n",
        );
        assert_eq!(
            types(&v),
            ["integer", "integer", "integer", "integer", "integer", "number", "number", "boolean", "date", "datetime", "text", "text", "text", "text", "text", "text", "text", "text"]
        );
        let cols: Vec<Value> = v["columns"].as_array().unwrap().iter().map(|c| c[0].clone()).collect();
        assert_eq!(
            cols,
            vec![
                json!(1),
                json!(300),
                json!(70000),
                json!(5),
                json!(255),
                json!(1.5),
                json!(2.25),
                json!(true),
                json!(1709596800000i64),
                json!(1709634030123i64),
                json!("01:02:03.500"),
                json!("1 year 2 months 3 days 04:00:00"),
                json!("héllo"),
                json!("AB"),
                json!("[1,2,3]"),
                json!("{\"a\":1,\"b\":\"x\"}"),
                json!("{\"k\":1}"),
                Value::Null,
            ]
        );
        assert_eq!(v["rows"], json!(1));
        assert_eq!(v["truncated"], json!(false));
    }

    #[test]
    fn enums_and_uuids_become_text() {
        let (e, _d) = engine();
        e.exec("CREATE TYPE mood AS ENUM ('sad', 'ok')").unwrap();
        let v = rows(&e, "SELECT 'ok'::mood AS m, '123e4567-e89b-12d3-a456-426614174000'::UUID AS u");
        assert_eq!(types(&v), ["text", "text"]);
        assert_eq!(v["columns"][0][0], json!("ok"));
        assert!(!v["columns"][1][0].as_str().unwrap().is_empty());
    }

    #[test]
    fn unsafe_bigints_become_exact_text_for_the_whole_column() {
        let (e, _d) = engine();
        let v = rows(&e, "SELECT * FROM (VALUES (9007199254740993::BIGINT, 1::BIGINT), (2::BIGINT, 2::BIGINT)) t(big, small)");
        assert_eq!(types(&v), ["text", "integer"]);
        assert_eq!(v["columns"][0], json!(["9007199254740993", "2"]));
        assert_eq!(v["columns"][1], json!([1, 2]));
    }

    #[test]
    fn hugeint_sums_and_decimals_are_numbers() {
        let (e, _d) = engine();
        let v = rows(&e, "SELECT SUM(x) AS s, CAST(SUM(x) AS DECIMAL(18,2)) AS d FROM (VALUES (1), (2)) t(x)");
        assert_eq!(types(&v), ["number", "number"]);
        assert_eq!(v["columns"][0], json!([3.0]));
    }

    #[test]
    fn nan_and_infinity_become_null() {
        let (e, _d) = engine();
        let v = rows(&e, "SELECT 'nan'::DOUBLE AS a, 'inf'::DOUBLE AS b, 1.0::DOUBLE AS c");
        assert_eq!(v["columns"], json!([[null], [null], [1.0]]));
    }

    #[test]
    fn nulls_stay_null_in_every_column_type() {
        let (e, _d) = engine();
        let v = rows(&e, "SELECT NULL::INTEGER AS a, NULL::BIGINT AS b, NULL::DOUBLE AS c, NULL::DATE AS d, NULL::TIMESTAMP AS e, NULL::BOOLEAN AS f, NULL::VARCHAR AS g, NULL::INTERVAL AS h, NULL::TIME AS i, NULL::INTEGER[] AS j");
        assert_eq!(v["columns"], json!([[null], [null], [null], [null], [null], [null], [null], [null], [null], [null]]));
    }

    #[test]
    fn empty_results_keep_their_columns() {
        let (e, _d) = engine();
        let v = rows(&e, "SELECT 1 AS a, 'x' AS b WHERE false");
        assert_eq!(v["rows"], json!(0));
        assert_eq!(v["columns"], json!([[], []]));
        assert_eq!(types(&v), ["integer", "text"]);
    }

    #[test]
    fn max_rows_truncates_like_the_web_engine() {
        let (e, _d) = engine();
        let cut: Value = serde_json::from_slice(&e.query("SELECT * FROM range(10)", Some(3)).unwrap()).unwrap();
        assert_eq!(cut["rows"], json!(3));
        assert_eq!(cut["truncated"], json!(true));
        assert_eq!(cut["columns"][0], json!([0, 1, 2]));
        let exact: Value = serde_json::from_slice(&e.query("SELECT * FROM range(3)", Some(3)).unwrap()).unwrap();
        assert_eq!(exact["rows"], json!(3));
        assert_eq!(exact["truncated"], json!(false));
        let big: Value = serde_json::from_slice(&e.query("SELECT * FROM range(100000)", Some(5000)).unwrap()).unwrap();
        assert_eq!(big["rows"], json!(5000));
        assert_eq!(big["truncated"], json!(true));
    }

    #[test]
    fn large_results_cross_batch_boundaries() {
        let (e, _d) = engine();
        let v = rows(&e, "SELECT range AS i, 'row ' || range AS s FROM range(250000)");
        assert_eq!(v["rows"], json!(250000));
        assert_eq!(v["columns"][0].as_array().unwrap().len(), 250000);
        assert_eq!(v["columns"][1][249999], json!("row 249999"));
    }

    #[test]
    fn schema_has_no_rows() {
        let (e, _d) = engine();
        let v: Value = serde_json::from_slice(&e.schema("SELECT 1 AS a, 'x' AS b, DATE '2024-01-01' AS c").unwrap()).unwrap();
        assert_eq!(v["rows"], json!(0));
        assert_eq!(types(&v), ["integer", "text", "date"]);
        assert_eq!(v["fields"][1]["name"], json!("b"));
    }

    #[test]
    fn count_counts() {
        let (e, _d) = engine();
        assert_eq!(e.count("SELECT * FROM range(1234)").unwrap(), 1234);
    }

    #[test]
    fn errors_come_back_as_messages() {
        let (e, _d) = engine();
        let err = e.query("SELEC 1", None).unwrap_err();
        assert!(err.contains("syntax error") || err.contains("Parser Error"), "{err}");
        let err = e.query("SELECT * FROM missing_table", None).unwrap_err();
        assert!(err.contains("missing_table"), "{err}");
    }

    #[test]
    fn plan_returns_text_lines() {
        let (e, _d) = engine();
        let lines = e.plan("EXPLAIN SELECT 1").unwrap();
        assert!(!lines.is_empty());
        let json = e.plan("EXPLAIN (ANALYZE, FORMAT JSON) SELECT * FROM range(10)").unwrap().join("");
        assert!(serde_json::from_str::<Value>(&json).is_ok(), "{json}");
    }

    #[test]
    fn registered_files_are_read_by_their_virtual_name() {
        let (e, d) = engine();
        let folder = d.path().join("my data");
        fs::create_dir_all(&folder).unwrap();
        let csv = folder.join("o'brien sales.csv");
        fs::write(&csv, "region,amount\nشمال,10\nجنوب,32\n").unwrap();
        e.register("sales.csv", &csv).unwrap();
        let v = rows(&e, "SELECT count(*) AS n, sum(amount) AS total FROM read_csv('sales.csv', header=true)");
        assert_eq!(v["columns"][0], json!([2]));
        assert_eq!(v["columns"][1], json!([42]));
        let v = rows(&e, "SELECT region FROM read_csv('sales.csv', header=true) ORDER BY region");
        assert_eq!(v["columns"][0], json!(["جنوب", "شمال"]));
        e.drop_file("sales.csv");
        assert!(e.query("SELECT * FROM read_csv('sales.csv', header=true)", None).is_err());
    }

    #[test]
    fn register_rejects_missing_files_and_folders() {
        let (e, d) = engine();
        assert!(e.register("a.csv", &d.path().join("nope.csv")).is_err());
        assert!(e.register("a.csv", d.path()).is_err());
    }

    #[test]
    fn parquet_json_and_csv_exports_round_trip() {
        let (e, _d) = engine();
        for (format, magic) in [("parquet", "PAR1"), ("csv", "a,b"), ("json", "["), ("jsonl", "{")] {
            let bytes = e.export_bytes("SELECT range AS a, 'x' || range AS b FROM range(5)", format).unwrap();
            assert!(String::from_utf8_lossy(&bytes[..magic.len()]) == magic, "{format}");
        }
        let (path, size) = e.export("SELECT range AS a, 'x' || range AS b FROM range(1000)", "parquet").unwrap();
        assert!(size > 0 && path.is_file());
        e.register("out.parquet", &path).unwrap();
        let v = rows(&e, "SELECT count(*) AS n, max(a) AS m FROM read_parquet('out.parquet')");
        assert_eq!(v["columns"], json!([[1000], [999]]));
    }

    #[test]
    fn exports_read_registered_files_and_replace_the_previous_export() {
        let (e, d) = engine();
        let csv = d.path().join("in.csv");
        fs::write(&csv, "a\n1\n2\n3\n").unwrap();
        e.register("in.csv", &csv).unwrap();
        let (first, _) = e.export("SELECT * FROM read_csv('in.csv', header=true)", "csv").unwrap();
        assert!(fs::read_to_string(&first).unwrap().contains("3"));
        let (second, _) = e.export("SELECT * FROM read_csv('in.csv', header=true)", "jsonl").unwrap();
        assert!(!first.exists() && second.is_file());
        assert!(e.export("SELECT 1", "xlsx").is_err());
    }

    #[test]
    fn move_export_places_the_file_and_refuses_other_paths() {
        let (e, d) = engine();
        let (path, _) = e.export("SELECT 1 AS a", "csv").unwrap();
        let target = d.path().join("saved.csv");
        fs::write(&target, "old").unwrap();
        e.move_export(&path, &target).unwrap();
        assert!(fs::read_to_string(&target).unwrap().starts_with("a"));
        assert!(!path.exists());
        let other = d.path().join("other.csv");
        fs::write(&other, "x").unwrap();
        assert!(e.move_export(&other, &d.path().join("stolen.csv")).is_err());
        assert!(other.exists());
    }

    #[test]
    fn staged_files_support_chunks_and_cleanup() {
        let (e, _d) = engine();
        e.stage("__put_1.csv", b"a,b\n1,x\n", false).unwrap();
        e.stage("__put_1.csv", b"2,y\n", true).unwrap();
        e.exec("CREATE OR REPLACE TABLE \"t\" AS SELECT * FROM read_csv('__put_1.csv', header=true, columns={'a': 'BIGINT', 'b': 'VARCHAR'}, auto_detect=false)").unwrap();
        e.exec("INSERT INTO \"t\" SELECT * FROM read_csv('__put_1.csv', header=true, columns={'a': 'BIGINT', 'b': 'VARCHAR'}, auto_detect=false)").unwrap();
        e.drop_file("__put_1.csv");
        assert_eq!(e.count("SELECT * FROM t").unwrap(), 4);
        assert!(e.exec("SELECT * FROM read_csv('__put_1.csv')").is_err());
        let staged = e.run_dir().join("staged");
        assert_eq!(fs::read_dir(staged).unwrap().count(), 0);
    }

    #[test]
    fn tables_survive_between_queries() {
        let (e, _d) = engine();
        e.exec("CREATE TABLE people AS SELECT * FROM (VALUES (1, 'a'), (2, 'b')) t(id, name)").unwrap();
        let v = rows(&e, "SELECT name FROM people ORDER BY id DESC");
        assert_eq!(v["columns"][0], json!(["b", "a"]));
    }

    #[test]
    fn cancel_stops_a_running_query_and_the_engine_recovers() {
        let (e, _d) = engine();
        let worker = {
            let e = e.clone();
            std::thread::spawn(move || e.query("SELECT sum(hash(a.range * b.range)) FROM range(200000) a, range(200000) b", None))
        };
        let started = Instant::now();
        while !worker.is_finished() && started.elapsed().as_secs() < 60 {
            std::thread::sleep(std::time::Duration::from_millis(150));
            e.cancel();
        }
        let result = worker.join().unwrap();
        assert!(result.is_err(), "the query should have been interrupted");
        assert!(started.elapsed().as_secs() < 60);
        let v = rows(&e, "SELECT 42 AS answer");
        assert_eq!(v["columns"][0], json!([42]));
    }

    #[test]
    fn queries_from_several_threads_are_serialised() {
        let (e, _d) = engine();
        let handles: Vec<_> = (0..6)
            .map(|i| {
                let e = e.clone();
                std::thread::spawn(move || e.count(&format!("SELECT * FROM range({})", i * 100)).unwrap())
            })
            .collect();
        let mut got: Vec<i64> = handles.into_iter().map(|h| h.join().unwrap()).collect();
        got.sort();
        assert_eq!(got, vec![0, 100, 200, 300, 400, 500]);
    }

    #[test]
    fn excel_files_are_read_with_the_bundled_extension() {
        let (Ok(ext), Ok(book)) = (std::env::var("DUCKBENCH_TEST_EXCEL_EXT"), std::env::var("DUCKBENCH_TEST_XLSX")) else {
            eprintln!("skipped: DUCKBENCH_TEST_EXCEL_EXT and DUCKBENCH_TEST_XLSX are not set");
            return;
        };
        let (e, _d) = engine();
        let dir = PathBuf::from(ext).parent().unwrap().to_path_buf();
        e.load_excel(&[dir]).unwrap();
        e.register("book.xlsx", Path::new(&book)).unwrap();
        let v = rows(&e, "SELECT * FROM read_xlsx('book.xlsx', ignore_errors=true, empty_as_varchar=true)");
        assert_eq!(v["rows"], json!(3));
        assert_eq!(v["fields"][0]["name"], json!("Name"));
        assert_eq!(v["columns"][0], json!(["alpha", "beta", "مرحبا"]));
        assert_eq!(v["columns"][1], json!([1.0, 2.0, 3.0]));
    }

    #[test]
    fn shutdown_removes_the_work_folder() {
        let (e, _d) = engine();
        e.exec("CREATE TABLE t AS SELECT 1 AS a").unwrap();
        let dir = e.run_dir().to_path_buf();
        assert!(dir.exists());
        e.shutdown();
        assert!(!dir.exists());
        assert!(e.query("SELECT 1", None).is_err());
    }
}
