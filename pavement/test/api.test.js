// API 冒烟测试：真实 HTTP 起服（临时库 + 临时端口），走一遍主流程
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';

// 独立临时库/端口，避免与其他测试文件并行运行时串数据
const tmp = mkdtempSync(join(tmpdir(), `pavement-test-api-${process.pid}-`));
process.env.PAVEMENT_DATA = tmp;
process.env.PORT = String(4400 + (process.pid % 200));

const { server } = await import('../server/index.js');
await once(server, 'listening');
const base = `http://localhost:${process.env.PORT}`;

after(() => server.close());

const j = async (path, opts) => {
  const res = await fetch(base + path, {
    headers: opts?.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json();
  return { status: res.status, data };
};

test('GET /api/meta 返回字典与去重阈值', async () => {
  const { status, data } = await j('/api/meta');
  assert.equal(status, 200);
  assert.ok(data.types.length >= 10);
  assert.equal(data.thresholds.hashDupBits, 10);
});

test('跑道：创建 -> 重复代号 409 -> 列表可见', async () => {
  const r = await j('/api/runways', {
    method: 'POST',
    body: { code: '09L', name: '测试西跑道',
      thresholdLat: 31.19, thresholdLon: 121.83, bearing: 336, lengthM: 3400 },
  });
  assert.equal(r.status, 200);
  const dup = await j('/api/runways', {
    method: 'POST',
    body: { code: '09L', name: 'x', thresholdLat: 1, thresholdLon: 2, bearing: 1, lengthM: 1 },
  });
  assert.equal(dup.status, 409);
  const list = await j('/api/runways');
  assert.ok(list.data.runways.some((x) => x.code === '09L'));
});

test('GPS->里程换算', async () => {
  const { runways } = (await j('/api/runways')).data;
  const rw = runways[0];
  const r = await j(`/api/runways/${rw.id}/locate`, {
    method: 'POST', body: { ...rw.threshold }, // 阈值点本身
  });
  assert.equal(r.status, 200);
  assert.ok(Math.abs(r.data.station) < 0.01);
});

test('巡查任务 + 缺陷检索 + 统计端到端', async () => {
  const { runways } = (await j('/api/runways')).data;
  const rw = runways[0];
  const ins = await j('/api/inspections', {
    method: 'POST',
    body: { runwayId: rw.id, conductedAt: '2026-09-20T08:00:00Z', team: '测试班' },
  });
  assert.equal(ins.status, 200);
  const insId = ins.data.inspection.id;

  // 造一张 PNG 并走 multipart 上传
  const { encodePNG } = await import('../server/png.js');
  const { pHash } = await import('../server/phash.js');
  const { runwayToLatLon } = await import('../server/geo.js');
  const S = 128;
  const px = new Uint8ClampedArray(S * S * 4).fill(120);
  for (let y = 40; y < 90; y++) for (let x = 30; x < 100; x++) {
    const i = (y * S + x) * 4; px[i] = px[i + 1] = px[i + 2] = 20;
  }
  const pngBuf = encodePNG(px, S, S);
  const hash = pHash(px, S, S);
  const ll = runwayToLatLon(
    { lat: rw.threshold.lat, lon: rw.threshold.lon }, rw.bearing, 800, 2);

  const fd = new FormData();
  fd.set('file', new Blob([pngBuf], { type: 'image/png' }), 'pothole-test.png');
  fd.set('type', 'pothole');
  fd.set('severity', 'high');
  fd.set('lat', String(ll.lat));
  fd.set('lon', String(ll.lon));
  fd.set('phash', hash);
  const up = await fetch(`${base}/api/inspections/${insId}/images`, { method: 'POST', body: fd });
  const upData = await up.json();
  assert.equal(up.status, 200);
  assert.equal(upData.decision, 'new_defect');
  assert.ok(upData.defect.code.startsWith(rw.code));

  // 同字节再传一次 => exact
  const fd2 = new FormData();
  fd2.set('file', new Blob([pngBuf], { type: 'image/png' }), 'copy.png');
  fd2.set('lat', String(ll.lat)); fd2.set('lon', String(ll.lon)); fd2.set('phash', hash);
  const up2 = await (await fetch(`${base}/api/inspections/${insId}/images`,
    { method: 'POST', body: fd2 })).json();
  assert.equal(up2.decision, 'exact_duplicate');

  // 检索
  const search = await j(`/api/defects?runwayId=${rw.id}&type=pothole&severity=high`);
  assert.equal(search.data.defects.length, 1);
  assert.equal(search.data.defects[0].type.code, 'pothole');

  // 详情含观测
  const detail = await j(`/api/defects/${upData.defect.id}`);
  assert.equal(detail.data.observations.length, 1);
  assert.ok(detail.data.auditLogs.some((l) => l.action === 'defect_created'));

  // 改状态为已修复
  const patch = await j(`/api/defects/${upData.defect.id}`, {
    method: 'PATCH', body: { status: 'repaired' },
  });
  assert.equal(patch.data.defect.status.code, 'repaired');

  // 非法枚举 400
  const bad = await j(`/api/defects/${upData.defect.id}`, {
    method: 'PATCH', body: { severity: 'catastrophic' },
  });
  assert.equal(bad.status, 400);

  // 统计
  const stats = await j('/api/stats/overview');
  assert.equal(stats.status, 200);
  assert.ok(stats.data.defectsTotal >= 1);
  assert.ok(stats.data.duplicates.exact_dupes >= 1);

  // 不存在的资源 404
  assert.equal((await j('/api/defects/99999')).status, 404);
});

test('静态资源：首页与 SPA 回退', async () => {
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /道面病害编目/);
  const fallback = await fetch(base + '/defects/123');
  assert.equal(fallback.status, 200);
});
