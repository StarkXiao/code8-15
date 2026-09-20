import { api, upload } from '../api.js';
import { toast, esc, fmtDateTime, fmtStation, sideLabel, decisionText } from '../ui.js';
import { pHash, fromImageData } from '../phash.js';

export async function InspectionsPage() {
  const [{ inspections }, { runways }] = await Promise.all([
    api('/api/inspections'), api('/api/runways'),
  ]);
  const el = document.createElement('div');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>巡查任务</h1>
        <div class="sub">一次巡查的影像归入一个任务；上传时自动定位、去重、建档</div></div>
      <button id="add">+ 新建巡查任务</button>
    </div>
    <div class="card">
      <table>
        <thead><tr><th>巡查时间</th><th>跑道</th><th>班组</th><th>备注</th>
          <th class="num">影像数</th><th class="num">字节重复</th><th></th></tr></thead>
        <tbody>
          ${inspections.map((i) => `
            <tr>
              <td class="mono">${fmtDateTime(i.conducted_at)}</td>
              <td>${i.runway_code}</td>
              <td class="muted">${esc(i.team ?? '—')}</td>
              <td class="muted">${esc(i.note ?? '—')}</td>
              <td class="num">${i.image_count}</td>
              <td class="num">${i.duplicate_count}</td>
              <td class="right"><a class="btn btn-sm" href="#/inspections/${i.id}">打开 / 上传</a></td>
            </tr>`).join('') || '<tr><td colspan="7" class="empty">还没有巡查任务</td></tr>'}
        </tbody>
      </table>
    </div>`;
  el.querySelector('#add').onclick = () => createModal(runways);
  return el;
}

function createModal(runways) {
  if (!runways.length) return toast('请先在「跑道与定位」登记跑道', 'err');
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60000)
    .toISOString().slice(0, 16);
  const mask = document.createElement('div');
  mask.className = 'modal-mask';
  mask.innerHTML = `<div class="modal">
    <h3>新建巡查任务</h3>
    <div class="field"><label>跑道 *</label><select id="c-rw">
      ${runways.map((r) => `<option value="${r.id}">${r.code} ${r.name}</option>`).join('')}
    </select></div>
    <div class="field"><label>巡查时间 *</label><input id="c-at" type="datetime-local" value="${local}"></div>
    <div class="field"><label>班组</label><input id="c-team" placeholder="甲班"></div>
    <div class="field"><label>备注</label><textarea id="c-note" rows="2"></textarea></div>
    <div class="right"><button class="ghost" id="c-cancel">取消</button> <button id="c-save">创建并打开</button></div>
  </div>`;
  mask.onclick = () => mask.remove();
  document.body.appendChild(mask);
  mask.querySelector('#c-cancel').onclick = () => mask.remove();
  mask.querySelector('#c-save').onclick = async () => {
    try {
      const { inspection } = await api('/api/inspections', {
        method: 'POST',
        body: {
          runwayId: +mask.querySelector('#c-rw').value,
          conductedAt: new Date(mask.querySelector('#c-at').value).toISOString(),
          team: mask.querySelector('#c-team').value,
          note: mask.querySelector('#c-note').value,
        },
      });
      toast('巡查任务已创建', 'ok');
      mask.remove();
      location.hash = `#/inspections/${inspection.id}`;
    } catch (e) { toast(e.message, 'err'); }
  };
}

export async function InspectionDetail(id) {
  const data = await api(`/api/inspections/${id}`);
  const ins = data.inspection;
  const meta = await api('/api/meta');
  const runway = (await api(`/api/runways/${ins.runway_id}`)).runway;

  const el = document.createElement('div');
  el.innerHTML = `
    <div class="page-head">
      <div><h1>巡查 ${fmtDateTime(ins.conducted_at)}</h1>
        <div class="sub"><a class="link" href="#/inspections">巡查任务</a> /
          ${runway.code} · ${esc(ins.team ?? '未指定班组')} · ${esc(ins.note ?? '')}</div>
      </div>
    </div>

    <div class="card">
      <h2>上传巡查影像</h2>
      <div class="sub mb-sm">
        浏览器本地先算感知哈希（pHash, 64bit），随原图上传；服务端按 GPS→里程定位，并执行三级去重。
      </div>
      <div class="form-row">
        <div class="field"><label>默认病害类型（可逐张改）</label>
          <select id="up-type"><option value="">不标注（按自动初判）</option>
            ${meta.types.map((t) => `<option value="${t.code}">${t.name}</option>`).join('')}
          </select></div>
        <div class="field"><label>默认严重程度</label>
          <select id="up-sev"><option value="">不标注</option>
            ${meta.severities.map((s) => `<option value="${s.code}">${s.name}</option>`).join('')}
          </select></div>
      </div>
      <div class="form-row">
        <div class="field"><label>无 GPS 时统一填写的里程</label>
          <input id="up-station" placeholder="K1+234.56（图片带 GPS 时此项被忽略）"></div>
        <div class="field"><label>横距 m（右正左负）</label>
          <input id="up-offset" type="number" step="0.1" placeholder="0"></div>
      </div>
      <div id="drop" class="dropzone">
        把 JPEG / PNG / WebP 拖到这里，或点击选择（可多选）<br>
        <span class="muted" style="font-size:12px">
          含 GPS 的手机照片将自动投影为里程；重复上传同一文件会被内容哈希直接拦截
        </span>
        <input type="file" id="file" accept="image/*" multiple hidden>
      </div>
      <div id="thumbs" class="thumbs"></div>
      <div class="right mt"><button id="submit" disabled>开始入库 (0)</button></div>
      <div id="results" class="mt-sm"></div>
    </div>

    <div class="card mt">
      <h2>本任务影像（${data.images.length}）</h2>
      <table>
        <thead><tr><th>影像</th><th>原始文件名</th><th>里程</th><th>横距</th>
          <th>来源/判定</th><th>拍摄时间</th><th>pHash</th></tr></thead>
        <tbody>
          ${data.images.map((im) => `
            <tr style="${im.duplicateOfId ? 'opacity:.6' : ''}">
              <td><img src="${im.url}" style="width:54px;height:54px;object-fit:cover;border-radius:4px;cursor:zoom-in"
                class="zoom" data-url="${im.url}"></td>
              <td class="mono" style="max-width:220px;word-break:break-all">${esc(im.originalName)}</td>
              <td class="mono">${im.stationLabel}</td>
              <td>${im.side}</td>
              <td>${sourceBadge(im)}</td>
              <td class="muted">${fmtDateTime(im.capturedAt)}</td>
              <td class="mono muted">${im.phash?.slice(0, 12) ?? '—'}</td>
            </tr>`).join('') || '<tr><td colspan="7" class="empty">尚未上传影像</td></tr>'}
        </tbody>
      </table>
    </div>`;

  el.querySelectorAll('.zoom').forEach((img) => {
    img.onclick = () => {
      const m = document.createElement('div');
      m.className = 'lightbox';
      m.innerHTML = `<img src="${img.dataset.url}">`;
      m.onclick = () => m.remove();
      document.body.appendChild(m);
    };
  });

  // ---- 上传交互 ----
  const drop = el.querySelector('#drop');
  const fileInput = el.querySelector('#file');
  const submitBtn = el.querySelector('#submit');
  const thumbs = el.querySelector('#thumbs');
  const results = el.querySelector('#results');
  const queue = [];

  drop.onclick = () => fileInput.click();
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
  drop.ondragleave = () => drop.classList.remove('drag');
  drop.ondrop = (e) => {
    e.preventDefault(); drop.classList.remove('drag');
    enqueue([...e.dataTransfer.files]);
  };
  fileInput.onchange = () => enqueue([...fileInput.files]);

  async function enqueue(files) {
    for (const file of files) {
      if (!/^image\//.test(file.type)) continue;
      const card = document.createElement('div');
      card.className = 'thumb-card';
      card.innerHTML = `
        <img src="${URL.createObjectURL(file)}">
        <div class="cap">${esc(file.name)}</div>
        <div class="ingest-line muted">计算哈希中…</div>`;
      thumbs.appendChild(card);
      let phashHex = null;
      try {
        phashHex = await computePhash(file);
        card.querySelector('.ingest-line').innerHTML =
          `<span class="muted mono">pHash ${phashHex.slice(0, 12)}…</span>`;
      } catch (e) {
        card.querySelector('.ingest-line').innerHTML =
          `<span style="color:var(--red)">哈希失败：${esc(e.message)}</span>`;
      }
      queue.push({ file, phash: phashHex, card });
      submitBtn.disabled = false;
      submitBtn.textContent = `开始入库 (${queue.length})`;
    }
    fileInput.value = '';
  }

  submitBtn.onclick = async () => {
    submitBtn.disabled = true;
    const fields = () => ({
      type: el.querySelector('#up-type').value,
      severity: el.querySelector('#up-sev').value,
      station: el.querySelector('#up-station').value,
      offset: el.querySelector('#up-offset').value,
    });
    while (queue.length) {
      const item = queue.shift();
      const line = item.card.querySelector('.ingest-line');
      line.className = 'ingest-line muted';
      line.textContent = '上传中…';
      try {
        const r = await upload(
          `/api/inspections/${id}/images`, item.file,
          { ...fields(), phash: item.phash ?? '' },
          (p) => { line.textContent = `上传中 ${(p * 100).toFixed(0)}%`; });
        line.innerHTML =
          `<span class="pill-decision dec-${r.decision}">${decisionText[r.decision] ?? r.decision}</span>
           ${r.defect ? `<a class="link mono" href="#/defects/${r.defect.id}">${r.defect.code}</a>` : ''}`;
      } catch (e) {
        line.innerHTML = `<span style="color:var(--red)">失败：${esc(e.message)}</span>`;
      }
    }
    submitBtn.textContent = '完成';
    toast('入库完成，3 秒后刷新列表', 'ok');
    setTimeout(() => window.dispatchEvent(new HashChangeEvent('hashchange')), 2500);
  };

  return el;
}

function sourceBadge(im) {
  if (im.duplicateOfId) {
    return `<span class="pill-decision dec-exact_duplicate">字节重复</span>
      <div class="sub" style="font-size:11px">${esc(im.ingestNote ?? '')}</div>`;
  }
  if (im.source === 'reobservation') {
    return `<span class="pill-decision dec-near_duplicate">感知近重复</span>
      <div class="sub" style="font-size:11px">${esc(im.ingestNote ?? '')}</div>`;
  }
  return `<span class="tag">${im.source === 'duplicate' ? '重复' : '新图'}</span>`;
}

// 浏览器端把图片画到 256 画布再算 pHash（与服务端同算法）
async function computePhash(file) {
  const bitmap = await createImageBitmap(file);
  const S = 256;
  const canvas = document.createElement('canvas');
  canvas.width = S; canvas.height = S;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // cover 裁切，减少黑边影响
  const ratio = Math.max(S / bitmap.width, S / bitmap.height);
  const w = bitmap.width * ratio, h = bitmap.height * ratio;
  ctx.drawImage(bitmap, (S - w) / 2, (S - h) / 2, w, h);
  const img = ctx.getImageData(0, 0, S, S);
  bitmap.close();
  return pHash(img.data, S, S);
}
