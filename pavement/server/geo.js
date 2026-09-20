// 跑道里程定位：WGS84 经纬度 <-> 跑道坐标系（里程 station / 横距 offset）
// 跑道坐标：阈值点 (lat0,lon0) + 方位角 bearing(°)。
// station: 沿跑道方向的距离（米，可略负/超出长度）；offset: 垂直距离，
// 面向跑道方向时左负右正。

const R = 6371008.8; // 平均地球半径（米）
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function havDistance(a, b) {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R;
  const dφ = (b.lat - a.lat) * D2R;
  const dλ = (b.lon - a.lon) * D2R;
  const h = Math.sin(dφ / 2) ** 2 +
    Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 初始方位角 a -> b，归一化到 [0,360)
export function bearing(a, b) {
  const φ1 = a.lat * D2R, φ2 = b.lat * D2R;
  const dλ = (b.lon - a.lon) * D2R;
  const y = Math.sin(dλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) -
    Math.sin(φ1) * Math.cos(φ2) * Math.cos(dλ);
  return (Math.atan2(y, x) * R2D + 360) % 360;
}

// 从 a 出发，沿方位角 brng(°) 走 dist(米) 到达的点
export function destination(a, brng, dist) {
  const δ = dist / R;
  const θ = brng * D2R;
  const φ1 = a.lat * D2R, λ1 = a.lon * D2R;
  const sinφ2 = Math.sin(φ1) * Math.cos(δ) +
    Math.cos(φ1) * Math.sin(δ) * Math.cos(θ);
  const φ2 = Math.asin(Math.min(1, Math.max(-1, sinφ2)));
  const λ2 = λ1 + Math.atan2(
    Math.sin(θ) * Math.sin(δ) * Math.cos(φ1),
    Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2)
  );
  return { lat: φ2 * R2D, lon: ((λ2 * R2D + 540) % 360) - 180 };
}

// 点 p 在跑道（阈值点 t + 方位角 brng）上的局部平面投影
// 返回 { station, offset, acrossTrack, alongTrack }
export function locateOnRunway(t, brngDeg, p) {
  const d = havDistance(t, p);
  if (d === 0) return { station: 0, offset: 0, alongTrack: 0, acrossTrack: 0 };
  const brngTP = bearing(t, p) * D2R;
  const θ = brngDeg * D2R;
  const along = d * Math.cos(brngTP - θ);
  const across = d * Math.sin(brngTP - θ);
  return {
    station: round2(along),
    offset: round2(across), // 正=右侧，负=左侧
    alongTrack: round2(along),
    acrossTrack: round2(across),
  };
}

// 跑道坐标反算经纬度
export function runwayToLatLon(t, brngDeg, station, offset = 0) {
  const along = destination(t, brngDeg, station);
  if (!offset) return along;
  // 垂直方向：右侧 = bearing+90
  return destination(along, brngDeg + 90, offset);
}

export const SEVERITY_ORDER = { low: 1, medium: 2, high: 3 };

export function maxSeverity(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (SEVERITY_ORDER[b] ?? 0) > (SEVERITY_ORDER[a] ?? 0) ? b : a;
}

export function round2(n) {
  return Math.round(n * 100) / 100;
}

export function sideLabel(offset) {
  if (Math.abs(offset) < 0.3) return '中线';
  return `${Math.abs(round2(offset))}m ${offset > 0 ? '右' : '左'}`;
}

// 里程格式化：1234.56 -> "K1+234.56"
export function fmtStation(m) {
  if (m == null || Number.isNaN(m)) return '—';
  const sign = m < 0 ? '-' : '';
  const v = Math.abs(m);
  const km = Math.floor(v / 1000);
  return `${sign}K${km}+${(v % 1000).toFixed(2).padStart(6, '0')}`;
}

// 反解析 "K1+234.56" / "1234.5" -> 米
export function parseStation(s) {
  if (typeof s === 'number') return s;
  if (!s) return null;
  const m = String(s).trim().match(/^(-?)\s*K?(\d+)(?:\+(\d+(?:\.\d+)?))?$/);
  if (!m) {
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  const km = Number(m[2]);
  const rest = m[3] !== undefined ? Number(m[3]) : 0;
  const v = km * 1000 + rest;
  return m[1] === '-' ? -v : v;
}
