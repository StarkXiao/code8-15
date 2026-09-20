// HTTP 服务：纯 Node http，静态托管 web/（SPA），API 返回 JSON
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { migrate, IMG_DIR } from './db.js';
import { parseMultipart } from './multipart.js';
import { registerRoutes } from './routes/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');
const MAX_UPLOAD = Number(process.env.MAX_UPLOAD_MB ?? 30) * 1024 * 1024;

migrate();

const routes = [];
registerRoutes({
  get: (p, h) => routes.push({ method: 'GET', re: toRe(p), h, raw: false }),
  post: (p, h) => routes.push({ method: 'POST', re: toRe(p), h, raw: false }),
  patch: (p, h) => routes.push({ method: 'PATCH', re: toRe(p), h, raw: false }),
  del: (p, h) => routes.push({ method: 'DELETE', re: toRe(p), h, raw: false }),
});

function toRe(p) {
  return new RegExp('^' + p.replace(/:([a-zA-Z]+)/g, '(?<$1>[^/]+)') + '$');
}

export const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;

    if (path.startsWith('/api/')) {
      const route = routes.find((r) => r.method === req.method && r.re.test(path));
      if (!route) return send(res, 404, { error: 'NOT_FOUND' });
      const match = route.re.exec(path);
      const params = match.groups ?? {};
      const query = Object.fromEntries(url.searchParams);
      const ctx = { params, query, req, res };

      if (req.method === 'POST' || req.method === 'PATCH') {
        const ctype = req.headers['content-type'] || '';
        if (ctype.startsWith('multipart/form-data')) {
          const body = await readBody(req, MAX_UPLOAD);
          const { fields, files } = parseMultipart(body, ctype);
          ctx.fields = fields;
          ctx.files = files;
        } else {
          const body = await readBody(req, 1024 * 1024);
          ctx.body = body.length ? JSON.parse(body.toString('utf8') || '{}') : {};
        }
      }
      const out = await route.h(ctx);
      if (!res.writableEnded) send(res, 200, out ?? { ok: true });
      return;
    }

    await serveStatic(res, path);
  } catch (e) {
    if (e instanceof SyntaxError) return send(res, 400, { error: 'BAD_JSON' });
    console.error('[http]', e);
    send(res, e.status || 500, {
      error: e.code || 'INTERNAL',
      detail: e.detail || e.message,
    });
  }
});

async function readBody(req, max) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > max) {
      const e = new Error('PAYLOAD_TOO_LARGE');
      e.status = 413; e.code = 'PAYLOAD_TOO_LARGE';
      throw e;
    }
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.svg': 'image/svg+xml',
};

async function serveStatic(res, path) {
  // 原图直读（证据文件，哈希命名，只读）
  if (path.startsWith('/images/')) {
    const name = path.split('/').pop();
    if (!/^[a-f0-9]{16}\.[a-z0-9]+$/.test(name)) return send404(res);
    return sendFile(res, join(IMG_DIR, name));
  }
  let rel = path === '/' ? '/index.html' : path;
  let file = normalize(join(WEB_DIR, rel));
  if (!file.startsWith(WEB_DIR)) return send404(res);
  try {
    const s = await stat(file);
    if (s.isDirectory()) file = join(file, 'index.html');
    return sendFile(res, file);
  } catch {
    // SPA 回退
    return sendFile(res, join(WEB_DIR, 'index.html'));
  }
}

async function sendFile(res, file) {
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'content-type': MIME[extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    send404(res);
  }
}
function send404(res) {
  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
}

// 直接运行（node server/index.js）或由测试以 PORT 环境变量拉起时监听
const entry = process.argv[1] && process.argv[1].endsWith('index.js');
if (entry || process.env.PORT) {
  const port = Number(process.env.PORT ?? 4200);
  server.listen(port, () => {
    console.log(`机场道面病害编目系统: http://localhost:${port}`);
  });
}
