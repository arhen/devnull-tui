// @ts-check
import { humanSize } from "./attachments.js";
import { avatar } from "./avatars.js";
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
export const inverse = noColor ? "" : "\x1b[7m";

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

// The tabs, in the order their numbers select them: the open log first, so a
// new pane lands on something to read, and the user's own two last.
export const TABS = ["latest", "trending", "following", "notifications"];

// The timeline shows this much of a commit before "… N more lines"; enter
// opens the commit and its conversation in full.
const FEED_BODY_LINES = 5;

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

/** @typedef {{kind: string, text: string}} Piece */
/** @param {Piece[][]} lines */
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
 * @param {{mode?: "circle"|"none", onReady?: () => void}} [options]
 */
const railFor = (commit, { mode = "circle", onReady } = {}) => {
  const laneHex = legible(commit.author.lane);
  const lane = fg(laneHex);
  const width = COMPACT_RAIL;

  const connector = () => {
    const row = new Row();
    row.add("○", lane, dim);
    row.space(width - 1);
    return row;
  };

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
 *   bodyLines?: number,
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
  const bodyLines = Number.isFinite(options.bodyLines) ? Math.max(1, options.bodyLines) : body.length;
  body.slice(0, bodyLines).forEach((line, index) => {
    const row = new Row(base);
    for (const piece of line) renderSegment(row, piece);
    push(row, index + 1);
  });
  if (body.length > bodyLines) {
    const more = body.length - bodyLines;
    const row = new Row(base);
    row.add(`… ${more} more ${more === 1 ? "line" : "lines"}`, fg(T.faint));
    push(row, bodyLines + 1);
  }

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

      const replyBody = trimTrailingEmpty(wrapTokens(reply.segments, innerWidth));
      const shown = replyBody.slice(0, 3);
      shown.forEach((line, lineIndex) => {
        const row = new Row(base);
        row.add("  ", "");
        for (const piece of line) {
          if (piece.kind === "code") row.add(piece.text, fg(T.code));
          else if (piece.kind === "link") row.add(piece.text, fg(T.link), underline);
          else row.add(piece.text, fg(T.muted));
        }
        if (lineIndex === shown.length - 1 && replyBody.length > shown.length) row.add(" …", fg(T.faint));
        push(row, rows.length);
      });
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
 * @param {{width: number, now: number, selectedIndex?: number, avatarMode?: "circle"|"none", onReady?: () => void, bodyLines?: number}} options
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
      // A long commit keeps its place in the log; enter opens the whole of it.
      bodyLines: options.bodyLines,
    });
    rows.push(...block);
    blocks.push({ id: commit.id, index, start, end: rows.length - 1 });
  });

  return { rows, blocks };
};

/** The inbox shows this much of a commit under its notification. */
const NOTIFICATION_BODY_LINES = 2;

const renderMuted = (/** @type {Row} */ row, /** @type {{kind: string, text: string}} */ piece) => {
  if (piece.kind === "code") row.add(piece.text, fg(T.code));
  else if (piece.kind === "link") row.add(piece.text, fg(T.link), underline);
  else row.add(piece.text, fg(T.muted));
};

/**
 * One notification: who did it, what they did, and the commit it happened to.
 * @param {any} notification
 * @param {{width: number, now: number, selected?: boolean, depth?: number, childrenLoaded?: boolean}} options
 */
const buildNotification = (notification, options) => {
  const width = options.width;
  const now = options.now;
  const depth = options.depth ?? 0;
  const base = options.selected ? bg(T.selected) : "";
  const lane = fg(legible(notification.actor.lane));
  const contentWidth = Math.max(8, width - COMPACT_RAIL - depth * 2);
  /** @type {Row[]} */
  const rows = [];

  /** @param {Row} row */
  const push = (row) => {
    const first = rows.length === 0;
    const prefixed = new Row(base);
    if (depth > 0) prefixed.add(first ? "· " : "  ", fg(T.faint));
    else if (first) prefixed.add(notification.isNew ? "⬤ " : "○ ", notification.isNew ? lane : fg(T.faint));
    else prefixed.add("│ ", fg(T.faint));
    prefixed.space(depth * 2);
    prefixed.parts.push(row.toString());
    prefixed.width += row.width;
    if (options.selected) prefixed.fill(width);
    rows.push(prefixed);
  };

  const others = Math.max(0, notification.actorsCount - 1);
  const name = others > 0 ? `${notification.actor.name} and ${others} ${others === 1 ? "other" : "others"}` : notification.actor.name;
  const hash = notification.commit?.shortHash ?? "";

  const header = new Row(base);
  const fitted = fitHeader(
    { name, handle: `@${notification.actor.username}`, time: ` · ${ago(notification.createdAt, now)}` },
    Math.max(12, contentWidth - displayWidth(notification.text) - 2 - (hash ? hash.length + 3 : 0)),
  );
  header.add(fitted.name, bold, fg(T.name));
  if (fitted.handle && others === 0) header.add(` ${fitted.handle}`, lane);
  header.add(` ${notification.text}`, fg(T.muted));
  if (hash) {
    header.space(Math.max(1, contentWidth - header.width - hash.length - displayWidth(fitted.time)));
    header.add(hash, fg(T.faint), dim);
  }
  if (fitted.time) header.add(fitted.time, fg(T.faint));
  push(header);

  const commit = notification.commit;
  if (commit) {
    if (commit.deleted) {
      push(new Row(base).add("a commit that was deleted", fg(T.faint), italic));
    } else {
      const body = trimTrailingEmpty(wrapTokens(commit.segments, contentWidth)).filter((line) =>
        line.some((piece) => piece.text.trim() !== ""),
      );
      body.slice(0, NOTIFICATION_BODY_LINES).forEach((line, index) => {
        const row = new Row(base);
        for (const piece of line) renderMuted(row, piece);
        if (index === NOTIFICATION_BODY_LINES - 1 && body.length > NOTIFICATION_BODY_LINES) row.add(" …", fg(T.faint));
        push(row);
      });
    }
  }

  if (notification.reason) {
    const row = new Row(base);
    row.add("reason: ", fg(T.faint));
    row.add(notification.reason, fg(T.muted));
    push(row);
  }

  if (notification.rankDescription) push(new Row(base).add(notification.rankDescription, fg(T.muted)));

  if (notification.eventCount > 1 || others > 0) {
    const row = new Row(base);
    row.add(`↳ ${notification.eventCount} ${notification.eventCount === 1 ? "event" : "events"}`, fg(T.faint));
    if (notification.unreadCount > 0) row.add(` · ${notification.unreadCount} new`, fg(T.brand));
    if (depth === 0) row.add(options.childrenLoaded ? " · e to close" : " · e to expand", fg(T.faint));
    push(row);
  }

  return rows;
};

/**
 * @param {{notification: any, depth: number, childrenLoaded?: boolean}[]} items
 * @param {{width: number, now: number, selectedIndex?: number}} options
 */
export function renderNotifications(items, options) {
  /** @type {Row[]} */
  const rows = [];
  /** @type {{id: string, index: number, start: number, end: number}[]} */
  const blocks = [];

  items.forEach((item, index) => {
    const start = rows.length;
    const block = buildNotification(item.notification, {
      width: options.width,
      now: options.now,
      selected: index === options.selectedIndex,
      depth: item.depth,
      childrenLoaded: item.childrenLoaded,
    });
    rows.push(...block);
    blocks.push({ id: item.notification.id, index, start, end: rows.length - 1 });
  });

  return { rows, blocks };
}

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
 * @param {{width: number, now: number, selectedIndex?: number, avatarMode?: "circle"|"none", onReady?: () => void}} options
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
    TABS.forEach((tab, index) => {
      const active = state.tab === tab;
      // The number is the key that switches to the tab, so it is on screen.
      row.add(String(index + 1), active ? bold : "", fg(active ? T.brand : T.faint));
      row.add(` ${tab}`, active ? `${bold}${underline}${fg(T.name)}` : fg(T.tab));
      // Unread groups, from the signed user: no listing, so nothing is marked read.
      if (tab === "notifications" && state.unread > 0) row.add(` ${state.unread}`, bold, fg(T.brand));
      row.space(2);
    });
  }

  /** @type {string[]} */
  const right = [];
  if (state.mode !== "thread") {
    if (state.tab === "notifications") {
      const groups = state.notifications?.groups ?? [];
      right.push(`${groups.length} ${groups.length === 1 ? "group" : "groups"}`);
      const fresh = groups.filter((/** @type {any} */ group) => group.unreadCount > 0).length;
      if (fresh > 0) right.push(`${fresh} new`);
    } else {
      right.push(`${state.commits.length} commits`);
    }
  }
  if (state.tab !== "notifications" && state.newCount > 0) right.push(`+${state.newCount} new`);
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
    const composer = state.composer;
    /** @type {Row[]} */
    const draftRows = [];
    const mention = composer.mention;

    if (mention?.users?.length) {
      mention.users.forEach((/** @type {any} */ user, /** @type {number} */ index) => {
        const active = index === mention.index;
        const row = new Row();
        row.add(active ? " ▸ " : "   ", fg(T.brand));
        row.add(`@${user.username}`, ...(active ? [bold, fg(T.name)] : [fg(T.text)]));
        if (user.name && user.name.toLowerCase() !== user.username.toLowerCase()) {
          const room = Math.max(8, width - displayWidth(user.username) - 10);
          row.add(` · ${truncate(user.name, room)}`, fg(T.muted));
        }
        draftRows.push(row.fill(width));
      });
    } else if (mention?.loading) {
      draftRows.push(new Row().add(" searching people…", fg(T.faint)).fill(width));
    }

    if (composer.images?.length) {
      const row = new Row();
      row.add(composer.images.length === 1 ? " 1 image · " : ` ${composer.images.length} images · `, bold, fg(T.brand));
      composer.images.forEach((/** @type {any} */ image, /** @type {number} */ index) => {
        if (index > 0) row.add(" · ", fg(T.faint));
        row.add(truncate(image.name, 24), fg(T.text));
        row.add(` ${humanSize(image.size)}`, fg(T.faint));
      });
      draftRows.push(row.fill(width));
    }

    const prompt = state.composer.replyTo
      ? `reply @${clean(state.composer.replyTo.author.username)}`
      : `commit${state.me ? ` as @${clean(state.me)}` : ""}`;
    const head = ` ${prompt} ▸ `;
    const headWidth = displayWidth(head);
    const room = Math.max(4, width - headWidth - 8);

    // The draft is a body with a caret in it, but the composer is two lines
    // tall: the rest is reached by moving the caret, up and down.
    const value = state.composer.value;
    const caret = Math.max(0, Math.min(value.length, Number.isInteger(state.composer.cursor) ? state.composer.cursor : value.length));
    const beforeCaret = value.slice(0, caret);
    const caretLine = (beforeCaret.match(/\n/g) ?? []).length;
    const caretLineStart = beforeCaret.lastIndexOf("\n") + 1;
    const caretColumn = displayWidth(value.slice(caretLineStart, caret));

    const lines = value.split("\n");
    const maxDraftRows = 2;
    const firstLine = Math.max(0, Math.min(caretLine - (maxDraftRows - 1), Math.max(0, lines.length - maxDraftRows)));
    const lastLine = Math.min(lines.length, firstLine + maxDraftRows);

    for (let index = firstLine; index < lastLine; index += 1) {
      const isFirst = index === firstLine;
      const line = new Row();
      line.add(isFirst ? head : " ".repeat(headWidth), fg(T.brand), ...(isFirst ? [bold] : []));
      let available = room;
      if (isFirst && firstLine > 0) {
        line.add("…", fg(T.faint));
        available -= 1;
      }

      const text = lines[index];
      if (index === caretLine) {
        const before = text.slice(0, caret - caretLineStart);
        const after = text.slice(caret - caretLineStart);
        const skip = Math.max(0, caretColumn - Math.max(1, available - 2));
        const dropped = dropColumns(before, skip);
        if (skip > 0) {
          line.add("…", fg(T.faint));
          available -= 1;
        }
        line.add(dropped.text, fg(T.text));
        available -= displayWidth(dropped.text);

        const segments = graphemes(after);
        const cell = segments[0] ?? " ";
        line.add(cell, inverse, fg(T.name));
        available -= graphemeWidth(cell);
        const rest = takeColumns(segments.slice(1).join(""), available - (segments.length > 1 ? 1 : 0));
        line.add(rest.text, fg(T.text));
        if (rest.clipped) line.add("…", fg(T.faint));

        if (state.composer.busy) line.add(` ${state.composer.busy}`, fg(T.muted));
        if (state.composer.error) line.add(` ${state.composer.error}`, fg(T.bad));
      } else {
        const shown = takeColumns(text, available - 1);
        line.add(shown.text, fg(T.text));
        if (shown.clipped) line.add("…", fg(T.faint));
      }
      draftRows.push(line.fill(width));
    }

    const hidden = {
      above: firstLine,
      below: lines.length - lastLine,
    };
    const more = (/** @type {number} */ count, /** @type {string} */ arrow) =>
      `${arrow} ${count} more ${count === 1 ? "line" : "lines"}`;

    const hint = new Row();
    if (composer.kind === "device") {
      hint.add(" paste the code the browser gave you · enter approves · esc cancels", fg(T.faint));
    } else if (mention?.users?.length) {
      hint.add(" ↑↓ pick person · enter or tab tags them · esc closes", fg(T.faint));
    } else if (hidden.above || hidden.below) {
      // The composer is two lines: say how much of the draft is out of view.
      const parts = [];
      if (hidden.above) parts.push(more(hidden.above, "↑"));
      if (hidden.below) parts.push(more(hidden.below, "↓"));
      parts.push("↑↓ move", "enter send", "shift+enter new line", "esc cancel");
      hint.add(` ${parts.join(" · ")}`, fg(T.faint));
    } else if (state.composer.images?.length) {
      hint.add(" ←→ move · enter send · shift+enter new line · backspace removes an image · esc cancel", fg(T.faint));
    } else if (!value) {
      hint.add(" enter send · shift+enter new line · @ tags · drop or paste an image · ←→ move", fg(T.faint));
    } else {
      hint.add(" ←→ move · ctrl+←→ words · enter send · shift+enter new line · esc cancel · ctrl+u clear", fg(T.faint));
    }
    return [...draftRows, hint.fill(width)];
  }

  const hint = new Row();
  if (state.error) {
    hint.add(` ${state.error}`, fg(T.bad));
  } else if (state.mode === "thread") {
    hint.add(" j/k select · enter open reply · e expand · R reply · o browser · esc back · q quit", fg(T.faint));
  } else if (state.tab === "notifications") {
    hint.add(" j/k select · enter open · e group · o browser · r refresh · 1-4 tabs · ? help · q quit", fg(T.faint));
  } else {
    hint.add(" j/k select · enter open · R reply · c commit · o browser · 1-4 tabs · ? help · q quit", fg(T.faint));
  }
  return [hint.fill(width)];
};

/** Drops whole graphemes from the left until `columns` are gone. */
const dropColumns = (text, columns) => {
  if (columns <= 0) return { dropped: 0, text };
  const segments = graphemes(text);
  let used = 0;
  let index = 0;
  while (index < segments.length && used < columns) {
    used += graphemeWidth(segments[index]);
    index += 1;
  }
  return { dropped: used, text: segments.slice(index).join("") };
};

/** Takes graphemes while they fit, and says whether any were left. */
const takeColumns = (text, width) => {
  const segments = graphemes(text);
  const limit = Math.max(1, width);
  let used = 0;
  const out = [];
  for (const segment of segments) {
    const cell = graphemeWidth(segment);
    if (used + cell > limit) return { text: out.join(""), clipped: out.length > 0 };
    out.push(segment);
    used += cell;
  }
  return { text: out.join(""), clipped: false };
};

const renderHelp = () => {
  const entries = [
    ["j ↓ / k ↑", "next and previous commit"],
    ["→ / ←", "open the selected commit / go back"],
    ["1 2 3 4", "latest · trending · following · notifications"],
    ["n", "jump to notifications from anywhere"],
    ["g / G", "first and last commit"],
    ["enter", "open the commit with its conversation"],
    ["e", "expand the selected reply, or a group of notifications"],
    ["R", "reply to the selected commit"],
    ["c", "commit something new"],
    ["shift+enter", "in the composer: start a new line"],
    ["←→ / ↑↓", "in the composer: move the caret · between lines"],
    ["@", "in the composer: tag someone, ↑↓ then enter"],
    ["drop", "in the composer: attach up to 3 images"],
    ["o", "open the selected commit in a browser"],
    ["s / d", "star the selected commit / delete your own"],
    ["a", "avatars: colour dots on / off"],
    ["r / t", "refresh · switch latest and trending"],
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
  if (state.approval) {
    row.add(" waiting for the approval in your browser…", fg(T.muted));
    row.add(" · esc pastes the code instead", fg(T.faint));
  } else if (state.gate) {
    row.add(` ${state.gate} is yours alone, so it needs an approved device`, fg(T.muted));
    row.add(" · press s to approve this pane", fg(T.faint));
  } else if (state.error) row.add(` ${state.error} · retrying`, fg(T.bad));
  else if (state.tab === "notifications") {
    if (state.loading) row.add(" reading the inbox…", fg(T.muted));
    else row.add(" nothing in the inbox yet: follows, stars, replies, quotes, mentions and moderation land here", fg(T.muted));
  } else if (state.tab === "following" && !state.loading) {
    row.add(" nobody in your Following log yet · follow people on dev-null.sh", fg(T.muted));
  } else row.add(" loading the /dev/null log…", fg(T.muted));
  return row;
};

/**
 * @param {any} state
 * @returns {{lines: string[], offset: number, selectedIndex: number, blockCount: number, selectedId: string|null, blocks: {id: string, index: number, start: number, end: number}[]}}
 */
export function renderScreen(state) {
  const width = Math.max(24, state.width);
  const height = Math.max(3, state.height);
  // Suggestions and attachments may scroll away, never the composer itself.
  const allFooter = footerRows(state, width);
  const room = Math.max(2, height - 3);
  const footer = allFooter.length > room ? allFooter.slice(allFooter.length - room) : allFooter;
  const chrome = 2 + footer.length;
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
        {
          width,
          now: state.now,
          selectedIndex: state.selectedIndex,
          avatarMode: state.avatarMode,
          onReady: redraw,
        },
      ));
    } else {
      rows = [placeholder(state)];
    }
  } else if (state.tab === "notifications") {
    const items = state.notifications?.items ?? [];
    if (items.length) {
      ({ rows, blocks } = renderNotifications(items, {
        width,
        now: state.now,
        selectedIndex: state.selectedIndex,
      }));
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
      bodyLines: FEED_BODY_LINES,
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
  for (const row of footer) lines.push(clip(row.toString(), width));

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
  const header = clip(headerRow({ ...state, mode: "timeline" }, width).toString(), width);

  if (state.tab === "notifications") {
    const { rows } = renderNotifications(state.notifications?.items ?? [], { width, now: state.now });
    return [header, clip(ruleRow(width).toString(), width), ...rows.map((row) => clip(row.toString(), width))];
  }

  const { rows } = renderFeed(state.commits, {
    width,
    now: state.now,
    avatarMode: "circle",
    onReady: () => {},
    // The text log is for reading the whole thing: no clamp.
    bodyLines: Infinity,
  });
  return [header, clip(ruleRow(width).toString(), width), ...rows.map((row) => clip(row.toString(), width))];
}
