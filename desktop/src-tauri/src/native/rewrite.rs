use std::collections::HashMap;
use std::path::PathBuf;

fn read_call_before(out: &str) -> bool {
    let t = out.trim_end();
    let Some(t) = t.strip_suffix('(') else { return false };
    let t = t.trim_end();
    let start = t
        .rfind(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
        .map(|i| i + 1)
        .unwrap_or(0);
    t[start..].to_ascii_lowercase().starts_with("read_")
}

fn literal_end(sql: &str, start: usize) -> usize {
    let bytes = sql.as_bytes();
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'\'' {
            if bytes.get(i + 1) == Some(&b'\'') {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

fn quoted_identifier_end(sql: &str, start: usize) -> usize {
    let bytes = sql.as_bytes();
    let mut i = start + 1;
    while i < bytes.len() {
        if bytes[i] == b'"' {
            if bytes.get(i + 1) == Some(&b'"') {
                i += 2;
                continue;
            }
            return i + 1;
        }
        i += 1;
    }
    bytes.len()
}

fn dollar_quote_end(sql: &str, start: usize) -> Option<usize> {
    let rest = &sql[start..];
    let tag_len = rest[1..].find('$')?;
    let tag = &rest[..tag_len + 2];
    if !tag[1..tag.len() - 1].chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }
    if tag.len() > 2 && tag[1..2].chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let body = start + tag.len();
    Some(match sql[body..].find(tag) {
        Some(i) => body + i + tag.len(),
        None => sql.len(),
    })
}

pub fn resolve_files(sql: &str, files: &HashMap<String, PathBuf>) -> String {
    if files.is_empty() {
        return sql.to_string();
    }
    let bytes = sql.as_bytes();
    let mut out = String::with_capacity(sql.len() + 32);
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'\'' => {
                let end = literal_end(sql, i);
                let raw = &sql[i..end];
                let closed = raw.len() >= 2 && raw.ends_with('\'');
                let inner = if closed { raw[1..raw.len() - 1].replace("''", "'") } else { String::new() };
                match files.get(&inner) {
                    Some(path) if closed && read_call_before(&out) => {
                        out.push('\'');
                        out.push_str(&path.to_string_lossy().replace('\'', "''"));
                        out.push('\'');
                    }
                    _ => out.push_str(raw),
                }
                i = end;
            }
            b'"' => {
                let end = quoted_identifier_end(sql, i);
                out.push_str(&sql[i..end]);
                i = end;
            }
            b'-' if bytes.get(i + 1) == Some(&b'-') => {
                let end = sql[i..].find('\n').map(|n| i + n).unwrap_or(sql.len());
                out.push_str(&sql[i..end]);
                i = end;
            }
            b'/' if bytes.get(i + 1) == Some(&b'*') => {
                let end = sql[i + 2..].find("*/").map(|n| i + 2 + n + 2).unwrap_or(sql.len());
                out.push_str(&sql[i..end]);
                i = end;
            }
            b'$' => match dollar_quote_end(sql, i) {
                Some(end) => {
                    out.push_str(&sql[i..end]);
                    i = end;
                }
                None => {
                    out.push('$');
                    i += 1;
                }
            },
            _ => {
                let ch = sql[i..].chars().next().unwrap();
                out.push(ch);
                i += ch.len_utf8();
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn files(pairs: &[(&str, &str)]) -> HashMap<String, PathBuf> {
        pairs.iter().map(|(k, v)| (k.to_string(), PathBuf::from(v))).collect()
    }

    #[test]
    fn replaces_the_first_argument_of_read_calls() {
        let f = files(&[("sales.csv", "/data/in/sales.csv")]);
        assert_eq!(
            resolve_files("SELECT * FROM read_csv('sales.csv', header=true)", &f),
            "SELECT * FROM read_csv('/data/in/sales.csv', header=true)"
        );
        assert_eq!(
            resolve_files("select * from READ_CSV ( 'sales.csv' )", &f),
            "select * from READ_CSV ( '/data/in/sales.csv' )"
        );
    }

    #[test]
    fn covers_every_reader_the_app_generates() {
        let f = files(&[("a.parquet", "/p/a.parquet"), ("b.json", "/p/b.json"), ("c.xlsx", "/p/c.xlsx")]);
        assert_eq!(resolve_files("SELECT * FROM read_parquet('a.parquet')", &f), "SELECT * FROM read_parquet('/p/a.parquet')");
        assert_eq!(resolve_files("SELECT * FROM read_json_auto('b.json', format='newline_delimited')", &f), "SELECT * FROM read_json_auto('/p/b.json', format='newline_delimited')");
        assert_eq!(resolve_files("SELECT * FROM read_xlsx('c.xlsx', sheet='S')", &f), "SELECT * FROM read_xlsx('/p/c.xlsx', sheet='S')");
    }

    #[test]
    fn leaves_other_literals_alone() {
        let f = files(&[("sales.csv", "/data/sales.csv")]);
        let sql = "SELECT * FROM t WHERE name = 'sales.csv' AND x IN ('sales.csv')";
        assert_eq!(resolve_files(sql, &f), sql);
        let sql = "SELECT concat('sales.csv', 'x'), replace(col, 'sales.csv', '')";
        assert_eq!(resolve_files(sql, &f), sql);
    }

    #[test]
    fn leaves_unregistered_names_alone() {
        let f = files(&[("sales.csv", "/data/sales.csv")]);
        let sql = "SELECT * FROM read_csv('other.csv')";
        assert_eq!(resolve_files(sql, &f), sql);
    }

    #[test]
    fn ignores_comments_identifiers_and_dollar_strings() {
        let f = files(&[("a.csv", "/x/a.csv")]);
        let sql = "SELECT 1 -- read_csv('a.csv')\n, \"read_csv('a.csv')\" /* read_csv('a.csv') */, $$read_csv('a.csv')$$";
        assert_eq!(resolve_files(sql, &f), sql);
    }

    #[test]
    fn escapes_quotes_in_paths_and_unescapes_names() {
        let f = files(&[("o'brien.csv", "C:\\Users\\O'Brien\\a b\\o'brien.csv")]);
        assert_eq!(
            resolve_files("SELECT * FROM read_csv('o''brien.csv')", &f),
            "SELECT * FROM read_csv('C:\\Users\\O''Brien\\a b\\o''brien.csv')"
        );
    }

    #[test]
    fn handles_non_ascii_sql() {
        let f = files(&[("مبيعات.csv", "/d/مبيعات.csv")]);
        assert_eq!(
            resolve_files("SELECT 'é' AS é, * FROM read_csv('مبيعات.csv') WHERE n = 'ع'", &f),
            "SELECT 'é' AS é, * FROM read_csv('/d/مبيعات.csv') WHERE n = 'ع'"
        );
    }

    #[test]
    fn survives_unterminated_input() {
        let f = files(&[("a.csv", "/x/a.csv")]);
        for sql in ["SELECT 'abc", "SELECT \"abc", "SELECT /* abc", "SELECT $$abc", "SELECT $", "read_csv('a.csv"] {
            let _ = resolve_files(sql, &f);
        }
    }

    #[test]
    fn nested_reads_inside_a_subquery_resolve() {
        let f = files(&[("a.csv", "/x/a.csv"), ("b.csv", "/x/b.csv")]);
        assert_eq!(
            resolve_files("SELECT * FROM (SELECT * FROM read_csv('a.csv')) a JOIN read_csv('b.csv') b ON a.id = b.id", &f),
            "SELECT * FROM (SELECT * FROM read_csv('/x/a.csv')) a JOIN read_csv('/x/b.csv') b ON a.id = b.id"
        );
    }
}
