// Database layer: PostgreSQL via `pg` in production, embedded PGlite (real Postgres in WASM) for dev/tests
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const dir = path.dirname(fileURLToPath(import.meta.url));
const NUMERIC = 1700, INT8 = 20, DATE = 1082;
let impl = null;

function wrap(q) {
  return {
    query: async (sql, params = []) => (await q(sql, params)).rows,
    one: async (sql, params = []) => (await q(sql, params)).rows[0] || null,
  };
}

export async function connect({ url = config.databaseUrl, pgliteDir = config.pgliteDir } = {}) {
  if (url) {
    const pg = (await import('pg')).default;
    pg.types.setTypeParser(NUMERIC, parseFloat);
    pg.types.setTypeParser(INT8, Number);
    pg.types.setTypeParser(DATE, (v) => v);
    const pool = new pg.Pool({ connectionString: url, max: 10, ssl: /sslmode=require|supabase|neon/.test(url) ? { rejectUnauthorized: false } : undefined });
    impl = {
      ...wrap((s, p) => pool.query(s, p)),
      exec: (s) => pool.query(s),
      async tx(fn) {
        const c = await pool.connect();
        try { await c.query('begin'); const r = await fn(wrap((s, p) => c.query(s, p))); await c.query('commit'); return r; }
        catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
      },
      close: () => pool.end(),
      kind: 'postgres',
    };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    if (pgliteDir) fs.mkdirSync(pgliteDir, { recursive: true });
    const db = new PGlite(pgliteDir || undefined);
    const opts = { parsers: { [NUMERIC]: parseFloat, [INT8]: Number, [DATE]: (v) => v } };
    await db.waitReady;
    // PGlite is single-connection: serialise transactions with a mutex
    let chain = Promise.resolve();
    const lock = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
    impl = {
      ...wrap((s, p) => lock(() => db.query(s, p, opts))),
      exec: (s) => lock(() => db.exec(s)),
      tx: (fn) => lock(() => db.transaction((t) => fn(wrap((s, p) => t.query(s, p, opts))))),
      close: () => db.close(),
      kind: 'pglite',
    };
  }
  await migrate();
  return impl;
}

async function migrate() {
  await impl.exec('create table if not exists schema_migrations (name text primary key, applied_at timestamptz default now())');
  const done = new Set((await impl.query('select name from schema_migrations')).map((r) => r.name));
  const files = fs.readdirSync(path.join(dir, 'db/migrations')).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    await impl.exec(fs.readFileSync(path.join(dir, 'db/migrations', f), 'utf8'));
    await impl.query('insert into schema_migrations(name) values ($1)', [f]);
  }
}

export const db = {
  query: (s, p) => impl.query(s, p),
  one: (s, p) => impl.one(s, p),
  tx: (fn) => impl.tx(fn),
  close: () => impl?.close(),
  get kind() { return impl?.kind; },
};
