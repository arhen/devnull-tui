#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { cleanup, postCommit } from "./lib/auth.js";
import { avatarRows } from "./lib/avatars.js";
import { LOGS, fetchLog, fetchThread } from "./lib/devnull.js";
import { renderOnce, renderScreen } from "./lib/draw.js";
import { clean } from "./lib/text.js";

const args = process.argv.slice(2);

/**
 * @param {string} name
 * @param {string|number|boolean|null} [fallback]
 */
const flag = (name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : true;
};

const once = args.includes("--once");
const wantedLog = String(flag("log", "latest"));
const initialLog = LOGS.includes(wantedLog) ? wantedLog : "latest";
const interval = Math.max(15, Number(flag("interval", 60)) || 60);

/** @type {any} */
const state = {
  mode: "timeline",
  log: initialLog,
  commits: [],
  thread: null,
  threadStack: [],
  timelineIndex: 0,
  selectedIndex: 0,
  selectedId: null,
  blockCount: 0,
  blocks: [],
  offset: 0,
  composer: null,
  newCount: 0,
  status: null,
  error: null,
  help: false,
  loading: true,
  avatarMode: /** @type {"chip"|"photo"|"none"} */ (args.includes("--photos") ? "photo" : "chip"),
  me: null,
  fetchedAt: 0,
  now: Date.now(),
  width: process.stdout.columns || 100,
  height: process.stdout.rows || 30,
};

let flashUntil = 0;
let loadSeq = 0;
let fetchSeq = 0;
let refreshing = false;

/** @param {string} text */
const flash = (text) => {
  state.status = { kind: "ok", text };
  flashUntil = Date.now() + 3000;
  draw();
};

const selectedCommit = () => {
  if (state.mode === "thread") {
    if (!state.thread?.root) return null;
    return state.thread.root.id === state.selectedId ? state.thread.root : state.thread.replies.find((/** @type {any} */ reply) => reply.id === state.selectedId) ?? state.thread.root;
  }
  return state.commits[state.selectedIndex] ?? null;
};

async function refresh({ quiet = false } = {}) {
  if (refreshing && quiet) return;
  const token = ++fetchSeq;
  const log = state.log;
  const selected = state.commits[state.selectedIndex];
  const previousIds = new Set(state.commits.map((/** @type {any} */ commit) => commit.id));
  if (!quiet) flash("refreshing…");
  refreshing = true;

  try {
    const result = await fetchLog(log);
    if (token !== fetchSeq || log !== state.log) return;

    state.commits = result.commits;
    state.fetchedAt = result.fetchedAt;
    state.loading = false;
    state.error = null;

    const kept = selected ? result.commits.findIndex((/** @type {any} */ commit) => commit.id === selected.id) : -1;
    state.selectedIndex = kept >= 0 ? kept : 0;
    state.selectedId = result.commits[state.selectedIndex]?.id ?? null;
    state.newCount =
      previousIds.size > 0 && kept > 0
        ? result.commits.slice(0, kept).filter((/** @type {any} */ commit) => !previousIds.has(commit.id)).length
        : 0;
    if (Date.now() > flashUntil) state.status = null;
  } catch (error) {
    if (token === fetchSeq) {
      state.error = clean(error instanceof Error ? error.message : String(error));
      state.loading = false;
    }
  } finally {
    refreshing = false;
    if (token === fetchSeq) draw();
  }
}

/** @param {any} commit */
async function loadThread(commit) {
  const token = ++loadSeq;
  state.mode = "thread";
  state.thread = { root: commit, ancestors: [], replies: [], expanded: new Map(), more: false, loading: true };
  state.selectedId = commit.id;
  state.selectedIndex = 0;
  state.offset = 0;
  state.error = null;
  draw();

  try {
    const thread = await fetchThread(commit);
    if (token !== loadSeq) return;
    state.thread = { ...thread, expanded: new Map(), loading: false };
    state.selectedId = thread.root.id;
    state.selectedIndex = 0;
    state.fetchedAt = thread.fetchedAt;
  } catch (error) {
    if (token !== loadSeq) return;
    if (state.thread) {
      state.thread.loading = false;
      state.error = clean(error instanceof Error ? error.message : String(error));
    }
  }
  if (token === loadSeq) draw();
}

/** @param {any} commit */
const openThread = (commit) => {
  state.threadStack = [];
  state.help = false;
  void loadThread(commit);
};

/** Enter on a reply walks into that reply's own conversation. */
const openReply = (/** @type {any} */ commit) => {
  if (!state.thread?.root || commit.id === state.thread.root.id) return;
  state.threadStack.push(state.thread);
  void loadThread(commit);
};

const back = () => {
  if (state.help) {
    state.help = false;
    return draw();
  }
  if (state.composer) {
    state.composer = null;
    return draw();
  }
  if (state.mode !== "thread") return;
  loadSeq += 1;
  if (state.threadStack.length) {
    state.thread = state.threadStack.pop();
    state.selectedId = state.thread.root.id;
    state.selectedIndex = 0;
    return draw();
  }
  state.mode = "timeline";
  state.thread = null;
  state.selectedIndex = state.timelineIndex;
  state.selectedId = state.commits[state.selectedIndex]?.id ?? null;
  draw();
};

const expand = async () => {
  const commit = selectedCommit();
  const thread = state.thread;
  if (!thread || !commit || !commit.replies) {
    flash("nothing to expand");
    return;
  }
  if (commit.id === thread.root.id) {
    flash("the conversation is already open");
    return;
  }

  const cached = thread.expanded.get(commit.id);
  if (Array.isArray(cached)) {
    thread.expanded.delete(commit.id);
    return draw();
  }

  flash(`loading ${commit.replies} ${commit.replies === 1 ? "reply" : "replies"}…`);
  try {
    const loaded = await fetchThread(commit);
    if (state.thread !== thread || state.mode !== "thread") return;
    thread.expanded.set(commit.id, loaded.replies);
    if (Date.now() > flashUntil) state.status = null;
  } catch (error) {
    if (state.thread !== thread) return;
    state.error = clean(error instanceof Error ? error.message : String(error));
  }
  draw();
};

const draw = () => {
  if (once) return;
  state.now = Date.now();
  const result = renderScreen(state);
  state.offset = result.offset;
  state.selectedIndex = result.selectedIndex;
  state.blockCount = result.blockCount;
  state.selectedId = result.selectedId;
  state.blocks = result.blocks;
  if (state.mode === "timeline") state.timelineIndex = result.selectedIndex;
  process.stdout.write(`\x1b[H${result.lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
};

const spawnDetached = (/** @type {string} */ command, /** @type {string[]} */ commandArgs) =>
  new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });

const guiCandidates = () =>
  [
    process.env.HERDR_GPUI_PATH,
    "/Applications/Herdr.app/Contents/MacOS/Herdr",
    "herdr-gpui",
  ].filter(Boolean);

async function openInBrowserTab(/** @type {string} */ url) {
  for (const candidate of guiCandidates()) {
    if (candidate.includes("/") && !existsSync(candidate)) continue;
    if (await spawnDetached(String(candidate), ["browser", "open", url])) return true;
  }
  const fallback = process.platform === "darwin" ? "open" : "xdg-open";
  return spawnDetached(fallback, [url]);
}

async function openSelected() {
  const commit = selectedCommit();
  if (!commit) return;
  flash(`opening @${clean(commit.author.username)}…`);
  const opened = await openInBrowserTab(commit.permalink);
  flash(opened ? `opened @${clean(commit.author.username)}` : commit.permalink);
}

const startComposer = (/** @type {any} */ replyTo) => {
  state.composer = { replyTo, value: "", busy: null, error: null };
  state.help = false;
  draw();
};

async function submit() {
  const composer = state.composer;
  if (!composer || composer.busy) return;
  const body = composer.value.trim();
  if (!body) {
    composer.error = "nothing to send";
    return draw();
  }

  composer.busy = "signing…";
  composer.error = null;
  draw();

  try {
    const answer = await postCommit({ body, replyTo: composer.replyTo?.permalink ?? null });
    const handle = /@([\w.-]+)\/commits/.exec(answer);
    if (handle) state.me = handle[1];
    if (state.composer === composer) state.composer = null;
    flash(composer.replyTo ? "replied ✓" : "committed ✓");
    if (state.mode === "thread" && state.thread?.root) await loadThread(state.thread.root);
    else await refresh({ quiet: true });
  } catch (error) {
    if (state.composer !== composer) return;
    composer.busy = null;
    composer.error = clean(error instanceof Error ? error.message : String(error));
    draw();
  }
}

const moveSelection = (/** @type {number} */ delta, /** @type {number} */ max) => {
  const count = max || state.blockCount;
  if (!count) return;
  state.selectedIndex = Math.max(0, Math.min(count - 1, state.selectedIndex + delta));
  state.selectedId = null;
};

const scrollHalfPage = (/** @type {number} */ direction) => {
  const half = Math.max(1, Math.floor((state.height - 3) / 2));
  const target = state.offset + direction * half;
  let index = 0;
  for (const block of state.blocks) if (block.start <= target) index = block.index;
  state.selectedIndex = Math.max(0, Math.min(state.blockCount - 1, index));
  state.selectedId = null;
};

const typeInComposer = (/** @type {string} */ key, /** @type {string} */ text, /** @type {boolean} */ pasted) => {
  const composer = state.composer;
  if (!composer || composer.busy) return;

  if (pasted) {
    composer.value += clean(text);
  } else if (key === "\r") {
    void submit();
    return;
  } else if (key === "\u007f" || key === "\b") {
    composer.value = [...composer.value].slice(0, -1).join("");
  } else if (key === "\u0015") {
    composer.value = "";
  } else if (key === "\u0017") {
    composer.value = composer.value.replace(/\s*\S*$/, "");
  } else if (text >= " " && text !== "\u007f") {
    composer.value += text;
  }
  draw();
};

/** @param {string} key @param {string} text */
function onKey(key, text) {
  if (state.composer) {
    if (key === "\u0003") {
      state.composer = null;
      return draw();
    }
    if (key === "\u001b") {
      state.composer = null;
      return draw();
    }
    return typeInComposer(key, text, false);
  }

  if (key === "\u0003") return quit();

  switch (key) {
    case "q":
      if (state.mode === "thread") return back();
      return quit();
    case "j":
    case "\u001b[B":
    case "\u001bOB":
      moveSelection(1, 0);
      break;
    case "k":
    case "\u001b[A":
    case "\u001bOA":
      moveSelection(-1, 0);
      break;
    case "g":
    case "\u001b[H":
    case "\u001bOH":
      state.selectedIndex = 0;
      state.selectedId = null;
      break;
    case "G":
    case "\u001b[F":
    case "\u001bOF":
      state.selectedIndex = Math.max(0, state.blockCount - 1);
      state.selectedId = null;
      break;
    case "\u0004":
    case "\u001b[6~":
      scrollHalfPage(1);
      break;
    case "\u0015":
    case "\u001b[5~":
      scrollHalfPage(-1);
      break;
    case "\r":
      if (state.mode === "thread") {
        const commit = selectedCommit();
        if (commit) return void openReply(commit);
      } else {
        const commit = selectedCommit();
        if (commit) return openThread(commit);
      }
      break;
    case "e":
      return void expand();
    case "R": {
      const commit = selectedCommit();
      if (commit) return startComposer(commit);
      break;
    }
    case "c":
      return startComposer(null);
    case "o":
      return void openSelected();
    case "r":
      if (state.mode === "thread" && state.thread?.root) return void loadThread(state.thread.root);
      return void refresh();
    case "t":
      return switchLog(state.log === "latest" ? "trending" : "latest");
    case "1":
      return switchLog("latest");
    case "2":
      return switchLog("trending");
    case "a":
      state.avatarMode = state.avatarMode === "chip" ? "photo" : state.avatarMode === "photo" ? "none" : "chip";
      flash(`avatars: ${state.avatarMode}`);
      break;
    case "?":
      state.help = !state.help;
      break;
    case "\u001b":
      return back();
    default:
      return;
  }
  draw();
}

const switchLog = (/** @type {string} */ log) => {
  if (state.log === log) return;
  state.log = log;
  state.mode = "timeline";
  state.thread = null;
  state.commits = [];
  state.selectedIndex = 0;
  state.timelineIndex = 0;
  state.selectedId = null;
  state.offset = 0;
  state.newCount = 0;
  state.help = false;
  state.loading = true;
  draw();
  void refresh();
};

const restore = () => process.stdout.write("\x1b[?2004l\x1b[?7h\x1b[?1049l\x1b[?25h");

const quit = () => {
  cleanup();
  restore();
  process.exit(0);
};

function startKeys() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdout.write("\x1b[?2004h\x1b[?7l");

  let buffer = "";
  /** @type {NodeJS.Timeout|null} */
  let escapeTimer = null;

  const flushEscape = () => {
    if (buffer === "\u001b") {
      buffer = "";
      onKey("\u001b", "\u001b");
    }
  };

  process.stdin.on("data", (chunk) => {
    buffer += String(chunk);

    while (buffer.length) {
      if (escapeTimer) {
        clearTimeout(escapeTimer);
        escapeTimer = null;
      }

      if (buffer.startsWith("\u001b[200~")) {
        const end = buffer.indexOf("\u001b[201~");
        if (end === -1) return;
        const pasted = buffer.slice(6, end);
        buffer = buffer.slice(end + 6);
        if (state.composer) typeInComposer("", pasted, true);
        continue;
      }

      if (buffer[0] === "\u001b") {
        const csi = /^\u001b[[O][0-9;]*[A-Za-z~]/.exec(buffer) ?? /^\u001bO[A-Za-z]/.exec(buffer);
        if (csi) {
          buffer = buffer.slice(csi[0].length);
          onKey(csi[0], csi[0]);
          continue;
        }
        if (buffer.length === 1) {
          escapeTimer = setTimeout(flushEscape, 30);
          return;
        }
        buffer = buffer.slice(1);
        onKey("\u001b", "\u001b");
        continue;
      }

      const char = String.fromCodePoint(/** @type {number} */ (buffer.codePointAt(0)));
      buffer = buffer.slice(char.length);
      onKey(char, char);
    }
  });

  process.stdin.on("end", quit);
}

async function main() {
  state.now = Date.now();

  if (once) {
    await refresh({ quiet: true });
    if (state.error) {
      process.stderr.write(`${state.error}\n`);
      process.exit(1);
    }
    const width = Number(flag("width", process.stdout.columns || 100));
    state.width = Number.isFinite(width) && width > 20 ? width : 100;
    state.avatarMode = args.includes("--photos") || args.includes("--avatars") ? "photo" : "chip";
    if (state.avatarMode === "photo") {
      for (const commit of state.commits) avatarRows(commit.author);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    process.stdout.write(`${renderOnce(state).join("\n")}\n`);
    return;
  }

  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  process.on("exit", restore);
  process.stdout.on("resize", () => {
    state.width = process.stdout.columns || state.width;
    state.height = process.stdout.rows || state.height;
    draw();
  });

  startKeys();
  draw();
  void refresh({ quiet: true });

  setInterval(() => {
    state.now = Date.now();
    draw();
  }, 1000);
  setInterval(() => {
    if (state.mode === "timeline" && !state.help && !state.composer) void refresh({ quiet: true });
  }, interval * 1000);
}

for (const signal of /** @type {const} */ (["SIGTERM", "SIGINT", "SIGHUP"])) {
  process.on(signal, quit);
}

process.on("unhandledRejection", (reason) => fail(reason));
process.on("uncaughtException", (error) => fail(error));

/** @param {unknown} reason */
function fail(reason) {
  cleanup();
  restore();
  const message = reason instanceof Error ? reason.stack ?? reason.message : String(reason);
  process.stderr.write(`devnull.feed: ${message}\n`);
  process.exit(1);
}

void main();
