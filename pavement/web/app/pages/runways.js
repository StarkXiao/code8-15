import { api } from '../api.js';
import { toast, fmtStation, sideLabel } from '../ui.js';
import { runwayMap } from '../components/runway-map.js';

export async function RunwaysPage() {
  const { runways } = await api('/api/runways');
  const { defects } = await api('/api/defects');
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>跑道与定位</h1>
        <div class="sub">每条跑道登记阈值点坐标与方位角；影像 GPS 投影到跑道坐标系，得到精确里程与横距</div>
      </div>
      <button id="add">+ 登记跑道</button>
    </div>
    <div class="grid">
      ${runways.map((r) => {
        const ds = defects.filter((d) => d.runwayId === r.id);
        return `
        <div class="card">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <div>
              <a class="link" href="#/runways/${r.id}" style="font-size:16px;font-weight:600">${r.code}</a>
              <span class="muted"> · ${r.name}</span>
            </div>
            <span class="tag">${ds.length} 条档案</span>
          </div>
          <dl class="kv mt-sm">
            <dt>阈值点</dt><dd class="mono">${r.threshold.lat.toFixed(6)}, ${r.threshold.lon.toFixed(6)}</dd>
            <dt>方位角</dt><dd>${r.bearing}°</dd>
            <dt>长度/宽度</dt><dd>${r.lengthM} m / ${r.widthM} m（${fmtStation(r.lengthM)}）</dd>
            <dt>里程范围</dt><dd>${r.station0Label} → ${fmtStation(r.lengthM)}</dd>
          </dl>
        </div>`;
      }).join('') || '<div class="card empty">还没有跑道，点击右上角登记</div>'}
    </div>

    <div class="card mt">
      <h2>里程换算工具</h2>
      <div class="sub mb">输入巡查点 GPS，验证能否正确投影到某条跑道的里程</div>
      <div class="filters">
        <div class="field"><label>跑道</label><select id="lrw">
          ${runways.map((r) => `<option value="${r.id}">${r.code} ${r.name}</option>`).join('')}
        </select></div>
        <div class="field"><label>纬度</label><input id="llat" placeholder="31.1980"></div>
        <div class="field"><label>经度</label><input id="llon" placeholder="121.8388"></div>
        <button id="locate">换算</button>
      </div>
      <div id="locate-out" class="mono muted"></div>
    </div>`;

  el.querySelector('#add').onclick = () => runwayModal(el);
  el.querySelector('#locate').onclick = async () => {
    const out = el.querySelector('#locate-out');
    try {
      const r = await api(`/api/runways/${el.querySelector('#lrw').value}/locate`, {
        method: 'POST',
        body: { lat: +el.querySelector('#llat').value, lon: +el.querySelector('#llon').value },
      });
      out.innerHTML = `里程 <strong>${r.stationLabel}</strong>（${r.station} m） ·
        横距 <strong>${sideLabel(r.offset)}</strong>（${r.offset} m）`;
    } catch (e) { out.textContent = e.message; }
  };
  return el;
}

export async function RunwayDetail(id) {
  const [{ runway }, map] = await Promise.all([
    api(`/api/runways/${id}`),
    api(`/api/runways/${id}/defect-map`),
  ]);
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>${runway.code} <span class="muted" style="font-size:14px">${runway.name}</span></h1>
        <div class="sub"><a class="link" href="#/runways">跑道与定位</a> / ${runway.code}</div>
      </div>
      <a class="btn ghost" href="#/defects?runwayId=${runway.id}">查看该跑道全部档案</a>
    </div>
    <div class="card">
      <h2>纵断面病害分布（点击点位进入档案）</h2>
      <div id="map"></div>
    </div>
    <div class="card mt">
      <dl class="kv">
        <dt>阈值点</dt><dd class="mono">${runway.threshold.lat.toFixed(6)}, ${runway.threshold.lon.toFixed(6)}</dd>
        <dt>方位角</dt><dd>${runway.bearing}°</dd>
        <dt>长度 / 宽度</dt><dd>${runway.lengthM} m / ${runway.widthM} m</dd>
        <dt>病害点</dt><dd>${map.points.length} 处（含已处理）</dd>
      </dl>
    </div>`;
  el.querySelector('#map').appendChild(runwayMap(runway, map.points));
  return el;
}

function runwayModal(parent) {
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal" onclick="event.stopPropagation()">
    <h3>登记跑道</h3>
    <div class="form-row">
      <div class="field"><label>跑道代号 *</label><input id="m-code" placeholder="18R"></div>
      <div class="field"><label>名称 *</label><input id="m-name" placeholder="18R/36L 跑道"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>阈值点纬度 *</label><input id="m-lat" placeholder="31.194600"></div>
      <div class="field"><label>阈值点经度 *</label><input id="m-lon" placeholder="121.835200"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>方位角 (°) *</label><input id="m-brg" placeholder="156"></div>
      <div class="field"><label>长度 (m) *</label><input id="m-len" placeholder="3800"></div>
    </div>
    <div class="form-row">
      <div class="field"><label>宽度 (m)</label><input id="m-wid" value="45"></div>
      <div class="field"><label>起始里程标记</label><input id="m-s0" value="K0+000.00"></div>
    </div>
    <div class="right">
      <button class="ghost" id="m-cancel">取消</button>
      <button id="m-save">保存</button>
    </div>
  </div>`;
  mask.onclick = () => mask.remove();
  document.body.appendChild(mask);
  mask.querySelector('#m-cancel').onclick = () => mask.remove();
  mask.querySelector('#m-save').onclick = async () => {
    const v = (id) => mask.querySelector(id).value;
    try {
      await api('/api/runways', {
        method: 'POST',
        body: {
          code: v('#m-code'), name: v('#m-name'),
          thresholdLat: +v('#m-lat'), thresholdLon: +v('#m-lon'),
          bearing: +v('#m-brg'), lengthM: +v('#m-len'),
          widthM: +v('#m-wid') || 45, station0Label: v('#m-s0'),
        },
      });
      toast('跑道已登记', 'ok');
      mask.remove();
      renderParent(parent);
    } catch (e) { toast(e.message, 'err'); }
  };
}

// 简单刷新当前页
function renderParent() { location.hash = location.hash; window.dispatchEvent(new HashChangeEvent('hashchange')); }
