import { fmtStation } from '../ui.js';

const SEV_COLOR = { low: '#3fb950', medium: '#d29922', high: '#f85149' };

// 跑道纵断面示意图：点的横向位置 = 里程，纵向 = 横距（按宽度比例）
export function runwayMap(runway, points, { height = 150, clickable = true } = {}) {
  const box = document.createElement('div');
  const padX = 30;
  const W = 1000; // 内部坐标宽度（百分比定位）
  const scale = (station) =>
    `${padX + (Math.max(0, Math.min(runway.lengthM, station)) / runway.lengthM) * (W - padX * 2)}px`;
  const vScale = (offset) => {
    const usable = height - 34;
    const cy = height / 2 + 2;
    const y = cy - (offset / (runway.widthM / 2)) * (usable / 2 - 6);
    return `${Math.max(12, Math.min(height - 12, y))}px`;
  };

  box.innerHTML = `
    <div class="runway-map" style="height:${height}px">
      <div class="threshold-label" style="left:30px">${runway.code} · ${fmtStation(0)}</div>
      <div class="threshold-label" style="right:30px">${fmtStation(runway.lengthM)}</div>
      <div class="runway-strip" style="left:${padX}px;right:${padX}px;top:${height / 2 - 18}px;height:36px"></div>
      <div class="runway-center" style="left:${padX}px;right:${padX}px;top:${height / 2 - 2}px"></div>
      ${points.map((p) => {
        const dim = p.status !== 'open' ? 'opacity:.35;' : '';
        const cursor = clickable ? '' : 'pointer:default;';
        return `<div class="map-point" data-id="${p.id}" title="${esc(p.code)} ${esc(p.typeName)} · ${p.stationLabel} · ${p.severity}"
          style="left:${scale(p.stationM)};top:${vScale(p.offsetM)};background:${SEV_COLOR[p.severity]};${dim}${cursor}"></div>`;
      }).join('')}
    </div>
    <div class="ruler" style="padding:0 ${padX}px">
      <span>面向跑道方向：上=左侧，下=右侧</span>
      <span>颜色 = 严重程度；深色 = 已处理</span>
    </div>
    <div class="legend">
      <span><i style="background:${SEV_COLOR.high}"></i>重度</span>
      <span><i style="background:${SEV_COLOR.medium}"></i>中度</span>
      <span><i style="background:${SEV_COLOR.low}"></i>轻度</span>
    </div>`;

  box.querySelectorAll('.map-point').forEach((pt) => {
    pt.onclick = () => { location.hash = `#/defects/${pt.dataset.id}`; };
  });
  return box;
}

function esc(s) {
  return String(s ?? '').replace(/["<>]/g, (c) => ({ '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c]));
}
