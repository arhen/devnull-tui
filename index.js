#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

import { postCommit, signingKey } from "./lib/auth.js";
import { avatarRows } from "./lib/avatars.js";
import { LOGS, fetchLog, fetchThread } from "./lib/devnull.js";
import { renderOnce, renderScreen } from "./lib/draw.js";

const args = process.argv.slice(2);
const flag = (/** @type {string} */ name, fallback = null) => {
  const index = args.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = args[index + 1];
  return value && !value.startsWith("--") ? value : true;
};

const once = args.includes("--once");
const initialLog = LOGS.includes(String(flag("log"))) ? String(flag("log")) : "latest";
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
  offset: 0,
  composer: null,
  newCount: 0,
  status: null,
  error: null,
  help: false,
  loading: true,
  avatars: process.stdout.columns > 52,
  me: null,
  fetchedAt: 0,
  now: Date.now(),
  width: process.stdout.columns || 100,
  height: process.stdout.rows || 30,
  refresh: () => draw(),
};

let flashTimer = /** @type {NodeJS.Timeout|null} */ (null);
let refreshing = false;

/** @param {string} text */
const flash = (text) => {
  state.status = { kind: "ok", text };
  if (flashTimer) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    state.status = null;
    draw();
  }, 3000);
};

const selectedCommit = () => {
  if (state.mode === "thread") return threadBlocks().find((entry) => entry.commit.id === state.selectedId)?.commit ?? state.thread?.root ?? null;
  return state.commits[state.selectedIndex] ?? null;
};

// The flat, ordered list the thread view draws, so selection maps to a commit.
const threadBlocks = () => {
  if (!state.thread?.root) return [];
  /** @type {any[]} */
  const flat = [{ commit: state.thread.root, depth: 0 }];
  /** @param {any[]} replies @param {number} depth */
  const walk = (replies, depth) => {
    for (const reply of replies) {
      flat.push({ commit: reply, depth });
      const children = state.thread.expanded.get(reply.id);
      if (Array.isArray(children)) walk(children, depth + 1);
    }
  };
  walk(state.thread.replies, 1);
  return flat;
};

async function refresh({ quiet = false } = {}) {
  if (refreshing) return;
  refreshing = true;
  if (!quiet) flash("refreshing…");

  const previousIds = new Set(state.commits.map((/** @type {any} */ commit) => commit.id));
  const selected = state.commits[state.selectedIndex];

  try {
    const result = await fetchLog(state.log);
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
    if (state.newCount === 0) state.status = null;
  } catch (error) {
    state.error = String(error instanceof Error ? error.message : error);
    state.loading = false;
  } finally {
    refreshing = false;
    draw();
  }
}

/** @param {any} commit */
async function loadThread(commit) {
  state.thread = {
    root: commit,
    ancestors: [],
    replies: [],
    expanded: new Map(),
    more: false,
    loading: true,
  };
  state.selectedId = commit.id;
  state.selectedIndex = 0;
  state.offset = 0;
  state.error = null;
  draw();

  try {
    const thread = await fetchThread(commit);
    state.thread = { ...thread, expanded: new Map(), loading: false };
    state.selectedId = thread.root.id;
    state.selectedIndex = 0;
    state.fetchedAt = thread.fetchedAt;
  } catch (error) {
    state.thread.loading = false;
    state.error = String(error instanceof Error ? error.message : error);
  }
  draw();
}

/** @param {any} commit */
const openThread = (commit) => {
  state.mode = "thread";
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
  if (!commit || !state.thread || !commit.replies) {
    flash("no replies to expand");
    return;
  }
  const cached = state.thread.expanded.get(commit.id);
  if (Array.isArray(cached)) {
    state.thread.expanded.delete(commit.id);
    return draw();
  }

  flash(`loading ${commit.replies} ${commit.replies === 1 ? "reply" : "replies"}…`);
  try {
    const thread = await fetchThread(commit);
    state.thread.expanded.set(commit.id, thread.replies);
    state.status = null;
  } catch (error) {
    state.error = String(error instanceof Error ? error.message : error);
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
  if (state.mode === "timeline") state.timelineIndex = result.selectedIndex;
  process.stdout.write(`\x1b[H${result.lines.map((line) => `${line}\x1b[K`).join("\r\n")}\x1b[J`);
};

const spawnDetached = (/** @type {string} */ command, /** @type {string[]} */ commandArgs) =>
  new Promise((resolve) => {
    const child = spawn(command, commandArgs, { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });

async function openSelected() {
  const commit = selectedCommit();
  if (!commit) return;

  const herdr = process.env.HERDR_BIN_PATH ?? "/Applications/Herdr.app/Contents/MacOS/Herdr";
  const fallback = process.platform === "darwin" ? "open" : "xdg-open";
  const inBrowserTab = existsSync(herdr) && (await spawnDetached(herdr, ["browser", "open", commit.permalink]));
  if (!inBrowserTab) void spawnDetached(fallback, [commit.permalink]);
  flash(`opened @${commit.author.username}`);
}

const startComposer = (/** @type {any} */ replyTo) => {
  state.composer = { replyTo, value: "", busy: null, error: null };
  state.help = false;
  draw();
};

async function submit() {
  const composer = state.composer;
  if (!composer) return;
  const body = composer.value.trim();
  if (!body) {
    composer.error = "nothing to send";
    return draw();
  }

  composer.busy = "signing…";
  composer.error = null;
  draw();

  try {
    const answer = await postCommit({ body, replyTo: composer.replyTo?.id ?? null });
    const handle = /@([\w.-]+)\/commits/.exec(answer);
    if (handle) state.me = handle[1];
    state.composer = null;
    flash(composer.replyTo ? "replied ✓" : "committed ✓");
    if (state.mode === "thread" && state.thread?.root) await loadThread(state.thread.root);
    else await refresh({ quiet: true });
  } catch (error) {
    composer.busy = null;
    composer.error = String(error instanceof Error ? error.message : error);
    draw();
  }
}

const moveSelection = (/** @type {number} */ delta) => {
  const count = state.blockCount || (state.mode === "thread" ? threadBlocks().length : state.commits.length);
  if (!count) return;
  state.selectedIndex = Math.max(0, Math.min(count - 1, state.selectedIndex + delta));
  state.selectedId = null;
};

const typeInComposer = (/** @type {string} */ key, /** @type {string} */ chunk) => {
  const composer = state.composer;
  if (!composer || composer.busy) return;

  if (key === "\r") return void submit();
  if (key === "\u007f" || key === "\b") {
    composer.value = [...composer.value].slice(0, -1).join("");
  } else if (key === "\u0015") {
    composer.value = "";
  } else if (key === "\u0017") {
    composer.value = composer.value.replace(/\s*\S*$/, "");
  } else if (chunk.length === 1 && chunk >= " " && chunk !== "\u007f") {
    composer.value += chunk;
  }
  draw();
};

/** @param {string} key @param {string} chunk */
function onKey(key, chunk) {
  if (state.composer) {
    if (key === "\u001b") {
      state.composer = null;
      return draw();
    }
    return typeInComposer(key, chunk);
  }

  if (key === "\u0003") return quit();

  switch (key) {
    case "q":
      if (state.mode === "thread") return back();
      return quit();
    case "j":
    case "\u001b[B":
      moveSelection(1);
      break;
    case "k":
    case "\u001b[A":
      moveSelection(-1);
      break;
    case "g":
    case "\u001b[H":
      state.selectedIndex = 0;
      state.selectedId = null;
      break;
    case "G":
    case "\u001b[F":
      state.selectedIndex = Math.max(0, state.blockCount - 1);
      state.selectedId = null;
      break;
    case "\u0004":
    case "\u001b[6~":
      moveSelection(5);
      break;
    case "\u0015":
    case "\u001b[5~":
      moveSelection(-5);
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

const quit = () => {
  process.stdout.write("\x1b[?1049l\x1b[?25h");
  process.exit(0);
};

function startKeys() {
  if (!process.stdin.isTTY) return;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    const text = String(chunk);
    let index = 0;
    while (index < text.length) {
      if (text[index] === "\u001b" && text[index + 1] === "[") {
        const match = /^\u001b\[[0-9;]*[A-Za-z~]/.exec(text.slice(index));
        if (match) {
          onKey(match[0], match[0]);
          index += match[0].length;
          continue;
        }
      }
      onKey(text[index], text[index]);
      index += 1;
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
    state.width = Number(flag("width", process.stdout.columns || 100));
    state.avatars = args.includes("--avatars") || state.width > 52;
    if (state.avatars) {
      for (const commit of state.commits) avatarRows(commit.author);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    process.stdout.write(`${renderOnce(state).join("\n")}\n`);
    return;
  }

  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  process.on("exit", () => process.stdout.write("\x1b[?1049l\x1b[?25h"));
  process.stdout.on("resize", () => {
    state.width = process.stdout.columns || state.width;
    state.height = process.stdout.rows || state.height;
    state.avatars = state.width > 52;
    draw();
  });

  startKeys();
  draw();
  void refresh({ quiet: true }).then(() => {
    void signingKey().catch(() => {
      // Committing is optional: the feed stays readable without a key.
    });
  });

  setInterval(() => {
    state.now = Date.now();
    draw();
  }, 1000);
  setInterval(() => {
    if (state.mode === "timeline" && !state.help) void refresh({ quiet: true });
  }, interval * 1000);
}

process.on("SIGTERM", quit);
process.on("SIGINT", quit);

void main();
