import { api, qs } from '../api.js';
import { toast, esc, fmtStation, fmtDate, fmtDateTime, sideLabel, lightbox } from '../ui.js';

export async function DefectsPage() {
  const [{ types, severities }, { runways }] = await Promise.all([
    api('/api/meta'), api('/api/runways'),
  ]);
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const filters = {
    runwayId: params.get('runwayId') || '',
    type: params.get('type') || '',
    severity: params.get('severity') || '',
    status: params.get('status') || 'open',
    q: params.get('q') || '',
  };

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>病害档案库</h1>
        <div class="sub">同一处病害的历次巡查影像归在同一档案下；里程、类型、状态可检索</div>
      </div>
    </div>
    <div class="card">
      <div class="filters">
        <div class="field"><label>跑道</label>
          <select id="f-runway"><option value="">全部</option>
            ${runways.map((r) => `<option value="${r.id}" ${sel(filters.runwayId, r.id)}>${r.code}</option>`).join('')}
          </select></div>
        <div class="field"><label>类型</label>
          <select id="f-type"><option value="">全部</option>
            ${types.map((t) => `<option value="${t.code}" ${sel(filters.type, t.code)}>${t.name}</option>`).join('')}
          </select></div>
        <div class="field"><label>严重程度</label>
          <select id="f-sev"><option value="">全部</option>
            ${severities.map((s) => `<option value="${s.code}" ${sel(filters.severity, s.code)}>${s.name}</option>`).join('')}
          </select></div>
        <div class="field"><label>状态</label>
          <select id="f-status">
            <option value="">全部</option>
            <option value="open" ${sel(filters.status, 'open')}>未处理</option>
            <option value="repaired" ${sel(filters.status, 'repaired')}>已修复</option>
            <option value="closed" ${sel(filters.status, 'closed')}>已关闭</option>
          </select></div>
        <div class="field" style="min-width:200px"><label>关键字（编号 / 板号 / 描述）</label>
          <input id="f-q" value="${esc(filters.q)}" placeholder="如 18R-2026 或 B-12"></div>
        <button class="ghost" id="f-reset">重置</button>
      </div>
      <div id="list"></div>
    </div>`;

  async function loadList() {
    const fv = (id) => el.querySelector(id).value;
    const query = {
      runwayId: fv('#f-runway'), type: fv('#f-type'),
      severity: fv('#f-sev'), status: fv('#f-status'), q: fv('#f-q'),
    };
    const { defects } = await api(`/api/defects${qs(query)}`);
    const holder = el.querySelector('#list');
    holder.innerHTML = `
      <div class="sub mb-sm">共 ${defects.length} 条档案</div>
      <table>
        <thead><tr>
          <th>档案编号</th><th>跑道</th><th>里程</th><th>横距</th><th>类型</th>
          <th>严重</th><th>状态</th><th class="num">观测次数</th><th>首次发现</th><th>最近发现</th>
        </tr></thead>
        <tbody>
          ${defects.map((d) => `
            <tr>
              <td><a class="link mono" href="#/defects/${d.id}">${d.code}</a></td>
              <td>${d.runwayCode ?? '—'}</td>
              <td class="mono">${d.stationLabel}</td>
              <td>${d.side}</td>
              <td>${d.type.name}</td>
              <td><span class="badge sev-${d.severity.code}">${d.severity.name}</span></td>
              <td><span class="badge status-${d.status.code}">${d.status.name}</span></td>
              <td class="num">${d.observationCount}</td>
              <td class="muted">${fmtDate(d.firstSeen)}</td>
              <td class="muted">${fmtDate(d.lastSeen)}</td>
            </tr>`).join('') || '<tr><td colspan="10" class="empty">没有匹配的档案</td></tr>'}
        </tbody>
      </table>`;
  }

  ['#f-runway', '#f-type', '#f-sev', '#f-status'].forEach((id) =>
    el.querySelector(id).onchange = loadList);
  let timer;
  el.querySelector('#f-q').oninput = () => { clearTimeout(timer); timer = setTimeout(loadList, 300); };
  el.querySelector('#f-reset').onclick = () => {
    location.hash = '#/defects';
    loadList();
  };
  await loadList();
  return el;
}

const sel = (a, b) => String(a) === String(b) ? 'selected' : '';

export async function DefectDetail(id) {
  const data = await api(`/api/defects/${id}`);
  const [{ types }] = await api('/api/meta');
  const d = data.defect;
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="page-head">
      <div>
        <h1 class="mono">${d.code}</h1>
        <div class="sub"><a class="link" href="#/defects">病害档案库</a> / ${d.code}
          · ${d.runwayCode} ${d.runwayName}</div>
      </div>
      <div style="display:flex;gap:8px">
        <button class="ghost" id="btn-edit">编辑档案</button>
        <button class="ghost" id="btn-merge">合并其他档案</button>
      </div>
    </div>

    <div class="grid grid-3">
      <div class="card"><div class="stat-num">${d.observationCount}</div><div class="stat-label">观测次数（跨多次巡查）</div></div>
      <div class="card"><div class="stat-num">${d.stationLabel}</div><div class="stat-label">里程 · ${d.side}</div></div>
      <div class="card">
        <div><span class="badge sev-${d.severity.code}">${d.severity.name}</span>
          <span class="badge status-${d.status.code}">${d.status.name}</span></div>
        <div class="stat-label mt-sm">${d.type.name}${d.slabNo ? ' · 板号 ' + esc(d.slabNo) : ''}</div>
      </div>
    </div>

    <div class="mt grid grid-2">
      <div class="card">
        <h2>定位信息</h2>
        <dl class="kv">
          <dt>里程</dt><dd class="mono">${d.stationLabel}（${d.stationM} m）</dd>
          <dt>横距</dt><dd>${d.side}（${d.offsetM} m，面向跑道方向）</dd>
          <dt>经纬度</dt><dd class="mono">${d.lat?.toFixed(6) ?? '—'}, ${d.lon?.toFixed(6) ?? '—'}</dd>
          <dt>板号</dt><dd>${esc(d.slabNo ?? '—')}</dd>
          <dt>描述</dt><dd>${esc(d.description ?? '—')}</dd>
          <dt>首次发现</dt><dd>${fmtDateTime(d.firstSeen)}</dd>
          <dt>最近发现</dt><dd>${fmtDateTime(d.lastSeen)}</dd>
        </dl>
      </div>
      <div class="card">
        <h2>观测时间线（${data.observations.length}）</h2>
        <div class="timeline">
          ${data.observations.map((o) => `
            <div class="obs-item ${o.isNew ? 'new' : ''}">
              <div class="obs-grid">
                <img class="obs-thumb" data-img="${o.imageUrl}" src="${o.imageUrl}" alt="">
                <div>
                  <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                    ${o.isNew ? '<span class="tag new">首次建档</span>' : '<span class="tag dup">重复观测</span>'}
                    ${o.type ? `<strong>${o.type.name}</strong>` : ''}
                    ${o.severity ? `<span class="badge sev-${o.severity.code}">${o.severity.name}</span>` : ''}
                    <span class="tag">${o.detector === 'manual' ? '人工标注' : o.detector === 'seed' ? '种子数据' : '自动初判'}</span>
                  </div>
                  <div class="sub mt-sm mono">${o.stationLabel} · ${o.side}</div>
                  <div class="sub mt-sm">${fmtDateTime(o.inspectionAt)} 巡查${o.inspectionTeam ? ' · ' + esc(o.inspectionTeam) : ''}</div>
                  <div class="sub mt-sm" style="word-break:break-all">原图：${esc(o.originalName)}</div>
                </div>
              </div>
            </div>`).join('')}
        </div>
      </div>
    </div>

    <div class="card mt">
      <h2>档案变更记录</h2>
      <table>
        <thead><tr><th>时间</th><th>动作</th><th>详情</th></tr></thead>
        <tbody>
          ${data.auditLogs.map((l) => `
            <tr><td class="muted">${fmtDateTime(l.created_at)}</td>
              <td class="mono">${l.action}</td>
              <td class="mono muted" style="word-break:break-all">${esc(JSON.stringify(l.detail))}</td>
            </tr>`).join('') || '<tr><td colspan="3" class="empty">无</td></tr>'}
        </tbody>
      </table>
    </div>`;

  el.querySelectorAll('.obs-thumb').forEach((img) => {
    img.onclick = () => lightbox(img.dataset.img);
  });
  el.querySelector('#btn-edit').onclick = () => editModal(d, types);
  el.querySelector('#btn-merge').onclick = () => mergeModal(d);
  return el;
}

function editModal(d, types) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">
    <h3>编辑档案 <span class="mono muted">${d.code}</span></h3>
    <div class="form-row">
      <div class="field"><label>类型</label><select id="e-type">
        ${types.map((t) => `<option value="${t.code}" ${d.type.code === t.code ? 'selected' : ''}>${t.name}</option>`).join('')}
      </select></div>
      <div class="field"><label>严重程度</label><select id="e-sev">
        ${['low', 'medium', 'high'].map((s) => `<option value="${s}" ${d.severity.code === s ? 'selected' : ''}>${({low:'轻度',medium:'中度',high:'重度'})[s]}</option>`).join('')}
      </select></div>
    </div>
    <div class="form-row">
      <div class="field"><label>状态</label><select id="e-status">
        ${['open', 'repaired', 'closed'].map((s) => `<option value="${s}" ${d.status.code === s ? 'selected' : ''}>${({open:'未处理',repaired:'已修复',closed:'已关闭'})[s]}</option>`).join('')}
      </select></div>
      <div class="field"><label>板号</label><input id="e-slab" value="${esc(d.slabNo ?? '')}"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>里程（K1+234.56 或米数）</label><input id="e-station" value="${d.stationM}"></div>
      <div class="field"><label>横距（m，右正左负）</label><input id="e-offset" type="number" step="0.1" value="${d.offsetM}"></div>
    </div>
    <div class="field"><label>描述</label><textarea id="e-desc" rows="2">${esc(d.description ?? '')}</textarea></div>
    <div class="right"><button class="ghost" id="e-cancel">取消</button> <button id="e-save">保存</button></div>
  </div>`;
  mask.onclick = () => mask.remove();
  document.body.appendChild(mask);
  mask.querySelector('#e-cancel').onclick = () => mask.remove();
  mask.querySelector('#e-save').onclick = async () => {
    const v = (s) => mask.querySelector(s).value;
    try {
      await api(`/api/defects/${d.id}`, {
        method: 'PATCH',
        body: {
          type: v('#e-type'), severity: v('#e-sev'), status: v('#e-status'),
          slabNo: v('#e-slab'), station: v('#e-station'),
          offset: +v('#e-offset'), description: v('#e-desc'),
        },
      });
      toast('已保存', 'ok');
      mask.remove();
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) { toast(e.message, 'err'); }
  };
}

async function mergeModal(d) {
  const { defects } = await api(`/api/defects?runwayId=${d.runwayId}`);
  const others = defects.filter((x) => x.id !== d.id);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">
    <h3>合并档案到 ${d.code}</h3>
    <div class="sub mb">当自动去重把同一处病害拆成了两条档案时使用。被选中档案的全部观测并入当前档案，其档案删除，操作记入审计。</div>
    <div class="field"><label>选择被合并的档案</label><select id="m-src">
      ${others.map((o) => `<option value="${o.id}">${o.code} · ${o.type.name} · ${o.stationLabel} · ${o.status.name}（${o.observationCount} 次观测）</option>`).join('')}
    </select></div>
    ${others.length ? '' : '<div class="empty">同跑道没有其他档案</div>'}
    <div class="right"><button class="ghost" id="m-cancel">取消</button>
      <button class="danger" id="m-ok" ${others.length ? '' : 'disabled'}>确认合并</button></div>
  </div>`;
  mask.onclick = () => mask.remove();
  document.body.appendChild(mask);
  mask.querySelector('#m-cancel').onclick = () => mask.remove();
  mask.querySelector('#m-ok')?.addEventListener('click', async () => {
    try {
      await api(`/api/defects/${d.id}/merge`, {
        method: 'POST',
        body: { sourceDefectId: +mask.querySelector('#m-src').value },
      });
      toast('合并完成', 'ok');
      mask.remove();
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } catch (e) { toast(e.message, 'err'); }
  });
}
