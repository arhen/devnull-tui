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
const USER_AGENT = "herdr-devnull/0.1 (+https://dev-null.sh)";
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_COLUMNS = 56;
const MAX_ROWS = 14;
const TIMEOUT_MS = 10000;

/** @typedef {{width: number, height: number, rgb: number[][]}} Decoded */

// A converter is picked once and reused; the ones ahead of it are only tried
// when it is not installed.
/** @type {[string, (input: string, output: string, size: {width: number, height: number}) => string[]][]} */
const CONVERTERS = [
  ["dwebp", (input, output, size) => {
    const scale = size.width && size.height ? ["-scale", String(Math.min(480, size.width)), String(Math.max(1, Math.round((Math.min(480, size.width) * size.height) / size.width)))] : [];
    return ["-quiet", ...scale, "-o", output, input];
  }],
  ["sips", (input, output) => ["-s", "format", "png", "-Z", "480", input, "--out", output]],
  ["ffmpeg", (input, output) => ["-v", "error", "-y", "-i", input, "-frames:v", "1", "-vf", "scale='min(480,iw)':-1", output]],
  ["magick", (input, output) => [input, output]],
  ["convert", (input, output) => [input, output]],
  ["vips", (input, output) => ["copy", input, output]],
];

/** @type {string|null} */
let converter = null;

const stateDir = () => {
  const base =
    process.env.HERDR_PLUGIN_STATE_DIR || join(process.env.HOME ?? ".", ".cache", "herdr-devnull");
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

const cachedPng = (/** @type {string} */ id) => {
  const directory = dir();
  if (!directory) return null;
  const path = join(directory, `${keyOf(id)}.png`);
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
    writeFileSync(join(directory, `${keyOf(id)}.png`), png);
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
  const input = join(tmpdir(), `herdr-devnull-${stamp}.webp`);
  const output = join(tmpdir(), `herdr-devnull-${stamp}.png`);
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

/** @typedef {{state: "loading"} | {state: "failed", reason: string} | {state: "ready", image: Decoded}} Entry */

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
      settle(image.id, { state: "ready", image: decoded });
    } catch {
      settle(image.id, { state: "failed", reason: "image could not be read" });
    }
  })();
};

/**
 * Two pixels per cell: a colour pair and a half block, repeated. The source is
 * sampled to the size the pane gives it, keeping the picture's shape.
 * @param {Decoded} source
 * @param {number} columns
 * @returns {{lines: string[], columns: number}}
 */
const halfBlocks = (source, columns) => {
  const ratio = source.height / Math.max(1, source.width);
  let cols = Math.max(4, Math.min(columns, MAX_COLUMNS));
  let rows = Math.max(1, Math.round((cols * ratio) / 2));
  if (rows > MAX_ROWS) {
    rows = MAX_ROWS;
    cols = Math.max(4, Math.min(cols, Math.round((rows * 2) / Math.max(0.01, ratio))));
  }

  const pixelRows = rows * 2;
  /** @type {string[]} */
  const lines = [];
  for (let row = 0; row < rows; row += 1) {
    const top = Math.min(source.height - 1, Math.floor((row * 2 * source.height) / pixelRows));
    const bottom = Math.min(source.height - 1, Math.floor(((row * 2 + 1) * source.height) / pixelRows));
    let line = "";
    let lastFg = "";
    let lastBg = "";
    for (let col = 0; col < cols; col += 1) {
      const x = Math.min(source.width - 1, Math.floor((col * source.width) / cols));
      const upper = source.rgb[top * source.width + x];
      const lower = source.rgb[bottom * source.width + x];
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
 * @returns {{lines: string[], columns: number}|null}
 */
export function picture(image, columns, onReady) {
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

  const key = `${image.id}:${columns}`;
  const done = rendered.get(key);
  if (done) return done;

  const result = halfBlocks(entry.image, columns);
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
