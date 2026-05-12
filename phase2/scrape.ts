import 'dotenv/config';
import { getDb, closeDb } from '../shared/db.js';
import { streamPosts } from './reddit-client.js';
import type { RedditApiPost, StreamOptions } from './reddit-client.js';

// ── Scrape targets ────────────────────────────────────────────────────────────
// Ordered by relevance. r/medicalbilling is the primary source; the others
// catch billing complaints filed under adjacent subreddits.

const TARGETS: (StreamOptions & { label: string })[] = [
  {
    label: 'r/hospitalbills — new',
    subreddit: 'hospitalbills',
    sort: 'new',
    pageLimit: 1000,
  },
  {
    label: 'r/hospitalbills — top all time',
    subreddit: 'hospitalbills',
    sort: 'top',
    timeframe: 'all',
    pageLimit: 500,
  },
  {
    label: 'r/medicalbill — new',
    subreddit: 'medicalbill',
    sort: 'new',
    pageLimit: 500,
  },
  {
    label: 'r/medicalbill — top all time',
    subreddit: 'medicalbill',
    sort: 'top',
    timeframe: 'all',
    pageLimit: 300,
  },
  {
    label: 'r/povertyfinance — search "medical bill"',
    subreddit: 'povertyfinance',
    searchQuery: 'medical bill',
    pageLimit: 400,
  },
  {
    label: 'r/healthinsurance — search "medical bill"',
    subreddit: 'healthinsurance',
    searchQuery: 'medical bill',
    pageLimit: 500,
  },
  {
    label: 'r/personalfinance — search "medical billing"',
    subreddit: 'personalfinance',
    searchQuery: 'medical billing',
    pageLimit: 300,
  },
];

// ── DB helpers ────────────────────────────────────────────────────────────────

function toBindParams(post: RedditApiPost, now: string) {
  return {
    $post_id: post.name,                               // "t3_<id>"
    $subreddit: post.subreddit,
    $title: post.title,
    $body: post.selftext,
    $author: post.author,
    $created_utc: Math.floor(post.created_utc),
    $score: post.score,
    $url: `https://www.reddit.com${post.permalink}`,
    $comment_count: post.num_comments,
    $scraped_at: now,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { max, dryRun } = parseArgs();

  console.log('Reddit Medical Billing Scrape');
  console.log(`  Targets    : ${TARGETS.length} queries`);
  console.log(`  Max posts  : ${max ?? 'unlimited'}`);
  if (process.env.REDDIT_CLIENT_ID) {
    console.log('  Auth       : OAuth (higher rate limits)');
  } else {
    console.log('  Auth       : public API (~1 req/sec)');
  }
  console.log();

  if (dryRun) {
    for (const t of TARGETS) console.log(`  ${t.label}  [limit ${t.pageLimit}]`);
    return;
  }

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO reddit_posts
      (post_id, subreddit, title, body, author, created_utc,
       score, url, comment_count, scraped_at)
    VALUES
      ($post_id, $subreddit, $title, $body, $author, $created_utc,
       $score, $url, $comment_count, $scraped_at)
    ON CONFLICT(post_id) DO UPDATE SET
      score         = excluded.score,
      comment_count = excluded.comment_count,
      scraped_at    = excluded.scraped_at
  `);

  const BATCH = 50;
  let totalIngested = 0;

  try {
    for (const target of TARGETS) {
      console.log(`  ${target.label}`);

      const effectiveLimit = max
        ? Math.min(target.pageLimit ?? 1000, max - totalIngested)
        : target.pageLimit;

      if (effectiveLimit !== undefined && effectiveLimit <= 0) break;

      let buf: ReturnType<typeof toBindParams>[] = [];
      let targetCount = 0;

      const flush = () => {
        if (buf.length === 0) return;
        const now = new Date().toISOString();
        db.exec('BEGIN');
        try {
          for (const p of buf) upsert.run(p);
          db.exec('COMMIT');
        } catch (e) {
          db.exec('ROLLBACK');
          throw e;
        }
        totalIngested += buf.length;
        targetCount += buf.length;
        buf = [];
        process.stdout.write(
          `\r    Posts this target: ${targetCount}  Total: ${totalIngested}`
        );
      };

      for await (const post of streamPosts({ ...target, pageLimit: effectiveLimit })) {
        buf.push(toBindParams(post, new Date().toISOString()));
        if (buf.length >= BATCH) flush();
        if (max && totalIngested + buf.length >= max) break;
      }
      flush();

      console.log(`\r    Posts this target: ${targetCount}  Total: ${totalIngested}`);
      if (max && totalIngested >= max) break;
    }
  } finally {
    closeDb();
  }

  console.log(`\nComplete — ${totalIngested.toLocaleString()} posts written to pipeline.db`);
}

// ── CLI args ──────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = { max: undefined as number | undefined, dryRun: false };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--max':     out.max = parseInt(args[++i], 10); break;
      case '--dry-run': out.dryRun = true; break;
      case '--help':
        console.log([
          'Usage: npm run phase2 [-- options]',
          '',
          'Options:',
          '  --max N     Stop after N total posts across all targets',
          '  --dry-run   Print targets without scraping',
          '',
          'Targets (in order):',
          ...TARGETS.map((t) => `  ${t.label}  [limit ${t.pageLimit}]`),
          '',
          'Optional .env vars for OAuth (higher rate limits):',
          '  REDDIT_CLIENT_ID',
          '  REDDIT_CLIENT_SECRET',
          '  REDDIT_USER_AGENT  (default: sam-billing-pipeline/0.1)',
        ].join('\n'));
        process.exit(0);
    }
  }
  return out;
}

main().catch((err) => {
  console.error('\nFatal:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});
