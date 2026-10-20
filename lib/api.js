// @ts-check
// /dev/null's own API, the one the mobile app talks to: signed with the device
// key, it answers what the web only shows a signed-in user — Following, and the
// notifications that mark themselves read as they are listed.
import { get } from "./device.js";
import { laneFor, normalizeCommit } from "./devnull.js";
import { clean } from "./text.js";

const BASE = "https://dev-null.sh";

/** @param {any} user */
const normalizeActor = (user) => {
  const username = clean(user?.username) || "unknown";
  return {
    id: user?.id ?? username,
    name: clean(user?.name) || username,
    username,
    lane: laneFor(user),
    avatarUrl: user?.avatar_url ?? null,
    permalink: typeof user?.html_url === "string" ? user.html_url : `${BASE}/@${username}`,
    followed: Boolean(user?.is_followed),
    followsYou: Boolean(user?.follows_you),
  };
};

/** A commit that is only images has nothing else to read in the inbox. */
const isImagesOnly = (/** @type {any} */ commit) =>
  Boolean(commit) && commit.images > 0 && commit.segments.every((/** @type {any} */ piece) => !piece.text.trim());

/**
 * @param {any} notification
 * @param {string|null} readAt
 */
const isUnread = (notification, readAt) => {
  if (!notification.read_at) return true;
  const seen = Date.parse(String(notification.read_at));
  const moment = readAt ? Date.parse(readAt) : Number.NaN;
  if (!Number.isFinite(seen)) return true;
  return Number.isFinite(moment) && seen >= moment;
};

/** @param {any} notification */
const actionOf = (notification) => {
  switch (notification.type) {
    case "followed":
      return "followed you";
    case "replied":
      return "replied to your commit";
    case "quoted":
      return "quoted your commit";
    case "starred":
      return isImagesOnly(notification.commit) ? "starred your images" : "starred your commit";
    case "mentioned":
      return "mentioned you";
    case "approved":
      return "approved your commit";
    case "rejected":
      return "rejected your commit";
    case "leveled_up":
      return notification.rank ? `reached level ${notification.level}: ${notification.rank}` : "leveled up";
    default:
      return String(notification.type ?? "did something").replaceAll("_", " ");
  }
};

/**
 * @param {any} notification
 * @param {string|null} readAt when the user last read the inbox
 */
const normalizeNotification = (notification, readAt) => {
  const commit = notification.commit ? normalizeCommit(notification.commit) : null;
  return {
    id: String(notification.id),
    type: String(notification.type ?? ""),
    groupId: String(notification.group_id ?? notification.id),
    eventCount: Number(notification.event_count ?? 1),
    actorsCount: Number(notification.actors_count ?? 1),
    unreadCount: Number(notification.unread_count ?? 0),
    readAt: notification.read_at ?? null,
    createdAt: notification.created_at ?? null,
    reason: clean(notification.reason ?? "") || null,
    level: notification.level ?? null,
    rank: clean(notification.rank ?? "") || null,
    rankDescription: clean(notification.rank_description ?? "") || null,
    actor: normalizeActor(notification.actor),
    actors: Array.isArray(notification.actors) ? notification.actors.map(normalizeActor) : [],
    commit,
    text: actionOf({ ...notification, commit }),
    // Listing marks everything read, so what was read just now arrived since
    // the last visit: that is how the web decides what is new.
    isNew: isUnread(notification, readAt),
  };
};

const cursorOf = (/** @type {any} */ page) => {
  const next = page?.meta?.next_cursor ?? page?.next_cursor ?? null;
  return typeof next === "string" && next ? next : null;
};

/**
 * The Following log: the user's own timeline, which only a signed request gets.
 * /dev/null answers the same commit shape the web renders, with the bodies
 * already segmented.
 */
export async function fetchFollowing() {
  const page = await get("/api/v1/log/following");
  return {
    commits: (page?.data ?? []).map(normalizeCommit),
    suggestions: (page?.suggestions ?? []).map(normalizeCommit),
    nextCursor: cursorOf(page),
    fetchedAt: Date.now(),
  };
}

/**
 * The inbox, grouped and filtered the way the web groups it. Listing marks
 * every notification read, so the pane only asks while the tab is open.
 * @param {{through?: string|null}} [options]
 */
export async function fetchNotifications({ through = null } = {}) {
  const query = new URLSearchParams({ type: "all" });
  if (through) query.set("through", through);
  const page = await get(`/api/v1/notifications?${query.toString()}`);
  const readAt = typeof page?.read_at === "string" ? page.read_at : null;
  return {
    notifications: (page?.data ?? []).map((/** @type {any} */ notification) =>
      normalizeNotification(notification, readAt),
    ),
    readAt,
    nextCursor: cursorOf(page),
    fetchedAt: Date.now(),
  };
}

/**
 * Every notification in a group, newest first, so `e` can open one.
 * @param {any} notification
 */
export async function fetchNotificationGroup(notification) {
  const page = await get(
    `/api/v1/notifications/${encodeURIComponent(notification.id)}/group?${new URLSearchParams({ type: "all" }).toString()}`,
  );
  return (page?.data ?? [])
    .map((/** @type {any} */ member) => normalizeNotification(member, null))
    .filter((/** @type {any} */ member) => member.id !== notification.id);
}
