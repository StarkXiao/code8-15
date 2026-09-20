// 基线数据：一条 18R/36L 跑道 + 两次巡查 + 程序化生成的病害影像
// 影像由 PNG 纹理程序生成（圆形/椭圆/网状纹理 + 位置微抖 + 亮度噪声），
// 故意让"同一条裂缝的第二次巡查照片"在字节上不同、但 pHash 距离很近，
// 用于直观演示三级去重（字节重复 / 感知近重复 / 复发并入）。
import { randomBytes } from 'node:crypto';
import { all, get, run, migrate, persistNow } from './db.js';
import { encodePNG } from './png.js';
import { pHash } from './phash.js';
import { ingestImage } from './ingest.js';
import { runwayToLatLon } from './geo.js';

migrate();

const THRESHOLD = { lat: 31.1946, lon: 121.8352 }; // 上海浦东附近（示例坐标）
const BEARING = 156.0;
const LENGTH = 3800;

function ensureRunway() {
  const existing = get('SELECT * FROM runways WHERE code=?', ['18R']);
  if (existing) return existing;
  const now = new Date().toISOString();
  run(
    `INSERT INTO runways (code,name,threshold_lat,threshold_lon,bearing,
      length_m,width_m,station0_label,created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    ['18R', '18R/36L 跑道', THRESHOLD.lat, THRESHOLD.lon, BEARING, LENGTH, 60,
     'K0+000.00', now]);
  return get('SELECT * FROM runways WHERE code=?', ['18R']);
}

function ensureInspection(runway, conductedAt, team, note) {
  const existing = get(
    'SELECT * FROM inspections WHERE runway_id=? AND conducted_at=?',
    [runway.id, conductedAt]);
  if (existing) return existing;
  const res = run(
    `INSERT INTO inspections (runway_id, conducted_at, team, note, created_at)
     VALUES (?,?,?,?,?)`,
    [runway.id, conductedAt, team, note, new Date().toISOString()]);
  return get('SELECT * FROM inspections WHERE id=?', [res.lastId]);
}

// ---- 程序化"道面病害"纹理 256x256 RGBA ----
function drawDefect(kind, seed) {
  const S = 256;
  const px = new Uint8ClampedArray(S * S * 4);
  const rnd = mulberry32(seed);
  // 道面底色：沥青偏深 / 混凝土偏灰。
  // 噪声由"大尺度平滑光照 + 细颗粒"组成——真实重拍间只有光照变化，
  // 病害结构在 DCT 低频段保持稳定（这是 pHash 能识别重拍的前提）。
  const concrete = ['corner_break', 'slab_crack', 'joint_seal', 'spalling',
    'faulting', 'pumping'].includes(kind);
  const base = concrete ? 168 : 92;
  const g = [rnd(), rnd(), rnd(), rnd()];
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const ty = y / S, tx = x / S;
      const smooth = (g[0] * (1 - tx) * (1 - ty) + g[1] * tx * (1 - ty) +
        g[2] * (1 - tx) * ty + g[3] * tx * ty - 0.5) * 16;
      const grain = (rnd() - 0.5) * 2;
      const v = base + smooth + grain;
      const i = (y * S + x) * 4;
      px[i] = clamp(v); px[i + 1] = clamp(v - 2);
      px[i + 2] = clamp(v - 6); px[i + 3] = 255;
    }
  }
  const put = (x, y, v, a = 255) => {
    x = x | 0; y = y | 0;
    if (x < 0 || y < 0 || x >= S || y >= S) return;
    const i = (y * S + x) * 4;
    px[i] = v; px[i + 1] = v; px[i + 2] = v; px[i + 3] = a;
  };
  const line = (x0, y0, x1, y1, w, v) => {
    const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 2;
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      for (let k = -w; k <= w; k++) {
        put(x0 + (x1 - x0) * t + k, y0 + (y1 - y0) * t, v);
        put(x0 + (x1 - x0) * t, y0 + (y1 - y0) * t + k, v);
      }
    }
  };
  const blob = (cx, cy, rx, ry, v) => {
    for (let y = -ry; y <= ry; y++) {
      for (let x = -rx; x <= rx; x++) {
        if ((x / rx) ** 2 + (y / ry) ** 2 <= 1) put(cx + x, cy + y, v);
      }
    }
  };

  switch (kind) {
    case 'crack_long':
      line(128 + jitter(rnd), 10, 128 + jitter(rnd), 246, 2, 28); break;
    case 'crack_trans':
      line(10, 130 + jitter(rnd), 246, 128 + jitter(rnd), 2, 26); break;
    case 'crack_map':
      for (let i = 0; i < 26; i++) {
        const x = 40 + rnd() * 176, y = 40 + rnd() * 176;
        const a = rnd() * Math.PI, l = 18 + rnd() * 40;
        line(x, y, x + Math.cos(a) * l, y + Math.sin(a) * l, 1, 30);
      }
      break;
    case 'pothole':
      blob(128 + jitter(rnd), 128 + jitter(rnd), 42, 34, 20);
      blob(128, 128, 30, 24, 44); break;
    case 'raveling':
      for (let i = 0; i < 500; i++) {
        const x = 30 + rnd() * 196, y = 30 + rnd() * 196;
        put(x, y, 40 + rnd() * 40);
      }
      break;
    case 'corner_break':
      line(14, 240, 150, 40, 3, 36);
      line(150, 40, 220, 240, 1, 58); break;
    case 'joint_seal':
      line(10, 128, 246, 128, 7, 30);
      line(10, 128, 246, 128, 1, 12); break;
    default:
      blob(120, 120, 30, 22, 30);
  }
  // 拼缝（混凝土板的横竖缝，让画面更像道面）
  if (concrete) {
    line(0, 128, S, 128, 1, 90); line(128, 0, 128, S, 1, 90);
  }
  return { rgba: px, width: S, height: S };
}

function jitter(rnd) { return (rnd() - 0.5) * 40; }
function clamp(v) { return Math.max(0, Math.min(255, v)); }
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function ingest(runway, inspection, { kind, severity, station, offset, seed, exactDup = false }) {
  const img = drawDefect(kind, seed);
  const png = encodePNG(img.rgba, img.width, img.height);
  const hash = pHash(img.rgba, img.width, img.height);
  const ll = runwayToLatLon(
    { lat: runway.threshold_lat, lon: runway.threshold_lon },
    runway.bearing, station, offset);
  const result = ingestImage({
    inspectionId: inspection.id,
    buffer: png, mime: 'image/png',
    originalName: `${kind}-${seed}.png`,
    phash: hash,
    type: kind, severity,
    lat: ll.lat, lon: ll.lon,
    station, offset,
    capturedAt: inspection.conducted_at,
    detector: 'seed',
  });
  if (exactDup) {
    // 同一张原图再传一次：应当被字节去重拦住
    ingestImage({
      inspectionId: inspection.id,
      buffer: png, mime: 'image/png',
      originalName: `${kind}-${seed}-copy.png`,
      phash: hash, lat: ll.lat, lon: ll.lon,
      station, offset, capturedAt: inspection.conducted_at, detector: 'seed',
    });
  }
  return result;
}

const runway = ensureRunway();
const ins1 = ensureInspection(runway, '2026-09-15T09:00:00', '甲班', '月度例行徒步巡查');
const ins2 = ensureInspection(runway, '2026-09-19T09:30:00', '乙班', '雨后巡查');

// 首次巡查：6 处病害
const defects = [
  { kind: 'crack_long',  severity: 'medium', station: 420.5,  offset: -7.2, seed: 11 },
  { kind: 'crack_trans', severity: 'low',    station: 1180.0, offset: 2.1,  seed: 22 },
  { kind: 'pothole',     severity: 'high',   station: 2050.4, offset: -11.5, seed: 33 },
  { kind: 'crack_map',   severity: 'medium', station: 2610.0, offset: 6.0,  seed: 44 },
  { kind: 'corner_break', severity: 'low',   station: 3120.8, offset: 12.3, seed: 55 },
  { kind: 'joint_seal',  severity: 'low',    station: 3420.0, offset: 0,     seed: 66 },
];

const seeded = get('SELECT COUNT(*) c FROM images WHERE runway_id=?', [runway.id]);
if (seeded.c === 0) {
  for (const d of defects) ingest(runway, ins1, d);
  // 第二次巡查：
  //  - 420.5 纵缝：位置微抖 0.3m、重拍（pHash 近似）=> 感知近重复/复发
  ingest(runway, ins2, { ...defects[0], station: 420.8, offset: -7.0, seed: 110 });
  //  - 1180 横缝：同类、里程内 => 复发
  ingest(runway, ins2, { ...defects[1], station: 1180.6, offset: 2.4, seed: 220 });
  //  - 2050 坑槽：加重
  ingest(runway, ins2, { ...defects[2], station: 2050.2, offset: -11.3, severity: 'high', seed: 330 });
  //  - 3420 接缝：同一张图重复上传 => 字节级重复
  ingest(runway, ins2, { ...defects[5], exactDup: true });
  //  - 新发现两处
  ingest(runway, ins2, { kind: 'raveling', severity: 'low', station: 1780.0, offset: 4.4, seed: 77 });
  ingest(runway, ins2, { kind: 'pothole', severity: 'medium', station: 3560.0, offset: -5.0, seed: 88 });

  // 演示修复后复发：把 2610 网裂标记修复（第二次巡查没拍到它）
  const repaired = get('SELECT d.id FROM defects d WHERE d.runway_id=? AND d.type=? AND d.station_m=?',
    [runway.id, 'crack_map', 2610]);
  if (repaired) {
    run("UPDATE defects SET status='repaired', updated_at=? WHERE id=?",
      [new Date().toISOString(), repaired.id]);
  }

  persistNow();
  console.log('种子数据写入完成。');
} else {
  console.log('已存在影像数据，跳过种子写入。');
}

const stats = {
  runways: get('SELECT COUNT(*) c FROM runways').c,
  inspections: get('SELECT COUNT(*) c FROM inspections').c,
  images: get('SELECT COUNT(*) c FROM images').c,
  exactDupes: get('SELECT COUNT(*) c FROM images WHERE duplicate_of_id IS NOT NULL').c,
  defects: get('SELECT COUNT(*) c FROM defects').c,
  observations: get('SELECT COUNT(*) c FROM observations').c,
};
console.log(stats);
