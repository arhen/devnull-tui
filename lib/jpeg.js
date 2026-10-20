// @ts-check
// Baseline JPEG decoder, enough for the 6x6 avatars GitHub serves: 8-bit
// samples, Huffman coding, restart markers, grayscale or YCbCr. Progressive
// JPEGs are reported as unsupported, and the caller falls back to a chip.

const ZIGZAG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27,
  20, 13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58,
  59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

const COS = new Float64Array(64);
for (let x = 0; x < 8; x += 1) for (let u = 0; u < 8; u += 1) COS[x * 8 + u] = Math.cos(((2 * x + 1) * u * Math.PI) / 16);

const halve = new Float64Array(64);
for (let u = 0; u < 8; u += 1) halve[u] = u === 0 ? Math.SQRT1_2 : 1;

const idct = (/** @type {Float32Array} */ block) => {
  const temp = new Float64Array(64);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 8; x += 1) {
      let sum = 0;
      for (let u = 0; u < 8; u += 1) sum += halve[u] * block[y * 8 + u] * COS[x * 8 + u];
      temp[y * 8 + x] = sum / 2;
    }
  }
  const out = new Float64Array(64);
  for (let x = 0; x < 8; x += 1) {
    for (let y = 0; y < 8; y += 1) {
      let sum = 0;
      for (let v = 0; v < 8; v += 1) sum += halve[v] * temp[v * 8 + x] * COS[y * 8 + v];
      out[y * 8 + x] = sum / 2;
    }
  }
  return out;
};

class Bits {
  /** @param {Uint8Array} data */
  constructor(data) {
    this.data = data;
    this.position = 0;
    this.buffer = 0;
    this.count = 0;
  }

  byte() {
    if (this.position >= this.data.length) return 0;
    const value = this.data[this.position];
    if (value === 0xff) {
      const next = this.data[this.position + 1];
      if (next === 0x00) {
        this.position += 2;
        return 0xff;
      }
      return -1;
    }
    this.position += 1;
    return value;
  }

  /** @param {number} size */
  read(size) {
    while (this.count < size) {
      const byte = this.byte();
      const value = byte < 0 ? 0 : byte;
      this.buffer = ((this.buffer << 8) | value) & 0xffffff;
      this.count += 8;
    }
    this.count -= size;
    return (this.buffer >>> this.count) & ((1 << size) - 1);
  }

  align() {
    this.count = 0;
    this.buffer = 0;
  }

  restart() {
    this.align();
    if (this.data[this.position] === 0xff) this.position += 2;
    this.align();
  }
}

const buildTable = (/** @type {number[]} */ counts, /** @type {number[]} */ values) => {
  /** @type {Map<string, number>} */
  const codes = new Map();
  let code = 0;
  let index = 0;
  for (let length = 1; length <= 16; length += 1) {
    for (let entry = 0; entry < (counts[length - 1] ?? 0); entry += 1) {
      codes.set(`${length}:${code}`, values[index]);
      index += 1;
      code += 1;
    }
    code <<= 1;
  }
  return codes;
};

const decodeHuffman = (/** @type {Bits} */ bits, /** @type {Map<string, number>} */ table) => {
  let code = 0;
  for (let length = 1; length <= 16; length += 1) {
    code = (code << 1) | bits.read(1);
    const value = table.get(`${length}:${code}`);
    if (value !== undefined) return value;
  }
  return 0;
};

const extend = (/** @type {number} */ value, /** @type {number} */ size) => {
  if (size === 0) return 0;
  return value < 1 << (size - 1) ? value - (1 << size) + 1 : value;
};

/**
 * @param {Buffer} buffer
 * @returns {{width: number, height: number, rgb: number[][]}|null}
 */
export const decodeJpeg = (buffer) => {
  const data = new Uint8Array(buffer);
  if (data[0] !== 0xff || data[1] !== 0xd8) return null;

  /** @type {{id: number, h: number, v: number, tq: number}[]} */
  let components = [];
  let width = 0;
  let height = 0;
  let precision = 8;
  /** @type {Record<number, Int32Array>} */
  const quant = {};
  /** @type {Record<string, Map<string, number>>} */
  const huffman = {};
  let scan = null;
  let restartInterval = 0;

  let offset = 2;
  const readLength = () => {
    const length = (data[offset] << 8) | data[offset + 1];
    const start = offset + 2;
    offset += length;
    return { start, end: start + length - 2 };
  };

  while (offset < data.length - 1) {
    if (data[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    while (data[offset + 1] === 0xff) offset += 1;
    const marker = data[offset + 1];
    offset += 2;

    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (marker === 0xd9) break;

    const { start, end } = readLength();

    if (marker === 0xc0 || marker === 0xc1) {
      precision = data[start];
      height = (data[start + 1] << 8) | data[start + 2];
      width = (data[start + 3] << 8) | data[start + 4];
      const count = data[start + 5];
      components = [];
      for (let index = 0; index < count; index += 1) {
        const at = start + 6 + index * 3;
        const h = count === 1 ? 1 : data[at + 1] >> 4;
        const v = count === 1 ? 1 : data[at + 1] & 15;
        if (h < 1 || h > 4 || v < 1 || v > 4) return null;
        components.push({ id: data[at], h, v, tq: data[at + 2] });
      }
      if (!width || !height || width * height > 256 * 256) return null;
    } else if (marker === 0xc2) {
      return null;
    } else if (marker === 0xdd) {
      restartInterval = (data[start] << 8) | data[start + 1];
    } else if (marker === 0xdb) {
      let at = start;
      while (at < end) {
        const table = data[at];
        const wide = table >> 4 === 1;
        const values = new Int32Array(64);
        at += 1;
        for (let index = 0; index < 64; index += 1) {
          values[ZIGZAG[index]] = wide ? (data[at + index * 2] << 8) | data[at + index * 2 + 1] : data[at + index];
        }
        quant[table & 15] = values;
        at += wide ? 128 : 64;
      }
    } else if (marker === 0xc4) {
      let at = start;
      while (at < end) {
        const selector = data[at];
        const counts = Array.from({ length: 16 }, (_, index) => data[at + 1 + index]);
        const total = counts.reduce((sum, value) => sum + value, 0);
        const values = Array.from({ length: total }, (_, index) => data[at + 17 + index]);
        huffman[`${selector >> 4}:${selector & 15}`] = buildTable(counts, values);
        at += 17 + total;
      }
    } else if (marker === 0xda) {
      const count = data[start];
      const selectors = [];
      for (let index = 0; index < count; index += 1) {
        const at = start + 1 + index * 2;
        selectors.push({ component: data[at], dc: data[at + 1] >> 4, ac: data[at + 1] & 15 });
      }
      const scanStart = start + 1 + count * 2 + 3;
      let end = scanStart;
      while (end < data.length - 1 && !(data[end] === 0xff && data[end + 1] !== 0x00 && !(data[end + 1] >= 0xd0 && data[end + 1] <= 0xd7))) end += 1;
      scan = { selectors, data: data.subarray(scanStart, end) };
      break;
    }
  }

  if (!width || !height || !scan || !components.length || precision !== 8) return null;
  if (components.length !== 1 && components.length !== 3) return null;

  const hMax = Math.max(...components.map((component) => component.h));
  const vMax = Math.max(...components.map((component) => component.v));
  const mcuWidth = hMax * 8;
  const mcuHeight = vMax * 8;
  const mcusX = Math.ceil(width / mcuWidth);
  const mcusY = Math.ceil(height / mcuHeight);

  const planes = components.map((component) => {
    const planeWidth = Math.ceil((width * component.h) / hMax);
    const planeHeight = Math.ceil((height * component.v) / vMax);
    return {
      component,
      width: planeWidth,
      height: planeHeight,
      pixels: new Float32Array(planeWidth * planeHeight),
    };
  });

  const scanComponents = components.map((component) => {
    const selector = scan.selectors.find((/** @type {any} */ entry) => entry.component === component.id);
    if (!selector) return null;
    const dcTable = huffman[`0:${selector.dc}`];
    const acTable = huffman[`1:${selector.ac}`];
    const table = quant[component.tq];
    if (!dcTable || !acTable || !table) return null;
    return { dcTable, acTable, table };
  });
  if (scanComponents.some((entry) => entry === null)) return null;

  const bits = new Bits(scan.data);
  const predictors = new Array(components.length).fill(0);

  let mcuIndex = 0;

  for (let mcuY = 0; mcuY < mcusY; mcuY += 1) {
    for (let mcuX = 0; mcuX < mcusX; mcuX += 1) {
      if (restartInterval > 0 && mcuIndex > 0 && mcuIndex % restartInterval === 0) {
        bits.restart();
        predictors.fill(0);
      }
      mcuIndex += 1;
      components.forEach((component, componentIndex) => {
        const plane = planes[componentIndex];
        const tables = scanComponents[componentIndex];
        if (!tables) return;
        const { dcTable, acTable, table } = tables;

        for (let blockY = 0; blockY < component.v; blockY += 1) {
          for (let blockX = 0; blockX < component.h; blockX += 1) {
            const block = new Float32Array(64);
            const dc = decodeHuffman(bits, dcTable);
            const difference = extend(bits.read(dc), dc);
            predictors[componentIndex] += difference;
            block[0] = predictors[componentIndex] * table[0];

            for (let index = 1; index < 64; ) {
              const value = decodeHuffman(bits, acTable);
              const run = value >> 4;
              const size = value & 15;
              if (size === 0) {
                if (run === 15) {
                  index += 16;
                  continue;
                }
                break;
              }
              index += run;
              if (index > 63) break;
              block[ZIGZAG[index]] = extend(bits.read(size), size) * table[ZIGZAG[index]];
              index += 1;
            }

            const output = idct(block);
            const originX = mcuX * component.h + blockX;
            const originY = mcuY * component.v + blockY;
            for (let y = 0; y < 8; y += 1) {
              for (let x = 0; x < 8; x += 1) {
                const atX = originX * 8 + x;
                const atY = originY * 8 + y;
                if (atX >= plane.width || atY >= plane.height) continue;
                const value = output[y * 8 + x] + 128;
                plane.pixels[atY * plane.width + atX] = Math.max(0, Math.min(255, value));
              }
            }
          }
        }
      });
    }
  }

  const sample = (/** @type {number} */ index, /** @type {number} */ x, /** @type {number} */ y) => {
    const plane = planes[index];
    const sx = Math.min(plane.width - 1, Math.floor((x * plane.component.h) / hMax));
    const sy = Math.min(plane.height - 1, Math.floor((y * plane.component.v) / vMax));
    return plane.pixels[sy * plane.width + sx];
  };

  const rgb = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (components.length === 1) {
        const value = Math.round(sample(0, x, y));
        rgb.push([value, value, value]);
      } else {
        const luma = sample(0, x, y);
        const cb = sample(1, x, y) - 128;
        const cr = sample(2, x, y) - 128;
        rgb.push([
          Math.max(0, Math.min(255, Math.round(luma + 1.402 * cr))),
          Math.max(0, Math.min(255, Math.round(luma - 0.344136 * cb - 0.714136 * cr))),
          Math.max(0, Math.min(255, Math.round(luma + 1.772 * cb))),
        ]);
      }
    }
  }

  return { width, height, rgb };
};
