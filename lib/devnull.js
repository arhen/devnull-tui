// @ts-check
import { clean, htmlToText, linkify } from "./text.js";

const BASE = "https://dev-null.sh";
const USER_AGENT = "herdr-devnull/0.1 (+https://dev-null.sh)";
const REPLIES_PER_PAGE = 25;

export const LOGS = ["latest", "trending"];

// /dev/null's own lanes, dark theme: lane 0-5 on the web, and the same six
// colours for users whose lane is unset, picked from their login like the web.
const LANES = ["#ff8a4c", "#51cf66", "#da77f2", "#3bc9db", "#f06595", "#fcc419"];

const LANE_PATTERN = /^#[0-9a-f]{6}$/i;

const laneFor = (user) => {
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
    shortHash: hashOf(commit),
    permalink: `${BASE}/@${author.username}/commits/${commit.id}`,
    createdAt: commit.created_at,
    author: {
      id: author.id ?? author.username,
      name: clean(author.name) || clean(author.username) || "someone",
      username: clean(author.username) || "unknown",
      avatarUrl: author.avatar_url ?? null,
      lane,
    },
    segments: segmentsOf(commit),
    stars: commit.stars_count ?? 0,
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
    images: (commit.images ?? []).length,
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

/**
 * A commit and its conversation: the commit page carries the root, its
 * ancestors, and its replies, which deeper replies hang off.
 */
export async function fetchThread(commit, { maxPages = 5 } = {}) {
  const headers = { cookie: `replies_per_page=${REPLIES_PER_PAGE}` };
  let props = pageProps(await get(commit.permalink, { headers }));

  const replies = (props.replies?.data ?? []).map(normalizeCommit);
  let url = props.replies?.next_page_url ?? null;
  let pages = 1;

  while (url && pages < maxPages) {
    props = pageProps(await get(url, { headers }));
    replies.push(...(props.replies?.data ?? []).map(normalizeCommit));
    url = props.replies?.next_page_url ?? null;
    pages += 1;
  }

  return {
    root: normalizeCommit(props.commit),
    ancestors: (props.ancestors ?? []).map(normalizeCommit),
    replies,
    more: Boolean(url),
    fetchedAt: Date.now(),
  };
}
