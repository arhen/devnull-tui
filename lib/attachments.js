// @ts-check
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// What /dev/null's commit form takes, from CreateCommitImages and
// CreateCommitRequest::attachmentRules: up to three JPEG, PNG or WebP images
// of at most 10 MB each, checked by content and never by extension.
export const MAX_IMAGES = 3;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const IMAGE_HINT = "JPEG, PNG or WebP up to 10 MB each";

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ascii = (/** @type {Buffer} */ bytes, /** @type {number} */ start, /** @type {number} */ length) =>
  bytes.toString("latin1", start, start + length);

/** @param {Buffer} bytes */
const imageType = (bytes) => {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return "image/png";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  return null;
};

/**
 * What a file is, named the way a person would: an accepted image type, or the
 * reason it is not one.
 * @param {Buffer} bytes
 */
export function describeType(bytes) {
  const type = imageType(bytes);
  if (type) return { type, label: type.slice(6).toUpperCase() };

  if (ascii(bytes, 4, 4) === "ftyp") {
    const brand = ascii(bytes, 8, 4);
    if (brand === "avif" || brand === "avis") return { type: null, label: "AVIF" };
    if (/^(heic|heix|hevc|heim|heis|mif1|msf1)$/.test(brand)) return { type: null, label: "HEIC" };
    return { type: null, label: "a video" };
  }
  if (ascii(bytes, 0, 4) === "GIF8") return { type: null, label: "a GIF" };
  if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { type: null, label: "a video" };
  }
  if (ascii(bytes, 0, 4) === "OggS") return { type: null, label: "a video" };
  if (ascii(bytes, 0, 5) === "%PDF-") return { type: null, label: "a PDF" };
  if (/^\s*(<\?xml[^>]*>\s*)?<svg/i.test(bytes.toString("utf8", 0, Math.min(bytes.length, 200)))) {
    return { type: null, label: "an SVG" };
  }
  return { type: null, label: "not an image" };
}

/** @param {string} raw */
const expand = (raw) => {
  let text = raw.trim();
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(text);
  if (quoted) {
    text = quoted[1] === '"' ? quoted[2].replace(/\\(["\\$`])/g, "$1") : quoted[2];
  } else {
    text = text.replace(/\\(.)/g, "$1");
  }
  if (text.startsWith("file:")) {
    try {
      text = fileURLToPath(text);
    } catch {
      // Not a file URL after all: keep it as typed.
    }
  }
  if (text === "~") return homedir();
  if (text.startsWith("~/")) return homedir() + text.slice(1);
  return text;
};

/** @param {string} path */
const resolvePath = (path) => (isAbsolute(path) ? path : resolve(process.cwd(), path));

/** @param {string} path */
const existingFile = async (path) => {
  try {
    const info = await stat(resolvePath(path));
    return info.isFile() ? resolvePath(path) : null;
  } catch {
    return null;
  }
};

/**
 * Whitespace-separated tokens, keeping quotes and backslash escapes so a path
 * with spaces survives Finder's or a shell's idea of quoting it.
 * @param {string} line
 */
const tokensOf = (line) => {
  const tokens = [];
  let current = "";
  let quote = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      current += char;
      if (char === quote) quote = "";
      continue;
    }
    if (char === "\\") {
      current += char + (line[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) tokens.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  if (current) tokens.push(current);
  return tokens;
};

/**
 * The paths a drop or a paste carries, or null when the text is something else.
 * Herdr pastes a dropped file as its path, one per line, and a shell may add
 * quoting or escaping; both forms are accepted here.
 * @param {string} text
 * @returns {Promise<string[]|null>}
 */
export async function droppedPaths(text) {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) return null;

  const paths = [];
  for (const line of lines) {
    const whole = await existingFile(expand(line));
    if (whole) {
      paths.push(whole);
      continue;
    }
    const tokens = tokensOf(line);
    if (tokens.length < 2) return null;
    const parts = [];
    for (const token of tokens) {
      const part = await existingFile(expand(token));
      if (!part) return null;
      parts.push(part);
    }
    paths.push(...parts);
  }
  return paths;
}

/**
 * A readable image, or why the file cannot be attached. The type comes from
 * the bytes, so a renamed video or SVG is refused here as the server would.
 * @param {string} path
 * @returns {Promise<{image?: {path: string, name: string, type: string, size: number, bytes: Buffer}, error?: string}>}
 */
export async function readAttachment(path) {
  const absolute = resolvePath(path);
  const name = basename(absolute);
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return { error: `${name} is not a file` };
    if (info.size === 0) return { error: `${name} is empty` };
    if (info.size > MAX_IMAGE_BYTES) return { error: `${name} is larger than 10 MB` };

    const bytes = await readFile(absolute);
    const { type, label } = describeType(bytes);
    if (!type) return { error: `${name} is ${label} — /dev/null takes ${IMAGE_HINT}` };

    return { image: { path: absolute, name, type, size: bytes.length, bytes } };
  } catch {
    return { error: `could not read ${name}` };
  }
}

const TOKEN = /(?:'[^']*'|"[^"]*"|`[^`]*`|\\.|[^\s])+/g;

/**
 * Pulls the images a draft names out of its text, for a drop that arrived as
 * typed characters instead of one paste: a path that is not an image stays in
 * the body as typed.
 * @param {string} text
 * @returns {Promise<{body: string, images: {path: string, name: string, type: string, size: number, bytes: Buffer}[]}>}
 */
export async function extractImages(text) {
  /** @type {{path: string, name: string, type: string, size: number, bytes: Buffer}[]} */
  const images = [];
  /** @type {[number, number][]} */
  const cuts = [];

  for (const match of text.matchAll(TOKEN)) {
    const raw = match[0];
    if (!/[./~]/.test(raw)) continue;
    const path = expand(raw);
    if (!isAbsolute(path) && !path.includes("/")) continue;

    const found = await readAttachment(path);
    if (!found.image) continue;
    images.push(found.image);
    const start = match.index ?? 0;
    cuts.push([start, start + raw.length]);
  }

  if (!cuts.length) return { body: text, images };

  let body = "";
  let cursor = 0;
  for (const [start, end] of cuts) {
    body += text.slice(cursor, start);
    cursor = end;
  }
  body += text.slice(cursor);

  return { body: body.replace(/ {2,}/g, " ").trim(), images };
}

/** @param {number} bytes */
export const humanSize = (bytes) =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
