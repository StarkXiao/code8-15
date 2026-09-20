// 入库闭环测试（独立临时库）：
// 字节去重 -> 新病害建档 -> 近重复重拍 -> 跨巡查复发 -> 修复后复发 -> 手工里程越界
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 在导入 db 之前指定隔离数据目录（每个测试文件独立，避免并行运行串库）
const tmp = mkdtempSync(join(tmpdir(), `pavement-test-ingest-${process.pid}-`));
process.env.PAVEMENT_DATA = tmp;

const { all, get, run, migrate } = await import('../server/db.js');
const { encodePNG } = await import('../server/png.js');
const { pHash } = await import('../server/phash.js');
const { ingestImage } = await import('../server/ingest.js');
const { runwayToLatLon } = await import('../server/geo.js');

const THRESHOLD = { lat: 31.1946, lon: 121.8352 };

function draw(kind, seed) {
  const S = 256;
  const px = new Uint8ClampedArray(S * S * 4);
  const rnd = mulberry32(seed);
  // 平滑光照 + 细颗粒（与 seed.js 同一噪声模型）
  const g = [rnd(), rnd(), rnd(), rnd()];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const ty = y / S, tx = x / S;
      const smooth = (g[0] * (1 - tx) * (1 - ty) + g[1] * tx * (1 - ty) +
        g[2] * (1 - tx) * ty + g[3] * tx * ty - 0.5) * 16;
      const b = 92 + smooth + (rnd() - 0.5) * 2;
      const i = (y * S + x) * 4;
      px[i] = b; px[i + 1] = b - 2; px[i + 2] = b - 6; px[i + 3] = 255;
    }
  }
  const put = (x, y, v) => {
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = px[i + 1] = px[i + 2] = v;
  };
  const line = (x0, y0, x1, y1, w, v) => {
    const steps = 500;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      for (let k = -w; k <= w; k++) {
        put((x0 + (x1 - x0) * t + k) | 0, (y0 + (y1 - y0) * t) | 0, v);
        put((x0 + (x1 - x0) * t) | 0, (y0 + (y1 - y0) * t + k) | 0, v);
      }
    }
  };
  const blob = (cx, cy, rx, ry, v) => {
    for (let y = -ry; y <= ry; y++) for (let x = -rx; x <= rx; x++) {
      if ((x / rx) ** 2 + (y / ry) ** 2 <= 1) put((cx + x) | 0, (cy + y) | 0, v);
    }
  };
  if (kind === 'crack_long') line(128 + (seed % 9), 10, 128 - (seed % 7), 246, 2, 28);
  else if (kind === 'pothole') blob(128 + (seed % 5), 128, 40, 34, 20);
  else blob(120, 120, 30, 22, 30);
  return px;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function png(kind, seed) {
  const rgba = draw(kind, seed);
  const buf = encodePNG(rgba, 256, 256);
  return { buf, hash: pHash(rgba, 256, 256) };
}
function at(station, offset = 0) {
  return runwayToLatLon(THRESHOLD, 156, station, offset);
}

let runwayId, ins1, ins2;

before(() => {
  migrate();
  run(
    `INSERT INTO runways (code,name,threshold_lat,threshold_lon,bearing,length_m,width_m,station0_label,created_at)
     VALUES ('18R','测试跑道',?,?,156,3800,60,'K0+000.00',?)`,
    [THRESHOLD.lat, THRESHOLD.lon, new Date().toISOString()]);
  runwayId = get('SELECT id FROM runways').id;
  run(`INSERT INTO inspections (runway_id,conducted_at,team,note,created_at)
    VALUES (?,?,?,?,?)`, [runwayId, '2026-09-10T09:00:00Z', '甲班', '', new Date().toISOString()]);
  ins1 = get('SELECT id FROM inspections ORDER BY id').id;
  run(`INSERT INTO inspections (runway_id,conducted_at,team,note,created_at)
    VALUES (?,?,?,?,?)`, [runwayId, '2026-09-17T09:00:00Z', '乙班', '', new Date().toISOString()]);
  ins2 = get('SELECT id FROM inspections ORDER BY id DESC').id;
});

function send(insId, kind, seed, { station = 1000, offset = 0, severity = 'low',
  type = kind, rename = false, bufOverride, hashOverride } = {}) {
  const img = png(kind, seed);
  const buf = bufOverride ?? img.buf;
  const ll = at(station, offset);
  return ingestImage({
    inspectionId: insId, buffer: buf, mime: 'image/png',
    originalName: rename ? `${kind}-${seed}-copy.png` : `${kind}-${seed}.png`,
    phash: hashOverride ?? img.hash, type, severity,
    lat: ll.lat, lon: ll.lon, station, offset,
    capturedAt: '2026-09-10T10:00:00Z', detector: 'test',
  });
}

test('1. 第一张图：新病害建档', () => {
  const r = send(ins1, 'crack_long', 11, { station: 420.5, type: 'crack_long', severity: 'medium' });
  assert.equal(r.decision, 'new_defect');
  assert.ok(r.defectId);
  const d = get('SELECT * FROM defects WHERE id=?', [r.defectId]);
  assert.match(d.code, /^18R-2026-\d{4}$/);
  assert.equal(d.type, 'crack_long');
  assert.equal(d.severity, 'medium');
  assert.ok(Math.abs(d.station_m - 420.5) < 0.1);
  assert.equal(d.observation_count, 1);
});

test('2. 同一字节内容再传（改名）：exact_duplicate，不新增观测/档案', () => {
  const before = get('SELECT COUNT(*) c FROM defects').c;
  const r = send(ins1, 'crack_long', 11, {
    station: 420.5, rename: true,
  });
  assert.equal(r.decision, 'exact_duplicate');
  assert.equal(get('SELECT COUNT(*) c FROM defects').c, before);
  assert.equal(get('SELECT COUNT(*) c FROM observations').c, 1);
  const dup = get('SELECT * FROM images WHERE id=?', [r.imageId]);
  assert.ok(dup.duplicate_of_id);
});

test('3. 同位置不同类型的新图：建立第二条档案', () => {
  const r = send(ins1, 'pothole', 33, { station: 2050, severity: 'high' });
  assert.equal(r.decision, 'new_defect');
});

test('3b. 跨巡查重传同一字节文件：recurrence，补一条观测但不建新图实体引用', () => {
  const before = get('SELECT COUNT(*) c FROM defects').c;
  const r = send(ins2, 'crack_long', 11, { station: 420.5 });
  assert.equal(r.decision, 'recurrence', r.decision);
  assert.equal(get('SELECT COUNT(*) c FROM defects').c, before);
  const target = get("SELECT id FROM defects WHERE type='crack_long' AND station_m BETWEEN 420 AND 421");
  assert.equal(r.defectId, target.id);
});

test('4. 跨巡查、位置微抖 0.4m 的重拍：近重复 -> 并入原档案', () => {
  const before = get('SELECT COUNT(*) c FROM defects').c;
  const targetBefore = get(
    "SELECT id, observation_count FROM defects WHERE type='crack_long' AND station_m BETWEEN 420 AND 421");
  const r = send(ins2, 'crack_long', 111, { station: 420.9, offset: 0.3, severity: 'medium' });
  assert.ok(['near_duplicate', 'recurrence'].includes(r.decision), r.decision);
  // 找到原 crack_long @420 的档案
  const target = get("SELECT * FROM defects WHERE type='crack_long' AND station_m BETWEEN 420 AND 421");
  assert.equal(r.defectId, target.id);
  assert.equal(get('SELECT COUNT(*) c FROM defects').c, before);
  assert.equal(
    get('SELECT COUNT(*) c FROM observations WHERE defect_id=?', [target.id]).c,
    targetBefore.observation_count + 1);
});

test('5. 坑槽在里程阈值内再次出现：复发，且严重程度取最高', () => {
  const r = send(ins2, 'pothole', 330, { station: 2050.8, offset: -0.2, severity: 'medium' });
  assert.ok(['near_duplicate', 'recurrence'].includes(r.decision));
  const d = get('SELECT * FROM defects WHERE id=?', [r.defectId]);
  assert.equal(d.severity, 'high', '历史重度 + 本次中度 => 仍为重度');
  assert.ok(d.observation_count >= 2);
});

test('6. 里程超过跑道长度：拒绝入库（不存文件、不建档）', () => {
  const defectsBefore = get('SELECT COUNT(*) c FROM defects').c;
  assert.throws(
    () => send(ins2, 'crack_long', 555, { station: 99999 }),
    /OFF_RUNWAY/);
  assert.equal(get('SELECT COUNT(*) c FROM defects').c, defectsBefore);
});

test('7. 没有任何定位信息：拒绝入库', () => {
  const img = png('pothole', 9999); // 未出现过的图，确保不是被字节去重拦下
  assert.throws(() => ingestImage({
    inspectionId: ins2, buffer: img.buf, mime: 'image/png',
    originalName: 'x.png', phash: img.hash,
    type: 'pothole',
  }), /NO_POSITION/);
});

test('8. 已修复档案再次发现：状态自动回到 open', () => {
  const target = get("SELECT id FROM defects WHERE type='crack_long' AND station_m BETWEEN 420 AND 421");
  run("UPDATE defects SET status='repaired' WHERE id=?", [target.id]);
  const r = send(ins2, 'crack_long', 222, { station: 420.6 });
  assert.equal(r.defectId, target.id);
  assert.equal(get('SELECT status s FROM defects WHERE id=?', [target.id]).s, 'open');
});

test('9. 汇总：2 条档案；观测 6 条（crack_long 4 + pothole 2）；字节重复登记 2 条', () => {
  assert.equal(get('SELECT COUNT(*) c FROM defects').c, 2);
  const obs = get('SELECT COUNT(*) c FROM observations').c;
  assert.equal(obs, 6);
  const exact = get('SELECT COUNT(*) c FROM images WHERE duplicate_of_id IS NOT NULL').c;
  assert.ok(exact >= 2);
});

test('10. 手工里程（无 GPS）也能入库并反算经纬度', () => {
  const img = png('crack_long', 400);
  const r = ingestImage({
    inspectionId: ins2, buffer: img.buf, mime: 'image/png',
    originalName: 'manual.png', phash: img.hash,
    station: 3000, offset: 3, type: 'crack_long',
    capturedAt: '2026-09-17T11:00:00Z', detector: 'test',
  });
  assert.equal(r.decision, 'new_defect');
  const d = get('SELECT * FROM defects WHERE id=?', [r.defectId]);
  assert.ok(Math.abs(d.station_m - 3000) < 0.1);
  assert.ok(d.lat != null && d.lon != null);
  assert.equal(get('SELECT COUNT(*) c FROM defects').c, 3);
});
