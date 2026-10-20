// @ts-check
import { AVATAR_COLS, avatar } from "./avatars.js";
import { clean, displayWidth, graphemeWidth, graphemes, sanitize, truncate, wrapTokens } from "./text.js";

const noColor =
  Boolean(process.env.NO_COLOR) || process.env.TERM === "dumb" || !process.stdout.isTTY;
const RESET = noColor ? "" : "\x1b[0m";

const rgb = (hex, layer) => {
  if (noColor) return "";
  const value = Number.parseInt(hex.slice(1), 16);
  return `\x1b[${layer};2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m`;
};

/** @param {string} hex */
export const fg = (hex) => rgb(hex, 38);
/** @param {string} hex */
export const bg = (hex) => rgb(hex, 48);
export const bold = noColor ? "" : "\x1b[1m";
export const dim = noColor ? "" : "\x1b[2m";
export const italic = noColor ? "" : "\x1b[3m";
export const underline = noColor ? "" : "\x1b[4m";

const T = {
  text: "#e6e8ec",
  name: "#f3f4f7",
  muted: "#8b9099",
  faint: "#5f6570",
  code: "#c9a6ff",
  link: "#8ab4ff",
  brand: "#e7a3ff",
  tab: "#9aa0aa",
  good: "#6ee787",
  bad: "#ff7a7a",
  rule: "#33363d",
  selected: "#1d2029",
};

const COMPACT_RAIL = 2;

class Row {
  /** @param {string} [base] */
  constructor(base = "") {
    this.base = base;
    this.parts = [];
    this.width = 0;
  }

  /**
   * @param {string} text
   * @param {...string} codes
   */
  add(text, ...codes) {
    if (!text) return this;
    // Every string that reaches a row is remote content or an error message:
    // strip control bytes here so no path can send escape sequences.
    const safe = sanitize(text).replace(/\n/g, " ");
    if (!safe) return this;
    const style = codes.filter(Boolean).join("");
    this.parts.push(`${this.base}${style}${safe}${RESET}`);
    this.width += displayWidth(safe);
    return this;
  }

  /**
   * @param {string} text already styled
   * @param {number} width
   */
  raw(text, width) {
    this.parts.push(text);
    this.width += width;
    return this;
  }

  /** @param {number} [count] */
  space(count = 1) {
    return this.add(" ".repeat(Math.max(0, count)));
  }

  /** @param {number} width */
  fill(width) {
    if (this.width < width) this.space(width - this.width);
    return this;
  }

  toString() {
    return this.parts.length ? `${this.parts.join("")}${RESET}` : "";
  }
}

/**
 * @param {string} iso
 * @param {number} [now]
 */
export function ago(iso, now = Date.now()) {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "—";
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo`;
  return `${Math.round(months / 12)}y`;
}

// Lane colours come from the web, where they sit on a card. On a terminal they
// carry the rail, so lift dark lanes until they stay readable.
const legible = (hex) => {
  const value = Number.parseInt(hex.slice(1), 16);
  let r = (value >> 16) & 255;
  let g = (value >> 8) & 255;
  let b = value & 255;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (luminance < 0.42) {
    const lift = ((0.42 - luminance) / 0.42) * 0.8;
    r = Math.round(r + (255 - r) * lift);
    g = Math.round(g + (255 - g) * lift);
    b = Math.round(b + (255 - b) * lift);
  }
  return `#${[r, g, b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
};

/** @param {string} hex @param {number} factor */
const darken = (hex, factor) => {
  const value = Number.parseInt(hex.slice(1), 16);
  const channels = [(value >> 16) & 255, (value >> 8) & 255, value & 255];
  return `#${channels
    .map((channel) => Math.round(channel * factor).toString(16).padStart(2, "0"))
    .join("")}`;
};

const trimTrailingEmpty = (lines) => {
  const out = [...lines];
  const blank = (/** @type {{text: string}[]} */ line) => line.every((piece) => piece.text.trim() === "");
  while (out.length && blank(out[out.length - 1])) out.pop();
  return out;
};

/**
 * @param {{name: string, handle: string, time: string}} header
 * @param {number} budget
 */
const fitHeader = ({ name, handle, time }, budget) => {
  const total = () => displayWidth(name) + 1 + displayWidth(handle) + displayWidth(time);
  if (total() > budget) time = "";
  if (total() > budget) handle = truncate(handle, Math.max(0, budget - displayWidth(name) - 1));
  if (total() > budget) name = truncate(name, Math.max(1, budget));
  return { name, handle, time };
};

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
};

/**
 * @param {any} commit
 * @param {{mode?: "circle"|"photo"|"none", onReady?: () => void}} [options]
 */
const railFor = (commit, { mode = "circle", onReady } = {}) => {
  const laneHex = legible(commit.author.lane);
  const lane = fg(laneHex);
  const width = mode === "photo" ? AVATAR_COLS + 1 : COMPACT_RAIL;

  const connector = () => {
    const row = new Row();
    row.add("○", lane, dim);
    row.space(width - 1);
    return row;
  };

  if (mode === "circle") {
    // One circle before the name, in a colour sampled from the real photo, so
    // the rail costs two columns instead of a picture's worth of cells.
    const sampled = avatar(commit.author, onReady)?.color ?? laneHex;

    return {
      width,
      connector,
      /** @param {number} index */
      prefix: (index) => {
        const row = new Row();
        row.add(index === 0 ? "⬤ " : "│ ", fg(legible(sampled)));
        return row;
      },
    };
  }

  if (mode === "none") {
    return {
      width,
      connector,
      /** @param {number} index */
      prefix: (index) => {
        const row = new Row();
        row.add(index === 0 ? "● " : "│ ", lane);
        return row;
      },
    };
  }

  const rows = avatar(commit.author, onReady)?.rows ?? null;
  const chip = `${bg(darken(laneHex, 0.32))}${" ".repeat(AVATAR_COLS)}${RESET}`;

  return {
    width,
    connector,
    /** @param {number} index */
    prefix: (index) => {
      const row = new Row();
      if (rows && index >= 0 && index < rows.length) row.raw(rows[index], AVATAR_COLS);
      else if (!rows && index >= 0 && index < AVATAR_COLS / 2) row.raw(chip, AVATAR_COLS);
      else {
        row.add("│", lane);
        row.space(AVATAR_COLS - 1);
      }
      row.space(1);
      return row;
    },
  };
};

const compactRail = (commit) => {
  const laneHex = legible(commit.author.lane);
  const lane = fg(laneHex);
  return {
    width: COMPACT_RAIL,
    connector: () => {
      const row = new Row();
      row.add("○ ", lane, dim);
      return row;
    },
    /** @param {number} index */
    prefix: (index) => {
      const row = new Row();
      row.add(index === 0 ? "● " : "│ ", lane);
      return row;
    },
  };
};

const renderSegment = (/** @type {Row} */ row, /** @type {{kind: string, text: string}} */ piece) => {
  if (piece.kind === "code") row.add(piece.text, fg(T.code));
  else if (piece.kind === "link") row.add(piece.text, fg(T.link), underline);
  else row.add(piece.text, fg(T.text));
};

/**
 * @param {any} commit
 * @param {{
 *   width: number,
 *   now: number,
 *   selected?: boolean,
 *   rail?: {width: number, prefix: (index: number) => Row, connector: () => Row},
 *   indent?: number,
 *   counts?: boolean,
 *   expandable?: number,
 *   childrenLoaded?: boolean,
 *   preview?: boolean,
 * }} options
 */
const buildCommit = (commit, options) => {
  const width = options.width;
  const now = options.now;
  const indent = options.indent ?? 0;
  const rail = options.rail ?? compactRail(commit);
  const counts = options.counts !== false;
  const base = options.selected ? bg(T.selected) : "";
  const lane = fg(legible(commit.author.lane));
  const contentWidth = Math.max(8, width - rail.width - indent);
  /** @type {Row[]} */
  const rows = [];

  const push = (/** @type {Row} */ row, /** @type {number} */ index) => {
    const prefixed = new Row(base);
    const prefix = rail.prefix(index);
    prefixed.parts.push(prefix.toString());
    prefixed.width += prefix.width;
    if (indent) prefixed.space(indent);
    prefixed.parts.push(row.toString());
    prefixed.width += row.width;
    rows.push(prefixed);
  };

  const header = new Row(base);
  const fitted = fitHeader(
    {
      name: commit.author.name,
      handle: `@${commit.author.username}`,
      time: ` · ${ago(commit.createdAt, now)}`,
    },
    contentWidth - (contentWidth >= 40 ? commit.shortHash.length + 2 : 0),
  );

  header.add(fitted.name, bold, fg(T.name));
  if (fitted.handle) header.add(` ${fitted.handle}`, fg(legible(commit.author.lane)));
  if (fitted.time) header.add(fitted.time, fg(T.faint));
  if (contentWidth >= 40) {
    header.space(Math.max(1, contentWidth - header.width - commit.shortHash.length));
    header.add(commit.shortHash, fg(T.faint), dim);
  }
  if (options.selected) header.fill(contentWidth);
  push(header, 0);

  const body = trimTrailingEmpty(wrapTokens(commit.segments, contentWidth));
  body.forEach((line, index) => {
    const row = new Row(base);
    for (const piece of line) renderSegment(row, piece);
    push(row, index + 1);
  });

  if (commit.quote || commit.quoteMissing) {
    const innerWidth = Math.max(8, contentWidth - 3);
    if (commit.quote) {
      const quote = commit.quote;
      const quoteLane = fg(legible(quote.author.lane));
      const quoteHeader = fitHeader(
        {
          name: quote.author.name,
          handle: `@${quote.author.username}`,
          time: ` · ${ago(quote.createdAt, now)}`,
        },
        innerWidth,
      );
      const head = new Row(base);
      head.add("┃ ", quoteLane);
      head.add(quoteHeader.name, bold, fg(T.name));
      if (quoteHeader.handle) head.add(` ${quoteHeader.handle}`, quoteLane);
      if (quoteHeader.time) head.add(quoteHeader.time, fg(T.faint));
      push(head, rows.length);

      const quoted = trimTrailingEmpty(wrapTokens(quote.segments, innerWidth));
      for (const line of quoted.slice(0, 5)) {
        const row = new Row(base);
        row.add("┃ ", quoteLane);
        for (const piece of line) {
          if (piece.kind === "code") row.add(piece.text, fg(T.code));
          else if (piece.kind === "link") row.add(piece.text, fg(T.link), underline);
          else row.add(piece.text, fg(T.muted));
        }
        push(row, rows.length);
      }
      if (quoted.length > 5) {
        const row = new Row(base);
        row.add("┃ ", quoteLane);
        row.add("…", fg(T.faint));
        push(row, rows.length);
      }
    } else {
      const row = new Row(base);
      row.add("┃ ", fg(T.faint));
      row.add("a commit that was deleted", fg(T.faint), italic);
      push(row, rows.length);
    }
  }

  if (commit.linkPreview) {
    const preview = commit.linkPreview;
    const innerWidth = Math.max(8, contentWidth - 2);
    const host = hostOf(preview.url);
    const title = preview.title.trim();
    const showTitle = title.length > 0 && title.toLowerCase() !== host.toLowerCase();

    if (showTitle) {
      for (const line of wrapTokens([{ kind: "text", text: title }], innerWidth).slice(0, 2)) {
        const row = new Row(base);
        row.add("▸ ", fg(T.faint));
        for (const piece of line) row.add(piece.text, bold, fg(T.text));
        push(row, rows.length);
      }
    }

    const row = new Row(base);
    row.add(showTitle ? "  " : "▸ ", fg(T.faint));
    row.add(host, fg(T.muted));
    const room = innerWidth - displayWidth(host) - 3;
    if (preview.description && room > 12) row.add(` · ${truncate(preview.description, room)}`, fg(T.faint));
    push(row, rows.length);
  }

  if (commit.images) {
    const row = new Row(base);
    row.add(`▣ ${commit.images} ${commit.images === 1 ? "image" : "images"}`, fg(T.muted));
    push(row, rows.length);
  }

  if (commit.poll) {
    for (const option of commit.poll.options) {
      const row = new Row(base);
      row.add(`${option.voted ? "☑" : "☐"} `, fg(T.muted));
      row.add(truncate(option.label, Math.max(4, contentWidth - 2)), fg(T.text));
      push(row, rows.length);
    }
    const closed = commit.poll.closed || (commit.poll.closesAt && Date.parse(commit.poll.closesAt) < now);
    const count = commit.poll.options.length;
    const row = new Row(base);
    row.add(`poll · ${count} ${count === 1 ? "option" : "options"} · ${closed ? "closed" : "open"}`, fg(T.faint));
    push(row, rows.length);
  }

  if (options.preview !== false) {
    for (const reply of commit.replyPreview.slice(0, 3)) {
      const innerWidth = Math.max(8, contentWidth - 4);
      const replyHeader = fitHeader(
        {
          name: reply.author.name,
          handle: `@${reply.author.username}`,
          time: ` · ${ago(reply.createdAt, now)}`,
        },
        innerWidth,
      );
      const head = new Row(base);
      head.add("↳ ", fg(legible(reply.author.lane)));
      head.add(replyHeader.name, bold, fg(T.name));
      if (replyHeader.handle) head.add(` ${replyHeader.handle}`, fg(legible(reply.author.lane)));
      if (replyHeader.time) head.add(replyHeader.time, fg(T.faint));
      push(head, rows.length);

      for (const line of trimTrailingEmpty(wrapTokens(reply.segments, innerWidth)).slice(0, 3)) {
        const row = new Row(base);
        row.add("  ", "");
        for (const piece of line) {
          if (piece.kind === "code") row.add(piece.text, fg(T.code));
          else if (piece.kind === "link") row.add(piece.text, fg(T.link), underline);
          else row.add(piece.text, fg(T.muted));
        }
        push(row, rows.length);
      }
    }
    if (commit.replies > Math.min(3, commit.replyPreview.length)) {
      const more = commit.replies - Math.min(3, commit.replyPreview.length);
      const row = new Row(base);
      row.add(`↳ ${more} more ${more === 1 ? "reply" : "replies"}`, fg(T.faint));
      push(row, rows.length);
    }
  }

  if (options.expandable && !options.childrenLoaded) {
    const row = new Row(base);
    row.add(`↳ ${options.expandable} ${options.expandable === 1 ? "reply" : "replies"}`, fg(T.muted));
    row.add(" · e to expand", fg(T.faint));
    push(row, rows.length);
  }

  if (counts) {
    const row = new Row(base);
    row.add(`★ ${commit.stars}`, fg(commit.stars ? T.muted : T.faint));
    row.add("   ", "");
    row.add(`↳ ${commit.replies}`, fg(commit.replies ? T.muted : T.faint));
    if (options.selected) row.add("   R reply · c commit", fg(T.faint));
    push(row, rows.length);
  }

  const connector = new Row();
  const pad = rail.connector();
  connector.parts.push(pad.toString());
  connector.width += pad.width;
  rows.push(connector);

  return rows;
};

/**
 * @param {any[]} commits
 * @param {{width: number, now: number, selectedIndex?: number, avatarMode?: "circle"|"photo"|"none", onReady?: () => void}} options
 */
export function renderFeed(commits, options) {
  /** @type {Row[]} */
  const rows = [];
  /** @type {{id: string, index: number, start: number, end: number}[]} */
  const blocks = [];

  commits.forEach((commit, index) => {
    const start = rows.length;
    const block = buildCommit(commit, {
      width: options.width,
      now: options.now,
      selected: index === options.selectedIndex,
      rail: railFor(commit, { mode: options.avatarMode, onReady: options.onReady }),
    });
    rows.push(...block);
    blocks.push({ id: commit.id, index, start, end: rows.length - 1 });
  });

  return { rows, blocks };
};

/**
 * @param {{root: any, replies: any[], expanded: Map<string, any[]>}} thread
 */
const flattenThread = (thread) => {
  /** @type {{commit: any, depth: number, expandable: number, childrenLoaded: boolean}[]} */
  const flat = [{ commit: thread.root, depth: 0, expandable: 0, childrenLoaded: true }];

  /** @param {any[]} replies @param {number} depth */
  const walk = (replies, depth) => {
    for (const reply of replies) {
      const children = thread.expanded.get(reply.id);
      flat.push({
        commit: reply,
        depth,
        expandable: reply.replies,
        childrenLoaded: Array.isArray(children),
      });
      if (Array.isArray(children)) walk(children, depth + 1);
    }
  };

  walk(thread.replies, 1);
  return flat;
};

/**
 * @param {{root: any, replies: any[], expanded: Map<string, any[]>}} thread
 * @param {{width: number, now: number, selectedIndex?: number, avatarMode?: "circle"|"photo"|"none", onReady?: () => void}} options
 */
export function renderThread(thread, options) {
  const rows = [];
  const blocks = [];
  const flat = flattenThread(thread);

  flat.forEach((entry, index) => {
    const start = rows.length;
    const isRoot = entry.depth === 0;
    const block = buildCommit(entry.commit, {
      width: options.width,
      now: options.now,
      selected: index === options.selectedIndex,
      rail: isRoot
        ? railFor(entry.commit, { mode: options.avatarMode, onReady: options.onReady })
        : compactRail(entry.commit),
      indent: isRoot ? 0 : Math.min(entry.depth, 6) * 2,
      preview: false,
      expandable: entry.expandable,
      childrenLoaded: entry.childrenLoaded,
    });
    rows.push(...block);
    blocks.push({ id: entry.commit.id, index, start, end: rows.length - 1 });
  });

  return { rows, blocks };
};

// Cuts a styled line to the pane width, keeping its escape sequences, so a
// long name or URL can never wrap the screen and push the header away.
export const clip = (/** @type {string} */ text, /** @type {number} */ width) => {
  let out = "";
  let used = 0;
  let index = 0;

  while (index < text.length) {
    if (text[index] === "\u001b") {
      const csi = /^\u001b\[[0-9;?]*[A-Za-z]/.exec(text.slice(index));
      if (csi) {
        out += csi[0];
        index += csi[0].length;
        continue;
      }
      const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/.exec(text.slice(index));
      out += osc ? osc[0] : "";
      index += osc ? osc[0].length : 1;
      continue;
    }

    const next = text.indexOf("\u001b", index);
    const run = next === -1 ? text.slice(index) : text.slice(index, next);

    for (const segment of graphemes(run)) {
      const cell = graphemeWidth(segment);
      if (used + cell > width) return `${out}${RESET}`;
      out += segment;
      used += cell;
    }

    index += run.length;
  }

  return out;
};

const ruleRow = (/** @type {number} */ width) => {
  const row = new Row();
  row.add("─".repeat(width), fg(T.rule));
  return row;
};

/** @param {any} state @param {number} width */
const headerRow = (state, width) => {
  const row = new Row();

  if (state.mode === "thread" && state.thread) {
    row.add("← ", fg(T.faint));
    row.add(`@${clean(state.thread.root.author.username)}`, bold, fg(T.name));
    row.add(` · ${state.thread.root.shortHash}`, fg(T.faint));
    const count = state.thread.root.replies;
    row.add(` · ${count} ${count === 1 ? "reply" : "replies"}`, fg(T.faint));
    if (state.thread.loading) row.add(" · loading…", fg(T.muted));
    if (state.thread.more) row.add(" · more on the web", fg(T.faint));
  } else {
    row.add("/dev/null ", bold, fg(T.brand));
    row.space(2);
    for (const log of ["latest", "trending"]) {
      const active = state.log === log;
      row.add(log, active ? `${bold}${underline}${fg(T.name)}` : fg(T.tab));
      row.space(2);
    }
  }

  /** @type {string[]} */
  const right = [];
  if (state.mode !== "thread") right.push(`${state.commits.length} commits`);
  if (state.newCount > 0) right.push(`+${state.newCount} new`);
  if (state.status) right.push(state.status.text);
  else if (state.fetchedAt) right.push(`updated ${Math.max(0, Math.round((state.now - state.fetchedAt) / 1000))}s ago`);
  else right.push("loading…");

  const text = right.join(" · ");
  const gap = width - row.width - displayWidth(text) - 1;
  if (gap > 0) {
    row.space(gap);
    const tone = state.status?.kind === "error" ? T.bad : state.status?.kind === "ok" ? T.good : T.faint;
    row.add(text, fg(tone));
  }
  return row.fill(width);
};

/** @param {any} state @param {number} width */
const footerRows = (state, width) => {
  if (state.composer) {
    const prompt = state.composer.replyTo
      ? `reply @${clean(state.composer.replyTo.author.username)}`
      : `commit${state.me ? ` as @${clean(state.me)}` : ""}`;
    const head = ` ${prompt} ▸ `;
    const room = Math.max(4, width - displayWidth(head) - 8);
    const draft = state.composer.value;
    const shown = displayWidth(draft) <= room ? draft : tail(draft, room);
    const line = new Row();
    line.add(head, fg(T.brand), bold);
    if (displayWidth(draft) > room) line.add("…", fg(T.faint));
    line.add(shown, fg(T.text));
    line.add("▏", fg(T.brand));
    if (state.composer.busy) line.add(` ${state.composer.busy}`, fg(T.muted));
    if (state.composer.error) line.add(` ${state.composer.error}`, fg(T.bad));

    const hint = new Row();
    hint.add(" enter send · esc cancel · ctrl+u clear", fg(T.faint));
    return [line.fill(width), hint.fill(width)];
  }

  const hint = new Row();
  if (state.error) {
    hint.add(` ${state.error}`, fg(T.bad));
  } else if (state.mode === "thread") {
    hint.add(" j/k select · enter open reply · e expand · R reply · o browser · esc back · q quit", fg(T.faint));
  } else {
    hint.add(" j/k select · enter open · R reply · c commit · o browser · t log · ? help · q quit", fg(T.faint));
  }
  return [hint.fill(width)];
};

const tail = (/** @type {string} */ text, /** @type {number} */ width) => {
  const segments = graphemes(text);
  let used = 0;
  let out = "";
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const cell = graphemeWidth(segments[index]);
    if (used + cell > width) break;
    out = segments[index] + out;
    used += cell;
  }
  return out;
};

const renderHelp = () => {
  const entries = [
    ["j ↓ / k ↑", "next and previous commit"],
    ["→ / ←", "open the selected commit / go back"],
    ["g / G", "first and last commit"],
    ["enter", "open the commit with its conversation"],
    ["e", "expand the selected reply's own replies"],
    ["R", "reply to the selected commit"],
    ["c", "commit something new"],
    ["o", "open the selected commit in a browser"],
    ["a", "avatars: colour circle, tiny photo, none"],
    ["r / t / 1 / 2", "refresh · switch latest and trending"],
    ["esc", "back one level: reply → its parent → timeline"],
    ["q", "close the pane"],
  ];
  const rows = [];
  rows.push(new Row().add(" keys", bold, fg(T.name)));
  rows.push(new Row());
  for (const [key, description] of entries) {
    const row = new Row();
    row.add("  ", "");
    row.add(key.padEnd(16), fg(T.brand));
    row.add(description, fg(T.text));
    rows.push(row);
  }
  rows.push(new Row());
  rows.push(new Row().add("  the rail is each author's lane colour, as on the web", fg(T.faint)));
  rows.push(new Row().add("  commits and replies are signed with your SSH key, as dev-null's own CLI does", fg(T.faint)));
  return rows;
};

const placeholder = (/** @type {any} */ state) => {
  const row = new Row();
  if (state.error) row.add(` ${state.error} · retrying`, fg(T.bad));
  else row.add(" loading the /dev/null log…", fg(T.muted));
  return row;
};

/**
 * @param {any} state
 * @returns {{lines: string[], offset: number, selectedIndex: number, blockCount: number, selectedId: string|null, blocks: {id: string, index: number, start: number, end: number}[]}}
 */
export function renderScreen(state) {
  const width = Math.max(24, state.width);
  const height = Math.max(3, state.height);
  const chrome = state.composer ? 4 : 3;
  const bodyHeight = Math.max(1, height - chrome);

  /** @type {Row[]} */
  let rows;
  /** @type {{id: string, index: number, start: number, end: number}[]} */
  let blocks = [];

  const redraw = () => state.refresh?.();

  if (state.help) {
    rows = renderHelp();
  } else if (state.mode === "thread") {
    if (state.thread?.root) {
      ({ rows, blocks } = renderThread(
        { root: state.thread.root, replies: state.thread.replies, expanded: state.thread.expanded },
        { width, now: state.now, selectedIndex: state.selectedIndex, avatarMode: state.avatarMode, onReady: redraw },
      ));
    } else {
      rows = [placeholder(state)];
    }
  } else if (state.commits.length) {
    ({ rows, blocks } = renderFeed(state.commits, {
      width,
      now: state.now,
      selectedIndex: state.selectedIndex,
      avatarMode: state.avatarMode,
      onReady: redraw,
    }));
  } else {
    rows = [placeholder(state)];
  }

  const selectedBlock = blocks.find((block) => block.index === state.selectedIndex) ?? blocks[0];
  let offset = state.offset;
  if (selectedBlock) {
    const tall = selectedBlock.end - selectedBlock.start + 1 > bodyHeight;
    if (tall) {
      if (offset < selectedBlock.start) offset = selectedBlock.start;
      if (offset > selectedBlock.end - bodyHeight + 1) offset = selectedBlock.end - bodyHeight + 1;
    } else {
      if (selectedBlock.start < offset) offset = selectedBlock.start;
      if (selectedBlock.end > offset + bodyHeight - 1) offset = selectedBlock.end - bodyHeight + 1;
    }
  }
  offset = Math.max(0, Math.min(offset, Math.max(0, rows.length - bodyHeight)));

  const visible = rows.slice(offset, offset + bodyHeight);
  const lines = [clip(headerRow(state, width).toString(), width), clip(ruleRow(width).toString(), width)];
  for (const row of visible) lines.push(clip(row.toString(), width));
  for (let index = visible.length; index < bodyHeight; index += 1) lines.push("");
  for (const row of footerRows(state, width)) lines.push(clip(row.toString(), width));

  return {
    lines: lines.slice(0, height),
    offset,
    selectedIndex: selectedBlock?.index ?? 0,
    blockCount: blocks.length,
    selectedId: selectedBlock?.id ?? null,
    blocks,
  };
}

/** @param {any} state */
export function renderOnce(state) {
  const width = Math.max(24, state.width);
  const { rows } = renderFeed(state.commits, {
    width,
    now: state.now,
    avatarMode: state.avatarMode,
    onReady: () => {},
  });
  return [
    clip(headerRow({ ...state, mode: "timeline" }, width).toString(), width),
    clip(ruleRow(width).toString(), width),
    ...rows.map((row) => clip(row.toString(), width)),
  ];
}
