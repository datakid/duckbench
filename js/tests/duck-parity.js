import { Engine } from '../engine/engine.js';
import { migrateStep } from '../core/transforms.js';
import { compileStep } from '../engine/compile.js';
import { withInput } from '../engine/duck.js';
import * as duck from '../engine/duck.js';
import { formatValue } from '../core/types.js';
import { hashString } from '../core/util.js';
import { SAMPLE_SALES_CSV, SAMPLE_REGIONS_CSV } from '../app/samples.js';

const EXTRA = 'id,code,tags,when_txt,amount_txt,flag,name\n1,A-1,"x, y",2026-01-05,"$1,200.50",yes,  ﬁona  smith \n2,B-22,y,03/04/2026,(45),no,ÉLAN\n3,,"z,,w",2026-02-30,12%,maybe,o\'brien-jones\n4,C-3,,5 Mar 2026,abc,Y,straße\n5,A-1,"x",2026-01-05 10:30,7,1,\n';

const PMESS = 'id,name,city,score,amount,grp,flag,seen,note\n1,Alice,Cairo,3,10.5,A,yes,2026-01-05,plain\n2,alice,cairo,3,10.50,a,no,2026-01-05,dup case\n3,ALICE,CAIRO,1,-2.25,A,yes,2026-02-10,\n4,Jose,Madrid,2,0,B,true,2026-03-01,accent\n5,José,Madrid,2,0.0,B,false,,accent2\n6,josé,MADRID,,100,b,yes,2026-03-01,\n7,  Bob,Berlin,5,1000,C,no,2025-12-31,leading space\n8,Bob  ,Berlin,5,1000,C,yes,2026-12-31,trailing space\n9,Bob,Berlin,5,999.999,C,no,2026-01-01,\n10,,Paris,4,,A,yes,2026-04-04,missing name\n11,   ,Paris,4,7,A,no,2026-04-04,blank name\n12,محمد,القاهرة,6,3.14,D,yes,2026-05-05,arabic\n13,مُحمد,القاهرة,6,3.14,D,no,2026-05-05,arabic diacritic\n14,straße,Köln,7,12,E,yes,2026-06-06,eszett\n15,STRASSE,KÖLN,7,12.00,E,no,2026-06-06,\n16,Émile,Lyon,-1,-0.5,F,true,2026-07-07,neg\n17,emile,Lyon,0,0.5,F,false,2026-07-07,\n18,O\'Brien,Dublin,8,1234567.89,G,yes,2026-08-08,"quote ""x"" here"\n19,"Smith, J",Leeds,9,9007199254,G,no,2026-09-09,comma\n20,Zed,Oslo,9,0.1,H,yes,2026-10-10,"multi\nline"\n21,,,,,,,,\n22, , , , , , , ,\n23,Alice,Cairo,3,10.5,A,yes,2026-01-05,plain\n24,Bob,Berlin,5,999.999,C,no,2026-01-01,\n25,Yan,Taipei,2,,B,,,\n26,Yan,Taipei,2,5,B,yes,2026-11-11,x\n27,Ünal,İzmir,4,2,A,no,2026-02-02,turkish dotted\n28,ünal,izmir,4,2,A,no,2026-02-02,\n';

const WSP = 'id,name,qty,note\n1,Ann,5,a\n2,"\t",6,\n3,"\u00a0",7,x\n4,"\n",8,\n5,"  ",9,y\n6,Bob,10,"\u2003"\n7,,11,\n8,"\u3000x",12,z\n9,"\r",13,\n10," \ufeff",14,w\n';

const ZERO = 'id,g,v,n,void\n1,a,5,3,\n2,a,-5,-3,\n3,b,0,0,\n4,b,,,\n5,c,1.5,2,\n6,c,2.5,2,\n7,d,,,\n8,,4,5,\n9,,-4,-5,\n10,e,0.1,1,\n11,e,0.2,1,\n12,e,-0.3,-2,\n';

const CASES = [
  ['trim_clean', 'x', { type: 'trim_clean', data: {} }],
  ['replace whole text', 's', { type: 'replace_values', data: { columns: ['status'], match: 'whole', find: 'Pending', replace: 'Open', caseSensitive: true } }],
  ['replace contains', 's', { type: 'replace_values', data: { columns: ['product'], match: 'contains', find: 'e', replace: '3', caseSensitive: true } }],
  ['replace numeric', 's', { type: 'replace_values', data: { columns: ['quantity'], match: 'whole', find: '2', replace: '20', caseSensitive: true } }],
  ['change_type text→number lenient', 'x', { type: 'change_type', data: { columns: ['amount_txt'], type: 'number', lenient: true } }],
  ['change_type text→integer', 'x', { type: 'change_type', data: { columns: ['amount_txt'], type: 'integer', lenient: true } }],
  ['change_type text→date', 'x', { type: 'change_type', data: { columns: ['when_txt'], type: 'date' } }],
  ['change_type text→datetime DMY', 'x', { type: 'change_type', data: { columns: ['when_txt'], type: 'datetime', dateOrder: 'DMY' } }],
  ['change_type text→boolean', 'x', { type: 'change_type', data: { columns: ['flag'], type: 'boolean' } }],
  ['change_type integer/date→text', 's', { type: 'change_type', data: { columns: ['quantity', 'order_date'], type: 'text' } }],
  ['change_type decimal→text refuses', 's', { type: 'change_type', data: { columns: ['unit_price'], type: 'text' } }, 'refuse'],
  ['change_type number→integer', 's', { type: 'change_type', data: { columns: ['unit_price'], type: 'integer' } }],
  ['change_case upper', 's', { type: 'change_case', data: { columns: ['customer'], mode: 'upper' } }],
  ['change_case proper', 's', { type: 'change_case', data: { columns: ['customer', 'category'], mode: 'proper' } }],
  ['change_case refuses ß', 'x', { type: 'change_case', data: { columns: ['name'], mode: 'upper' } }, 'refuse'],
  ['split each → columns', 'x', { type: 'split_column', data: { column: 'tags', by: 'delimiter', delimiter: ',', at: 'each', mode: 'columns', trimParts: true } }],
  ['split max parts', 'x', { type: 'split_column', data: { column: 'tags', by: 'delimiter', delimiter: ',', at: 'each', mode: 'columns', maxParts: 2, trimParts: true } }],
  ['split first / keep original', 'x', { type: 'split_column', data: { column: 'code', delimiter: '-', at: 'first', mode: 'columns', keepOriginal: true } }],
  ['split last', 'x', { type: 'split_column', data: { column: 'code', delimiter: '-', at: 'last', mode: 'columns' } }],
  ['split → rows', 'x', { type: 'split_column', data: { column: 'tags', delimiter: ',', at: 'each', mode: 'rows', trimParts: true } }],
  ['split infers dates', 'x', { type: 'split_column', data: { column: 'when_txt', delimiter: ' ', at: 'first', mode: 'columns' } }],
  ['join left', 's', { type: 'join', data: { rightSource: 'r', joinType: 'left', keys: [{ left: 'region', right: 'region' }] } }],
  ['join inner + prefix', 's', { type: 'join', data: { rightSource: 'r', joinType: 'inner', keys: [{ left: 'region', right: 'region' }], prefix: 'r_' } }],
  ['join anti', 's', { type: 'join', data: { rightSource: 'r', joinType: 'left_anti', keys: [{ left: 'region', right: 'region' }] } }],
  ['join semi', 's', { type: 'join', data: { rightSource: 'r', joinType: 'left_semi', keys: [{ left: 'region', right: 'region' }] } }],
  ['pivot sum by quantity', 's', { type: 'pivot', data: { onColumn: 'quantity', valueColumn: 'unit_price', fn: 'sum', groupColumns: ['region'] } }],
  ['pivot count fill 0', 's', { type: 'pivot', data: { onColumn: 'quantity', valueColumn: 'order_id', fn: 'count', groupColumns: ['category'], fillZero: true } }],
  ['merge columns skip empty', 's', { type: 'merge_columns', data: { columns: ['customer', 'region', 'quantity'], separator: ' / ', name: 'label', skipEmpty: true } }],
  ['merge columns keep original', 's', { type: 'merge_columns', data: { columns: ['order_date', 'status'], separator: '-', name: 'status', skipEmpty: false, keepOriginal: true } }],
  ['merge decimal refuses', 's', { type: 'merge_columns', data: { columns: ['customer', 'unit_price'], separator: ' ', name: 'x' } }, 'refuse'],
  ['unpivot selected', 's', { type: 'unpivot', data: { mode: 'selected', columns: ['quantity', 'unit_price', 'discount'], nameColumn: 'Attribute', valueColumn: 'Value' } }],
  ['unpivot others keep empty', 'x', { type: 'unpivot', data: { mode: 'others', columns: ['id'], nameColumn: 'Attribute', valueColumn: 'Value', keepEmpty: true } }],
  ...['year', 'quarter', 'month', 'day', 'weekday', 'day_of_year', 'week', 'month_name', 'day_name', 'year_month', 'start_of_week', 'start_of_month', 'end_of_month', 'start_of_quarter', 'start_of_year'].map(p => [`date_part ${p}`, 's', { type: 'date_part', data: { column: 'order_date', part: p, name: p === 'month' ? '' : `${p}_x` } }]),
  ['date_part on text refuses', 'x', { type: 'date_part', data: { column: 'when_txt', part: 'year' } }, 'refuse'],
  ['index column', 's', { type: 'index_column', data: { name: 'Index', start: 1, step: 1 } }],
  ['index column per region, step 0.5', 's', { type: 'index_column', data: { name: 'n', start: 10, step: 0.5, partitionBy: ['region'] } }],
  ['duplicate column', 's', { type: 'duplicate_column', data: { column: 'quantity' } }],
  ['move columns after', 's', { type: 'move_column', data: { columns: ['status', 'discount'], to: 'after', target: 'customer' } }],
  ['move column to end', 's', { type: 'move_column', data: { columns: ['order_id'], to: 'end' } }],
  ['replace empty text + number', 's', { type: 'replace_nulls', data: { columns: ['customer', 'discount'], value: '0' } }],
  ['replace empty with blank', 'x', { type: 'replace_nulls', data: { columns: ['name', 'id'], value: '' } }],
  ['replace empty invalid number refuses', 's', { type: 'replace_nulls', data: { columns: ['discount'], value: 'n/a' } }, 'refuse'],
  ['pivot first', 's', { type: 'pivot', data: { onColumn: 'quantity', valueColumn: 'customer', fn: 'first', groupColumns: ['region'] } }],
  ["filter = text (case-insensitive)", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "=", "value": "alice"}]} }],
  ["filter != text (case-insensitive)", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "!=", "value": "alice"}]} }],
  ["filter = text case-sensitive", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "=", "value": "Alice", "caseSensitive": true}]} }],
  ["filter = accent text", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "=", "value": "josé"}]} }],
  ["filter = arabic text", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "=", "value": "محمد"}]} }],
  ["filter = eszett", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "=", "value": "STRASSE"}]} }],
  ["filter = turkish", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "=", "value": "ünal"}]} }],
  ["filter contains", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "contains", "value": "bob"}]} }],
  ["filter contains cs", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "contains", "value": "Bo", "caseSensitive": true}]} }],
  ["filter not_contains", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "not_contains", "value": "a"}]} }],
  ["filter starts_with", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "starts_with", "value": "j"}]} }],
  ["filter ends_with", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "ends_with", "value": "E"}]} }],
  ["filter number >", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": ">", "value": "3"}]} }],
  ["filter number >=", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": ">=", "value": "3"}]} }],
  ["filter number <", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": "<", "value": "3"}]} }],
  ["filter number <=", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": "<=", "value": "3"}]} }],
  ["filter number =", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": "=", "value": "5"}]} }],
  ["filter number !=", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": "!=", "value": "5"}]} }],
  ["filter number between", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": "between", "value": "2", "value2": "5"}]} }],
  ["filter decimal >", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "amount", "operator": ">", "value": "10.5"}]} }],
  ["filter decimal between negative", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "amount", "operator": "between", "value": "-1", "value2": "10.5"}]} }],
  ["filter decimal = 0", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "amount", "operator": "=", "value": "0"}]} }],
  ["filter in_list numbers", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": "in_list", "value": "1, 2, 9"}]} }],
  ["filter not_in_list numbers", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": "not_in_list", "value": "1, 2, 9"}]} }],
  ["filter in_list text cs", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "in_list", "value": "Alice, Bob", "caseSensitive": true}]} }],
  ["filter is_null name", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "is_null"}]} }],
  ["filter is_not_null name", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "name", "operator": "is_not_null"}]} }],
  ["filter is_null score", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": "is_null"}]} }],
  ["filter is_not_null amount", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "amount", "operator": "is_not_null"}]} }],
  ["filter date >", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "seen", "operator": ">", "value": "2026-03-01"}]} }],
  ["filter date =", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "seen", "operator": "=", "value": "2026-01-05"}]} }],
  ["filter date between", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "seen", "operator": "between", "value": "2026-01-01", "value2": "2026-04-30"}]} }],
  ["filter boolean =", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "flag", "operator": "=", "value": "true"}]} }],
  ["filter any of two", "p", { type: "filter", data: {"mode": "rules", "logic": "any", "rules": [{"column": "score", "operator": "=", "value": "9"}, {"column": "name", "operator": "=", "value": "zed"}]} }],
  ["filter all of three", "p", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "score", "operator": ">=", "value": "2"}, {"column": "amount", "operator": "<", "value": "100"}, {"column": "name", "operator": "is_not_null"}]} }],
  ["filter values include text (with empty)", "p", { type: "filter", data: {"mode": "values", "column": "grp", "values": {"include": true, "list": ["A", "B", null]}} }],
  ["filter values exclude text", "p", { type: "filter", data: {"mode": "values", "column": "grp", "values": {"include": false, "list": ["A", "a"]}} }],
  ["filter values integer", "p", { type: "filter", data: {"mode": "values", "column": "score", "values": {"include": true, "list": ["3", null]}} }],
  ["filter on sales status", "s", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "status", "operator": "=", "value": "completed"}, {"column": "quantity", "operator": ">=", "value": "2"}]} }],
  ["filter sales discount empty", "s", { type: "filter", data: {"mode": "rules", "logic": "all", "rules": [{"column": "discount", "operator": "is_null"}]} }],
  ["sort name asc", "p", { type: "sort", data: {"keys": [{"column": "name", "direction": "asc"}], "nullsLast": true} }, 'refuse'],
  ["sort name desc", "p", { type: "sort", data: {"keys": [{"column": "name", "direction": "desc"}], "nullsLast": true} }, 'refuse'],
  ["sort name asc nulls first", "p", { type: "sort", data: {"keys": [{"column": "name", "direction": "asc"}], "nullsLast": false} }, 'refuse'],
  ["sort city asc unicode", "p", { type: "sort", data: {"keys": [{"column": "city", "direction": "asc"}], "nullsLast": true} }, 'refuse'],
  ["sort score asc ties", "p", { type: "sort", data: {"keys": [{"column": "score", "direction": "asc"}], "nullsLast": true} }],
  ["sort score desc nulls first", "p", { type: "sort", data: {"keys": [{"column": "score", "direction": "desc"}], "nullsLast": false} }],
  ["sort amount desc", "p", { type: "sort", data: {"keys": [{"column": "amount", "direction": "desc"}], "nullsLast": true} }],
  ["sort seen asc", "p", { type: "sort", data: {"keys": [{"column": "seen", "direction": "asc"}], "nullsLast": true} }],
  ["sort grp then score desc", "p", { type: "sort", data: {"keys": [{"column": "grp", "direction": "asc"}, {"column": "score", "direction": "desc"}], "nullsLast": true} }],
  ["sort flag asc", "p", { type: "sort", data: {"keys": [{"column": "flag", "direction": "asc"}], "nullsLast": true} }],
  ["sort note asc", "p", { type: "sort", data: {"keys": [{"column": "note", "direction": "asc"}], "nullsLast": true} }, 'refuse'],
  ["sort sales category asc", "s", { type: "sort", data: {"keys": [{"column": "category", "direction": "asc"}], "nullsLast": true} }],
  ["sort sales discount desc nulls first", "s", { type: "sort", data: {"keys": [{"column": "discount", "direction": "desc"}], "nullsLast": false} }],
  ["sort sales region, unit_price desc", "s", { type: "sort", data: {"keys": [{"column": "region", "direction": "asc"}, {"column": "unit_price", "direction": "desc"}], "nullsLast": true} }],
  ["select reorder", "p", { type: "select_columns", data: {"columns": ["score", "name", "id"]} }],
  ["select two", "p", { type: "select_columns", data: {"columns": ["id", "seen"]} }],
  ["select sales subset", "s", { type: "select_columns", data: {"columns": ["status", "customer", "order_id"]} }],
  ["remove two", "p", { type: "remove_columns", data: {"columns": ["note", "flag"]} }],
  ["remove many", "p", { type: "remove_columns", data: {"columns": ["note", "flag", "city", "seen", "amount"]} }],
  ["rename two", "p", { type: "rename_columns", data: {"mapping": {"name": "full name", "score": "points"}} }],
  ["rename with symbols", "p", { type: "rename_columns", data: {"mapping": {"amount": "Amount ($)", "grp": "group\"q"}} }],
  ["keep first 5", "p", { type: "keep_rows", data: {"mode": "first", "count": 5} }],
  ["keep first 0", "p", { type: "keep_rows", data: {"mode": "first", "count": 0} }],
  ["keep first 1000", "p", { type: "keep_rows", data: {"mode": "first", "count": 1000} }],
  ["remove first 3", "p", { type: "keep_rows", data: {"mode": "remove_first", "count": 3} }],
  ["keep range", "p", { type: "keep_rows", data: {"mode": "range", "offset": 4, "count": 5} }],
  ["remove first beyond end", "p", { type: "keep_rows", data: {"mode": "remove_first", "count": 500} }],
  ["blank rows all", "p", { type: "remove_blank_rows", data: {"columns": [], "mode": "all"} }],
  ["blank rows any on two", "p", { type: "remove_blank_rows", data: {"columns": ["name", "amount"], "mode": "any"} }],
  ["blank rows all on two", "p", { type: "remove_blank_rows", data: {"columns": ["name", "city"], "mode": "all"} }],
  ["blank rows sales any", "s", { type: "remove_blank_rows", data: {"columns": ["customer", "discount"], "mode": "any"} }],
  ["dedupe whole row", "p", { type: "remove_duplicates", data: {"columns": [], "matchMode": "exact", "keep": "first"} }],
  ["dedupe name keep first", "p", { type: "remove_duplicates", data: {"columns": ["name"], "matchMode": "exact", "keep": "first"} }],
  ["dedupe name keep last", "p", { type: "remove_duplicates", data: {"columns": ["name"], "matchMode": "exact", "keep": "last"} }],
  ["dedupe grp+city", "p", { type: "remove_duplicates", data: {"columns": ["grp", "city"], "matchMode": "exact", "keep": "first"} }],
  ["dedupe lowest score per grp", "p", { type: "remove_duplicates", data: {"columns": ["grp"], "matchMode": "exact", "orderBy": "score"} }],
  ["dedupe lowest amount per name", "p", { type: "remove_duplicates", data: {"columns": ["name"], "matchMode": "exact", "orderBy": "amount"} }],
  ["dedupe sales customer", "s", { type: "remove_duplicates", data: {"columns": ["customer"], "matchMode": "exact", "keep": "first"} }],
  ["group count by grp", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "count"}]} }],
  ["group count_nonblank name", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "count_nonblank", "column": "name"}]} }],
  ["group count_distinct name", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "count_distinct", "column": "name"}]} }],
  ["group sum score", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "sum", "column": "score"}]} }],
  ["group sum amount", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "sum", "column": "amount"}]} }],
  ["group avg amount", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "avg", "column": "amount"}]} }],
  ["group median score", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "median", "column": "score"}]} }],
  ["group min max amount", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "min", "column": "amount"}, {"fn": "max", "column": "amount"}]} }],
  ["group min max name", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "min", "column": "name"}, {"fn": "max", "column": "name"}]} }, 'refuse'],
  ["group std amount", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "std", "column": "amount"}]} }],
  ["group first last name", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "first", "column": "name"}, {"fn": "last", "column": "name"}]} }, 'refuse'],
  ["group concat name", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "concat", "column": "name"}]} }, 'refuse'],
  ["group by name text variants", "p", { type: "group_by", data: {"groupColumns": ["name"], "aggregations": [{"fn": "count"}, {"fn": "sum", "column": "score"}]} }],
  ["group by two keys", "p", { type: "group_by", data: {"groupColumns": ["grp", "city"], "aggregations": [{"fn": "count"}, {"fn": "avg", "column": "score"}]} }],
  ["group no keys (global)", "p", { type: "group_by", data: {"groupColumns": [], "aggregations": [{"fn": "count"}, {"fn": "sum", "column": "amount"}, {"fn": "max", "column": "seen"}]} }],
  ["group min max date", "p", { type: "group_by", data: {"groupColumns": ["grp"], "aggregations": [{"fn": "min", "column": "seen"}, {"fn": "max", "column": "seen"}]} }],
  ["group sales by region", "s", { type: "group_by", data: {"groupColumns": ["region"], "aggregations": [{"fn": "sum", "column": "quantity"}, {"fn": "avg", "column": "unit_price"}, {"fn": "count_distinct", "column": "customer"}]} }],
  ["group sales by category (mixed case)", "s", { type: "group_by", data: {"groupColumns": ["category"], "aggregations": [{"fn": "count"}]} }],
  ["sort sales customer asc (letters and spaces)", "s", { type: "sort", data: {"keys":[{"column":"customer","direction":"asc"}],"nullsLast":true} }],
  ["sort sales customer desc nulls first", "s", { type: "sort", data: {"keys":[{"column":"customer","direction":"desc"}],"nullsLast":false} }],
  ["sort sales status then quantity", "s", { type: "sort", data: {"keys":[{"column":"status","direction":"asc"},{"column":"quantity","direction":"desc"}],"nullsLast":true} }],
  ["sort sales product (hyphen) refuses", "s", { type: "sort", data: {"keys":[{"column":"product","direction":"asc"}],"nullsLast":true} }, 'refuse'],
  ["sort numbered text refuses", "x", { type: "sort", data: {"keys":[{"column":"code","direction":"asc"}],"nullsLast":true} }, 'refuse'],
  ["whitespace remove blank rows (all)", "w", { type: "remove_blank_rows", data: {"columns": ["name", "note"], "mode": "all"} }],
  ["whitespace remove blank rows (any)", "w", { type: "remove_blank_rows", data: {"columns": ["name", "note"], "mode": "any"} }],
  ["whitespace filter is empty", "w", { type: "filter", data: {"mode": "rules", "rules": [{"column": "name", "operator": "is_null"}]} }],
  ["whitespace filter is not empty", "w", { type: "filter", data: {"mode": "rules", "rules": [{"column": "note", "operator": "is_not_null"}]} }],
  ["whitespace group count_nonblank", "w", { type: "group_by", data: {"groupColumns": [], "aggregations": [{"fn": "count_nonblank", "column": "name"}, {"fn": "count_distinct", "column": "note"}]} }],
  ["whitespace merge skip empty", "w", { type: "merge_columns", data: {"columns": ["name", "note"], "name": "m", "separator": "-", "skipEmpty": true} }],
  ["whitespace unpivot skips blanks", "w", { type: "unpivot", data: {"columns": ["name", "note"], "nameColumn": "k", "valueColumn": "v"} }],
  ["whitespace pivot count_distinct", "w", { type: "pivot", data: {"onColumn": "qty", "valueColumn": "name", "fn": "count_distinct", "groupColumns": []} }],
  ["rank standard desc", "p", { type: "rank", data: {"column": "score", "direction": "desc", "mode": "rank", "partitionBy": [], "name": "Rank"} }],
  ["rank dense asc per group", "p", { type: "rank", data: {"column": "amount", "direction": "asc", "mode": "dense", "partitionBy": ["grp"], "name": "Rank"} }],
  ["rank unique per city", "p", { type: "rank", data: {"column": "score", "direction": "desc", "mode": "row_number", "partitionBy": ["city"], "name": "Rank"} }],
  ["rank percentile per group", "p", { type: "rank", data: {"column": "score", "direction": "asc", "mode": "percent", "partitionBy": ["grp"], "name": "Pct"} }],
  ["rank dates", "p", { type: "rank", data: {"column": "seen", "direction": "asc", "mode": "rank", "partitionBy": [], "name": "Rank"} }],
  ["rank text refuses", "p", { type: "rank", data: {"column": "name", "direction": "asc", "mode": "rank", "partitionBy": [], "name": "Rank"} }, "refuse"],
  ["running total integer", "p", { type: "running_total", data: {"column": "score", "orderBy": "", "partitionBy": [], "name": "Run"} }],
  ["running total decimals ordered per group", "p", { type: "running_total", data: {"column": "amount", "orderBy": "seen", "partitionBy": ["grp"], "name": "Run"} }],
  ["running total decimals row order", "p", { type: "running_total", data: {"column": "amount", "orderBy": "", "partitionBy": [], "name": "Run"} }],
  ["running total text order refuses", "p", { type: "running_total", data: {"column": "score", "orderBy": "name", "partitionBy": [], "name": "Run"} }, "refuse"],
  ["percent of total per group", "p", { type: "percent_of_total", data: {"column": "amount", "partitionBy": ["grp"], "name": "Share"} }],
  ["percent of total integer", "p", { type: "percent_of_total", data: {"column": "score", "partitionBy": [], "name": "Share"} }],
  ["percent of total text refuses", "p", { type: "percent_of_total", data: {"column": "note", "partitionBy": [], "name": "Share"} }, "refuse"],
  ["percent of total zero and cancelling totals", "z", { type: "percent_of_total", data: {"column": "v", "partitionBy": ["g"], "name": "Share"} }],
  ["percent of total integers summing to zero", "z", { type: "percent_of_total", data: {"column": "n", "partitionBy": ["g"], "name": "Share"} }],
  ["percent of total whole column", "z", { type: "percent_of_total", data: {"column": "v", "partitionBy": [], "name": "Share"} }],
  ["running total skips nulls per group", "z", { type: "running_total", data: {"column": "v", "orderBy": "id", "partitionBy": ["g"], "name": "Run"} }],
  ["running total integers per group", "z", { type: "running_total", data: {"column": "n", "orderBy": "", "partitionBy": ["g"], "name": "Run"} }],
  ["running total all-null column refuses", "z", { type: "running_total", data: {"column": "void", "orderBy": "", "partitionBy": [], "name": "Run"} }, "refuse"],
  ["rank text keys refuse", "x", { type: "rank", data: {"column": "code", "direction": "asc", "mode": "rank", "partitionBy": [], "name": "Rank"} }, "refuse"],
];

const list = document.getElementById('list');
const report = (name, ok, msg) => { const li = document.createElement('li'); li.className = 't-item'; li.innerHTML = `<span>${ok ? 'ok' : 'FAIL'}</span><span></span>`; li.children[1].textContent = name; if (msg) { const e = document.createElement('div'); e.className = 'err'; e.textContent = msg; li.appendChild(e); } list.appendChild(li); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${msg ? ' — ' + msg : ''}`); };

const norm = (fields, cols) => ({ fields: fields.map(f => `${f.name}:${f.type}`), rows: (cols[0] || []).map((_, r) => cols.map((c, i) => (c[r] == null ? null : formatValue(c[r], fields[i].type)))) });

async function compileWithProbes(step, srcSql, fields, deps) {
  const cache = new Map();
  for (let guard = 0; guard < 12; guard++) {
    let missing = null;
    const ctx = {
      probe: (p) => { const full = withInput(srcSql, p); if (cache.has(full)) return cache.get(full); missing = missing || full; return null; },
      dep: (id) => deps[id] || null,
    };
    const c = compileStep(step, fields, ctx);
    if (!missing) return c;
    try { const r = await duck.runQuery(missing, { maxRows: 1 }); let v = r.columns[0]?.[0]; if (typeof v === 'string' && /^\[/.test(v)) v = JSON.parse(v); cache.set(missing, v ?? null); } catch (err) { console.log('PROBE ERR ' + err.message.slice(0, 200)); cache.set(missing, null); }
  }
  return null;
}

let pass = 0, total = 0;
try {
  const e = new Engine();
  e.loadText({ id: 's', name: 's.csv', text: SAMPLE_SALES_CSV, format: 'csv' });
  e.loadText({ id: 'r', name: 'r.csv', text: SAMPLE_REGIONS_CSV, format: 'csv' });
  e.loadText({ id: 'x', name: 'x.csv', text: EXTRA, format: 'csv' });
  e.loadText({ id: 'p', name: 'p.csv', text: PMESS, format: 'csv' });
  e.loadText({ id: 'w', name: 'w.csv', text: WSP, format: 'csv' });
  e.loadText({ id: 'z', name: 'z.csv', text: ZERO, format: 'csv' });
  const base = {};
  for (const id of ['s', 'r', 'x', 'p', 'w', 'z']) {
    e.setQueries({ queries: [{ id, name: id, source: { kind: 'file', sourceId: id }, steps: [] }] });
    const r = e.evaluate({ queryId: id, pageSize: 1e6 });
    const cols = r.fields.map((_, c) => r.page.rows.map(row => row[c]));
    const t = `__parity_${id}`;
    await duck.putColumns(t, r.fields, cols);
    base[id] = { fields: r.fields, sql: `SELECT * FROM ${t}` };
  }
  for (const [name, src, raw, expect] of CASES) {
    total++;
    try {
      const step = { id: 'p', ...migrateStep(raw) };
      e.setQueries({ queries: [{ id: 'q', name: 'q', source: { kind: 'file', sourceId: src }, steps: [step] }, { id: 'r', name: 'regions', source: { kind: 'file', sourceId: 'r' }, steps: [] }] });
      const js = e.evaluate({ queryId: 'q', pageSize: 1e6 });
      if (js.error || js.fullError) throw new Error('JS: ' + (js.error || js.fullError.message));
      const c = await compileWithProbes(step, base[src].sql, base[src].fields, { r: base.r });
      if (expect === 'refuse') { if (c) throw new Error('compiled but should refuse'); report(name, true); pass++; continue; }
      if (!c) {
        const { MORE } = await import('../engine/compile-sql.js');
        let why = 'did not compile';
        try { const t = new Map(base[src].fields.map(f => [f.name, f.type])); MORE[step.type]?.(step.data, base[src].fields, t, { probe: () => null, dep: () => null }); } catch (x) { why += ': ' + x.message; }
        throw new Error(why);
      }
      const d = await duck.runQuery(withInput(base[src].sql, c.sql));
      const a = norm(js.fields, js.fields.map((_, i) => js.page.rows.map(row => row[i])));
      const b = norm(c.fields, d.columns);
      const close = (x, y) => { if (x === y) return true; if (x == null || y == null) return false; const nx = Number(x), ny = Number(y); return Number.isFinite(nx) && Number.isFinite(ny) && /^-?[\d.]+(e[-+]?\d+)?$/i.test(String(x)) && Math.abs(nx - ny) <= 1e-9 * Math.max(1, Math.abs(nx), Math.abs(ny)); };
      const sameRows = a.rows.length === b.rows.length && a.rows.every((r, k) => r.length === b.rows[k].length && r.every((v, i) => close(v, b.rows[k][i])));
      const A = JSON.stringify(a.fields), B = JSON.stringify(b.fields);
      if (A !== B || !sameRows) {
        let at = ''; if (JSON.stringify(a.fields) !== JSON.stringify(b.fields)) at = `fields js=${a.fields} duck=${b.fields}`; else { const i = a.rows.findIndex((r, k) => JSON.stringify(r) !== JSON.stringify(b.rows[k])); at = `rows ${a.rows.length}/${b.rows.length}, first diff #${i}: js=${JSON.stringify(a.rows[i])} duck=${JSON.stringify(b.rows[i])}`; }
        throw new Error(at);
      }
      report(name, true); pass++;
    } catch (err) { report(name, false, err.message); }
  }
} catch (err) { report('setup', false, err.message); }

const READER_FIXTURES = {
  basic: 'id,name,amount,day,ts,ok,note\n1,Ann,1.5,2026-01-02,2026-01-02 10:30:00,true,hello\n2,Bo,,2026-02-03,2026-02-03 00:00:00,false,\n3,Cy,3,,,true,"x, y"\n',
  crlf: 'a,b\r\n1,2\r\n3,4\r\n',
  bom: '\ufeffid,name\n1,Ann\n2,Bo\n',
  quoted_newline: 'id,note\n1,"line1\nline2"\n2,"say ""hi"""\n',
  quoted_newline_ragged: 'id,note,x\n1,"line1\nline2"\n2,"a",b\n',
  ragged_short: 'a,b,c\n1,2\n3,4,5\n',
  leading_zeros: 'zip,qty\n01234,1\n00012,2\n99999,3\n',
  bigint_ids: 'id,v\n1234567890123456789,1\n1234567890123456790,2\n-1234567890123456789,3\n',
  small_ints: 'id\n1\n2\n3\n',
  negatives: 'v\n-5\n(45)\n+7\n1e3\n',
  na_strings: 'v,w\nNA,1\nnull,2\nN/A,\n,4\n',
  thousands: 'v\n"1,234"\n"2,500.50"\n12\n',
  percent_currency: 'p,c\n12%,$5.00\n7.5%,"€1,200"\n',
  dates_iso: 'd\n2026-01-05\n2026-12-31\n2020-02-29\n',
  mixed_type: 'v\n1\n2\nabc\n4\n',
  booleans: 'f\nyes\nno\nY\nN\n1\n0\n',
  semicolon: 'a;b\n1;2\n3;4\n',
  unicode: 'name\nÉlan\nمحمد\n🦆 duck\nstraße\n',
  header_only: 'a,b,c\n',
  single_col: 'only\n1\n2\n3\n',
  whitespace_cells: 'a,b\n  x  , y\n\tz,w \n',
  decimal_precision: 'v\n0.1\n0.30000000000000004\n1234567.891234\n',
  long_text: 'v\n' + 'x'.repeat(5000) + '\n',
};
try {
  await duck.ensureDuck();
  for (const [name, text] of Object.entries(READER_FIXTURES)) {
    total++;
    try {
      const e = new Engine();
      e.loadText({ id: 'f', name: 'f.csv', text, format: 'csv' });
      e.setQueries({ queries: [{ id: 'q', name: 'q', source: { kind: 'file', sourceId: 'f' }, steps: [] }] });
      const v = e.evaluate({ queryId: 'q', pageSize: 1e6 });
      if (v.error || v.fullError) throw new Error(`JS import failed: ${v.error || v.fullError.message}`);
      const jsFields = v.fields.map(f => `${f.name}:${f.type}`);
      const jsRows = v.page.rows.map(row => row.map((c, i) => (c == null ? null : formatValue(c, v.fields[i].type))));
      const sep = text.startsWith('a;b') ? ';' : 'auto';
      await duck.registerFile(`rf_${name}.csv`, new File([text], `rf_${name}.csv`));
      const q = await duck.runQuery(`SELECT * FROM ${duck.readerFor(`rf_${name}.csv`, 'csv', { delimiter: sep })}`);
      const dFields = q.fields.map(f => `${f.name}:${f.type}`);
      const dRows = (q.columns[0] || []).map((_, i) => q.columns.map((c, k) => (c[i] == null ? null : formatValue(c[i], q.fields[k].type))));
      if (JSON.stringify(jsFields) !== JSON.stringify(dFields)) throw new Error(`fields js=${jsFields} duck=${dFields}`);
      const at = jsRows.findIndex((r, k) => JSON.stringify(r) !== JSON.stringify(dRows[k]));
      if (jsRows.length !== dRows.length || at >= 0) throw new Error(`rows js=${jsRows.length} duck=${dRows.length}, first diff #${at}: js=${JSON.stringify(jsRows[at])} duck=${JSON.stringify(dRows[at])}`);
      report(`file import: ${name}`, true); pass++;
    } catch (err) { report(`file import: ${name}`, false, err.message); }
  }
} catch (err) { report('reader setup', false, err.message); }
document.getElementById('score').textContent = `DuckDB parity ${pass}/${total}`;
console.log(`PARITY ${pass}/${total}`);
