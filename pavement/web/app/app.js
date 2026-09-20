// hash 路由：#/  #/runways  #/defects  #/defects/:id  #/inspections  #/inspections/:id
import { Dashboard } from './pages/dashboard.js';
import { RunwaysPage, RunwayDetail } from './pages/runways.js';
import { DefectsPage, DefectDetail } from './pages/defects.js';
import { InspectionsPage, InspectionDetail } from './pages/inspections.js';

const routes = [
  [/^\/$/, () => Dashboard()],
  [/^\/runways$/, () => RunwaysPage()],
  [/^\/runways\/(\d+)$/, (m) => RunwayDetail(m[1])],
  [/^\/defects$/, () => DefectsPage()],
  [/^\/defects\/(\d+)$/, (m) => DefectDetail(m[1])],
  [/^\/inspections$/, () => InspectionsPage()],
  [/^\/inspections\/(\d+)$/, (m) => InspectionDetail(m[1])],
];

const view = document.getElementById('view');

export async function render() {
  const hash = location.hash.replace(/^#/, '') || '/';
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.route === (hash === '/' ? '/' :
      '/' + hash.split('/')[1]));
  });
  for (const [re, page] of routes) {
    const m = re.exec(hash);
    if (m) {
      view.innerHTML = '<div class="empty">加载中…</div>';
      try {
        const node = await page(m);
        view.innerHTML = '';
        view.appendChild(node);
      } catch (e) {
        view.innerHTML = `<div class="card"><h2>页面出错</h2>
          <pre class="muted">${e.message}</pre></div>`;
        console.error(e);
      }
      return;
    }
  }
  view.innerHTML = '<div class="empty">页面不存在</div>';
}

window.addEventListener('hashchange', render);
render();
