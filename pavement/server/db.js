// SQLite (sql.js / WASM) 封装：同步查询 + 防抖落盘（写后 200ms 合并为一次原子写入）
import initSqlJs from 'sql.js';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const SQL = await initSqlJs({
  locateFile: (f) => require.resolve(`sql.js/dist/${f}`),
});

const __dirname = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(__dirname, '..');
export const DATA_DIR = process.env.PAVEMENT_DATA || join(ROOT, 'data');
export const IMG_DIR = join(DATA_DIR, 'images');
const DB_PATH = process.env.PAVEMENT_DB || join(DATA_DIR, 'app.db');

mkdirSync(IMG_DIR, { recursive: true });

export const db = new SQL.Database(
  existsSync(DB_PATH) ? require('node:fs').readFileSync(DB_PATH) : undefined
);
db.run('PRAGMA foreign_keys = ON;');

let flushTimer = null;
let dirty = false;

export function persistNow() {
  if (!dirty) return;
  const data = db.export();
  const tmp = `${DB_PATH}.tmp`;
  writeFileSync(tmp, Buffer.from(data));
  renameSync(tmp, DB_PATH);
  dirty = false;
}

function scheduleFlush() {
  dirty = true;
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    try {
      persistNow();
    } catch (e) {
      console.error('[db] 落盘失败:', e);
    }
  }, 200);
}

process.on('SIGINT', () => { persistNow(); process.exit(0); });
process.on('SIGTERM', () => { persistNow(); process.exit(0); });

// ---- 查询助手 ----
// dbGet/dbAll 返回的是对象（列名 -> 值）；写操作自动安排落盘
function toObjects(result) {
  if (!result || result.length === 0) return [];
  const { columns, values } = result[0];
  return values.map((row) => {
    const o = {};
    columns.forEach((c, i) => { o[c] = row[i]; });
    return o;
  });
}

export function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

export function get(sql, params = []) {
  return all(sql, params)[0] ?? null;
}

export function run(sql, params = []) {
  db.run(sql, params);
  scheduleFlush();
  return { lastId: lastInsertRowid(), changes: db.getRowsModified() };
}

export function lastInsertRowid() {
  return get('SELECT last_insert_rowid() AS id').id;
}

export function tx(fn) {
  db.run('BEGIN');
  try {
    const r = fn();
    db.run('COMMIT');
    scheduleFlush();
    return r;
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

// JSON 列读写助手
export function parseJson(v, fallback = null) {
  if (v == null) return fallback;
  try { return JSON.parse(v); } catch { return fallback; }
}
export function json(v) { return JSON.stringify(v ?? null); }

// 建表（幂等）
export function migrate() {
  db.run(`
  CREATE TABLE IF NOT EXISTS runways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    threshold_lat REAL NOT NULL,
    threshold_lon REAL NOT NULL,
    bearing REAL NOT NULL,
    length_m REAL NOT NULL,
    width_m REAL NOT NULL DEFAULT 45,
    station0_label TEXT NOT NULL DEFAULT 'K0+000.00',
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS inspections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    runway_id INTEGER NOT NULL REFERENCES runways(id),
    conducted_at TEXT NOT NULL,
    team TEXT,
    note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inspection_id INTEGER NOT NULL REFERENCES inspections(id),
    runway_id INTEGER NOT NULL REFERENCES runways(id),
    filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    phash TEXT,
    station_m REAL,
    offset_m REAL,
    lat REAL,
    lon REAL,
    gps_accuracy_m REAL,
    captured_at TEXT,
    source TEXT NOT NULL DEFAULT 'upload',
    duplicate_of_id INTEGER REFERENCES images(id),
    ingest_note TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS defects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    runway_id INTEGER NOT NULL REFERENCES runways(id),
    type TEXT NOT NULL,
    severity TEXT NOT NULL DEFAULT 'low',
    status TEXT NOT NULL DEFAULT 'open',
    station_m REAL NOT NULL,
    offset_m REAL NOT NULL DEFAULT 0,
    lat REAL,
    lon REAL,
    slab_no TEXT,
    description TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    observation_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    defect_id INTEGER NOT NULL REFERENCES defects(id) ON DELETE CASCADE,
    image_id INTEGER NOT NULL REFERENCES images(id),
    inspection_id INTEGER NOT NULL REFERENCES inspections(id),
    type TEXT,
    severity TEXT,
    station_m REAL,
    offset_m REAL,
    is_new INTEGER NOT NULL DEFAULT 0,
    detector TEXT NOT NULL DEFAULT 'manual',
    confidence REAL,
    created_at TEXT NOT NULL,
    UNIQUE(defect_id, image_id)
  );

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id INTEGER NOT NULL,
    action TEXT NOT NULL,
    detail TEXT,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_images_sha ON images(sha256);
  CREATE INDEX IF NOT EXISTS idx_images_phash ON images(phash);
  CREATE INDEX IF NOT EXISTS idx_images_insp ON images(inspection_id);
  CREATE INDEX IF NOT EXISTS idx_defects_runway ON defects(runway_id);
  CREATE INDEX IF NOT EXISTS idx_obs_defect ON observations(defect_id);
  `);
  scheduleFlush();
}
