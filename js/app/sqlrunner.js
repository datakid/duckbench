import * as duck from '../engine/duck.js';

const MAX_ROWS_BACK = 2_000_000;
const INPUT_CACHE = 8;

export function createSqlRunner(client, { onStatus } = {}) {
  let chain = Promise.resolve();
  const materialized = new Map();
  let seq = 0;

  const exclusive = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };

  async function ensureDuckReady() {
    if (duck.duckStatus() !== 'ready') onStatus?.('loading');
    await duck.ensureDuck();
    onStatus?.('ready');
  }

  async function materialize(key, fields, columns) {
    if (key && materialized.has(key)) {
      const name = materialized.get(key);
      materialized.delete(key); materialized.set(key, name);
      return name;
    }
    const name = `__in_${++seq}`;
    await duck.putColumns(name, fields, columns);
    if (key) {
      materialized.set(key, name);
      while (materialized.size > INPUT_CACHE) {
        const [k, old] = materialized.entries().next().value;
        materialized.delete(k);
        await duck.dropTable(old);
      }
    }
    return name;
  }

  function compose(ctes, userSql) {
    const entries = Object.entries(ctes);
    userSql = duck.normalizeMeta(userSql);
    if (!entries.length) return userSql;
    const [first, ...rest] = entries;
    let sql = userSql;
    for (const [name, src] of rest.reverse()) sql = withNamed(name, src, sql);
    return withNamed(first[0], first[1], sql);
  }

  function withNamed(name, src, userSql) {
    if (name === 'input') return duck.withInput(src, userSql);
    const m = /^\s*with\s+(recursive\s+)?/i.exec(userSql);
    if (m) return `WITH ${m[1] || ''}${duck.qi(name)} AS (${src}), ${userSql.slice(m[0].length)}`;
    return `WITH ${duck.qi(name)} AS (${src}) ${userSql}`;
  }

  async function buildSql(input, userSql) {
    const ctes = {};
    if (input.pushdown) ctes.input = input.pushdown;
    else ctes.input = `SELECT * FROM ${duck.qi(await materialize(input.inputKey, input.fields, input.columns))}`;
    const taken = new Set(['input']);
    const names = [];
    for (const t of input.tables) {
      const name = duck.tableNameFor(t.name, taken);
      names.push(name);
      const tbl = await materialize(t.key, t.fields, t.columns);
      ctes[name] = `SELECT * FROM ${duck.qi(tbl)}`;
    }
    return { sql: compose(ctes, userSql), names };
  }

  async function resolveStep(need, depth = 0) {
    const input = await client.call('sqlInput', { queryId: need.queryId, index: need.index }, { label: 'Preparing SQL input' });
    if (input.pending) {
      if (depth > 24) throw new Error('Too many chained SQL steps.');
      await resolve(input.pending, depth + 1);
      return resolveStep(need, depth + 1);
    }
    const v = duck.validateSql(input.sql);
    if (v.error) { await client.call('putSqlResult', { key: need.key, error: v.error }, { track: false }); return; }
    await ensureDuckReady();
    try {
      const { sql } = await buildSql(input, v.sql);
      const r = await duck.runQuery(sql, { maxRows: MAX_ROWS_BACK + 1 });
      if (r.truncated || r.rows > MAX_ROWS_BACK) throw new Error(`The query returns more than ${MAX_ROWS_BACK.toLocaleString()} rows. Add a filter or aggregation.`);
      await client.call('putSqlResult', { key: need.key, fields: dedupe(r.fields), columns: r.columns, note: null }, { track: false, label: 'Running SQL' });
    } catch (e) {
      await client.call('putSqlResult', { key: need.key, error: cleanError(e) }, { track: false });
    }
  }

  async function resolveSchema(need) {
    await ensureDuckReady();
    try {
      const fields = await duck.schemaOf(need.schema);
      await client.call('putDuckSchema', { key: need.key, fields: dedupe(fields) }, { track: false });
    } catch (e) {
      await client.call('putDuckSchema', { key: need.key, error: cleanError(e) }, { track: false });
    }
  }

  async function resolveSource(need) {
    const { table, sql, limit, pushed } = need.source;
    await ensureDuckReady();
    try {
      const take = limit || MAX_ROWS_BACK;
      const r = await duck.runQuery(sql, { maxRows: take });
      let note = null;
      if (r.truncated) {
        let total = null;
        try { total = await duck.countRows(sql); } catch {}
        note = `First ${take.toLocaleString()}${total ? ` of ${total.toLocaleString()}` : ''} rows${pushed ? ` after ${pushed} step${pushed === 1 ? '' : 's'} run by DuckDB over the whole file` : ''}. Full-file export uses every row.`;
      } else if (pushed) note = `${pushed} step${pushed === 1 ? '' : 's'} ran in DuckDB over the whole file.`;
      await client.call('putSqlResult', { key: need.key, fields: dedupe(r.fields), columns: r.columns, note }, { track: false });
    } catch (e) {
      await client.call('putSqlResult', { key: need.key, error: pushed ? cleanError(e) : `${table}: ${cleanError(e)}` }, { track: false });
    }
  }

  function resolve(need, depth = 0) {
    if (need.schema) return resolveSchema(need);
    if (need.source) return resolveSource(need);
    return resolveStep(need, depth);
  }

  async function loop(method, args, opts, locked = false) {
    let guard = 0;
    for (;;) {
      const res = await client.call(method, args, opts);
      if (!res || !res.needsSql) return res;
      if (++guard > 24) throw new Error('Too many chained SQL steps.');
      if (locked) await resolve(res.needsSql);
      else await exclusive(() => resolve(res.needsSql));
    }
  }

  async function adhoc({ sql, queries, inputQueryId, inputStep, limit = 1000 }) {
    const v = duck.validateSql(sql);
    if (v.error) throw new Error(v.error);
    return exclusive(async () => {
      const t0 = performance.now();
      await ensureDuckReady();
      const tLoad = performance.now() - t0;
      const { sql: finalSql, tables } = await prepareAdhoc({ sql, queries, inputQueryId, inputStep });
      const tPrep = performance.now() - t0 - tLoad;
      const res = await duck.runQuery(finalSql, { maxRows: limit });
      return { ...res, fields: dedupe(res.fields), tables, sql: finalSql, timing: { load: tLoad, prepare: tPrep, run: res.ms, total: performance.now() - t0 } };
    });
  }

  async function prepareAdhoc({ sql, queries, inputQueryId, inputStep }) {
    const v = duck.validateSql(sql);
    if (v.error) throw new Error(v.error);
    const taken = new Set(['input']);
    const ctes = {};
    const refs = [];
    for (const q of queries) refs.push({ q, name: duck.tableNameFor(q.name, taken) });
    const used = duck.referencedNames(v.sql, ['input', ...refs.map(r => r.name)]);
    const wanted = refs.filter(r => used.includes(r.name));
    if (inputQueryId && used.includes('input')) wanted.unshift({ q: { id: inputQueryId }, name: 'input' });
    for (const r of wanted) {
      const data = await loop('queryData', { queryId: r.q.id, stepIndex: r.name === 'input' ? inputStep : undefined }, { track: false }, true);
      if (data.error) throw new Error(`“${r.q.name || 'input'}”: ${data.error}`);
      if (data.pushdown) { ctes[r.name] = data.pushdown; continue; }
      const tbl = await materialize(data.key, data.fields, data.columns);
      ctes[r.name] = `SELECT * FROM ${duck.qi(tbl)}`;
    }
    return { sql: compose(ctes, v.sql), tables: wanted.map(r => r.name) };
  }

  async function explainAdhoc(args, { analyze = false } = {}) {
    return exclusive(async () => {
      const t0 = performance.now();
      await ensureDuckReady();
      const tLoad = performance.now() - t0;
      const { sql: finalSql } = await prepareAdhoc(args);
      const tPrep = performance.now() - t0 - tLoad;
      const r = await duck.explain(finalSql, { analyze });
      return { ...r, sql: finalSql, timing: { load: tLoad, prepare: tPrep, run: r.ms, total: performance.now() - t0 } };
    });
  }

  async function planFor(queryId, stepIndex) {
    for (let guard = 0; guard < 24; guard++) {
      const p = await client.call('duckPlan', { queryId, stepIndex }, { track: false });
      if (!p.needsSql) return p;
      await exclusive(() => resolve(p.needsSql));
    }
    throw new Error('Could not plan this query.');
  }

  async function exportViaDuck({ fields, columns, format, key }) {
    return exclusive(async () => {
      await ensureDuckReady();
      const tbl = await materialize(key, fields, columns);
      return duck.copyTo(`SELECT * FROM ${duck.qi(tbl)}`, format);
    });
  }

  async function summarizeSource(sql) {
    return exclusive(async () => {
      await ensureDuckReady();
      return duck.runQuery(`SELECT * FROM (SUMMARIZE ${sql})`, { maxRows: 5000 });
    });
  }

  return {
    evaluate: (args, opts) => loop('evaluate', args, opts),
    runSteps: (args, opts) => loop('runSteps', args, opts),
    async queryColumns(args) {
      let guard = 0;
      for (;;) {
        const pending = await client.call('pendingSql', { queryId: args.queryId }, { track: false });
        if (!pending || ++guard > 24) break;
        await exclusive(() => resolve(pending));
      }
      return client.call('queryColumns', args, { track: false });
    },
    async exportPrepared(queryId, stepIndex) {
      await loop('evaluate', { queryId, stepIndex, pageSize: 0 }, { track: false });
    },
    adhoc,
    explain: explainAdhoc,
    planFor,
    exportViaDuck,
    summarizeSource,
    async reset() {
      for (const name of materialized.values()) await duck.dropTable(name);
      materialized.clear();
    },
    cancel: () => duck.cancelDuck(),
  };
}

function dedupe(fields) {
  const seen = new Set();
  return fields.map(f => {
    let n = f.name || 'column', i = 2;
    while (seen.has(n)) n = `${f.name || 'column'}_${i++}`;
    seen.add(n);
    return { ...f, name: n };
  });
}

export function cleanError(e) {
  return String(e?.message || e).replace(/^(Binder|Parser|Catalog|Conversion|Invalid Input|Not implemented|Out of Range) Error:\s*/i, '').split('\n')[0];
}
