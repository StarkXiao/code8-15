// toast + 里程格式化（与服务端 geo.js 保持同一展示口径）
export function toast(msg, kind = '', ms = 3200) {
  const box = document.getElementById('toast');
  const el = document.createElement('div');
  el.className = `t ${kind}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

export function fmtStation(m) {
  if (m == null || Number.isNaN(m)) return '—';
  const sign = m < 0 ? '-' : '';
  const v = Math.abs(m);
  const km = Math.floor(v / 1000);
  return `${sign}K${km}+${(v % 1000).toFixed(2).padStart(6, '0')}`;
}

export function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function fmtDateTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${fmtDate(iso)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
const pad = (n) => String(n).padStart(2, '0');

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

export function sideLabel(offset) {
  if (Math.abs(offset) < 0.3) return '中线';
  return `${Math.abs(Math.round(offset * 100) / 100)}m ${offset > 0 ? '右' : '左'}`;
}

export const decisionText = {
  new_defect: '新病害建档',
  near_duplicate: '感知近重复 → 并入既有档案',
  recurrence: '复发 → 并入既有档案',
  exact_duplicate: '字节重复 → 已拦截',
  new_image: '已入库',
};

export function lightbox(url) {
  const mask = document.createElement('div');
  mask.className = 'lightbox';
  mask.innerHTML = `<img src="${url}" alt="">`;
  mask.onclick = () => mask.remove();
  document.body.appendChild(mask);
}
