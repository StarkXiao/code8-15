// 感知哈希 pHash：最近邻缩放到 32×32（灰度）→ 32 点 DCT → 取左上 8×8
// （跳过直流分量）与中位数比较 → 64 bit，返回 16 位小写 hex。
// 这份算法在前端 web/app/phash.js 保持逐行一致，使两端算得的哈希可直接比对。

export function pHash(rgba, width, height) {
  const N = 32;
  const gray = resizeGray(rgba, width, height, N, N);
  const dct = dct2d(gray, N);
  const vals = [];
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (x === 0 && y === 0) continue;
      vals.push(dct[y * N + x]);
    }
  }
  const sorted = [...vals].sort((a, b) => a - b);
  const median = vals.length % 2
    ? sorted[(vals.length - 1) >> 1]
    : (sorted[vals.length / 2 - 1] + sorted[vals.length / 2]) / 2;
  let bits = 1n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      if (x === 0 && y === 0) continue;
      bits = (bits << 1n) | (dct[y * N + x] > median ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export function hamming(h1, h2) {
  let x = BigInt('0x' + h1) ^ BigInt('0x' + h2);
  let n = 0;
  while (x) { n += Number(x & 1n); x >>= 1n; }
  return n;
}

function resizeGray(rgba, w, h, nw, nh) {
  const out = new Float64Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) * h / nh - 0.5;
    const y0 = Math.max(0, Math.floor(sy));
    const wy = sy - y0;
    const y1 = Math.min(h - 1, y0 + 1);
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) * w / nw - 0.5;
      const x0 = Math.max(0, Math.floor(sx));
      const wx = sx - x0;
      const x1 = Math.min(w - 1, x0 + 1);
      out[y * nw + x] =
        grayAt(rgba, w, x0, y0) * (1 - wx) * (1 - wy) +
        grayAt(rgba, w, x1, y0) * wx * (1 - wy) +
        grayAt(rgba, w, x0, y1) * (1 - wx) * wy +
        grayAt(rgba, w, x1, y1) * wx * wy;
    }
  }
  return out;
}

function grayAt(rgba, w, x, y) {
  const i = (y * w + x) * 4;
  return 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
}

// II 型 DCT，朴素实现（32×32 足够快）
function dct2d(input, N) {
  const tmp = new Float64Array(N * N);
  const out = new Float64Array(N * N);
  for (let y = 0; y < N; y++) {
    for (let k = 0; k < N; k++) {
      let s = 0;
      for (let n = 0; n < N; n++) {
        s += input[y * N + n] * Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
      }
      tmp[y * N + k] = s;
    }
  }
  for (let x = 0; x < N; x++) {
    for (let k = 0; k < N; k++) {
      let s = 0;
      for (let n = 0; n < N; n++) {
        s += tmp[n * N + x] * Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N));
      }
      out[k * N + x] = s;
    }
  }
  return out;
}

// Canvas ImageData -> { rgba, width, height }
export function fromImageData(img) {
  return { rgba: img.data, width: img.width, height: img.height };
}
