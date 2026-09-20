// 入库核心：定位 -> 字节级去重 -> 感知去重 -> 病害档案匹配（新增/复发）
// 三级判定：
//   1) SHA-256 完全相同            => exact（同一张图，不产生新观测）
//   2) pHash 汉明距离 ≤ HASH_DUP 且位置 ≤ SPATIAL_DUP_M => near
//      （同一病害的重拍：产生一条新观测，挂到既有档案，不建新档案）
//   3) 里程 ≤ ARCHIVE_MATCH_M 且类型相同 => 复发，并入既有档案
//   其余 => 新病害，建档并分配编号
import crypto from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { all, get, run, tx, json, IMG_DIR } from './db.js';
import { hamming } from './phash.js';
import { locateOnRunway, runwayToLatLon, maxSeverity, round2 } from './geo.js';
import { typeName } from './catalog.js';

export const HASH_DUP_BITS = 10;        // 感知哈希近重复阈值（64bit）
export const SPATIAL_DUP_M = 3;         // 近重复要求的空间半径
export const ARCHIVE_MATCH_M = 2.5;     // 档案匹配里程阈值
const OPEN_STATUSES = ['open', 'repaired']; // repaired 档案上再次发现 = 复发

export function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// 对一张图给出入库结论。input:
// { inspectionId, buffer, mime, originalName, phash?, type?, severity?,
//   lat?, lon?, station?(米/里程串), offset?, slabNo?, capturedAt?, confidence?, detector? }
export function ingestImage(input) {
  const inspection = get('SELECT * FROM inspections WHERE id=?', [input.inspectionId]);
  if (!inspection) throw badRequest('INSPECTION_NOT_FOUND', '巡查任务不存在');
  const runway = get('SELECT * FROM runways WHERE id=?', [inspection.runway_id]);

  const now = new Date().toISOString();
  const hash = sha256(input.buffer);

  // 1) 字节级去重：
  //    - 本巡查任务内已出现过同一文件 => 纯重复，只登记、不产生观测
  //    - 仅在其他任务出现过 => 跨巡查重复观测（相机缓存/拷贝复用），挂到既有档案
  const original = get(
    'SELECT * FROM images WHERE sha256=? ORDER BY id ASC LIMIT 1', [hash]);
  if (original) {
    const sameTask = get(
      'SELECT id FROM images WHERE sha256=? AND inspection_id=? LIMIT 1',
      [hash, inspection.id]);
    const dupOfId = sameTask?.id ?? original.id;
    const saved = run(
      `INSERT INTO images (inspection_id, runway_id, filename, original_name, mime,
        size_bytes, sha256, phash, station_m, offset_m, lat, lon, captured_at,
        source, duplicate_of_id, ingest_note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [inspection.id, runway.id, original.filename, input.originalName, input.mime,
       input.buffer.length, hash, original.phash, original.station_m, original.offset_m,
       original.lat, original.lon, input.capturedAt ?? inspection.conducted_at,
       'duplicate', dupOfId,
       sameTask
         ? '字节完全相同（SHA-256 一致），同任务重传，未生成新观测'
         : '字节完全相同（SHA-256 一致），跨巡查重复观测', now]);

    if (!sameTask) {
      const link = get('SELECT defect_id FROM observations WHERE image_id=?',
        [original.id]);
      if (link) {
        addObservation({
          defectId: link.defect_id, imageId: saved.lastId,
          inspectionId: inspection.id,
          type: input.type, severity: input.severity,
          station: original.station_m, offset: original.offset_m, isNew: false,
          confidence: input.confidence,
          detector: input.detector ?? 'manual', now });
        return {
          decision: 'recurrence', imageId: saved.lastId,
          duplicateOf: original.id, defectId: link.defect_id,
          match: { dist: 0, reason: '字节相同（跨巡查同一文件）' },
        };
      }
    }
    return {
      decision: 'exact_duplicate', imageId: saved.lastId, duplicateOf: dupOfId,
    };
  }

  // 2) 定位：优先 GPS 投影到跑道里程；没有 GPS 用手填里程
  let station = toNum(input.station);
  let offset = toNum(input.offset) ?? 0;
  let lat = toNum(input.lat);
  let lon = toNum(input.lon);
  if (lat != null && lon != null) {
    const loc = locateOnRunway(
      { lat: runway.threshold_lat, lon: runway.threshold_lon },
      runway.bearing, { lat, lon });
    station = loc.station;
    offset = loc.offset;
  }
  if (station == null) {
    throw badRequest('NO_POSITION', '无法定位：需要 GPS，或手工填写里程');
  }
  if (station < -5 || station > runway.length_m + 5) {
    throw badRequest('OFF_RUNWAY',
      `里程 ${station}m 超出跑道长度 ${runway.length_m}m（容差 5m）`);
  }

  // 保存原图（证据不可变：以内容哈希命名）
  const ext = extFromMime(input.mime, input.originalName);
  const filename = `${hash.slice(0, 16)}${ext}`;
  writeFileSync(join(IMG_DIR, filename), input.buffer);

  const phash = input.phash ?? null;

  return tx(() => {
    // 3) 感知近重复（同跑道、位置邻近）
    const candidates = all(
      `SELECT i.*, o.defect_id FROM images i
       LEFT JOIN observations o ON o.image_id = i.id
       WHERE i.runway_id=? AND i.phash IS NOT NULL AND i.duplicate_of_id IS NULL
       ORDER BY i.id DESC`, [runway.id]);
    let near = null;
    if (phash) {
      for (const c of candidates) {
        if (c.station_m == null) continue;
        const dist = Math.hypot(c.station_m - station, (c.offset_m ?? 0) - offset);
        if (dist <= SPATIAL_DUP_M && hamming(c.phash, phash) <= HASH_DUP_BITS) {
          near = { image: c, dist: round2(dist), bits: hamming(c.phash, phash) };
          break;
        }
      }
    }

    const imgRes = run(
      `INSERT INTO images (inspection_id, runway_id, filename, original_name, mime,
        size_bytes, sha256, phash, station_m, offset_m, lat, lon,
        captured_at, source, duplicate_of_id, ingest_note, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [inspection.id, runway.id, filename, input.originalName, input.mime,
       input.buffer.length, hash, phash, round2(station), round2(offset),
       lat, lon, input.capturedAt ?? inspection.conducted_at,
       near ? 'reobservation' : 'upload',
       near?.image.id ?? null,
       near ? `感知去重：与 #${near.image.id} 汉明距离 ${near.bits}、相距 ${near.dist}m`
            : null,
       now]);
    const imageId = imgRes.lastId;

    const result = { decision: 'new_image', imageId, near };

    // 近重复且原图挂在档案上 -> 只补一条观测，不做档案匹配
    if (near?.image.defect_id) {
      const defectId = near.image.defect_id;
      addObservation({
        defectId, imageId, inspectionId: inspection.id,
        type: input.type, severity: input.severity,
        station, offset, isNew: false,
        confidence: input.confidence, detector: input.detector ?? 'manual', now });
      result.decision = 'near_duplicate';
      result.defectId = defectId;
      return result;
    }

    // 4) 按里程匹配既有档案（同类型、里程阈值内、未关闭/可复发）
    const match = findArchiveMatch({
      runwayId: runway.id, station, offset, type: input.type ?? null, phash });

    if (match) {
      addObservation({
        defectId: match.defect.id, imageId, inspectionId: inspection.id,
        type: input.type ?? match.defect.type,
        severity: input.severity ?? match.defect.severity,
        station, offset, isNew: false,
        confidence: input.confidence,
        detector: input.detector ?? (input.type ? 'manual' : 'auto'), now });
      result.decision = 'recurrence';
      result.defectId = match.defect.id;
      result.match = { dist: match.dist, reason: match.reason };
      return result;
    }

    // 5) 新病害建档
    const defectId = createDefect({
      runway, station, offset, lat, lon,
      type: input.type ?? 'other',
      severity: input.severity ?? 'low',
      slabNo: input.slabNo ?? null,
      capturedAt: input.capturedAt ?? inspection.conducted_at,
      now,
    });
    addObservation({
      defectId, imageId, inspectionId: inspection.id,
      type: input.type ?? 'other', severity: input.severity ?? 'low',
      station, offset, isNew: true,
      confidence: input.confidence,
      detector: input.detector ?? (input.type ? 'manual' : 'auto'), now });
    result.decision = 'new_defect';
    result.defectId = defectId;
    return result;
  });
}

function findArchiveMatch({ runwayId, station, offset, type, phash }) {
  const defects = all(
    `SELECT * FROM defects WHERE runway_id=? AND status IN ('open','repaired')`,
    [runwayId]);
  let best = null;
  for (const d of defects) {
    const dist = Math.hypot(d.station_m - station, (d.offset_m ?? 0) - (offset ?? 0));
    if (dist > ARCHIVE_MATCH_M) continue;
    if (type && d.type !== type) continue;
    // 无类型信息时，需要哈希相似佐证，避免把相邻不同病害并掉
    if (!type) {
      const similar = closestHash(d.id, phash);
      if (!similar || similar.bits > HASH_DUP_BITS) continue;
    }
    if (!best || dist < best.dist) {
      best = { defect: d, dist: round2(dist), reason: type ? '同类型+里程邻近' : '里程邻近+图像相似' };
    }
  }
  return best;
}

function closestHash(defectId, phash) {
  if (!phash) return null;
  const imgs = all(
    `SELECT i.phash FROM observations o JOIN images i ON i.id=o.image_id
     WHERE o.defect_id=? AND i.phash IS NOT NULL`, [defectId]);
  let best = null;
  for (const i of imgs) {
    const bits = hamming(i.phash, phash);
    if (!best || bits < best.bits) best = { bits };
  }
  return best;
}

function addObservation({ defectId, imageId, inspectionId, type, severity,
  station, offset, isNew, confidence, detector, now }) {
  run(
    `INSERT INTO observations (defect_id, image_id, inspection_id, type, severity,
      station_m, offset_m, is_new, detector, confidence, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(defect_id, image_id) DO NOTHING`,
    [defectId, imageId, inspectionId, type ?? null, severity ?? null,
     round2(station), round2(offset), isNew ? 1 : 0, detector, confidence ?? null, now]);
  // 档案汇总刷新
  const d = get('SELECT * FROM defects WHERE id=?', [defectId]);
  const obs = all(
    `SELECT * FROM observations WHERE defect_id=? ORDER BY created_at`, [defectId]);
  const sev = obs.map((o) => o.severity).filter(Boolean)
    .reduce((a, b) => maxSeverity(a, b), d.severity);
  const stations = obs.map((o) => o.station_m).filter((x) => x != null);
  const offsets = obs.map((o) => o.offset_m).filter((x) => x != null);
  const stAvg = avg(stations), offAvg = avg(offsets);
  const distinctInsp = new Set(obs.map((o) => o.inspection_id));
  const lastSeen = obs[obs.length - 1]?.created_at ?? d.last_seen;
  let status = d.status;
  if (d.status === 'repaired') status = 'open'; // 修复点再开裂 -> 复发
  run(
    `UPDATE defects SET severity=?, status=?, station_m=?, offset_m=?,
      last_seen=?, observation_count=?, updated_at=? WHERE id=?`,
    [sev, status, round2(stAvg ?? d.station_m), round2(offAvg ?? d.offset_m),
     lastSeen, obs.length, now, defectId]);
  audit('defect', defectId,
    isNew ? 'defect_created' : 'observation_added',
    { imageId, inspectionId, type, severity, detector });
}

function createDefect({ runway, station, offset, lat, lon, type, severity,
  slabNo, capturedAt, now }) {
  const code = nextDefectCode(runway.code, now);
  const ll = (lat != null && lon != null)
    ? { lat, lon }
    : runwayToLatLon(
      { lat: runway.threshold_lat, lon: runway.threshold_lon },
      runway.bearing, station, offset);
  const res = run(
    `INSERT INTO defects (code, runway_id, type, severity, status, station_m,
      offset_m, lat, lon, slab_no, description, first_seen, last_seen,
      observation_count, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [code, runway.id, type, severity, 'open', round2(station), round2(offset ?? 0),
     round2(ll.lat * 1e7) / 1e7, round2(ll.lon * 1e7) / 1e7, slabNo,
     `${runway.code} ${typeName(type)}`, capturedAt, capturedAt, 0, now, now]);
  const id = res.lastId;
  audit('defect', id, 'defect_created', { code, type, station });
  return id;
}

export function nextDefectCode(runwayCode, nowIso) {
  const year = new Date(nowIso).getFullYear();
  const prefix = `${runwayCode}-${year}-`;
  const row = get(
    `SELECT code FROM defects WHERE code LIKE ? ORDER BY code DESC LIMIT 1`,
    [`${prefix}%`]);
  let seq = 1;
  if (row) {
    const m = /-(\d+)$/.exec(row.code);
    if (m) seq = Number(m[1]) + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

export function audit(entityType, entityId, action, detail) {
  run(
    `INSERT INTO audit_logs (entity_type, entity_id, action, detail, created_at)
     VALUES (?,?,?,?,?)`,
    [entityType, entityId, action, json(detail ?? {}), new Date().toISOString()]);
}

function avg(xs) {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}
function toNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function extFromMime(mime, name) {
  if (mime.includes('png')) return '.png';
  if (mime.includes('webp')) return '.webp';
  const m = /\.(jpe?g|png|webp)$/i.exec(name || '');
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}
function badRequest(code, detail) {
  const e = new Error(code);
  e.status = 400; e.code = code; e.detail = detail;
  return e;
}
