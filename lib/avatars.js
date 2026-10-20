// @ts-check
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

export const AVATAR_SIZE = 6;
export const AVATAR_COLS = AVATAR_SIZE;
export const AVATAR_ROWS = AVATAR_SIZE / 2;

const RESET = "\x1b[0m";
const PIXEL = "▀";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const stateDir = () => {
  const base =
    process.env.HERDR_PLUGIN_STATE_DIR || join(process.env.HOME ?? ".", ".cache", "herdr-devnull");
  return join(base, "avatars");
};

let cacheDir = null;
const dir = () => {
  if (!cacheDir) {
    cacheDir = stateDir();
    try {
      mkdirSync(cacheDir, { recursive: true });
    } catch {
      cacheDir = null;
    }
  }
  return cacheDir;
};

const memory = new Map();

const decode = (png) => {
  if (png.length < 24 || png.readUInt32BE(0) !== 0x89504e47) return null;

  let offset = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  let interlace = 0;
  let palette = null;
  const chunks = [];

  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("latin1", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "PLTE") palette = data;
    else if (type === "IDAT") chunks.push(data);
    else if (type === "IEND") break;
    offset += 12 + length;
  }

  if (!width || !height || bitDepth !== 8 || interlace !== 0) return null;

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  if (!channels) return null;

  let raw;
  try {
    raw = inflateSync(Buffer.concat(chunks));
  } catch {
    return null;
  }

  const stride = width * channels;
  if (raw.length < (stride + 1) * height) return null;

  const pixels = Buffer.alloc(stride * height);
  let previous = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const output = Buffer.alloc(stride);

    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? output[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let value = line[x];

      if (filter === 1) value += left;
      else if (filter === 2) value += up;
      else if (filter === 3) value += (left + up) >> 1;
      else if (filter === 4) {
        const estimate = left + up - upLeft;
        const toLeft = Math.abs(estimate - left);
        const toUp = Math.abs(estimate - up);
        const toUpLeft = Math.abs(estimate - upLeft);
        value += toLeft <= toUp && toLeft <= toUpLeft ? left : toUp <= toUpLeft ? up : upLeft;
      }

      output[x] = value & 0xff;
    }

    pixels.set(output, y * stride);
    previous = output;
  }

  const rgb = [];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = y * stride + x * channels;
      if (colorType === 2 || colorType === 6) rgb.push([pixels[at], pixels[at + 1], pixels[at + 2]]);
      else if (colorType === 3 && palette) {
        const index = pixels[at] * 3;
        rgb.push([palette[index], palette[index + 1], palette[index + 2]]);
      } else {
        const gray = pixels[at];
        rgb.push([gray, gray, gray]);
      }
    }
  }

  return { width, height, rgb };
};

const paint = (rgb, x, y, layer) => {
  const [r, g, b] = rgb[y * AVATAR_SIZE + x];
  return `\x1b[${layer};2;${r};${g};${b}m`;
};

const rows = (image) => {
  if (!image || image.width < AVATAR_SIZE || image.height < AVATAR_SIZE) return null;
  if (process.env.NO_COLOR || process.env.TERM === "dumb") return null;

  const out = [];
  for (let row = 0; row < AVATAR_ROWS; row += 1) {
    let text = "";
    for (let column = 0; column < AVATAR_COLS; column += 1) {
      text += paint(image.rgb, column, row * 2, 38);
      text += paint(image.rgb, column, row * 2 + 1, 48);
      text += PIXEL;
    }
    out.push(`${text}${RESET}`);
  }
  return out;
};

const pathFor = (user) => {
  const directory = dir();
  return directory ? join(directory, `${user.id}.json`) : null;
};

const readCache = (user) => {
  if (!existsSync(pathFor(user) ?? "")) return null;
  try {
    const cached = JSON.parse(readFileSync(pathFor(user), "utf8"));
    if (!cached.rows || Date.now() - (cached.at ?? 0) > CACHE_TTL_MS) return null;
    return cached.rows;
  } catch {
    return null;
  }
};

const writeCache = (user, avatarRows) => {
  const path = pathFor(user);
  if (!path) return;
  try {
    writeFileSync(path, JSON.stringify({ at: Date.now(), rows: avatarRows }));
  } catch {
    // A cold cache only costs one request.
  }
};

const download = async (user) => {
  const url = user.avatarUrl;
  if (!url) return null;
  const target = url.includes("?") ? `${url}&s=${AVATAR_SIZE}` : `${url}?s=${AVATAR_SIZE}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      headers: { "user-agent": "herdr-devnull/0.1 (+https://dev-null.sh)" },
    });
    if (!response.ok) return null;
    return decode(Buffer.from(await response.arrayBuffer()));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Returns the half-block rows for a user's avatar, or null while it is not
 * available yet. `onReady` is called once, after a download finishes.
 */
export function avatarRows(user, onReady) {
  const cached = memory.get(user.id);
  if (cached !== undefined) {
    if (cached === "loading" || cached === "failed") return null;
    return cached;
  }

  const stored = readCache(user);
  if (stored) {
    memory.set(user.id, stored);
    return stored;
  }

  memory.set(user.id, "loading");
  download(user)
    .then((image) => {
      const painted = rows(image);
      if (!painted) {
        memory.set(user.id, "failed");
        return;
      }
      memory.set(user.id, painted);
      writeCache(user, painted);
      onReady?.();
    })
    .catch(() => memory.set(user.id, "failed"));

  return null;
}
