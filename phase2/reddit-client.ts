// Reddit JSON API client — public endpoint with optional OAuth upgrade.
// Without OAuth: ~1 req/sec (Reddit's unofficial limit for unauthenticated).
// With OAuth:    100 req/min (set REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET in .env).

export interface RedditApiPost {
  id: string;              // base-36 ID, no prefix
  name: string;            // fullname: "t3_<id>"
  subreddit: string;
  title: string;
  selftext: string;        // "" when no body, "[deleted]"/"[removed]" when removed
  author: string;
  created_utc: number;     // unix timestamp
  score: number;
  url: string;
  num_comments: number;
  permalink: string;       // relative path, e.g. "/r/medicalbilling/comments/..."
  is_self: boolean;
}

interface Listing {
  kind: 'Listing';
  data: {
    children: Array<{ kind: string; data: RedditApiPost }>;
    after: string | null;
  };
}

export type SortMode = 'new' | 'hot' | 'top';
export type Timeframe = 'all' | 'year' | 'month' | 'week';

export interface StreamOptions {
  subreddit: string;
  sort?: SortMode;
  timeframe?: Timeframe;  // only used when sort=top
  searchQuery?: string;   // if set, uses /search.json restricted to subreddit
  pageLimit?: number;     // max posts to yield (default 1000)
}

// ── OAuth (optional) ─────────────────────────────────────────────────────────

let cachedToken: { value: string; expiresAt: number } | null = null;

async function getToken(): Promise<string | null> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) return null;

  if (cachedToken && Date.now() < cachedToken.expiresAt) return cachedToken.value;

  const creds = Buffer.from(`${id}:${secret}`).toString('base64');
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${creds}`,
      'User-Agent': userAgent(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    console.warn('  Reddit OAuth failed, falling back to public API');
    return null;
  }

  const body = (await res.json()) as { access_token: string; expires_in: number };
  cachedToken = { value: body.access_token, expiresAt: Date.now() + (body.expires_in - 60) * 1000 };
  return cachedToken.value;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────

function userAgent(): string {
  return process.env.REDDIT_USER_AGENT ?? 'sam-billing-pipeline/0.1';
}

async function get(path: string): Promise<Listing> {
  const token = await getToken();
  const base = token ? 'https://oauth.reddit.com' : 'https://www.reddit.com';
  const url = `${base}${path}`;

  const headers: Record<string, string> = {
    'User-Agent': userAgent(),
    Accept: 'application/json',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(url, { headers });

  if (res.status === 429) {
    const wait = parseInt(res.headers.get('Retry-After') ?? '65', 10);
    process.stdout.write(`\n  Rate-limited — waiting ${wait}s\n`);
    await sleep(wait * 1000);
    return get(path);
  }

  if (!res.ok) throw new Error(`Reddit API HTTP ${res.status}: ${url}`);

  return res.json() as Promise<Listing>;
}

// ── Generator ─────────────────────────────────────────────────────────────────

function isUsable(post: RedditApiPost): boolean {
  if (!post.is_self) return false;
  const text = post.selftext;
  return Boolean(text) && text !== '[deleted]' && text !== '[removed]';
}

export async function* streamPosts(opts: StreamOptions): AsyncGenerator<RedditApiPost> {
  const { subreddit, sort = 'new', timeframe = 'all', searchQuery, pageLimit = 1000 } = opts;

  let after: string | null = null;
  let yielded = 0;

  while (yielded < pageLimit) {
    let path: string;

    if (searchQuery) {
      const qs = new URLSearchParams({
        q: searchQuery,
        restrict_sr: '1',
        sort: 'new',
        type: 'link',
        limit: '100',
      });
      if (after) qs.set('after', after);
      path = `/r/${subreddit}/search.json?${qs}`;
    } else {
      const qs = new URLSearchParams({ limit: '100' });
      if (sort === 'top') qs.set('t', timeframe);
      if (after) qs.set('after', after);
      path = `/r/${subreddit}/${sort}.json?${qs}`;
    }

    const listing = await get(path);
    const children = listing.data?.children ?? [];
    if (children.length === 0) break;

    for (const child of children) {
      if (child.kind !== 't3') continue;
      if (!isUsable(child.data)) continue;
      yield child.data;
      yielded++;
      if (yielded >= pageLimit) return;
    }

    after = listing.data?.after ?? null;
    if (!after) break;

    // Stay within Reddit's rate limit (1 req/sec without OAuth)
    await sleep(1200);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
