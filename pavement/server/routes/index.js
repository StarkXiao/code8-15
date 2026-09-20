// 全部 API 路由（单一文件，业务简单集中比过早拆分好维护）
import { all, get, run, tx, parseJson } from '../db.js';
import { DEFECT_TYPES, SEVERITIES, DEFECT_STATUSES,
  typeName, severityName, statusName } from '../catalog.js';
import { ingestImage, HASH_DUP_BITS, SPATIAL_DUP_M, audit } from '../ingest.js';
import { locateOnRunway, parseStation, fmtStation, sideLabel, round2 } from '../geo.js';
import { decodePNG } from '../png.js';
import { pHash } from '../phash.js';
import { parseJpegExif } from '../exif.js';

export function registerRoutes(r) {
  // ---- 元数据 ----
  r.get('/api/meta', () => ({
    types: DEFECT_TYPES, severities: SEVERITIES, statuses: DEFECT_STATUSES,
    thresholds: { hashDupBits: HASH_DUP_BITS, spatialDupM: SPATIAL_DUP_M },
  }));

  // ---- 跑道 ----
  r.get('/api/runways', () => ({
    runways: all('SELECT * FROM runways ORDER BY code').map(runwayOut),
  }));

  r.post('/api/runways', ({ body }) => {
    const b = body ?? {};
    required(b, ['code', 'name', 'thresholdLat', 'thresholdLon', 'bearing', 'lengthM']);
    const code = String(b.code).trim();
    if (get('SELECT id FROM runways WHERE code=?', [code])) {
      throw conflict('RUNWAY_EXISTS', `跑道代号 ${code} 已存在`);
    }
    const now = new Date().toISOString();
    const res = run(
      `INSERT INTO runways (code,name,threshold_lat,threshold_lon,bearing,
        length_m,width_m,station0_label,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [code, String(b.name).trim(), num(b.thresholdLat), num(b.thresholdLon),
       num(b.bearing), num(b.lengthM), num(b.widthM) ?? 45,
       b.station0Label ?? 'K0+000.00', now]);
    audit('runway', res.lastId, 'runway_created', { code });
    return { runway: runwayOut(get('SELECT * FROM runways WHERE id=?', [res.lastId])) };
  });

  r.get('/api/runways/:id', ({ params }) => {
    const rw = mustRunway(params.id);
    return { runway: runwayOut(rw) };
  });

  // 里程 <-> 经纬度换算工具
  r.post('/api/runways/:id/locate', ({ params, body }) => {
    const rw = mustRunway(params.id);
    if (body.lat != null && body.lon != null) {
      const loc = locateOnRunway(
        { lat: rw.threshold_lat, lon: rw.threshold_lon }, rw.bearing,
        { lat: num(body.lat), lon: num(body.lon) });
      return { ...loc, stationLabel: fmtStation(loc.station), side: sideLabel(loc.offset) };
    }
    if (body.station != null) {
      const station = parseStation(body.station);
      if (station == null) throw badRequest('BAD_STATION', '里程格式无法识别');
      return { station, stationLabel: fmtStation(station) };
    }
    throw badRequest('NO_INPUT', '需要 lat/lon 或 station');
  });

  // ---- 巡查任务 ----
  r.get('/api/inspections', ({ query }) => {
    const where = [];
    const params = [];
    if (query.runwayId) { where.push('runway_id=?'); params.push(query.runwayId); }
    const rows = all(
      `SELECT i.*, (SELECT COUNT(*) FROM images im WHERE im.inspection_id=i.id
         AND im.duplicate_of_id IS NULL) AS image_count,
        (SELECT COUNT(*) FROM images im WHERE im.inspection_id=i.id
         AND im.duplicate_of_id IS NOT NULL) AS duplicate_count,
        rw.code AS runway_code
       FROM inspections i JOIN runways rw ON rw.id=i.runway_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY conducted_at DESC, id DESC`, params);
    return { inspections: rows };
  });

  r.post('/api/inspections', ({ body }) => {
    const b = body ?? {};
    required(b, ['runwayId', 'conductedAt']);
    mustRunway(b.runwayId);
    const now = new Date().toISOString();
    const res = run(
      `INSERT INTO inspections (runway_id, conducted_at, team, note, created_at)
       VALUES (?,?,?,?,?)`,
      [num(b.runwayId), new Date(b.conductedAt).toISOString(),
       b.team ?? null, b.note ?? null, now]);
    return { inspection: get('SELECT * FROM inspections WHERE id=?', [res.lastId]) };
  });

  r.get('/api/inspections/:id', ({ params }) => {
    const ins = get(
      `SELECT i.*, rw.code AS runway_code FROM inspections i
       JOIN runways rw ON rw.id=i.runway_id WHERE i.id=?`, [params.id]);
    if (!ins) throw notFound('INSPECTION_NOT_FOUND');
    const images = all(
      `SELECT * FROM images WHERE inspection_id=? ORDER BY id`, [params.id]);
    return { inspection: ins, images: images.map(imageOut) };
  });

  // ---- 影像入库（核心）----
  r.post('/api/inspections/:id/images', async ({ params, fields, files }) => {
    const file = files?.[0];
    if (!file) throw badRequest('NO_FILE', '缺少上传影像');
    if (!/^image\/(png|jpe?g|webp)/.test(file.mime)) {
      throw badRequest('BAD_MIME', `不支持的影像类型: ${file.mime}`);
    }
    const station = fields.station ? parseStation(fields.station) : null;
    if (fields.station && station == null) {
      throw badRequest('BAD_STATION', `里程无法解析: ${fields.station}`);
    }

    // 服务端尽力补全定位与感知哈希（PNG 可解码；JPEG 读 EXIF）
    let lat = fields.lat != null ? num(fields.lat) : null;
    let lon = fields.lon != null ? num(fields.lon) : null;
    let capturedAt = fields.capturedAt || null;
    let serverPhash = fields.phash || null;
    if (file.mime.includes('png')) {
      try {
        const img = decodePNG(file.data);
        serverPhash = pHash(img.rgba, img.width, img.height);
      } catch { /* 解不了就用客户端哈希 */ }
    } else if (file.mime.includes('jpeg') || file.mime.includes('jpg')) {
      const exif = parseJpegExif(file.data);
      if (exif?.gps?.lat != null) { lat = lat ?? exif.gps.lat; lon = lon ?? exif.gps.lon; }
      if (exif?.capturedAt) capturedAt = capturedAt ?? exif.capturedAt;
    }

    const result = ingestImage({
      inspectionId: num(params.id),
      buffer: file.data,
      mime: file.mime,
      originalName: file.filename,
      phash: serverPhash,
      type: fields.type || null,
      severity: fields.severity || null,
      lat, lon,
      station: fields.lat != null ? null : station, // 有 GPS 时以 GPS 为准
      offset: fields.offset != null ? num(fields.offset) : null,
      slabNo: fields.slabNo || null,
      capturedAt,
      detector: fields.detector || (fields.type ? 'manual' : 'auto'),
      confidence: fields.confidence != null ? num(fields.confidence) : null,
    });

    if (result.defectId) result.defect = defectOut(
      get('SELECT * FROM defects WHERE id=?', [result.defectId]));
    return result;
  });

  // ---- 病害档案 ----
  r.get('/api/defects', ({ query }) => {
    const where = [];
    const params = [];
    if (query.runwayId) { where.push('d.runway_id=?'); params.push(num(query.runwayId)); }
    if (query.type) { where.push('d.type=?'); params.push(query.type); }
    if (query.severity) { where.push('d.severity=?'); params.push(query.severity); }
    if (query.status) { where.push('d.status=?'); params.push(query.status); }
    if (query.stationFrom != null) { where.push('d.station_m>=?'); params.push(num(query.stationFrom)); }
    if (query.stationTo != null) { where.push('d.station_m<=?'); params.push(num(query.stationTo)); }
    if (query.q) {
      where.push('(d.code LIKE ? OR d.description LIKE ? OR d.slab_no LIKE ?)');
      const like = `%${query.q}%`;
      params.push(like, like, like);
    }
    const rows = all(
      `SELECT d.*, rw.code AS runway_code, rw.name AS runway_name
       FROM defects d JOIN runways rw ON rw.id=d.runway_id
       ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY d.station_m, d.id`, params);
    return { defects: rows.map(defectOut) };
  });

  r.get('/api/defects/:id', ({ params }) => {
    const d = get(
      `SELECT d.*, rw.code AS runway_code, rw.name AS runway_name,
              rw.threshold_lat, rw.threshold_lon, rw.bearing
       FROM defects d JOIN runways rw ON rw.id=d.runway_id WHERE d.id=?`,
      [params.id]);
    if (!d) throw notFound('DEFECT_NOT_FOUND');
    const observations = all(
      `SELECT o.*, im.filename, im.original_name, im.phash, im.station_m AS img_station,
              im.offset_m AS img_offset, im.captured_at AS img_captured_at,
              ins.conducted_at AS inspection_at, ins.team AS inspection_team
       FROM observations o
       JOIN images im ON im.id=o.image_id
       JOIN inspections ins ON ins.id=o.inspection_id
       WHERE o.defect_id=? ORDER BY o.created_at DESC, o.id DESC`, [params.id]);
    const logs = all(
      'SELECT * FROM audit_logs WHERE entity_type=? AND entity_id=? ORDER BY id DESC LIMIT 50',
      ['defect', params.id]);
    return {
      defect: defectOut(d),
      observations: observations.map((o) => ({
        id: o.id, imageId: o.image_id, inspectionId: o.inspection_id,
        imageUrl: `/images/${o.filename}`, originalName: o.original_name,
        phash: o.phash,
        stationM: o.img_station, offsetM: o.img_offset,
        stationLabel: fmtStation(o.station_m), side: sideLabel(o.offset_m),
        type: o.type ? { code: o.type, name: typeName(o.type) } : null,
        severity: o.severity ? { code: o.severity, name: severityName(o.severity) } : null,
        isNew: !!o.is_new, detector: o.detector, confidence: o.confidence,
        capturedAt: o.img_captured_at,
        inspectionAt: o.inspection_at, inspectionTeam: o.inspection_team,
        createdAt: o.created_at,
      })),
      auditLogs: logs.map((l) => ({ ...l, detail: parseJson(l.detail, {}) })),
    };
  });

  r.patch('/api/defects/:id', ({ params, body }) => {
    const d = mustDefect(params.id);
    const sets = [];
    const vals = [];
    const assign = (col, field, allowed) => {
      if (body[field] !== undefined) {
        if (allowed && !allowed.includes(body[field])) {
          throw badRequest('BAD_VALUE', `${field} 只能取 ${allowed.join('/')}`);
        }
        sets.push(`${col}=?`); vals.push(body[field]);
      }
    };
    assign('type', 'type');
    assign('severity', 'severity', ['low', 'medium', 'high']);
    assign('status', 'status', ['open', 'repaired', 'closed']);
    assign('description', 'description');
    assign('slab_no', 'slabNo');
    if (body.station != null) {
      const st = parseStation(body.station);
      sets.push('station_m=?'); vals.push(round2(st));
    }
    if (body.offset != null) { sets.push('offset_m=?'); vals.push(round2(num(body.offset))); }
    if (!sets.length) throw badRequest('NO_FIELDS', '没有要更新的字段');
    sets.push('updated_at=?'); vals.push(new Date().toISOString());
    vals.push(d.id);
    run(`UPDATE defects SET ${sets.join(', ')} WHERE id=?`, vals);
    audit('defect', d.id, 'defect_updated', body);
    return { defect: defectOut(get('SELECT * FROM defects WHERE id=?', [d.id])) };
  });

  // 人工合并：把另一个档案并入本档案（去重出错的纠正手段）
  r.post('/api/defects/:id/merge', ({ params, body }) => {
    const target = mustDefect(params.id);
    const sourceId = num(body?.sourceDefectId);
    if (!sourceId || sourceId === target.id) {
      throw badRequest('BAD_SOURCE', '需要与自身不同的 sourceDefectId');
    }
    const source = get('SELECT * FROM defects WHERE id=?', [sourceId]);
    if (!source || source.runway_id !== target.runway_id) {
      throw notFound('SOURCE_NOT_FOUND', '被合并档案不存在或不属于同一跑道');
    }
    tx(() => {
      const moved = run(
        'UPDATE observations SET defect_id=? WHERE defect_id=?', [target.id, source.id]);
      run(`UPDATE defects SET
        observation_count=(SELECT COUNT(*) FROM observations WHERE defect_id=?),
        last_seen=(SELECT MAX(created_at) FROM observations WHERE defect_id=?),
        updated_at=? WHERE id=?`,
        [target.id, target.id, new Date().toISOString(), target.id]);
      run('DELETE FROM defects WHERE id=?', [sourceId]);
      audit('defect', target.id, 'defect_merged',
        { sourceId, sourceCode: source.code, moved: moved.changes });
    });
    return { ok: true, defect: defectOut(get('SELECT * FROM defects WHERE id=?', [target.id])) };
  });

  // ---- 统计 ----
  r.get('/api/stats/overview', () => {
    const byRunway = all(
      `SELECT rw.id, rw.code, rw.name, rw.length_m,
        COUNT(d.id) AS total,
        SUM(CASE WHEN d.status='open' THEN 1 ELSE 0 END) AS open_count,
        SUM(CASE WHEN d.status='repaired' THEN 1 ELSE 0 END) AS repaired_count,
        SUM(CASE WHEN d.severity='high' AND d.status='open' THEN 1 ELSE 0 END) AS high_open,
        SUM(CASE WHEN d.severity='medium' AND d.status='open' THEN 1 ELSE 0 END) AS medium_open
       FROM runways rw LEFT JOIN defects d ON d.runway_id=rw.id
       GROUP BY rw.id ORDER BY rw.code`);
    const dupStats = get(
      `SELECT
        SUM(CASE WHEN duplicate_of_id IS NOT NULL THEN 1 ELSE 0 END) AS exact_dupes,
        SUM(CASE WHEN source='reobservation' THEN 1 ELSE 0 END) AS near_dupes,
        COUNT(*) AS images_total
       FROM images`);
    const typeBreakdown = all(
      `SELECT type, COUNT(*) c FROM defects WHERE status='open' GROUP BY type ORDER BY c DESC`);
    return {
      runways: byRunway.map((r) => ({
        ...r,
        typeBreakdown: typeBreakdown,
      })),
      typeBreakdown: typeBreakdown.map((t) => ({ ...t, name: typeName(t.type) })),
      duplicates: dupStats,
      defectsTotal: get('SELECT COUNT(*) c FROM defects').c,
      observationsTotal: get('SELECT COUNT(*) c FROM observations').c,
    };
  });

  // 跑道纵断面：按里程返回病害点（画跑道示意图用）
  r.get('/api/runways/:id/defect-map', ({ params }) => {
    const rw = mustRunway(params.id);
    const defects = all(
      'SELECT * FROM defects WHERE runway_id=? ORDER BY station_m', [rw.id]);
    return {
      runway: runwayOut(rw),
      points: defects.map((d) => ({
        id: d.id, code: d.code, type: d.type, typeName: typeName(d.type),
        severity: d.severity, status: d.status,
        stationM: d.station_m, offsetM: d.offset_m,
        stationLabel: fmtStation(d.station_m),
      })),
    };
  });

  r.get('/api/audit-logs', ({ query }) => {
    const limit = Math.min(num(query.limit) ?? 100, 500);
    const rows = all(
      'SELECT * FROM audit_logs ORDER BY id DESC LIMIT ?', [limit]);
    return { logs: rows.map((l) => ({ ...l, detail: parseJson(l.detail, {}) })) };
  });
}

// ---- 输出整形 ----
function runwayOut(r) {
  return {
    id: r.id, code: r.code, name: r.name,
    threshold: { lat: r.threshold_lat, lon: r.threshold_lon },
    bearing: r.bearing, lengthM: r.length_m, widthM: r.width_m,
    station0Label: r.station0_label, createdAt: r.created_at,
  };
}

function imageOut(i) {
  return {
    id: i.id, inspectionId: i.inspection_id,
    url: `/images/${i.filename}`, filename: i.filename, originalName: i.original_name,
    mime: i.mime, sizeBytes: i.size_bytes, sha256: i.sha256, phash: i.phash,
    stationM: i.station_m, offsetM: i.offset_m,
    stationLabel: fmtStation(i.station_m), side: sideLabel(i.offset_m),
    lat: i.lat, lon: i.lon,
    capturedAt: i.captured_at, source: i.source,
    duplicateOfId: i.duplicate_of_id, ingestNote: i.ingest_note,
    createdAt: i.created_at,
  };
}

function defectOut(d) {
  if (!d) return null;
  return {
    id: d.id, code: d.code,
    runwayId: d.runway_id,
    runwayCode: d.runway_code ?? null, runwayName: d.runway_name ?? null,
    type: { code: d.type, name: typeName(d.type) },
    severity: { code: d.severity, name: severityName(d.severity) },
    status: { code: d.status, name: statusName(d.status) },
    stationM: d.station_m, offsetM: d.offset_m,
    stationLabel: fmtStation(d.station_m), side: sideLabel(d.offset_m),
    lat: d.lat, lon: d.lon, slabNo: d.slab_no,
    description: d.description,
    firstSeen: d.first_seen, lastSeen: d.last_seen,
    observationCount: d.observation_count,
    createdAt: d.created_at, updatedAt: d.updated_at,
  };
}

// ---- 小工具 ----
function required(b, fields) {
  for (const f of fields) {
    if (b[f] === undefined || b[f] === null || b[f] === '') {
      throw badRequest('MISSING_FIELD', `缺少必填字段: ${f}`);
    }
  }
}
function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
function mustRunway(id) {
  const r = get('SELECT * FROM runways WHERE id=?', [num(id)]);
  if (!r) throw notFound('RUNWAY_NOT_FOUND');
  return r;
}
function mustDefect(id) {
  const d = get('SELECT * FROM defects WHERE id=?', [num(id)]);
  if (!d) throw notFound('DEFECT_NOT_FOUND');
  return d;
}
function notFound(code, detail) {
  const e = new Error(code); e.status = 404; e.code = code; e.detail = detail; return e;
}
function badRequest(code, detail) {
  const e = new Error(code); e.status = 400; e.code = code; e.detail = detail; return e;
}
function conflict(code, detail) {
  const e = new Error(code); e.status = 409; e.code = code; e.detail = detail; return e;
}
