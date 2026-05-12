import 'dotenv/config';
import { getDb, closeDb } from './db.js';

const db = getDb();

const tables = ['cfpb_complaints', 'reddit_posts', 'analysis_results'] as const;

for (const table of tables) {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
  console.log(`${table.padEnd(20)} ${row.n.toLocaleString()} rows`);
}

console.log('\n── cfpb_complaints sample ───────────────────────────────────');
const sample = db.prepare(`
  SELECT complaint_id, date_received, sub_product, state, status,
         SUBSTR(consumer_narrative, 1, 120) AS narrative_preview
  FROM cfpb_complaints
  ORDER BY date_received DESC
  LIMIT 5
`).all() as Record<string, unknown>[];

for (const row of sample) {
  console.log(JSON.stringify(row, null, 2));
}

console.log('\n── product breakdown ────────────────────────────────────────');
const breakdown = db.prepare(`
  SELECT sub_product, COUNT(*) AS n
  FROM cfpb_complaints
  GROUP BY sub_product
  ORDER BY n DESC
  LIMIT 10
`).all() as { sub_product: string; n: number }[];

for (const { sub_product, n } of breakdown) {
  console.log(`  ${String(n).padStart(6)}  ${sub_product}`);
}

closeDb();
