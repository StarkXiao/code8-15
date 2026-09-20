import { api } from '../api.js';
import { fmtDateTime } from '../ui.js';
import { runwayMap } from '../components/runway-map.js';

export async function Dashboard() {
  const [stats, defects, inspections] = await Promise.all([
    api('/api/stats/overview'),
    api('/api/defects?status=open'),
    api('/api/inspections'),
  ]);
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1>总览</h1>
        <div class="sub">巡查影像按里程定位、自动去重后形成的病害档案库</div>
      </div>
      <a class="btn" href="#/inspections">去上传巡查影像</a>
    </div>

    <div class="grid grid-4">
      <div class="card"><div class="stat-num red">${stats.defectsTotal}</div><div class="stat-label">病害档案（全部）</div></div>
      <div class="card"><div class="stat-num amber">${defects.defects.length}</div><div class="stat-label">未处理病害</div></div>
      <div class="card"><div class="stat-num">${stats.observationsTotal}</div><div class="stat-label">观测记录（去重后）</div></div>
      <div class="card"><div class="stat-num green">${stats.duplicates.exact_dupes + stats.duplicates.near_dupes}</div><div class="stat-label">被去重的影像（精确 ${stats.duplicates.exact_dupes} / 近似 ${stats.duplicates.near_dupes}）</div></div>
    </div>

    <div class="mt grid grid-2">
      ${stats.runways.map((r) => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <a class="link" href="#/runways/${r.id}"><strong>${r.code}</strong></a>
              <span class="muted"> · ${r.name}</span>
            </div>
            <div class="muted">长 ${r.length_m}m</div>
          </div>
          <div data-map="${r.id}"></div>
          <div class="kv mt-sm">
            <dt>未处理</dt><dd>${r.open_count ?? 0}（重度 ${r.high_open ?? 0} / 中度 ${r.medium_open ?? 0}）</dd>
            <dt>已修复</dt><dd>${r.repaired_count ?? 0}</dd>
            <dt>档案总数</dt><dd>${r.total ?? 0}</dd>
          </div>
        </div>`).join('') || '<div class="card empty">还没有跑道，<a class="link" href="#/runways">先登记一条</a></div>'}
    </div>

    <div class="mt grid grid-2">
      <div class="card">
        <h2>未处理病害类型分布</h2>
        ${barList(stats.typeBreakdown)}
      </div>
      <div class="card">
        <h2>最近巡查</h2>
        <table>
          <thead><tr><th>时间</th><th>跑道</th><th>班组</th><th class="num">新图/重复</th></tr></thead>
          <tbody>
            ${inspections.inspections.slice(0, 6).map((i) => `
              <tr>
                <td><a class="link mono" href="#/inspections/${i.id}">${fmtDateTime(i.conducted_at)}</a></td>
                <td>${i.runway_code}</td>
                <td class="muted">${i.team ?? '—'}</td>
                <td class="num">${i.image_count} / ${i.duplicate_count}</td>
              </tr>`).join('') || '<tr><td colspan="4" class="empty">暂无</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>`;

  // 画每条跑道的纵断面
  for (const r of stats.runways) {
    const holder = el.querySelector(`[data-map="${r.id}"]`);
    if (holder) {
      const map = await api(`/api/runways/${r.id}/defect-map`);
      holder.appendChild(runwayMap(map.runway, map.points, { height: 120 }));
    }
  }
  return el;
}

function barList(rows) {
  if (!rows?.length) return '<div class="empty">暂无未处理病害</div>';
  const max = Math.max(...rows.map((r) => r.c));
  return rows.slice(0, 10).map((r) => `
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
      <div style="width:130px" class="muted">${r.name}</div>
      <div style="flex:1;background:var(--panel2);border-radius:4px;height:16px;overflow:hidden">
        <div style="width:${(r.c / max * 100).toFixed(0)}%;height:100%;background:var(--accent2)"></div>
      </div>
      <div class="num mono" style="width:28px;text-align:right">${r.c}</div>
    </div>`).join('');
}
