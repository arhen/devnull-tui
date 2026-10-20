// @ts-check
const ZERO_WIDTH = [
  [0x10eeee, 0x10eeee],
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0e31, 0x0e31],
  [0x0e34, 0x0e3a],
  [0x0e47, 0x0e4e],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2064],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef],
];

const WIDE = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f],
  [0x1f680, 0x1f6ff],
  [0x1f900, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
];

const inRanges = (cp, ranges) => {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (cp < ranges[mid][0]) high = mid - 1;
    else if (cp > ranges[mid][1]) low = mid + 1;
    else return true;
  }
  return false;
};

const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function graphemes(text) {
  const out = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const EXTENDED_PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const REGIONAL_INDICATOR = /[\u{1F1E6}-\u{1F1FF}]/u;

export function graphemeWidth(segment) {
  if (!segment) return 0;
  // Terminals draw these two columns wide whatever the East Asian ranges say.
  if (EMOJI_PRESENTATION.test(segment)) return 2;
  if (segment.includes("\uFE0F") && EXTENDED_PICTOGRAPHIC.test(segment)) return 2;
  if (segment.includes("\u20E3")) return 2;
  if ([...segment].filter((char) => REGIONAL_INDICATOR.test(char)).length >= 2) return 2;

  let width = 0;
  let widest = 0;
  for (const char of segment) {
    const cp = char.codePointAt(0);
    if (inRanges(cp, ZERO_WIDTH)) continue;
    const w = inRanges(cp, WIDE) ? 2 : 1;
    widest = Math.max(widest, w);
    width += w;
  }
  if (segment.length > 1 && widest < 2) widest = 1;
  if (segment.includes("\u200d")) return 2;
  return Math.max(widest, width === 0 ? 1 : 0);
}

export function displayWidth(text) {
  if (!text) return 0;
  let width = 0;
  for (const { segment } of segmenter.segment(text)) width += graphemeWidth(segment);
  return width;
}

export function truncate(text, width) {
  if (width <= 0) return "";
  if (displayWidth(text) <= width) return text;
  const out = [];
  let used = 0;
  for (const segment of graphemes(text)) {
    const w = graphemeWidth(segment);
    if (used + w > width - 1) break;
    out.push(segment);
    used += w;
  }
  return out.join("") + "…";
}

// Strips control characters (including escape sequences a commit body may
// contain) and bidi overrides, so nothing in the feed can drive the terminal.
export function sanitize(text) {
  return String(text ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/\t/g, "  ")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** One sanitized line of remote text, for labels, names and answers. */
export function clean(text) {
  return sanitize(text).replace(/\s*\n\s*/g, " ").trim();
}

const ENTITIES = { nbsp: " ", lt: "<", gt: ">", quot: '"', amp: "&", apos: "'" };

/** Strips the markup of a highlighted code block down to its text. */
export function htmlToText(html) {
  return sanitize(String(html ?? "").replace(/<[^>]+>/g, ""))
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number(body.slice(1));
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
      }
      return ENTITIES[body.toLowerCase()] ?? entity;
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Wraps styled tokens into lines of at most `width` columns. Each token is
 * `{ text, kind }`; line breaks inside a token start a new line.
 */
export function wrapTokens(tokens, width) {
  const limit = Math.max(1, width);
  const lines = [];
  let line = [];
  let used = 0;

  const flush = () => {
    lines.push(merge(line));
    line = [];
    used = 0;
  };

  for (const token of tokens) {
    const kind = token.kind ?? "text";
    const parts = sanitize(token.text).split("\n");
    for (let index = 0; index < parts.length; index += 1) {
      if (index > 0) flush();
      for (const segment of graphemes(parts[index])) {
        const w = graphemeWidth(segment);
        if (used + w > limit && used > 0) {
          let spaceAt = -1;
          for (let i = line.length - 1; i > 0; i -= 1) {
            if (line[i].ch === " ") {
              spaceAt = i;
              break;
            }
          }
          if (spaceAt > 0) {
            const tail = line.splice(spaceAt + 1);
            line.pop();
            flush();
            line = tail;
            used = tail.reduce((sum, cell) => sum + cell.w, 0);
          } else {
            flush();
          }
        }
        line.push({ ch: segment, kind, w });
        used += w;
      }
    }
  }
  if (line.length) flush();
  return lines;
}

function merge(line) {
  const pieces = [];
  for (const cell of line) {
    const last = pieces[pieces.length - 1];
    if (last && last.kind === cell.kind) last.text += cell.ch;
    else pieces.push({ kind: cell.kind, text: cell.ch });
  }
  return pieces;
}

export const lineWidth = (pieces) =>
  pieces.reduce((sum, piece) => sum + displayWidth(piece.text), 0);

const TLDS =
  "com|org|net|io|dev|ai|co|app|xyz|me|gg|so|to|tv|fm|site|link|cloud|news|live|pro|art|wiki|store|online|space|studio|design|blog|tech|page|land";

const LINK_PATTERN = new RegExp(
  `https?:\\/\\/[^\\s<>"'\u0060]+` +
    `|\\bwww\\.[^\\s<>"'\u0060]+` +
    `|\\b[a-z0-9][a-z0-9-]*(?:\\.[a-z0-9-]+)*\\.(?:${TLDS})(?![a-z0-9-])[^\\s<>"'\u0060]*`,
  "gi",
);

/** Splits text into plain and link tokens, so links can be drawn underlined. */
export function linkify(text) {
  const tokens = [];
  let last = 0;
  LINK_PATTERN.lastIndex = 0;

  for (const match of text.matchAll(LINK_PATTERN)) {
    const start = match.index ?? 0;
    if (start > last) tokens.push({ kind: "text", text: text.slice(last, start) });
    const link = match[0].replace(/[.,;:!?)\]}]+$/, "");
    tokens.push({ kind: "link", text: link });
    last = start + link.length;
    if (last < start + match[0].length) {
      tokens.push({ kind: "text", text: match[0].slice(link.length) });
      last = start + match[0].length;
    }
  }

  if (last < text.length) tokens.push({ kind: "text", text: text.slice(last) });
  return tokens;
}
