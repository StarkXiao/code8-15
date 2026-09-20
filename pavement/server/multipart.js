// 最小 multipart/form-data 解析器（巡查影像单张通常 < 20MB，全缓冲足够）
export function parseMultipart(buffer, contentType) {
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!m) throw httpError(400, '缺少 multipart boundary');
  const boundary = Buffer.from(`--${m[1] || m[2]}`);
  const fields = {};
  const files = [];
  let pos = buffer.indexOf(boundary);
  if (pos < 0) return { fields, files };
  pos += boundary.length;

  while (pos < buffer.length) {
    if (buffer[pos] === 0x2d && buffer[pos + 1] === 0x2d) break; // -- 结束
    pos += 2; // CRLF
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), pos);
    if (headerEnd < 0) break;
    const headers = buffer.toString('utf8', pos, headerEnd);
    const bodyStart = headerEnd + 4;
    const next = buffer.indexOf(boundary, bodyStart);
    if (next < 0) break;
    let bodyEnd = next;
    if (buffer[bodyEnd - 2] === 0x0d && buffer[bodyEnd - 1] === 0x0a) bodyEnd -= 2;
    const data = buffer.subarray(bodyStart, bodyEnd);

    const nameM = /name="([^"]*)"/i.exec(headers);
    const fileM = /filename="([^"]*)"/i.exec(headers);
    const ctypeM = /content-type:\s*([^\r\n]+)/i.exec(headers);
    if (nameM) {
      const name = nameM[1];
      if (fileM && fileM[1]) {
        files.push({
          field: name,
          filename: fileM[1],
          mime: (ctypeM?.[1] || 'application/octet-stream').trim(),
          data: Buffer.from(data),
        });
      } else {
        fields[name] = data.toString('utf8');
      }
    }
    pos = next + boundary.length;
  }
  return { fields, files };
}

export function httpError(status, code, detail) {
  const e = new Error(code);
  e.status = status; e.code = code; e.detail = detail;
  return e;
}
