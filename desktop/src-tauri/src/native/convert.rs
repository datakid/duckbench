use duckdb::arrow::array::{Array, ArrayRef, AsArray};
use duckdb::arrow::compute::cast;
use duckdb::arrow::datatypes::*;
use duckdb::arrow::record_batch::RecordBatch;
use duckdb::arrow::util::display::array_value_to_string;
use serde_json::Value;
use std::io::Write;

const SAFE_INTEGER: i128 = 9_007_199_254_740_991;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    Integer,
    Number,
    Boolean,
    Date,
    DateTime,
    Text,
}

impl Kind {
    pub fn name(self) -> &'static str {
        match self {
            Kind::Integer => "integer",
            Kind::Number => "number",
            Kind::Boolean => "boolean",
            Kind::Date => "date",
            Kind::DateTime => "datetime",
            Kind::Text => "text",
        }
    }
}

fn plain_type(dt: &DataType) -> &DataType {
    match dt {
        DataType::Dictionary(_, v) => v.as_ref(),
        other => other,
    }
}

pub fn classify(dt: &DataType) -> Kind {
    match plain_type(dt) {
        DataType::Boolean => Kind::Boolean,
        DataType::Int8
        | DataType::Int16
        | DataType::Int32
        | DataType::Int64
        | DataType::UInt8
        | DataType::UInt16
        | DataType::UInt32
        | DataType::UInt64 => Kind::Integer,
        DataType::Float32 | DataType::Float64 | DataType::Decimal128(_, _) => Kind::Number,
        DataType::Date32 => Kind::Date,
        DataType::Date64 | DataType::Timestamp(_, _) => Kind::DateTime,
        _ => Kind::Text,
    }
}

fn is_wide(dt: &DataType) -> bool {
    matches!(plain_type(dt), DataType::Int64 | DataType::UInt64)
}

fn write_null(out: &mut Vec<u8>) {
    out.extend_from_slice(b"null");
}

fn write_f64(out: &mut Vec<u8>, v: f64) {
    match serde_json::Number::from_f64(v) {
        Some(n) => {
            let _ = write!(out, "{n}");
        }
        None => write_null(out),
    }
}

fn write_str(out: &mut Vec<u8>, s: &str) {
    let _ = serde_json::to_writer(&mut *out, s);
}

fn round_div(v: i64, d: i64) -> i64 {
    (v + d / 2).div_euclid(d)
}

fn small_int(a: &dyn Array, i: usize) -> i64 {
    match a.data_type() {
        DataType::Int8 => a.as_primitive::<Int8Type>().value(i) as i64,
        DataType::Int16 => a.as_primitive::<Int16Type>().value(i) as i64,
        DataType::Int32 => a.as_primitive::<Int32Type>().value(i) as i64,
        DataType::Int64 => a.as_primitive::<Int64Type>().value(i),
        DataType::UInt8 => a.as_primitive::<UInt8Type>().value(i) as i64,
        DataType::UInt16 => a.as_primitive::<UInt16Type>().value(i) as i64,
        DataType::UInt32 => a.as_primitive::<UInt32Type>().value(i) as i64,
        DataType::UInt64 => a.as_primitive::<UInt64Type>().value(i) as i64,
        _ => 0,
    }
}

fn wide_int(a: &dyn Array, i: usize) -> i128 {
    match a.data_type() {
        DataType::Int64 => a.as_primitive::<Int64Type>().value(i) as i128,
        DataType::UInt64 => a.as_primitive::<UInt64Type>().value(i) as i128,
        _ => 0,
    }
}

fn float_at(a: &dyn Array, i: usize) -> f64 {
    match a.data_type() {
        DataType::Float32 => a.as_primitive::<Float32Type>().value(i) as f64,
        DataType::Float64 => a.as_primitive::<Float64Type>().value(i),
        DataType::Decimal128(_, scale) => {
            let v = a.as_primitive::<Decimal128Type>().value(i);
            (v as f64) / 10f64.powi(*scale as i32)
        }
        _ => f64::NAN,
    }
}

fn millis_at(a: &dyn Array, i: usize) -> i64 {
    match a.data_type() {
        DataType::Date32 => a.as_primitive::<Date32Type>().value(i) as i64 * 86_400_000,
        DataType::Date64 => a.as_primitive::<Date64Type>().value(i),
        DataType::Timestamp(TimeUnit::Second, _) => a.as_primitive::<TimestampSecondType>().value(i).saturating_mul(1000),
        DataType::Timestamp(TimeUnit::Millisecond, _) => a.as_primitive::<TimestampMillisecondType>().value(i),
        DataType::Timestamp(TimeUnit::Microsecond, _) => round_div(a.as_primitive::<TimestampMicrosecondType>().value(i), 1000),
        DataType::Timestamp(TimeUnit::Nanosecond, _) => round_div(a.as_primitive::<TimestampNanosecondType>().value(i), 1_000_000),
        _ => 0,
    }
}

fn time_millis_at(a: &dyn Array, i: usize) -> Option<i64> {
    Some(match a.data_type() {
        DataType::Time32(TimeUnit::Second) => a.as_primitive::<Time32SecondType>().value(i) as i64 * 1000,
        DataType::Time32(TimeUnit::Millisecond) => a.as_primitive::<Time32MillisecondType>().value(i) as i64,
        DataType::Time64(TimeUnit::Microsecond) => round_div(a.as_primitive::<Time64MicrosecondType>().value(i), 1000),
        DataType::Time64(TimeUnit::Nanosecond) => round_div(a.as_primitive::<Time64NanosecondType>().value(i), 1_000_000),
        _ => return None,
    })
}

pub fn fmt_time(ms: i64) -> String {
    let ms = ms.rem_euclid(86_400_000);
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    let frac = ms % 1000;
    if frac != 0 {
        format!("{h:02}:{m:02}:{s:02}.{frac:03}")
    } else {
        format!("{h:02}:{m:02}:{s:02}")
    }
}

pub fn fmt_interval(months: i32, days: i32, nanos: i64) -> String {
    let unit = |n: i64, word: &str| format!("{} {}{}", n, word, if n.abs() == 1 { "" } else { "s" });
    let mut parts: Vec<String> = Vec::new();
    let years = (months / 12) as i64;
    let rest = (months % 12) as i64;
    if years != 0 {
        parts.push(unit(years, "year"));
    }
    if rest != 0 {
        parts.push(unit(rest, "month"));
    }
    if days != 0 {
        parts.push(unit(days as i64, "day"));
    }
    if nanos != 0 {
        let neg = nanos < 0;
        let mut rem = nanos.unsigned_abs();
        let h = rem / 3_600_000_000_000;
        rem %= 3_600_000_000_000;
        let m = rem / 60_000_000_000;
        rem %= 60_000_000_000;
        let s = rem / 1_000_000_000;
        let frac = rem % 1_000_000_000;
        let mut text = format!("{}{:02}:{:02}:{:02}", if neg { "-" } else { "" }, h, m, s);
        if frac != 0 {
            text.push('.');
            text.push_str(format!("{frac:09}").trim_end_matches('0'));
        }
        parts.push(text);
    }
    if parts.is_empty() {
        "00:00:00".to_string()
    } else {
        parts.join(" ")
    }
}

fn bytes_text(b: &[u8]) -> String {
    match std::str::from_utf8(b) {
        Ok(s) => s.to_string(),
        Err(_) => b.iter().map(|x| format!("{x:02x}")).collect(),
    }
}

fn json_number(v: f64) -> Value {
    serde_json::Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
}

fn json_value(a: &dyn Array, i: usize) -> Value {
    if a.is_null(i) || matches!(a.data_type(), DataType::Null) {
        return Value::Null;
    }
    match a.data_type() {
        DataType::Boolean => Value::Bool(a.as_boolean().value(i)),
        DataType::Int8 | DataType::Int16 | DataType::Int32 => Value::from(small_int(a, i)),
        DataType::UInt8 | DataType::UInt16 | DataType::UInt32 => Value::from(small_int(a, i)),
        DataType::Int64 | DataType::UInt64 => {
            let v = wide_int(a, i);
            if let Ok(x) = i64::try_from(v) {
                Value::from(x)
            } else if let Ok(x) = u64::try_from(v) {
                Value::from(x)
            } else {
                Value::String(v.to_string())
            }
        }
        DataType::Float32 | DataType::Float64 | DataType::Decimal128(_, _) => json_number(float_at(a, i)),
        DataType::Utf8 => Value::String(a.as_string::<i32>().value(i).to_string()),
        DataType::LargeUtf8 => Value::String(a.as_string::<i64>().value(i).to_string()),
        DataType::Utf8View => Value::String(a.as_string_view().value(i).to_string()),
        DataType::Binary => Value::String(bytes_text(a.as_binary::<i32>().value(i))),
        DataType::LargeBinary => Value::String(bytes_text(a.as_binary::<i64>().value(i))),
        DataType::List(_) => {
            let inner: ArrayRef = a.as_list::<i32>().value(i);
            Value::Array((0..inner.len()).map(|j| json_value(inner.as_ref(), j)).collect())
        }
        DataType::LargeList(_) => {
            let inner: ArrayRef = a.as_list::<i64>().value(i);
            Value::Array((0..inner.len()).map(|j| json_value(inner.as_ref(), j)).collect())
        }
        DataType::FixedSizeList(_, _) => {
            let inner: ArrayRef = a.as_fixed_size_list().value(i);
            Value::Array((0..inner.len()).map(|j| json_value(inner.as_ref(), j)).collect())
        }
        DataType::Struct(_) => {
            let s = a.as_struct();
            let mut map = serde_json::Map::new();
            for (name, col) in s.column_names().iter().zip(s.columns().iter()) {
                map.insert((*name).to_string(), json_value(col.as_ref(), i));
            }
            Value::Object(map)
        }
        DataType::Map(_, _) => {
            let entries = a.as_map().value(i);
            let keys = entries.column(0);
            let values = entries.column(1);
            let mut map = serde_json::Map::new();
            for j in 0..entries.len() {
                let key = match json_value(keys.as_ref(), j) {
                    Value::String(s) => s,
                    other => other.to_string(),
                };
                map.insert(key, json_value(values.as_ref(), j));
            }
            Value::Object(map)
        }
        _ => Value::String(array_value_to_string(a, i).unwrap_or_default()),
    }
}

fn write_text(out: &mut Vec<u8>, a: &dyn Array, i: usize) {
    match a.data_type() {
        DataType::Utf8 => write_str(out, a.as_string::<i32>().value(i)),
        DataType::LargeUtf8 => write_str(out, a.as_string::<i64>().value(i)),
        DataType::Utf8View => write_str(out, a.as_string_view().value(i)),
        DataType::Binary => write_str(out, &bytes_text(a.as_binary::<i32>().value(i))),
        DataType::LargeBinary => write_str(out, &bytes_text(a.as_binary::<i64>().value(i))),
        DataType::FixedSizeBinary(_) => write_str(out, &bytes_text(a.as_fixed_size_binary().value(i))),
        DataType::Time32(_) | DataType::Time64(_) => match time_millis_at(a, i) {
            Some(ms) => write_str(out, &fmt_time(ms)),
            None => write_null(out),
        },
        DataType::Interval(IntervalUnit::MonthDayNano) => {
            let v = a.as_primitive::<IntervalMonthDayNanoType>().value(i);
            write_str(out, &fmt_interval(v.months, v.days, v.nanoseconds));
        }
        DataType::List(_)
        | DataType::LargeList(_)
        | DataType::FixedSizeList(_, _)
        | DataType::Struct(_)
        | DataType::Map(_, _) => write_str(out, &json_value(a, i).to_string()),
        _ => write_str(out, &array_value_to_string(a, i).unwrap_or_default()),
    }
}

fn write_cell(out: &mut Vec<u8>, kind: Kind, a: &dyn Array, i: usize) {
    if matches!(a.data_type(), DataType::Null) || a.is_null(i) {
        write_null(out);
        return;
    }
    match kind {
        Kind::Integer => {
            let _ = write!(out, "{}", small_int(a, i));
        }
        Kind::Number => write_f64(out, float_at(a, i)),
        Kind::Boolean => out.extend_from_slice(if a.as_boolean().value(i) { b"true" } else { b"false" }),
        Kind::Date | Kind::DateTime => {
            let _ = write!(out, "{}", millis_at(a, i));
        }
        Kind::Text => write_text(out, a, i),
    }
}

struct Column {
    name: String,
    kind: Kind,
    wide: bool,
    plain: Vec<u8>,
    wide_values: Vec<Option<i128>>,
}

impl Column {
    fn append(&mut self, a: &dyn Array, take: usize) {
        if self.wide {
            for i in 0..take {
                let null = a.is_null(i);
                self.wide_values.push(if null { None } else { Some(wide_int(a, i)) });
            }
            return;
        }
        for i in 0..take {
            if !self.plain.is_empty() {
                self.plain.push(b',');
            }
            write_cell(&mut self.plain, self.kind, a, i);
        }
    }

    fn finish(self) -> (String, Kind, Vec<u8>) {
        if !self.wide {
            return (self.name, self.kind, self.plain);
        }
        let unsafe_values = self.wide_values.iter().flatten().any(|v| *v > SAFE_INTEGER || *v < -SAFE_INTEGER);
        let mut out = Vec::with_capacity(self.wide_values.len() * 8);
        for (n, v) in self.wide_values.iter().enumerate() {
            if n > 0 {
                out.push(b',');
            }
            match v {
                None => write_null(&mut out),
                Some(x) if unsafe_values => write_str(&mut out, &x.to_string()),
                Some(x) => {
                    let _ = write!(out, "{x}");
                }
            }
        }
        (self.name, if unsafe_values { Kind::Text } else { Kind::Integer }, out)
    }
}

pub struct Builder {
    columns: Vec<Column>,
    rows: usize,
    limit: usize,
    truncated: bool,
}

impl Builder {
    pub fn new(schema: &Schema, limit: Option<u64>) -> Self {
        let columns = schema
            .fields()
            .iter()
            .map(|f| Column {
                name: f.name().clone(),
                kind: classify(f.data_type()),
                wide: is_wide(f.data_type()),
                plain: Vec::new(),
                wide_values: Vec::new(),
            })
            .collect();
        Builder {
            columns,
            rows: 0,
            limit: limit.map(|n| n as usize).unwrap_or(usize::MAX),
            truncated: false,
        }
    }

    pub fn truncated(&self) -> bool {
        self.truncated
    }

    pub fn push(&mut self, batch: &RecordBatch) -> Result<(), String> {
        let room = self.limit.saturating_sub(self.rows);
        let take = batch.num_rows().min(room);
        if batch.num_rows() > take {
            self.truncated = true;
        }
        if take == 0 {
            return Ok(());
        }
        for (c, col) in self.columns.iter_mut().enumerate() {
            let array = batch.column(c);
            let plain: ArrayRef = match array.data_type() {
                DataType::Dictionary(_, value) => cast(array, value).map_err(|e| e.to_string())?,
                _ => array.clone(),
            };
            col.append(plain.as_ref(), take);
        }
        self.rows += take;
        Ok(())
    }

    pub fn finish(self, ms: f64) -> Vec<u8> {
        let rows = self.rows;
        let truncated = self.truncated;
        let mut fields: Vec<u8> = Vec::new();
        let mut columns: Vec<u8> = Vec::new();
        for (n, col) in self.columns.into_iter().enumerate() {
            let (name, kind, data) = col.finish();
            if n > 0 {
                fields.push(b',');
                columns.push(b',');
            }
            fields.extend_from_slice(b"{\"name\":");
            write_str(&mut fields, &name);
            fields.extend_from_slice(b",\"type\":\"");
            fields.extend_from_slice(kind.name().as_bytes());
            fields.extend_from_slice(b"\"}");
            columns.push(b'[');
            columns.extend_from_slice(&data);
            columns.push(b']');
        }
        let mut out = Vec::with_capacity(fields.len() + columns.len() + 96);
        out.extend_from_slice(b"{\"fields\":[");
        out.extend_from_slice(&fields);
        out.extend_from_slice(b"],\"columns\":[");
        out.extend_from_slice(&columns);
        let _ = write!(out, "],\"rows\":{rows},\"truncated\":{truncated},\"ms\":");
        write_f64(&mut out, ms);
        out.push(b'}');
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interval_text_matches_the_app() {
        assert_eq!(fmt_interval(14, 3, 4 * 3_600_000_000_000), "1 year 2 months 3 days 04:00:00");
        assert_eq!(fmt_interval(0, 0, 0), "00:00:00");
        assert_eq!(fmt_interval(1, 1, 0), "1 month 1 day");
        assert_eq!(fmt_interval(-13, 0, 0), "-1 year -1 month");
        assert_eq!(fmt_interval(0, 0, -1_500_000_000), "-00:00:01.5");
        assert_eq!(fmt_interval(0, 0, 90_061_000_000_001), "25:01:01.000000001");
    }

    #[test]
    fn time_text_matches_the_app() {
        assert_eq!(fmt_time(3_723_500), "01:02:03.500");
        assert_eq!(fmt_time(3_723_000), "01:02:03");
        assert_eq!(fmt_time(86_400_000), "00:00:00");
    }

    #[test]
    fn rounding_is_half_up_like_javascript() {
        assert_eq!(round_div(1500, 1000), 2);
        assert_eq!(round_div(1499, 1000), 1);
        assert_eq!(round_div(-1500, 1000), -1);
        assert_eq!(round_div(-1501, 1000), -2);
    }
}
