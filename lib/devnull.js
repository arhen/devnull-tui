// @ts-check
import { clean, htmlToText, linkify } from "./text.js";

const BASE = "https://dev-null.sh";
const USER_AGENT = "devnull-tui/0.1 (+https://github.com/arhen/devnull-tui)";
const REPLIES_PER_PAGE = 25;

export const LOGS = ["latest", "trending"];

// /dev/null's own lanes, dark theme. The web uses var(--lane-N) for the integer
// lanes it stores; for a lane it does not know, hash the login.
const LANES = ["#ff8a4c", "#51cf66", "#da77f2", "#3bc9db", "#f06595", "#fcc419"];

const LANE_PATTERN = /^#[0-9a-f]{6}$/i;

/** The lane colour /dev/null draws a user in: theirs, or one hashed from their login. */
export const laneFor = (user) => {
  const lane = user?.lane;
  if (typeof lane === "string" && LANE_PATTERN.test(lane)) return lane;
  if (Number.isInteger(lane) && lane >= 0 && lane < LANES.length) return LANES[lane];
  let hash = 0;
  for (const char of String(user?.username ?? "").toLowerCase()) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
  return LANES[hash % LANES.length];
};

const PAGE_PATTERN = /<script\b[^>]*\bdata-page="app"[^>]*>([\s\S]*?)<\/script>/;

const pageProps = (html) => {
  const match = PAGE_PATTERN.exec(html);
  if (!match) throw new Error("/dev/null sent a page without its data");
  return JSON.parse(match[1]).props;
};

const segmentsOf = (commit) => {
  const segments = Array.isArray(commit.body_segments) && commit.body_segments.length
    ? commit.body_segments
    : [{ type: "text", text: commit.body ?? "" }];

  return segments.flatMap((segment) => {
    if (segment.type === "code") return [{ kind: "code", text: segment.code ?? "" }];
    if (segment.type === "block") return [{ kind: "code", text: `\n${htmlToText(segment.html ?? segment.code ?? "")}\n` }];
    return linkify(segment.text ?? segment.code ?? "");
  });
};

const hashOf = (commit) => String(commit.id ?? "").replaceAll("-", "").slice(-7);

export const normalizeCommit = (commit) => {
  const author = commit.user ?? commit.author ?? {};
  const lane = laneFor(author);
  return {
    id: commit.id,
    shortHash: typeof commit.short_hash === "string" && commit.short_hash ? commit.short_hash : hashOf(commit),
    permalink: typeof commit.html_url === "string" && commit.html_url
      ? commit.html_url
      : `${BASE}/@${author.username}/commits/${commit.id}`,
    createdAt: commit.created_at ?? commit.deleted_at ?? null,
    // A deleted commit that still has replies comes back as a tombstone.
    deleted: Boolean(commit.deleted_at),
    author: {
      id: author.id ?? author.username,
      name: clean(author.name) || clean(author.username) || "someone",
      username: clean(author.username) || "unknown",
      avatarUrl: author.avatar_url ?? null,
      lane,
    },
    segments: segmentsOf(commit),
    stars: commit.stars_count ?? 0,
    starred: Boolean(commit.starred),
    replies: commit.replies_count ?? 0,
    quote: commit.quoted_commit ? normalizeCommit(commit.quoted_commit) : null,
    quoteMissing: Boolean(commit.quoted_commit_id) && !commit.quoted_commit,
    replyPreview: (commit.reply_preview?.data ?? []).map(normalizeCommit),
    linkPreview: commit.link_preview
      ? {
          url: commit.link_preview.url,
          title: clean(commit.link_preview.title),
          description: clean(commit.link_preview.description),
        }
      : null,
    images: (Array.isArray(commit.images) ? commit.images : [])
      .map((image) => ({
        id: String(image?.id ?? ""),
        url: typeof image?.url === "string" ? image.url : "",
        width: Number.isFinite(image?.width) ? image.width : 0,
        height: Number.isFinite(image?.height) ? image.height : 0,
        description: clean(image?.description ?? "") || null,
      }))
      .filter((image) => image.id && image.url),
    poll: commit.poll
      ? {
          closed: Boolean(commit.poll.is_closed),
          closesAt: commit.poll.closes_at,
          options: (commit.poll.options ?? []).map((option) => ({
            label: clean(option.label),
            voted: Boolean(option.voted),
          })),
        }
      : null,
  };
};

const get = async (url, { timeout = 15000, headers = {} } = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, {
      headers: { accept: "text/html", "user-agent": USER_AGENT, ...headers },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`/dev/null answered ${response.status}`);
    return await response.text();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("/dev/null answered")) throw error;
    throw new Error(error.name === "AbortError" ? "/dev/null did not answer" : "/dev/null is unreachable");
  } finally {
    clearTimeout(timer);
  }
};

export async function fetchLog(log) {
  const html = await get(`${BASE}/log/${LOGS.includes(log) ? log : "latest"}`);
  const props = pageProps(html);
  return {
    commits: (props.commits?.data ?? []).map(normalizeCommit),
    fetchedAt: Date.now(),
    log: props.log ?? log,
  };
}

const peopleCache = new Map();
const PEOPLE_TTL = 60_000;

/**
 * People for an @ completion, from the same public search the web composer
 * uses. A term is required: /dev/null answers nothing for a bare "@".
 * @param {string} query
 * @returns {Promise<{username: string, name: string}[]>}
 */
export async function searchUsers(query) {
  const term = String(query ?? "").trim().replace(/^@+/, "");
  if (!term) return [];

  const cached = peopleCache.get(term);
  if (cached && Date.now() - cached.at < PEOPLE_TTL) return cached.users;

  const url = `${BASE}/search/users?q=${encodeURIComponent(term)}`;
  let data;
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": USER_AGENT },
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`/dev/null answered ${response.status}`);
    data = await response.json();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("/dev/null answered")) throw error;
    throw new Error("could not search people");
  }

  const users = (Array.isArray(data?.users) ? data.users : [])
    .map((/** @type {any} */ user) => ({ username: clean(user?.username ?? ""), name: clean(user?.name ?? "") }))
    .filter((/** @type {any} */ user) => user.username)
    .slice(0, 6);

  // The search is rate limited: keep the last answers for a minute and drop
  // the oldest once the map grows, so a long session cannot hold on to all of it.
  peopleCache.set(term, { users, at: Date.now() });
  if (peopleCache.size > 64) peopleCache.delete(peopleCache.keys().next().value);
  return users;
}

/**
 * A commit and its conversation: the commit page carries the root, its
 * ancestors, and its replies, which deeper replies hang off.
 */
export async function fetchThread(commit, { maxPages = 5 } = {}) {
  const headers = { cookie: `replies_per_page=${REPLIES_PER_PAGE}` };
  const first = pageProps(await get(commit.permalink, { headers }));

  const replies = (first.replies?.data ?? []).map(normalizeCommit);
  let url = first.replies?.next_page_url ?? null;
  let pages = 1;

  while (url && pages < maxPages) {
    let next;
    try {
      next = new URL(url, BASE);
    } catch {
      break;
    }
    if (next.origin !== new URL(BASE).origin) break;

    const props = pageProps(await get(next.toString(), { headers }));
    replies.push(...(props.replies?.data ?? []).map(normalizeCommit));
    url = props.replies?.next_page_url ?? null;
    pages += 1;
  }

  return {
    root: normalizeCommit(first.commit),
    ancestors: (first.ancestors ?? []).map(normalizeCommit),
    replies,
    more: Boolean(url),
    fetchedAt: Date.now(),
  };
}
