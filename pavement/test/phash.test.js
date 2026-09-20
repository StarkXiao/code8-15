import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pHash, hamming } from '../server/phash.js';
import { encodePNG, decodePNG } from '../server/png.js';

function canvas(size = 256) {
  return new Uint8ClampedArray(size * size * 4);
}
function circle(px, S, cx, cy, r, shade = 20) {
  for (let y = -r; y <= r; y++) {
    for (let x = -r; x <= r; x++) {
      if (x * x + y * y <= r * r) {
        const i = ((cy + y) * S + (cx + x)) * 4;
        px[i] = px[i + 1] = px[i + 2] = shade; px[i + 3] = 255;
      }
    }
  }
}
function fill(px, shade) {
  for (let i = 0; i < px.length; i += 4) {
    px[i] = px[i + 1] = px[i + 2] = shade; px[i + 3] = 255;
  }
}

test('完全相同的图 pHash 距离为 0', () => {
  const S = 256;
  const a = canvas(S); fill(a, 100); circle(a, S, 128, 128, 30, 20);
  const h1 = pHash(a, S, S);
  const h2 = pHash(a, S, S);
  assert.equal(hamming(h1, h2), 0);
  assert.match(h1, /^[0-9a-f]{16}$/);
});

test('同一场景微抖动 => 距离很近（近重复）', () => {
  const S = 256;
  const a = canvas(S); fill(a, 100); circle(a, S, 128, 128, 30, 20);
  // 重拍：病灶位置/尺度轻微偏移、色调不变
  const b = canvas(S); fill(b, 100); circle(b, S, 131, 128, 31, 20);
  assert.ok(hamming(pHash(a, S, S), pHash(b, S, S)) <= 10);
});

test('完全不同的纹理 => 距离明显更大', () => {
  const S = 256;
  const a = canvas(S); fill(a, 90); circle(a, S, 60, 60, 28, 20);
  const b = canvas(S); fill(b, 160); circle(b, S, 200, 200, 60, 220);
  assert.ok(hamming(pHash(a, S, S), pHash(b, S, S)) > 10);
});

test('PNG 编解码往返后像素一致', () => {
  const S = 48;
  const a = canvas(S);
  for (let i = 0; i < a.length; i += 4) {
    a[i] = (i * 7) % 256; a[i + 1] = (i * 13) % 256;
    a[i + 2] = (i * 29) % 256; a[i + 3] = 255;
  }
  const buf = encodePNG(a, S, S);
  const dec = decodePNG(buf);
  assert.equal(dec.width, S);
  assert.equal(dec.height, S);
  // deflate 无损，逐像素一致
  for (let i = 0; i < a.length; i++) assert.equal(dec.rgba[i], a[i]);
});

test('非 PNG 输入解码报错', () => {
  assert.throws(() => decodePNG(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8])));
});
