import * as duck from '../engine/duck.js';

const MAX_ROWS_BACK = 2_000_000;

export function createSqlRunner(client, { onStatus } = {}) {
  let busy = false;

  async function resolveStep(need, depth = 0) {
    const input = await client.call('sqlInput', { queryId: need.queryId, index: need.index }, { label: 'Preparing SQL input' });
    if (input.pending) {
      if (depth > 24) throw new Error('Too many chained SQL steps.');
      await resolve(input.pending, depth + 1);
      return resolveStep(need, depth + 1);
    }
    const v = duck.validateSql(input.sql);
    if (v.error) { await client.call('putSqlResult', { key: need.key, error: v.error }, { track: false }); return; }
    onStatus?.('loading');
    await duck.ensureDuck();
    onStatus?.('ready');
    const taken = new Set(['input']);
    const created = [];
    const finalSql = input.pushdown ? duck.withInput(input.pushdown, v.sql) : v.sql;
    if (!input.pushdown) { await duck.putColumns('input', input.fields, input.columns); created.push('input'); }
    for (const t of input.tables) {
      const name = duck.tableNameFor(t.name, taken);
      await duck.putColumns(name, t.fields, t.columns);
      created.push(name);
    }
    try {
      const n = await duck.countRows(finalSql);
      if (n > MAX_ROWS_BACK) throw new Error(`The query returns ${n.toLocaleString()} rows. Add a filter or aggregation so the result stays under ${MAX_ROWS_BACK.toLocaleString()} rows.`);
      const r = await duck.queryColumns(finalSql);
      await client.call('putSqlResult', { key: need.key, fields: dedupe(r.fields), columns: r.columns }, { track: false, label: 'Running SQL' });
    } catch (e) {
      await client.call('putSqlResult', { key: need.key, error: cleanError(e) }, { track: false });
    } finally {
      for (const t of created) await duck.exec(`DROP TABLE IF EXISTS ${duck.qi(t)}`).catch(() => {});
    }
  }

  async function resolveSource(need) {
    const { table, sql, limit } = need.source;
    onStatus?.('loading');
    await duck.ensureDuck();
    onStatus?.('ready');
    try {
      const total = await duck.countRows(sql);
      const take = Math.min(total, limit || MAX_ROWS_BACK);
      const r = await duck.queryColumns(sql, take);
      const note = take < total ? `Large file: showing the first ${take.toLocaleString()} of ${total.toLocaleString()} rows. Steps run on this slice; use “Export full file via DuckDB” for every row.` : null;
      await client.call('putSqlResult', { key: need.key, fields: dedupe(r.fields), columns: r.columns, note }, { track: false });
    } catch (e) {
      await client.call('putSqlResult', { key: need.key, error: `${table}: ${cleanError(e)}` }, { track: false });
    }
  }

  async function resolve(need, depth = 0) {
    if (need.source) return resolveSource(need);
    return resolveStep(need, depth);
  }

  return {
    async evaluate(args, opts) {
      let guard = 0;
      for (;;) {
        const res = await client.call('evaluate', args, opts);
        if (!res.needsSql) return res;
        if (++guard > 24) throw new Error('Too many chained SQL steps.');
        if (busy) await new Promise(r => setTimeout(r, 50));
        busy = true;
        try { await resolve(res.needsSql); } finally { busy = false; }
      }
    },
    async runSteps(args, opts) {
      let guard = 0;
      for (;;) {
        const res = await client.call('runSteps', args, opts);
        if (!res.needsSql) return res;
        if (++guard > 24) throw new Error('Too many chained SQL steps.');
        await resolve(res.needsSql);
      }
    },
    async queryColumns(args) {
      let guard = 0;
      for (;;) {
        const pending = await client.call('pendingSql', { queryId: args.queryId }, { track: false });
        if (!pending) break;
        if (++guard > 24) break;
        await resolve(pending);
      }
      return client.call('queryColumns', args, { track: false });
    },
    async exportPrepared(queryId, stepIndex) {
      await this.evaluate({ queryId, stepIndex, pageSize: 0 }, { track: false });
    },
  };
}

function dedupe(fields) {
  const seen = new Set();
  return fields.map(f => {
    let n = f.name || 'column', i = 2;
    while (seen.has(n)) n = `${f.name}_${i++}`;
    seen.add(n);
    return { ...f, name: n };
  });
}

function cleanError(e) {
  return String(e?.message || e).replace(/^(Binder|Parser|Catalog|Conversion|Invalid Input) Error:\s*/i, '').split('\n')[0];
}
