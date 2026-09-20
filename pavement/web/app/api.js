// 极简 API 封装
export async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(data.detail || data.error || `HTTP ${res.status}`);
    e.status = res.status; e.code = data.error; e.data = data;
    throw e;
  }
  return data;
}

export const qs = (params) => {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
};

// multipart 上传：fields + file
export function upload(path, file, fields = {}, onProgress) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) {
      if (v !== undefined && v !== null && v !== '') fd.set(k, v);
    }
    fd.set('file', file, file.name || 'image.jpg');
    const xhr = new XMLHttpRequest();
    xhr.open('POST', path);
    xhr.onload = () => {
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status >= 400) {
          return reject(Object.assign(new Error(data.detail || data.error), { code: data.error, data }));
        }
        resolve(data);
      } catch (e) { reject(e); }
    };
    xhr.onerror = () => reject(new Error('网络错误'));
    if (onProgress) xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.send(fd);
  });
}
