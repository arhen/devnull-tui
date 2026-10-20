#!/usr/bin/env node
// @ts-check
import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";

import { cleanup, postCommit } from "./lib/auth.js";
import { MAX_IMAGES, droppedPaths, extractImages, readAttachment } from "./lib/attachments.js";
import { fetchFollowing, fetchNotificationGroup, fetchNotifications, fetchUnread } from "./lib/api.js";
import * as device from "./lib/device.js";
import { fetchLog, fetchThread, searchUsers } from "./lib/devnull.js";
import { TABS, renderOnce, renderScreen } from "./lib/draw.js";
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
const wantedTab = String(flag("log", "latest"));
const initialTab = TABS.includes(wantedTab) ? wantedTab : "latest";
const interval = Math.max(15, Number(flag("interval", 60)) || 60);

/** @type {any} */
const state = {
  mode: "timeline",
  tab: initialTab,
  commits: [],
  notifications: {
    groups: /** @type {any[]} */ ([]),
    items: /** @type {{notification: any, depth: number, childrenLoaded?: boolean}[]} */ ([]),
    readAt: null,
    nextCursor: null,
    fetchedAt: 0,
    expanded: /** @type {Map<string, any[]>} */ (new Map()),
  },
  gate: null,
  unread: 0,
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
  if (state.tab === "notifications") return null;
  return state.commits[state.selectedIndex] ?? null;
};

const selectedNotification = () =>
  state.tab === "notifications" && state.mode !== "thread"
    ? state.notifications.items[state.selectedIndex]?.notification ?? null
    : null;

/** One signed request for the badge: it marks nothing read, unlike listing the inbox. */
async function refreshUnread() {
  if (!device.hasDevice()) return;
  try {
    const count = await fetchUnread();
    if (state.unread === count) return;
    state.unread = count;
    draw();
  } catch {
    // The badge is a nicety; a failed poll must not put an error on screen.
  }
}

/** The commit the keys act on: the inbox's commit, or the log's selection. */
const selectedSubject = () => selectedNotification()?.commit ?? selectedCommit();

/** Following and the inbox are the user's own, so they need an approved device. */
const needsDevice = () => state.tab === "following" || state.tab === "notifications";

/** The flattened inbox: a group, then the members `e` opened under it. */
const rebuildNotifications = () => {
  const inbox = state.notifications;
  const selected = inbox.items[state.selectedIndex]?.notification ?? null;
  /** @type {{notification: any, depth: number, childrenLoaded?: boolean}[]} */
  const items = [];

  for (const group of inbox.groups) {
    const members = inbox.expanded.get(group.groupId);
    items.push({ notification: group, depth: 0, childrenLoaded: Array.isArray(members) });
    for (const member of members ?? []) items.push({ notification: member, depth: 1 });
  }

  inbox.items = items;
  const kept = selected ? items.findIndex((item) => item.notification.id === selected.id) : -1;
  const keptGroup = kept < 0 && selected ? items.findIndex((item) => item.notification.groupId === selected.groupId) : -1;
  const index = kept >= 0 ? kept : keptGroup >= 0 ? keptGroup : Math.min(state.selectedIndex, Math.max(0, items.length - 1));
  state.selectedIndex = index;
  if (state.mode === "timeline") state.timelineIndex = index;
  state.selectedId = items[index]?.notification.id ?? null;
};

async function refresh({ quiet = false } = {}) {
  if (refreshing && quiet) return;

  if (needsDevice() && !device.hasDevice()) {
    state.gate = state.tab;
    state.loading = false;
    state.error = null;
    draw();
    return;
  }
  state.gate = null;

  const token = ++fetchSeq;
  const tab = state.tab;
  if (!quiet) flash("refreshing…");
  refreshing = true;

  try {
    if (tab === "notifications") {
      const result = await fetchNotifications();
      if (token !== fetchSeq || tab !== state.tab) return;

      state.notifications.groups = result.notifications;
      state.notifications.readAt = result.readAt;
      state.notifications.nextCursor = result.nextCursor;
      state.notifications.fetchedAt = result.fetchedAt;
      state.notifications.expanded.clear();
      rebuildNotifications();
      state.fetchedAt = result.fetchedAt;
      state.loading = false;
      state.error = null;
      // Listing marks everything read, so there is nothing unread left.
      state.unread = 0;
      if (Date.now() > flashUntil) state.status = null;
      return;
    }

    const result = tab === "following" ? await fetchFollowing() : await fetchLog(tab);
    if (token !== fetchSeq || tab !== state.tab) return;

    // The user may have moved while the request was in flight: anchor on what
    // is selected now, and only rewrite the timeline's selection.
    const selected = state.commits[state.mode === "timeline" ? state.selectedIndex : state.timelineIndex];
    const kept = selected ? result.commits.findIndex((/** @type {any} */ commit) => commit.id === selected.id) : -1;
    const previousIds = new Set(state.commits.map((/** @type {any} */ commit) => commit.id));

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
    void refreshUnread();
  } catch (error) {
    if (token === fetchSeq) {
      const message = clean(error instanceof Error ? error.message : String(error));
      // A key the server does not know yet reads as "no longer approved": the
      // pane has not finished the approval, so offer it rather than retry.
      if (needsDevice() && /approved/.test(message)) state.gate = state.tab;
      else state.error = message;
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

const expandNotification = async () => {
  const item = state.notifications.items[state.selectedIndex] ?? null;
  if (!item || item.depth > 0) {
    flash("nothing to expand");
    return;
  }

  const notification = item.notification;
  const inbox = state.notifications;
  if (inbox.expanded.has(notification.groupId)) {
    inbox.expanded.delete(notification.groupId);
    rebuildNotifications();
    return draw();
  }
  if (notification.eventCount <= 1 && notification.actorsCount <= 1) {
    flash("nothing to expand");
    return;
  }

  flash(`loading ${notification.eventCount} ${notification.eventCount === 1 ? "event" : "events"}…`);
  try {
    const members = await fetchNotificationGroup(notification);
    if (state.tab !== "notifications") return;
    if (!members.length) {
      flash("this group has nothing more to show");
      return;
    }
    inbox.expanded.set(notification.groupId, members);
    rebuildNotifications();
    if (Date.now() > flashUntil) state.status = null;
  } catch (error) {
    flash(clean(error instanceof Error ? error.message : String(error)));
    return;
  }
  draw();
};

const expand = async () => {
  if (state.tab === "notifications" && state.mode !== "thread") return expandNotification();
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

/** Starts the one-time approval of this pane as a /dev/null device. */
async function approveDevice(/** @type {any} */ after = null) {
  try {
    const url = await device.authorizationUrl();
    await openInBrowserTab(url);
    state.pendingStar = after;
    state.composer = { kind: "device", replyTo: null, value: "", cursor: 0, busy: null, error: null, images: [], mention: null };
    flash("approve in the browser, then paste the code");
  } catch (error) {
    flash(clean(error instanceof Error ? error.message : String(error)));
  }
  draw();
}

async function openSelected() {
  const notification = selectedNotification();
  const commit = selectedSubject();
  const url = commit?.permalink ?? notification?.actor.permalink ?? null;
  if (!url) return;
  flash("opening…");
  const opened = await openInBrowserTab(url);
  flash(opened ? "opened in the browser" : url);
}

const isStarred = (/** @type {any} */ commit) => Boolean(commit.starred);

const toggleStar = async (/** @type {any} */ commit) => {
  if (!commit) return;
  if (!device.hasDevice()) return void approveDevice(commit);

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
  const commit = selectedSubject();
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

/**
 * The "@handle" ending at the caret.
 * @param {string} value
 * @param {number} cursor
 */
const mentionAt = (value, cursor) => {
  const before = value.slice(0, cursor);
  const match = MENTION_AT_END.exec(before);
  if (!match) return null;
  return { start: cursor - match[1].length - 1, query: match[1] };
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

  cursorOf(composer);
  const trigger = composer.kind === "device" ? null : mentionAt(composer.value, composer.cursor);
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

  const cursor = cursorOf(composer);
  if (mention.start > cursor) return false;

  const inserted = `@${user.username} `;
  composer.value = composer.value.slice(0, mention.start) + inserted + composer.value.slice(cursor);
  composer.cursor = mention.start + inserted.length;
  composer.mention = null;
  composer.error = null;
  stopMentionSearch();
  draw();
  return true;
};

/* ---- editing: the caret moves through the draft, grapheme by grapheme ---- */

/** Keeps the caret inside the draft, on a code-unit boundary it owns. */
const cursorOf = (/** @type {any} */ composer) => {
  const cursor = Number.isInteger(composer.cursor) ? composer.cursor : composer.value.length;
  composer.cursor = Math.max(0, Math.min(composer.value.length, cursor));
  return composer.cursor;
};

/** Every grapheme boundary in the draft, as offsets, so nothing splits a character. */
const stopsOf = (/** @type {string} */ value) => {
  /** @type {number[]} */
  const offsets = [0];
  let offset = 0;
  for (const segment of graphemes(value)) {
    offset += segment.length;
    offsets.push(offset);
  }
  return offsets;
};

/** @param {string} value @param {number} cursor */
const previousStop = (value, cursor) => {
  let previous = 0;
  for (const stop of stopsOf(value)) {
    if (stop >= cursor) break;
    previous = stop;
  }
  return previous;
};

/** @param {string} value @param {number} cursor */
const nextStop = (value, cursor) => {
  for (const stop of stopsOf(value)) if (stop > cursor) return stop;
  return value.length;
};

/** @param {string} value @param {number} index */
const snapBack = (value, index) => previousStop(value, Math.max(0, Math.min(value.length, index)) + 1);

/** @param {string} value @param {number} cursor */
const lineStart = (value, cursor) => value.lastIndexOf("\n", Math.max(0, cursor - 1)) + 1;

/** @param {string} value @param {number} cursor */
const lineEnd = (value, cursor) => {
  const end = value.indexOf("\n", cursor);
  return end === -1 ? value.length : end;
};

/** @param {string} value @param {number} cursor */
const previousWord = (value, cursor) => {
  const segments = graphemes(value);
  const stops = stopsOf(value);
  let index = stops.indexOf(cursor);
  if (index < 0) index = 0;
  while (index > 0 && /\s/.test(segments[index - 1])) index -= 1;
  while (index > 0 && !/\s/.test(segments[index - 1])) index -= 1;
  return stops[index];
};

/** @param {string} value @param {number} cursor */
const nextWord = (value, cursor) => {
  const segments = graphemes(value);
  const stops = stopsOf(value);
  let index = Math.max(0, stops.indexOf(cursor));
  while (index < segments.length && /\s/.test(segments[index])) index += 1;
  while (index < segments.length && !/\s/.test(segments[index])) index += 1;
  return stops[index] ?? value.length;
};

const moveCursorTo = (/** @type {any} */ composer, /** @type {number} */ to) => {
  composer.cursor = Math.max(0, Math.min(composer.value.length, to));
  updateMention();
};

const insertAtCursor = (/** @type {any} */ composer, /** @type {string} */ text) => {
  const cursor = cursorOf(composer);
  composer.value = composer.value.slice(0, cursor) + text + composer.value.slice(cursor);
  composer.cursor = cursor + text.length;
  updateMention();
};

const deleteBackward = (/** @type {any} */ composer) => {
  const cursor = cursorOf(composer);
  if (!cursor) return updateMention();
  const from = previousStop(composer.value, cursor);
  composer.value = composer.value.slice(0, from) + composer.value.slice(cursor);
  composer.cursor = from;
  updateMention();
};

const deleteForward = (/** @type {any} */ composer) => {
  const cursor = cursorOf(composer);
  const to = nextStop(composer.value, cursor);
  composer.value = composer.value.slice(0, cursor) + composer.value.slice(to);
  updateMention();
};

const deleteWordBackward = (/** @type {any} */ composer) => {
  const cursor = cursorOf(composer);
  if (!cursor) return updateMention();
  const from = previousWord(composer.value, cursor);
  composer.value = composer.value.slice(0, from) + composer.value.slice(cursor);
  composer.cursor = from;
  updateMention();
};

const deleteToLineEnd = (/** @type {any} */ composer) => {
  const cursor = cursorOf(composer);
  composer.value = composer.value.slice(0, cursor) + composer.value.slice(lineEnd(composer.value, cursor));
  updateMention();
};

const moveVertical = (/** @type {any} */ composer, /** @type {number} */ direction) => {
  const value = composer.value;
  const cursor = cursorOf(composer);
  const start = lineStart(value, cursor);
  const column = cursor - start;

  if (direction < 0) {
    if (start === 0) return moveCursorTo(composer, 0);
    const previousStart = lineStart(value, start - 1);
    return moveCursorTo(composer, snapBack(value, Math.min(previousStart + column, start - 1)));
  }

  const end = lineEnd(value, cursor);
  if (end >= value.length) return moveCursorTo(composer, value.length);
  const nextStart = end + 1;
  return moveCursorTo(composer, snapBack(value, Math.min(nextStart + column, lineEnd(value, nextStart))));
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
  insertAtCursor(composer, sanitize(text));
};

const startComposer = (/** @type {any} */ replyTo) => {
  stopMentionSearch();
  state.composer = { replyTo, value: "", cursor: 0, busy: null, error: null, images: [], mention: null };
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
      else if (needsDevice()) void refresh();
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
  composer.cursor = pulled.body.length;
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

const ARROW_LEFT = /^\u001b(?:\[[0-9;]*|O)D$/;
const ARROW_RIGHT = /^\u001b(?:\[[0-9;]*|O)C$/;
const ARROW_UP = /^\u001b(?:\[[0-9;]*|O)A$/;
const ARROW_DOWN = /^\u001b(?:\[[0-9;]*|O)B$/;
const KEY_HOME = /^\u001b(?:\[[0-9;]*|O)H$|^\u001b\[[17]~$/;
const KEY_END = /^\u001b(?:\[[0-9;]*|O)F$|^\u001b\[[48]~$/;
const KEY_DELETE = /^\u001b\[3(?:;\d+)*~$/;
// Kitty's CSI u and xterm's modifyOtherKeys. Herdr sends Shift-Enter the xterm
// way (CSI 27;2;13~), and Alt-Enter as ESC CR.
const ENHANCED_KEY = /^\u001b\[(?:27;(\d+);(\d+)~|(\d+)(?:;(\d+))?(?:;[\d:]+)?u)$/;

/** An arrow with Alt or Ctrl skips a word, the way a shell's does. */
const arrowSkipsWord = (/** @type {string} */ sequence) => {
  const match = /;(\d+)/.exec(sequence);
  if (!match) return false;
  return Boolean(Math.max(0, Number(match[1]) - 1) & (2 | 4));
};

/**
 * Keys that arrive as a code plus a modifier bitmask: shift-enter's newline,
 * Ctrl combinations, Alt words. True when the key was one of them.
 * @param {any} composer
 * @param {{code: number, bits: number}} key
 */
const applyEnhancedKey = (composer, key) => {
  const { code, bits } = key;
  const shift = Boolean(bits & 1);
  const alt = Boolean(bits & 2);
  const ctrl = Boolean(bits & 4);
  const superKey = Boolean(bits & 8);
  if (superKey) return true;

  if (code === 13) {
    insertAtCursor(composer, "\n");
    return true;
  }
  if (code === 27) {
    if (composer.mention) {
      composer.mention = null;
      stopMentionSearch();
      draw();
    } else {
      state.composer = null;
      stopMentionSearch();
      draw();
    }
    return true;
  }
  if (code === 9) {
    if (!shift) insertMention();
    return true;
  }
  if (code === 127) {
    if (ctrl || alt) deleteWordBackward(composer);
    else deleteBackward(composer);
    return true;
  }
  if (code >= 64 && code <= 95 && ctrl) {
    // Ctrl+letter again, as the byte the rest of the editor knows.
    return typeInComposer(String.fromCharCode(code & 0x1f), "", false), true;
  }
  if (alt && (code === 98 || code === 102)) {
    moveCursorTo(composer, code === 98 ? previousWord(composer.value, cursorOf(composer)) : nextWord(composer.value, cursorOf(composer)));
    return true;
  }
  if (!ctrl && !alt && code >= 32) {
    insertAtCursor(composer, String.fromCodePoint(code));
    return true;
  }
  return true;
};

const typeInComposer = (/** @type {string} */ key, /** @type {string} */ text, /** @type {boolean} */ pasted) => {
  const composer = state.composer;
  if (!composer || composer.busy) return;

  if (pasted) return void pasteIntoComposer(text);

  const enhanced = ENHANCED_KEY.exec(key);
  if (enhanced) {
    const code = Number(enhanced[3] ?? enhanced[2]);
    const mods = Number(enhanced[1] ?? enhanced[4] ?? 1);
    if (applyEnhancedKey(composer, { code, bits: Math.max(0, mods - 1) })) return;
  }

  if (key === "\r") {
    void submit();
    return;
  }
  if (key === "\n") return insertAtCursor(composer, "\n");

  const cursor = cursorOf(composer);
  if (ARROW_LEFT.test(key)) return moveCursorTo(composer, arrowSkipsWord(key) ? previousWord(composer.value, cursor) : previousStop(composer.value, cursor));
  if (ARROW_RIGHT.test(key)) return moveCursorTo(composer, arrowSkipsWord(key) ? nextWord(composer.value, cursor) : nextStop(composer.value, cursor));
  if (ARROW_UP.test(key)) return moveVertical(composer, -1);
  if (ARROW_DOWN.test(key)) return moveVertical(composer, 1);
  if (KEY_HOME.test(key) || key === "\u0001") return moveCursorTo(composer, lineStart(composer.value, cursor));
  if (KEY_END.test(key) || key === "\u0005") return moveCursorTo(composer, lineEnd(composer.value, cursor));
  if (KEY_DELETE.test(key) || key === "\u0004") return deleteForward(composer);
  if (key === "\u000b") return deleteToLineEnd(composer);

  if (key === "\u007f" || key === "\b") {
    // On an empty draft, backspace takes the last attachment instead.
    if (!composer.value && composer.images.length) {
      const removed = composer.images.pop();
      composer.error = null;
      flash(`removed ${removed.name}`);
      return updateMention();
    }
    return deleteBackward(composer);
  }
  if (key === "\u0015") {
    composer.value = "";
    composer.cursor = 0;
    return updateMention();
  }
  if (key === "\u0017") return deleteWordBackward(composer);

  if (sanitize(text) === text && text >= " " && text !== "\u007f") insertAtCursor(composer, text);
  else updateMention();
};

/** @param {string} key @param {string} text */
function onKey(key, text) {
  if (state.composer) {
    if (key === "\u0003") {
      state.composer.value = "";
      state.composer.cursor = 0;
      state.composer.error = null;
      state.composer.mention = null;
      stopMentionSearch();
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
      } else if (state.tab === "notifications") {
        const commit = selectedNotification()?.commit;
        if (commit) return openThread(commit);
        return void openSelected();
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
      const commit = selectedSubject();
      if (commit) return startComposer(commit);
      break;
    }
    case "c":
      return startComposer(null);
    case "s":
      if (state.gate) return void approveDevice();
      return void toggleStar(selectedSubject());
    case "d":
      return void removeSelected();
    case "o":
      return void openSelected();
    case "r":
      if (state.mode === "thread" && state.thread?.root) return void loadThread(state.thread.root);
      return void refresh();
    case "t":
      return switchTab(state.tab === "latest" ? "trending" : "latest");
    case "1":
    case "2":
    case "3":
    case "4":
      return switchTab(TABS[Number(key) - 1]);
    case "n":
      return switchTab("notifications");
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

const switchTab = (/** @type {string} */ tab) => {
  if (state.tab === tab) return;
  loadSeq += 1;
  state.threadStack = [];
  state.tab = tab;
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
  state.error = null;
  state.gate = null;
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
    const composer = state.composer;
    if (!composer || composer.busy) return;
    // Alt-Enter (which Herdr also sends for Shift-Enter): a new line in the body.
    if (alt === "\r") return insertAtCursor(composer, "\n");
    if (alt === "\u007f" || alt === "\b") return deleteWordBackward(composer);
    // Herdr maps Alt-Left and Alt-Right to these, as readline does.
    if (alt === "b") return moveCursorTo(composer, previousWord(composer.value, cursorOf(composer)));
    if (alt === "f") return moveCursorTo(composer, nextWord(composer.value, cursorOf(composer)));
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
    if (state.gate) {
      process.stderr.write(`${state.gate} is yours alone, so it needs an approved device: open the pane and press s once.\n`);
      process.exit(1);
    }
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
