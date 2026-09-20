// 最小 JPEG EXIF 解析：只取拍摄时间 DateTimeOriginal 与 GPS（纬度/经度/海拔/定位误差）
// 不依赖任何库。找不到就返回 null（巡查图常常没有 EXIF，走手工里程）。
export function parseJpegExif(buf) {
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 < buf.length) {
    if (buf[pos] !== 0xff) break;
    const marker = buf[pos + 1];
    // SOS：后面是扫描数据，不再有元数据
    if (marker === 0xda) break;
    const size = buf.readUInt16BE(pos + 2);
    if (marker === 0xe1) {
      const seg = buf.subarray(pos + 4, pos + 2 + size);
      if (seg.toString('ascii', 0, 4) === 'Exif') {
        return parseTiff(seg.subarray(6));
      }
    }
    pos += 2 + size;
  }
  return null;
}

function parseTiff(tiff) {
  const little = tiff[0] === 0x49; // 'II'
  const view = {
    u16: (o) => little ? tiff.readUInt16LE(o) : tiff.readUInt16BE(o),
    u32: (o) => little ? tiff.readUInt32LE(o) : tiff.readUInt32BE(o),
  };
  const n = view.u16(2);
  const tags = {};
  for (let i = 0; i < n; i++) {
    const e = 4 + i * 12;
    tags[view.u16(e)] = {
    type: view.u16(e + 2),
    count: view.u32(e + 4),
    valueOffset: e + 8, // 内联值或偏移
  };
  }
  const readValue = (tag) => {
    const t = tags[tag];
    if (!t) return null;
    const o = t.valueOffset;
    if (t.type === 2) { // ASCII
      let end = o;
      while (end < o + t.count && tiff[end] !== 0) end++;
      return tiff.toString('utf8', o, end);
    }
    if (t.type === 3 && t.count === 1) return view.u16(o); // SHORT 内联
    if (t.type === 4 && t.count === 1) return view.u32(o); // LONG 内联
    if (t.type === 5) { // RATIONAL：偏移 -> 两个 LONG
      const ro = view.u32(o);
      return view.u32(ro) / Math.max(1, view.u32(ro + 4));
    }
    if (t.type === 4) return view.u32(o);
    return null;
  };
  const readRationalAt = (ro) => ({
    num: view.u32(ro), den: view.u32(ro + 4),
    value: view.u32(ro) / Math.max(1, view.u32(ro + 4)),
  });

  // GPS IFD
  let gps = null;
  const gpsIfdPtr = tags[0x8825];
  if (gpsIfdPtr) {
    const go = view.u32(gpsIfdPtr.valueOffset);
    const gn = view.u16(go);
    const gt = {};
    for (let i = 0; i < gn; i++) {
      const e = go + 2 + i * 12;
      gt[view.u16(e)] = { type: view.u16(e + 2), count: view.u32(e + 4), off: e + 8 };
    }
    const rational = (id) => {
      const t = gt[id];
      if (!t) return null;
      const ro = view.u32(t.off);
      return readRationalAt(ro).value;
    };
    const dms = (id) => {
      const t = gt[id];
      if (!t) return null;
      const ro = view.u32(t.off);
      const d = readRationalAt(ro).value;
      const m = readRationalAt(ro + 8).value;
      const s = readRationalAt(ro + 16).value;
      return d + m / 60 + s / 3600;
    };
    let lat = dms(2), lon = dms(4);
    if (lat != null && gt[1] && tiff[view.u32(gt[1].off)] === 0x53) lat = -lat;
    if (lon != null && gt[3] && tiff[view.u32(gt[3].off)] === 0x57) lon = -lon;
    gps = {
      lat, lon,
      altitude: rational(6) ?? null,
      accuracy: rational(23) ?? null, // GPSHPositioningError（部分手机有）
    };
  }

  const capturedAt = readValue(0x9003) || readValue(0x0132) || null;
  return { capturedAt: capturedAt ? normalizeExifDate(capturedAt) : null, gps };
}

// "2026:09:18 10:23:45" -> ISO
function normalizeExifDate(s) {
  const m = s.trim().match(/^(\d{4}):(\d{2}):(\d{2})[ ](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`;
}
