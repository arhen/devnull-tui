#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

import { cleanup, postCommit } from "./lib/auth.js";
import * as device from "./lib/device.js";
import { avatar } from "./lib/avatars.js";
import { LOGS, fetchLog, fetchThread } from "./lib/devnull.js";
import { renderOnce, renderScreen } from "./lib/draw.js";
import { clean, graphemes, sanitize } from "./lib/text.js";

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
  confirm: null,
  newCount: 0,
  status: null,
  error: null,
  help: false,
  loading: true,
  avatarMode: /** @type {"circle"|"photo"|"none"} */ (args.includes("--photos") ? "photo" : "circle"),
  kitty: false,
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
  const previousIds = new Set(state.commits.map((/** @type {any} */ commit) => commit.id));
  if (!quiet) flash("refreshing…");
  refreshing = true;

  try {
    const result = await fetchLog(log);
    if (token !== fetchSeq || log !== state.log) return;

    // The user may have moved while the request was in flight: anchor on what
    // is selected now, and only rewrite the timeline's selection.
    const selected = state.commits[state.mode === "timeline" ? state.selectedIndex : state.timelineIndex];
    const kept = selected ? result.commits.findIndex((/** @type {any} */ commit) => commit.id === selected.id) : -1;

    state.commits = result.commits;
    state.fetchedAt = result.fetchedAt;
    state.loading = false;
    state.error = null;

    if (state.mode === "timeline") {
      state.selectedIndex = kept >= 0 ? kept : 0;
      state.selectedId = result.commits[state.selectedIndex]?.id ?? null;
    } else {
      state.timelineIndex = kept >= 0 ? kept : 0;
    }
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

let painted = /** @type {string[]} */ ([]);
const transmitted = new Set();
const placed = new Set();

/** @param {number} id @param {string} data */
/** @param {number} id @param {string} data */
const kittyTransmit = (id, data) => {
  const chunks = [];
  for (let at = 0; at < data.length; at += 4096) chunks.push(data.slice(at, at + 4096));
  return chunks
    .map((chunk, index) => `\x1b_Ga=t,f=100,i=${id},q=2${index < chunks.length - 1 ? ",m=1" : ""};${chunk}\x1b\\`)
    .join("");
};

/** @param {number} id */
const kittyDelete = (id) => `\x1b_Ga=d,d=i,i=${id},q=2\x1b\\`;

/** @param {number} row @param {number} id */
const kittyPlace = (row, id) => `\x1b[${row};1H\x1b_Ga=p,i=${id},c=2,r=1,q=2\x1b\\`;

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

  // Rewrite only the rows that changed: moving the selection repaints two or
  // three rows instead of the whole pane, which is what keeps it instant.
  const lines = result.lines;
  /** @type {Set<number>} */
  const changed = new Set();
  let frame = "";

  if (lines.length === painted.length) {
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] !== painted[index]) {
        frame += `\x1b[${index + 1};1H\x1b[2K${lines[index]}`;
        changed.add(index + 1);
      }
    }
  } else {
    frame = `\x1b[H${lines.map((line) => `\x1b[2K${line}`).join("\r\n")}\x1b[J`;
    for (let index = 0; index < lines.length; index += 1) changed.add(index + 1);
  }

  // Avatars as real images: transmit once, then put them back on any row that
  // was just erased (Kitty graphics does not survive a line clear).
  let graphics = "";
  const wanted = state.avatarMode === "photo" && state.kitty ? result.graphics : [];
  const keep = new Set(wanted.map((graphic) => graphic.id));

  for (const id of placed) {
    if (!keep.has(id)) {
      graphics += kittyDelete(id);
      placed.delete(id);
    }
  }

  for (const graphic of wanted) {
    if (!changed.has(graphic.row)) continue;
    if (!transmitted.has(graphic.id)) {
      graphics += kittyTransmit(graphic.id, graphic.data);
      transmitted.add(graphic.id);
    }
    graphics += kittyDelete(graphic.id) + kittyPlace(graphic.row, graphic.id);
    placed.add(graphic.id);
  }

  if (process.env.DEVNULL_DEBUG) {
    appendFileSync(
      "/tmp/devnull-debug.log",
      `draw mode=${state.avatarMode} kitty=${state.kitty} graphics=${result.graphics.length} changed=${changed.size}\n`,
    );
  }
  if (frame || graphics) process.stdout.write(frame + graphics);
  painted = lines;
};

/** Asks the terminal whether it speaks the Kitty graphics protocol. */
const detectKitty = async () => {
  if (!process.stdin.isTTY) return { kitty: false, stash: "" };
  let stash = "";
  return new Promise((resolve) => {
    let done = false;
    /** @param {boolean} kitty */
    const finish = (kitty) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      process.stdin.off("data", onData);
      resolve({ kitty, stash });
    };
    /** @param {Buffer|string} chunk */
    const onData = (chunk) => {
      const text = String(chunk);
      if (text.includes("\u001b_G")) return finish(true);
      stash += text;
    };
    const timer = setTimeout(() => finish(false), 300);
    process.stdin.on("data", onData);
    process.stdout.write("\u001b_Gi=1,a=q;AAAA\u001b\\");
  });
};

state.refresh = draw;

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

const isStarred = (/** @type {any} */ commit) => Boolean(commit.starred);

const toggleStar = async (/** @type {any} */ commit) => {
  if (!commit) return;
  if (!device.hasDevice()) {
    try {
      const url = await device.authorizationUrl();
      await openInBrowserTab(url);
      state.pendingStar = commit;
      state.composer = { kind: "device", replyTo: null, value: "", busy: null, error: null };
      flash("approve in the browser, then paste the code");
    } catch (error) {
      flash(clean(error instanceof Error ? error.message : String(error)));
    }
    return;
  }

  const on = isStarred(commit);
  try {
    if (on) await device.unstar(commit.id);
    else await device.star(commit.id);
    commit.starred = !on;
    commit.stars = Math.max(0, (commit.stars ?? 0) + (on ? -1 : 1));
    flash(on ? "unstarred" : "starred ✓");
  } catch (error) {
    flash(clean(error instanceof Error ? error.message : String(error)));
  }
  draw();
};

const removeSelected = async () => {
  const commit = selectedCommit();
  if (!commit) return;
  if (!device.hasDevice()) {
    flash("deletes need an approved device: press s once to approve one");
    return;
  }

  const now = Date.now();
  if (!state.confirm || state.confirm.id !== commit.id || now > state.confirm.until) {
    state.confirm = { id: commit.id, until: now + 4000 };
    flash("press d again to delete this commit");
    return;
  }

  state.confirm = null;
  try {
    await device.remove(commit.id);
    flash("deleted ✓");
    if (state.mode === "thread" && state.thread?.root) await loadThread(state.thread.root);
    else await refresh({ quiet: true });
  } catch (error) {
    flash(clean(error instanceof Error ? error.message : String(error)));
    draw();
  }
};

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

  if (composer.kind === "device") {
    composer.busy = "approving…";
    draw();
    try {
      await device.redeem(body);
      state.composer = null;
      flash("device approved ✓");
      const pending = state.pendingStar;
      state.pendingStar = null;
      if (pending) await toggleStar(pending);
    } catch (error) {
      if (state.composer === composer) {
        composer.busy = null;
        composer.error = clean(error instanceof Error ? error.message : String(error));
        draw();
      }
    }
    return;
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
  const bodyHeight = Math.max(1, state.height - 3);
  const half = Math.max(1, Math.floor(bodyHeight / 2));
  const target = state.offset + direction * half;
  const current =
    state.blocks.find((/** @type {any} */ block) => block.id === state.selectedId) ?? state.blocks[state.selectedIndex];

  if (current && current.end - current.start + 1 > bodyHeight) {
    // A commit taller than the pane scrolls inside itself, keeping the selection.
    state.offset = Math.max(current.start, Math.min(current.end - bodyHeight + 1, target));
    return;
  }

  let index = 0;
  for (const block of state.blocks) if (block.start <= target) index = block.index;
  state.selectedIndex = Math.max(0, Math.min(state.blockCount - 1, index));
  state.selectedId = null;
};

const typeInComposer = (/** @type {string} */ key, /** @type {string} */ text, /** @type {boolean} */ pasted) => {
  const composer = state.composer;
  if (!composer || composer.busy) return;

  if (pasted) {
    // Keep a pasted space that follows typed text: no trim on either side.
    composer.value += sanitize(text).replace(/\s*\n\s*/g, " ");
  } else if (key === "\r") {
    void submit();
    return;
  } else if (key === "\u007f" || key === "\b") {
    composer.value = graphemes(composer.value).slice(0, -1).join("");
  } else if (key === "\u0015") {
    composer.value = "";
  } else if (key === "\u0017") {
    composer.value = composer.value.replace(/\s*\S*$/, "");
  } else if (sanitize(text) === text && text >= " " && text !== "\u007f") {
    composer.value += text;
  }
  draw();
};

/** @param {string} key @param {string} text */
function onKey(key, text) {
  if (state.composer) {
    if (key === "\u0003") {
      state.composer.value = "";
      state.composer.error = null;
      return draw();
    }
    if (key === "\u001b") {
      if (state.composer.busy) {
        flash("posting — it cannot be cancelled");
        return;
      }
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
    case "\u001b[C":
    case "\u001bOC":
    case "\r":
      if (state.mode === "thread") {
        const commit = selectedCommit();
        if (commit) return void openReply(commit);
      } else {
        const commit = selectedCommit();
        if (commit) return openThread(commit);
      }
      break;
    case "\u001b[D":
    case "\u001bOD":
      return back();
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
    case "e":
      return void expand();
    case "R": {
      const commit = selectedCommit();
      if (commit) return startComposer(commit);
      break;
    }
    case "c":
      return startComposer(null);
    case "s":
      return void toggleStar(selectedCommit());
    case "d":
      return void removeSelected();
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
      state.avatarMode =
        state.avatarMode === "circle"
          ? state.kitty
            ? "photo"
            : "none"
          : state.avatarMode === "photo"
            ? "none"
            : "circle";
      flash(`avatars: ${state.avatarMode}`);
      painted = [];
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
  loadSeq += 1;
  state.threadStack = [];
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

const restore = () => {
  if (once) return;
  process.stdout.write("\x1b[?2004l\x1b[?7h\x1b[?1049l\x1b[?25h");
};

const quit = () => {
  cleanup();
  restore();
  process.exit(0);
};

function startKeys(/** @type {string} */ startingStash = "") {
  if (!process.stdin.isTTY) return;

  let buffer = startingStash;
  /** @type {NodeJS.Timeout|null} */
  let escapeTimer = null;

  /** @param {number} delay */
  const waitForRest = (delay) => {
    if (escapeTimer) clearTimeout(escapeTimer);
    // A lone ESC or half a sequence: drop it rather than run its bytes. A paste
    // marker may arrive in pieces, so it gets longer than a chord does.
    escapeTimer = setTimeout(() => {
      escapeTimer = null;
      const lone = buffer === "\u001b";
      buffer = "";
      // A bare Esc is a key; half a sequence is noise.
      if (lone) onKey("\u001b", "\u001b");
    }, delay);
  };

  /** @param {string} alt */
  const onAlt = (alt) => {
    if (!state.composer) return;
    if (alt === "\u007f" || alt === "\b") {
      state.composer.value = state.composer.value.replace(/\s*\S*$/, "");
      draw();
    }
  };

  const drain = () => {
    while (buffer.length) {
      if (escapeTimer) {
        clearTimeout(escapeTimer);
        escapeTimer = null;
      }

      if (buffer.startsWith("\u001b[200~")) {
        const end = buffer.indexOf("\u001b[201~");
        if (end === -1) return waitForRest(500);
        const pasted = buffer.slice(6, end);
        buffer = buffer.slice(end + 6);
        if (state.composer) typeInComposer("", pasted, true);
        continue;
      }

      if (buffer[0] === "\u001b") {
        const csi = /^\u001b[[O][0-9;]*[A-Za-z~]/.exec(buffer);
        if (csi) {
          buffer = buffer.slice(csi[0].length);
          onKey(csi[0], csi[0]);
          continue;
        }
        const partialPaste = "\u001b[200~".startsWith(buffer) && buffer.length >= 2;
        if (partialPaste) return waitForRest(500);
        if (/^\u001b(\[[0-9;]*|O)?$/.test(buffer)) return waitForRest(100);

        const alt = String.fromCodePoint(/** @type {number} */ (buffer.codePointAt(1)));
        buffer = buffer.slice(1 + alt.length);
        onAlt(alt);
        continue;
      }

      const char = String.fromCodePoint(/** @type {number} */ (buffer.codePointAt(0)));
      buffer = buffer.slice(char.length);
      onKey(char, char);
    }
  };

  process.stdin.on("data", (chunk) => {
    const text = String(chunk);
    // A terminal without bracketed paste drops a whole paste in one read, Enter
    // and all: never let that turn into a signed commit.
    if (!buffer && !text.startsWith("\u001b") && text.length > 4 && text.includes("\r")) {
      if (state.composer) typeInComposer("", text, true);
      return;
    }
    buffer += text;
    drain();
  });

  process.stdin.on("end", quit);
  if (buffer) drain();
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
    state.avatarMode = args.includes("--photos") || args.includes("--avatars") ? "photo" : "circle";
    if (state.avatarMode === "photo") {
      for (const commit of state.commits) avatar(commit.author);
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    process.stdout.write(`${renderOnce(state).join("\n")}\n`);
    return;
  }

  process.stdout.write("\x1b[?1049h\x1b[?25l\x1b[2J");
  painted = [];
  process.on("exit", restore);

  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdout.write("\x1b[?2004h\x1b[?7l");
  }

  const probe = await detectKitty();
  state.kitty = probe.kitty;
  if (process.env.DEVNULL_DEBUG) {
    appendFileSync("/tmp/devnull-debug.log", `probe kitty=${probe.kitty} stash=${probe.stash.length}\n`);
  }
  if (state.avatarMode === "photo" && !state.kitty) state.avatarMode = "circle";

  process.stdout.on("resize", () => {
    state.width = process.stdout.columns || state.width;
    state.height = process.stdout.rows || state.height;
    painted = [];
    process.stdout.write("\x1b[2J");
    draw();
  });

  startKeys(probe.stash);
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
