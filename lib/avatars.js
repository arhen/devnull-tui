// @ts-check
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";

import { createHash } from "node:crypto";

import { decodeJpeg } from "./jpeg.js";
import { encodePng } from "./png.js";

export const AVATAR_SIZE = 6;
export const IMAGE_SIZE = 32;
export const AVATAR_COLS = AVATAR_SIZE;
export const AVATAR_ROWS = AVATAR_SIZE / 2;

const RESET = "\x1b[0m";
const PIXEL = "▀";
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CACHE_VERSION = 2;

const AVATAR_HOST = "avatars.githubusercontent.com";
const ID_PATTERN = /^[\w-]{1,64}$/;
const FAILURE_TTL_MS = 60 * 60 * 1000;

const decode = (/** @type {Buffer} */ buffer) => {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return decodeJpeg(buffer);
  return decodePng(buffer);
};

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

/** @type {Map<string, {rows: string[]|null, color: string, png: string|null}|"loading"|"failed">} */
const memory = new Map();

const decodePng = (png) => {
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

/**
 * A colour that reads as the person: the average of the pixels, weighted by how
 * saturated they are, so a white background or dark hair does not wash the hue
 * out. Falls back to the plain average when a picture has no colour at all.
 */
const average = (/** @type {{width: number, height: number, rgb: number[][]}} */ image) => {
  let weightedR = 0;
  let weightedG = 0;
  let weightedB = 0;
  let weight = 0;
  let flatR = 0;
  let flatG = 0;
  let flatB = 0;
  let flat = 0;

  for (const [red, green, blue] of image.rgb) {
    const max = Math.max(red, green, blue);
    const min = Math.min(red, green, blue);
    const light = (max + min) / 510;
    const saturation = max === min ? 0 : (max - min) / (255 - Math.abs(max + min - 255));

    flatR += red;
    flatG += green;
    flatB += blue;
    flat += 1;

    if (light < 0.1 || light > 0.92) continue;
    const share = 0.25 + saturation * 3;
    weightedR += red * share;
    weightedG += green * share;
    weightedB += blue * share;
    weight += share;
  }

  const hex = (/** @type {number} */ value) => Math.round(value).toString(16).padStart(2, "0");
  if (weight > 0) return `#${hex(weightedR / weight)}${hex(weightedG / weight)}${hex(weightedB / weight)}`;
  if (!flat) return null;
  return `#${hex(flatR / flat)}${hex(flatG / flat)}${hex(flatB / flat)}`;
};

/** A stable 28-bit image id for the Kitty graphics protocol. */
export const imageId = (/** @type {{id: string}} */ user) => {
  const digest = createHash("sha1").update(String(user.id)).digest();
  return 1 + (digest.readUInt32BE(0) % 0x0fffffff);
};

/** @param {{width: number, height: number, rgb: number[][]}} image @param {number} x @param {number} y @param {number} layer */
const paint = (image, x, y, layer) => {
  const sx = Math.min(image.width - 1, Math.floor((x * image.width) / AVATAR_SIZE));
  const sy = Math.min(image.height - 1, Math.floor((y * image.height) / AVATAR_SIZE));
  const [r, g, b] = image.rgb[sy * image.width + sx];
  return `\x1b[${layer};2;${r};${g};${b}m`;
};

const rows = (/** @type {any} */ image) => {
  if (!image || image.width < 1 || image.height < 1) return null;
  if (process.env.NO_COLOR || process.env.TERM === "dumb") return null;

  const out = [];
  for (let row = 0; row < AVATAR_ROWS; row += 1) {
    let text = "";
    for (let column = 0; column < AVATAR_COLS; column += 1) {
      text += paint(image, column, row * 2, 38);
      text += paint(image, column, row * 2 + 1, 48);
      text += PIXEL;
    }
    out.push(`${text}${RESET}`);
  }
  return out;
};

const pathFor = (/** @type {{id: string}} */ user) => {
  if (!ID_PATTERN.test(String(user.id))) return null;
  const directory = dir();
  return directory ? join(directory, `${user.id}.json`) : null;
};

const readCache = (/** @type {{id: string}} */ user) => {
  const path = pathFor(user);
  if (!path || !existsSync(path)) return null;
  try {
    const cached = JSON.parse(readFileSync(path, "utf8"));
    const age = Date.now() - (cached.at ?? 0);
    if (cached.failed && age < FAILURE_TTL_MS) return { failed: true };
    if (cached.v !== CACHE_VERSION || age > CACHE_TTL_MS) return null;
    if (typeof cached.color !== "string" || !/^#[0-9a-f]{6}$/i.test(cached.color)) return null;
    const sane = Array.isArray(cached.rows) && cached.rows.every(
      (/** @type {unknown} */ row) => typeof row === "string" && /^(?:\x1b\[[0-9;]*m|▀)+$/.test(row.replace(/\x1b\[0m/g, "")),
    );
    return {
      color: cached.color,
      rows: sane ? cached.rows : null,
      png: typeof cached.png === "string" ? cached.png : null,
    };
  } catch {
    return null;
  }
};

const writeCache = (
  /** @type {{id: string}} */ user,
  /** @type {{rows: string[]|null, color: string|null, png: string|null}|null} */ entry,
) => {
  const path = pathFor(user);
  if (!path) return;
  try {
    writeFileSync(
      path,
      JSON.stringify(
        entry
          ? { v: CACHE_VERSION, at: Date.now(), rows: entry.rows, color: entry.color, png: entry.png }
          : { v: CACHE_VERSION, at: Date.now(), failed: true },
      ),
    );
  } catch {
    // A cold cache only costs one request.
  }
};

/**
 * Returns `{ image }` on an answer, `{ transient: true }` when the failure may
 * pass (offline, timeout, 5xx), and `{ image: null }` when it will not.
 */
const download = async (/** @type {{avatarUrl?: string|null}} */ user) => {
  const url = user.avatarUrl;
  if (!url) return { image: null };
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || parsed.hostname !== AVATAR_HOST) return { image: null };
  } catch {
    return { image: null };
  }
  const parsedUrl = new URL(url);
  parsedUrl.searchParams.set("s", String(IMAGE_SIZE));
  const target = parsedUrl.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(target, {
      signal: controller.signal,
      headers: { "user-agent": "herdr-devnull/0.1 (+https://dev-null.sh)" },
    });
    if (response.status >= 500) return { transient: true };
    if (!response.ok) return { image: null };
    const body = Buffer.from(await response.arrayBuffer());
    const image = decode(body);
    if (!image) return { image: null };
    const png = body[0] === 0x89 && body[1] === 0x50 ? body : encodePng(image);
    return { image, png };
  } catch {
    return { transient: true };
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Returns the half-block rows for a user's avatar, or null while it is not
 * available yet. `onReady` is called once, after a download finishes.
 */
/**
 * The avatar of a user: `rows` are the half-block picture, `color` a hex sample
 * of it for the one-cell circle. Null until the download finishes.
 * @param {any} user
 * @param {(() => void)} [onReady]
 * @returns {{rows: string[]|null, color: string, png: string|null}|null}
 */
export function avatar(user, onReady) {
  if (!user?.id) return null;
  if (process.env.NO_COLOR || process.env.TERM === "dumb") return null;
  const cached = memory.get(user.id);
  if (cached !== undefined) {
    if (cached === "loading" || cached === "failed") return null;
    return cached;
  }

  const stored = readCache(user);
  if (stored?.failed) {
    memory.set(user.id, "failed");
    return null;
  }
  if (stored?.color) {
    const entry = { rows: stored.rows ?? null, color: stored.color, png: stored.png ?? null };
    memory.set(user.id, entry);
    return entry;
  }

  memory.set(user.id, "loading");
  download(user)
    .then((result) => {
      if (result.transient) {
        // Offline now says nothing about later: do not poison the cache.
        memory.delete(user.id);
        return;
      }
      const painted = rows(result.image);
      const color = result.image ? average(result.image) : null;
      if (!color) {
        memory.set(user.id, "failed");
        writeCache(user, null);
        return;
      }
      const entry = { rows: painted ?? null, color, png: result.png ? result.png.toString("base64") : null };
      memory.set(user.id, entry);
      writeCache(user, entry);
      onReady?.();
    })
    .catch(() => memory.delete(user.id));

  return null;
}
