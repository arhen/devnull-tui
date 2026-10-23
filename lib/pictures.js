// @ts-check
// Attached images arrive as WebP, and Node has no WebP decoder. The file is
// converted to PNG by whichever tool the machine has, decoded with the PNG
// reader the avatars already use, and drawn as half blocks: two pixels to a
// cell, no graphics protocol, so it survives redraws, scrollback and every
// terminal.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { decodePng } from "./avatars.js";

const run = promisify(execFile);

const HOST = "dev-null.sh";
const USER_AGENT = "devnull-tui/0.1 (+https://github.com/arhen/devnull-tui)";
const MAX_BYTES = 8 * 1024 * 1024;
// Enough pixels for the widest box the pane draws, so the terminal scales down.
const CONVERT_WIDTH = 768;
const CACHE_VERSION = 2;
const MAX_COLUMNS = 96;
const MAX_ROWS = 22;
const TIMEOUT_MS = 10000;

/** @typedef {{width: number, height: number, rgb: number[][]}} Decoded */

// A converter is picked once and reused; the ones ahead of it are only tried
// when it is not installed.
/** @type {[string, (input: string, output: string, size: {width: number, height: number}) => string[]][]} */
const CONVERTERS = [
  ["dwebp", (input, output, size) => {
    const width = Math.min(CONVERT_WIDTH, size.width || CONVERT_WIDTH);
    const scale = size.width && size.height
      ? ["-scale", String(width), String(Math.max(1, Math.round((width * size.height) / size.width)))]
      : [];
    return ["-quiet", ...scale, "-o", output, input];
  }],
  ["sips", (input, output) => ["-s", "format", "png", "-Z", String(CONVERT_WIDTH), input, "--out", output]],
  ["ffmpeg", (input, output) => ["-v", "error", "-y", "-i", input, "-frames:v", "1", "-vf", "scale='min(768,iw)':-1", output]],
  ["magick", (input, output) => [input, output]],
  ["convert", (input, output) => [input, output]],
  ["vips", (input, output) => ["copy", input, output]],
];

/** @type {string|null} */
let converter = null;

const stateDir = () => {
  const base =
    process.env.HERDR_PLUGIN_STATE_DIR || join(process.env.HOME ?? ".", ".cache", "devnull-tui");
  return join(base, "pictures");
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

const keyOf = (/** @type {string} */ id) =>
  /^[\w-]{1,64}$/.test(id) ? id : createHash("sha256").update(id).digest("hex").slice(0, 32);

/** A stable Kitty image id: a number the terminal can name the picture by. */
const numericId = (/** @type {string} */ id) =>
  (Number.parseInt(createHash("sha256").update(id).digest("hex").slice(0, 8), 16) % 0x7fffffff) + 1;

const cachedPng = (/** @type {string} */ id) => {
  const directory = dir();
  if (!directory) return null;
  const path = join(directory, `${CACHE_VERSION}-${keyOf(id)}.png`);
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
};

const storePng = (/** @type {string} */ id, /** @type {Buffer} */ png) => {
  const directory = dir();
  if (!directory) return;
  try {
    writeFileSync(join(directory, `${CACHE_VERSION}-${keyOf(id)}.png`), png);
  } catch {
    // A cold cache only costs one conversion.
  }
};

const readable = (/** @type {string} */ url) => {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === HOST;
  } catch {
    return false;
  }
};

const download = async (/** @type {string} */ url) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": USER_AGENT, accept: "image/webp,image/*" },
    });
    if (!response.ok) return null;
    const body = Buffer.from(await response.arrayBuffer());
    return body.length > 0 && body.length <= MAX_BYTES ? body : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

const convert = async (
  /** @type {Buffer} */ bytes,
  /** @type {{width: number, height: number}} */ size,
) => {
  const stamp = `${process.pid}-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
  const input = join(tmpdir(), `devnull-tui-${stamp}.webp`);
  const output = join(tmpdir(), `devnull-tui-${stamp}.png`);
  try {
    writeFileSync(input, bytes);
  } catch {
    return null;
  }

  const candidates = converter ? CONVERTERS.filter(([name]) => name === converter) : CONVERTERS;
  try {
    for (const [name, args] of candidates) {
      try {
        await run(name, args(input, output, size), { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 });
        if (existsSync(output)) {
          converter = name;
          return readFileSync(output);
        }
      } catch (error) {
        const code = /** @type {any} */ (error)?.code;
        if (code === "ENOENT" || code === "EACCES") continue;
        // The tool ran and could not read the file: another one may.
      }
    }
    return null;
  } finally {
    rmSync(input, { force: true });
    rmSync(output, { force: true });
  }
};

/** @typedef {{state: "loading"} | {state: "failed", reason: string} | {state: "ready", image: Decoded, png: Buffer, native: number}} Entry */

/** @type {Map<string, Entry>} */
const entries = new Map();
/** @type {Map<string, {lines: string[], columns: number}>} */
const rendered = new Map();

/** @type {Map<string, (() => void)[]>} */
const waiting = new Map();

/** @param {string} id @param {Entry} entry */
const settle = (id, entry) => {
  entries.set(id, entry);
  for (const callback of waiting.get(id) ?? []) callback();
  waiting.delete(id);
};

/**
 * @param {{id: string, url: string, width?: number, height?: number}} image
 * @param {(() => void)|undefined} onReady
 */
const start = (image, onReady) => {
  entries.set(image.id, { state: "loading" });
  waiting.set(image.id, onReady ? [onReady] : []);
  void (async () => {
    try {
      let png = cachedPng(image.id);
      if (!png) {
        const bytes = await download(image.url);
        if (!bytes) return settle(image.id, { state: "failed", reason: "image could not be downloaded" });
        png = await convert(bytes, { width: image.width ?? 0, height: image.height ?? 0 });
        if (!png) return settle(image.id, { state: "failed", reason: "no WebP decoder (install dwebp)" });
      }
      const decoded = decodePng(png);
      if (!decoded) return settle(image.id, { state: "failed", reason: "image format not readable" });
      storePng(image.id, png);
      settle(image.id, { state: "ready", image: decoded, png, native: numericId(image.id) });
    } catch {
      settle(image.id, { state: "failed", reason: "image could not be read" });
    }
  })();
};

/**
 * The source pixels one cell covers, averaged. Nearest-neighbour sampling
 * turns a downscale into stripes and stray pixels; averaging keeps the picture
 * readable at the size the pane gives it.
 * @param {Decoded} source
 * @param {number} x0
 * @param {number} x1
 * @param {number} y0
 * @param {number} y1
 * @returns {number[]}
 */
const average = (source, x0, x1, y0, y1) => {
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) {
    const offset = y * source.width;
    for (let x = x0; x < x1; x += 1) {
      const pixel = source.rgb[offset + x];
      red += pixel[0];
      green += pixel[1];
      blue += pixel[2];
      count += 1;
    }
  }
  if (!count) return [0, 0, 0];
  return [Math.round(red / count), Math.round(green / count), Math.round(blue / count)];
};

/** The half-open source range a cell or pixel row covers. */
const span = (/** @type {number} */ index, /** @type {number} */ count, /** @type {number} */ size) => {
  const start = Math.min(size - 1, Math.floor((index * size) / count));
  const end = Math.min(size, Math.max(start + 1, Math.floor(((index + 1) * size) / count)));
  return /** @type {const} */ ([start, end]);
};

/**
 * How many cells a picture takes: the width it is given, the height its shape
 * asks for, capped. One cell is two pixels tall, so the height is halved.
 * @param {number} width
 * @param {number} height
 * @param {number} columns
 * @param {number} [maxRows]
 * @returns {{columns: number, rows: number}}
 */
export const boxFor = (width, height, columns, maxRows = MAX_ROWS) => {
  const ratio = height / Math.max(1, width);
  const limit = Math.max(2, Math.min(maxRows, MAX_ROWS));
  let cols = Math.max(4, Math.min(columns, MAX_COLUMNS));
  let rows = Math.max(1, Math.round((cols * ratio) / 2));
  if (rows > limit) {
    rows = limit;
    cols = Math.max(4, Math.min(cols, Math.round((rows * 2) / Math.max(0.01, ratio))));
  }
  return { columns: cols, rows };
};

/**
 * Two pixels per cell: a colour pair and a half block, repeated. The source is
 * averaged down to the size the pane gives it, keeping the picture's shape.
 * @param {Decoded} source
 * @param {number} columns
 * @param {number} maxRows
 * @returns {{lines: string[], columns: number}}
 */
const halfBlocks = (source, columns, maxRows) => {
  const { columns: cols, rows } = boxFor(source.width, source.height, columns, maxRows);
  const pixelRows = rows * 2;
  const xSpans = Array.from({ length: cols }, (_, index) => span(index, cols, source.width));
  const ySpans = Array.from({ length: pixelRows }, (_, index) => span(index, pixelRows, source.height));
  /** @type {string[]} */
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    const [topStart, topEnd] = ySpans[row * 2];
    const [bottomStart, bottomEnd] = ySpans[row * 2 + 1];
    let line = "";
    let lastFg = "";
    let lastBg = "";
    for (let col = 0; col < cols; col += 1) {
      const [start, end] = xSpans[col];
      const upper = average(source, start, end, topStart, topEnd);
      const lower = average(source, start, end, bottomStart, bottomEnd);
      const fg = `\x1b[38;2;${upper[0]};${upper[1]};${upper[2]}m`;
      const bg = `\x1b[48;2;${lower[0]};${lower[1]};${lower[2]}m`;
      if (fg !== lastFg) {
        line += fg;
        lastFg = fg;
      }
      if (bg !== lastBg) {
        line += bg;
        lastBg = bg;
      }
      line += "▀";
    }
    lines.push(`${line}\x1b[0m`);
  }

  return { lines, columns: cols };
};

/**
 * The half-block rows of an image, or null while it is still on its way. The
 * first call starts the download; `onReady` fires once it finishes.
 * @param {{id: string, url: string, width?: number, height?: number}} image
 * @param {number} columns
 * @param {(() => void)} [onReady]
 * @param {number} [maxRows]
 * @returns {{lines: string[], columns: number}|null}
 */
export function picture(image, columns, onReady, maxRows = MAX_ROWS) {
  if (!image?.id || !readable(image.url)) return null;

  let entry = entries.get(image.id);
  if (!entry) {
    start(image, onReady);
    entry = entries.get(image.id);
  } else if (entry.state === "loading" && onReady) {
    const callbacks = waiting.get(image.id) ?? [];
    if (!callbacks.includes(onReady)) callbacks.push(onReady);
    waiting.set(image.id, callbacks);
  }

  if (entry?.state !== "ready") return null;

  const key = `${image.id}:${columns}:${maxRows}`;
  const done = rendered.get(key);
  if (done) return done;

  const result = halfBlocks(entry.image, columns, maxRows);
  rendered.set(key, result);
  return result;
}

/**
 * Why an image has no rows: the failure, or that it is still loading.
 * @param {{id: string, url: string}} image
 * @returns {string|null}
 */
export function pictureError(image) {
  if (!image?.id || !readable(image.url)) return "image link not readable";
  const entry = entries.get(image.id);
  return entry?.state === "failed" ? entry.reason : null;
}

/**
 * Whether the terminal around the pane speaks the Kitty graphics protocol.
 * Herdr forwards it when its own terminal.kitty_graphics is on (the default).
 */
export function supportsNativeImages() {
  if (process.env.NO_COLOR || process.env.TERM === "dumb") return false;
  const term = String(process.env.TERM ?? "");
  const program = String(process.env.TERM_PROGRAM ?? "");
  return (
    Boolean(process.env.KITTY_WINDOW_ID) ||
    term.includes("kitty") ||
    program === "ghostty" ||
    program === "kitty" ||
    program === "WezTerm" ||
    Boolean(process.env.WEZTERM_PANE)
  );
}

/** Images whose bytes the terminal already holds, by numeric id. */
const transmitted = new Set();

/** The PNG, in base64 chunks, as the terminal takes it. */
const transmit = (/** @type {number} */ id, /** @type {Buffer} */ png) => {
  const payload = png.toString("base64");
  const chunks = payload.match(/.{1,4096}/g) ?? [""];
  const head = `\x1b_Gi=${id},f=100,a=t,t=d,q=2`;
  let out = `${head},m=${chunks.length > 1 ? 1 : 0};${chunks[0]}\x1b\\`;
  for (let index = 1; index < chunks.length; index += 1) {
    out += `\x1b_Gm=${index < chunks.length - 1 ? 1 : 0};${chunks[index]}\x1b\\`;
  }
  return out;
};

/** Puts a transmitted image at the cursor, in the cells it was given. */
const place = (/** @type {number} */ id, /** @type {number} */ columns, /** @type {number} */ rows) =>
  `\x1b_Gi=${id},a=p,c=${columns},r=${rows},q=2\x1b\\`;

/** Forgets an image and its placements. */
const forget = (/** @type {number} */ id) => `\x1b_Gi=${id},a=d,d=i,q=2\x1b\\`;

/**
 * The image the terminal can draw itself, or null while it is on its way.
 * @param {{id: string, url: string, width?: number, height?: number}} image
 * @param {number} columns
 * @param {number} [maxRows]
 * @param {(() => void)} [onReady]
 * @returns {{id: number, png: Buffer, columns: number, rows: number}|null}
 */
export function nativePicture(image, columns, maxRows = MAX_ROWS, onReady) {
  if (!image?.id || !readable(image.url)) return null;
  const entry = entries.get(image.id);
  if (!entry?.state || entry.state === "loading") {
    if (!entry) start(image, onReady);
    else if (onReady) {
      const callbacks = waiting.get(image.id) ?? [];
      if (!callbacks.includes(onReady)) callbacks.push(onReady);
      waiting.set(image.id, callbacks);
    }
    return null;
  }
  if (entry.state !== "ready") return null;
  const box = boxFor(entry.image.width, entry.image.height, columns, maxRows);
  return { id: entry.native, png: entry.png, columns: box.columns, rows: box.rows };
}

/**
 * What to write for a frame's images: the pictures that moved are placed again,
 * the ones that left the screen are forgotten. A picture keeps its place when
 * its cells did not change, so a redraw never makes it flicker.
 * @param {{id: number, png: Buffer, row: number, col: number, columns: number, rows: number}[]} placements
 * @param {Map<number, string>} placed
 * @returns {{output: string, placed: Map<number, string>}}
 */
export function placementOutput(placements, placed) {
  let output = "";
  /** @type {Map<number, string>} */
  const next = new Map();
  for (const image of placements ?? []) {
    const signature = `${image.row}:${image.col}:${image.columns}:${image.rows}`;
    next.set(image.id, signature);
    if (placed.get(image.id) === signature) continue;
    // Moving a picture means forgetting the old placement first: the protocol
    // would otherwise leave it behind and show the image twice.
    if (placed.has(image.id)) {
      output += forget(image.id);
      transmitted.delete(image.id);
    }
    output += `\x1b[${image.row};${image.col}H`;
    if (!transmitted.has(image.id)) {
      output += transmit(image.id, image.png);
      transmitted.add(image.id);
    }
    output += place(image.id, image.columns, image.rows);
  }
  for (const id of placed.keys()) {
    if (next.has(id)) continue;
    output += forget(id);
    transmitted.delete(id);
  }
  return { output, placed: next };
}

/** Drops every image this program put on screen. */
export function resetImages() {
  transmitted.clear();
  return "\x1b_Ga=d,d=A,q=2\x1b\\";
}
