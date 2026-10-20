#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

import { cleanup, postCommit } from "./lib/auth.js";
import { MAX_IMAGES, droppedPaths, extractImages, readAttachment } from "./lib/attachments.js";
import * as device from "./lib/device.js";
import { LOGS, fetchLog, fetchThread, searchUsers } from "./lib/devnull.js";
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
  avatarMode: /** @type {"circle"|"none"} */ "circle",
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
    stopMentionSearch();
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
  const height = lines.length;
  /** @type {string} */
  let frame = "";
  if (height === painted.length) {
    for (let index = 0; index < height; index += 1) {
      if (lines[index] !== painted[index]) frame += `\x1b[${index + 1};1H\x1b[2K${lines[index]}`;
    }
  } else {
    frame = `\x1b[H${lines.map((line) => `\x1b[2K${line}`).join("\r\n")}\x1b[J`;
  }
  if (frame) process.stdout.write(frame);
  painted = lines;
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
      state.composer = { kind: "device", replyTo: null, value: "", busy: null, error: null, images: [], mention: null };
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

const MAX_SUGGESTIONS = 6;
// The "@handle" being typed right before the caret, by /dev/null's own rule:
// an email, a path or a domain is not a mention.
const MENTION_AT_END = /(?:^|[^\p{L}\p{N}_./@-])@([A-Za-z0-9][A-Za-z0-9-]{0,38}|)$/u;

/** @param {string} value */
const mentionAt = (value) => {
  const match = MENTION_AT_END.exec(value);
  if (!match) return null;
  return { start: value.length - match[1].length - 1, query: match[1] };
};

/** The people already on screen: the thread's own first, then the feed's. */
const knownUsers = () => {
  /** @type {Map<string, {username: string, name: string}>} */
  const seen = new Map();
  const add = (/** @type {any} */ user) => {
    const username = clean(user?.username ?? "");
    if (!username || seen.has(username.toLowerCase())) return;
    seen.set(username.toLowerCase(), { username, name: clean(user?.name ?? "") });
  };
  if (state.thread?.root) add(state.thread.root.author);
  for (const reply of state.thread?.replies ?? []) add(reply.author);
  for (const commit of state.commits) add(commit.author);
  return [...seen.values()];
};

/**
 * The people whose handle or name matches, the way /dev/null's own suggestions
 * order them: an exact handle, then handles that start with the term, then names.
 * @param {{username: string, name: string}[]} users
 * @param {string} query
 */
const matchingUsers = (users, query) => {
  const term = query.toLowerCase();
  if (!term) return users.slice(0, MAX_SUGGESTIONS);

  /** @type {{user: {username: string, name: string}, score: number}[]} */
  const scored = [];
  for (const user of users) {
    const username = user.username.toLowerCase();
    const name = user.name.toLowerCase();
    const score = username === term ? 0
      : username.startsWith(term) ? 1
      : username.includes(term) ? 2
      : name.startsWith(term) ? 3
      : name.includes(term) ? 4
      : -1;
    if (score >= 0) scored.push({ user, score });
  }
  scored.sort((left, right) => left.score - right.score || left.user.username.localeCompare(right.user.username));
  return scored.slice(0, MAX_SUGGESTIONS).map((entry) => entry.user);
};

/** Fresh search hits go behind the people already on screen, never in front. */
const mergeUsers = (/** @type {{username: string, name: string}[]} */ first, /** @type {{username: string, name: string}[]} */ second) => {
  const seen = new Set(first.map((user) => user.username.toLowerCase()));
  const out = [...first];
  for (const user of second) {
    const key = user.username.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(user);
  }
  return out.slice(0, MAX_SUGGESTIONS);
};

/** @type {NodeJS.Timeout|null} */
let mentionTimer = null;
let mentionFetch = 0;

const stopMentionSearch = () => {
  if (mentionTimer) clearTimeout(mentionTimer);
  mentionTimer = null;
  mentionFetch += 1;
};

/** Recomputes the @ completion from the draft's tail, and searches when it is a real term. */
const updateMention = () => {
  const composer = state.composer;
  if (!composer) return;
  stopMentionSearch();

  const trigger = composer.kind === "device" ? null : mentionAt(composer.value);
  if (!trigger) {
    composer.mention = null;
    return draw();
  }

  const previous = composer.mention;
  const same = Boolean(previous && previous.query === trigger.query);
  const users = same ? mergeUsers(previous.users, matchingUsers(knownUsers(), trigger.query)) : matchingUsers(knownUsers(), trigger.query);

  composer.mention = {
    start: trigger.start,
    query: trigger.query,
    users,
    index: same ? Math.min(previous.index, Math.max(0, users.length - 1)) : 0,
    loading: trigger.query.length > 0,
  };
  draw();

  // A bare "@" offers the people on screen; /dev/null's search needs a term.
  if (!trigger.query) return;

  const query = trigger.query;
  const token = mentionFetch;
  mentionTimer = setTimeout(() => {
    mentionTimer = null;
    void searchUsers(query)
      .then((found) => {
        if (token !== mentionFetch || state.composer !== composer || composer.mention?.query !== query) return;
        composer.mention.users = mergeUsers(matchingUsers(knownUsers(), query), found);
        composer.mention.index = Math.min(composer.mention.index, Math.max(0, composer.mention.users.length - 1));
        composer.mention.loading = false;
        draw();
      })
      .catch(() => {
        if (token !== mentionFetch || state.composer !== composer || composer.mention?.query !== query) return;
        composer.mention.loading = false;
        draw();
      });
  }, 140);
};

/** Replaces the half-typed handle with the chosen person's and a space. */
const insertMention = () => {
  const composer = state.composer;
  const mention = composer?.mention;
  const user = mention?.users?.[mention.index];
  if (!composer || !mention || !user) return false;

  composer.value = `${composer.value.slice(0, mention.start)}@${user.username} `;
  composer.mention = null;
  composer.error = null;
  stopMentionSearch();
  draw();
  return true;
};

/** Keeps a dropped image even before it is read, so the draft shows it at once. */
const pushAttachments = (/** @type {any[]} */ images) => {
  const composer = state.composer;
  if (!composer) return [];

  /** @type {any[]} */
  const kept = [];
  for (const image of images) {
    if (composer.images.length >= MAX_IMAGES) break;
    if (composer.images.some((/** @type {any} */ existing) => existing.path === image.path)) continue;
    composer.images.push(image);
    kept.push(image);
  }
  return kept;
};

/**
 * Reads the files a drop or a paste named, and shows them in the composer.
 * Returns how many were attached; quiet leaves no error when nothing was, so a
 * paste of plain file names stays text.
 * @param {string[]} paths
 * @param {{quiet?: boolean}} [options]
 */
const attach = async (paths, { quiet = false } = {}) => {
  const composer = state.composer;
  if (!composer || composer.busy) return 0;

  if (composer.images.length >= MAX_IMAGES) {
    if (!quiet) composer.error = `a commit carries up to ${MAX_IMAGES} images`;
    draw();
    return 0;
  }

  /** @type {any[]} */
  const images = [];
  /** @type {string|null} */
  let error = null;

  for (const path of paths) {
    if (composer.images.length + images.length >= MAX_IMAGES) {
      error ??= `up to ${MAX_IMAGES} images per commit`;
      break;
    }
    if (composer.images.some((/** @type {any} */ image) => image.path === path)) continue;

    const found = await readAttachment(path);
    if (state.composer !== composer) return 0;
    if (found.image) images.push(found.image);
    else error ??= found.error ?? "could not read that image";
  }

  const kept = pushAttachments(images);
  composer.error = quiet && !kept.length ? null : error;
  if (kept.length === 1) flash(`attached ${kept[0].name}`);
  else if (kept.length > 1) flash(`attached ${kept.length} images`);
  updateMention();
  return kept.length;
};

/** A drop arrives as a paste of the file's path; prose pastes stay prose. */
const pasteIntoComposer = async (/** @type {string} */ text) => {
  const composer = state.composer;
  if (!composer || composer.busy) return;

  const paths = await droppedPaths(text);
  if (state.composer !== composer) return;
  if (paths?.length) {
    // One path is a drop and says what is wrong with it; a list of plain files
    // is a paste of names and stays text.
    const attached = await attach(paths, { quiet: paths.length > 1 });
    if (attached || paths.length === 1) return;
  }

  // A real paste keeps its line breaks: the composer is a commit body.
  composer.value += sanitize(text);
  updateMention();
};

const startComposer = (/** @type {any} */ replyTo) => {
  stopMentionSearch();
  state.composer = { replyTo, value: "", busy: null, error: null, images: [], mention: null };
  state.help = false;
  draw();
};

async function submit() {
  const composer = state.composer;
  if (!composer || composer.busy) return;

  if (composer.kind === "device") {
    const code = composer.value.trim();
    if (!code) {
      composer.error = "nothing to send";
      return draw();
    }

    composer.busy = "approving…";
    draw();
    try {
      await device.redeem(code);
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

  // A drop can arrive as typed characters when nothing wrapped it in a paste:
  // pull the images out of the draft and leave the words.
  const pulled = await extractImages(composer.value);
  if (state.composer !== composer) return;
  composer.value = pulled.body;
  if (pulled.images.length) pushAttachments(pulled.images);

  const body = composer.value.trim();
  if (!body) {
    composer.error = composer.images.length
      ? "add a line of text — /dev/null needs a commit message"
      : "nothing to send";
    return draw();
  }

  composer.busy = composer.images.length ? "signing and uploading…" : "signing…";
  composer.error = null;
  composer.mention = null;
  stopMentionSearch();
  draw();

  try {
    const answer = await postCommit({ body, replyTo: composer.replyTo?.permalink ?? null, images: composer.images });
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

  if (pasted) return void pasteIntoComposer(text);

  if (key === "\r") {
    void submit();
    return;
  }
  if (key === "\u007f" || key === "\b") {
    // On an empty draft, backspace takes the last attachment instead.
    if (!composer.value && composer.images.length) {
      const removed = composer.images.pop();
      composer.error = null;
      flash(`removed ${removed.name}`);
      return updateMention();
    }
    composer.value = graphemes(composer.value).slice(0, -1).join("");
  } else if (key === "\u0015") {
    composer.value = "";
  } else if (key === "\u0017") {
    composer.value = composer.value.replace(/\s*\S*$/, "");
  } else if (sanitize(text) === text && text >= " " && text !== "\u007f") {
    composer.value += text;
  }
  updateMention();
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
      // Esc first closes the people list, then the composer.
      if (state.composer.mention) {
        state.composer.mention = null;
        stopMentionSearch();
        return draw();
      }
      state.composer = null;
      stopMentionSearch();
      return draw();
    }

    const mention = state.composer.mention;
    if (mention?.users?.length) {
      if (key === "\u001b[A" || key === "\u001bOA" || key === "\u0010") {
        mention.index = (mention.index - 1 + mention.users.length) % mention.users.length;
        return draw();
      }
      if (key === "\u001b[B" || key === "\u001bOB" || key === "\u000e") {
        mention.index = (mention.index + 1) % mention.users.length;
        return draw();
      }
      if (key === "\t" || key === "\r") {
        if (insertMention()) return;
      }
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
      state.avatarMode = state.avatarMode === "circle" ? "none" : "circle";
      flash(`avatars: ${state.avatarMode === "circle" ? "colour dots" : "off"}`);
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
  process.stdout.write("\x1b[?2004l\x1b[?7h\x1b[?1049l\x1b[?25h\x1b_Ga=d,d=A,q=2\x1b\\");
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
    if (alt === "\r") {
      // Herdr sends Shift-Enter as Alt-Enter (ESC CR): a new line in the body.
      if (state.composer.busy) return;
      state.composer.value += "\n";
      return updateMention();
    }
    if (alt === "\u007f" || alt === "\b") {
      state.composer.value = state.composer.value.replace(/\s*\S*$/, "");
      updateMention();
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

  process.stdout.on("resize", () => {
    state.width = process.stdout.columns || state.width;
    state.height = process.stdout.rows || state.height;
    painted = [];
    process.stdout.write("\x1b[2J");
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
