import 'dotenv/config';
import Anthropic from '@anthropic-ai/sdk';
import { getDb, closeDb } from '../shared/db.js';
import { DataSource, AnalysisStatus } from '../shared/enums.js';
import { SYSTEM_PROMPT, buildUserMessage } from './prompt.js';
import type { AnalysisRecord, CfpbRecord, RedditRecord } from './prompt.js';
import type { ProductRequirement } from '../shared/schema.js';

const MODEL = 'claude-haiku-4-5';

// Pricing per token (claude-haiku-4-5)
const PRICE = {
  input:      1.00 / 1_000_000,
  output:     5.00 / 1_000_000,
  cacheRead:  0.10 / 1_000_000,
  cacheWrite: 1.25 / 1_000_000,
  // Batch API: 50% off input and output
  batchInput:  0.50 / 1_000_000,
  batchOutput: 2.50 / 1_000_000,
};

// Truncate body text to keep input tokens manageable.
// Long Reddit posts/CFPB narratives rarely add analysis value beyond this.
const MAX_BODY_CHARS = 2000;

interface ClaudeResult {
  themes: string[];
  pain_points: string[];
  product_requirements: ProductRequirement[];
}

interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

const client = new Anthropic();

// ── Shared helpers ────────────────────────────────────────────────────────────

function truncateBody(record: AnalysisRecord): AnalysisRecord {
  if (record.source === 'CFPB' && record.body.length > MAX_BODY_CHARS) {
    return { ...record, body: record.body.slice(0, MAX_BODY_CHARS) + ' [truncated]' };
  }
  if (record.source === 'REDDIT' && record.body.length > MAX_BODY_CHARS) {
    return { ...record, body: record.body.slice(0, MAX_BODY_CHARS) + ' [truncated]' };
  }
  return record;
}

function extractJson(text: string): ClaudeResult {
  const t = text.trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```)
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()) as ClaudeResult; } catch {}
  }

  // Direct parse
  try { return JSON.parse(t) as ClaudeResult; } catch {}

  // Find outermost JSON object
  const obj = t.match(/\{[\s\S]*\}/);
  if (obj) {
    try { return JSON.parse(obj[0]) as ClaudeResult; } catch {}
  }

  throw new Error('Could not parse JSON from response');
}

function buildRequestParams(record: AnalysisRecord): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: 1024,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [{ role: 'user', content: buildUserMessage(truncateBody(record)) }],
  };
}

function saveResult(
  source: DataSource,
  sourceId: string,
  status: AnalysisStatus,
  result: ClaudeResult | null,
  rawResponse: string,
  totalTokens: number,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO analysis_results
      (source, source_id, status, themes, pain_points, product_requirements,
       raw_response, model, tokens_used, analyzed_at)
    VALUES
      ($source, $source_id, $status, $themes, $pain_points, $product_requirements,
       $raw_response, $model, $tokens_used, $analyzed_at)
    ON CONFLICT(source, source_id) DO UPDATE SET
      status               = excluded.status,
      themes               = excluded.themes,
      pain_points          = excluded.pain_points,
      product_requirements = excluded.product_requirements,
      raw_response         = excluded.raw_response,
      model                = excluded.model,
      tokens_used          = excluded.tokens_used,
      analyzed_at          = excluded.analyzed_at
  `).run({
    $source: source,
    $source_id: sourceId,
    $status: status,
    $themes: result ? JSON.stringify(result.themes) : null,
    $pain_points: result ? JSON.stringify(result.pain_points) : null,
    $product_requirements: result ? JSON.stringify(result.product_requirements) : null,
    $raw_response: rawResponse,
    $model: MODEL,
    $tokens_used: totalTokens,
    $analyzed_at: new Date().toISOString(),
  });
}

// ── Queue building ────────────────────────────────────────────────────────────

function buildQueue(max?: number): AnalysisRecord[] {
  const db = getDb();
  const half = max ? Math.ceil(max / 2) : 5000;

  const cfpb = db.prepare(`
    SELECT c.complaint_id AS source_id, c.date_received, c.product, c.sub_product,
           c.consumer_narrative AS body
    FROM cfpb_complaints c
    WHERE NOT EXISTS (
      SELECT 1 FROM analysis_results ar
      WHERE ar.source = 'CFPB' AND ar.source_id = c.complaint_id
        AND ar.status = 'complete'
    )
    AND c.consumer_narrative IS NOT NULL AND LENGTH(c.consumer_narrative) > 80
    ORDER BY c.date_received DESC
    LIMIT ?
  `).all(half) as Array<Omit<CfpbRecord, 'source'>>;

  const reddit = db.prepare(`
    SELECT r.post_id AS source_id, r.subreddit, r.title, r.body, r.created_utc
    FROM reddit_posts r
    WHERE NOT EXISTS (
      SELECT 1 FROM analysis_results ar
      WHERE ar.source = 'REDDIT' AND ar.source_id = r.post_id
        AND ar.status = 'complete'
    )
    AND r.body IS NOT NULL AND LENGTH(r.body) > 80
    ORDER BY r.score DESC
    LIMIT ?
  `).all(half) as Array<Omit<RedditRecord, 'source'>>;

  const queue: AnalysisRecord[] = [];
  const len = Math.max(cfpb.length, reddit.length);
  for (let i = 0; i < len; i++) {
    if (i < cfpb.length)   queue.push({ source: DataSource.CFPB,   ...cfpb[i] });
    if (i < reddit.length) queue.push({ source: DataSource.REDDIT, ...reddit[i] });
  }

  return max ? queue.slice(0, max) : queue;
}

// ── Real-time mode ────────────────────────────────────────────────────────────

async function runRealtime(queue: AnalysisRecord[]): Promise<void> {
  const totals: TokenTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let complete = 0;
  let failed = 0;

  for (let i = 0; i < queue.length; i++) {
    const record = queue[i];
    const label = record.source === 'CFPB'
      ? `CFPB ${record.source_id}`
      : `Reddit ${record.source_id}`;

    process.stdout.write(`[${i + 1}/${queue.length}] ${label} … `);

    try {
      const response = await callWithRetry(record);
      const rawText = response.content[0]?.type === 'text' ? response.content[0].text : '';
      const result = extractJson(rawText);
      const { usage } = response;

      totals.input      += usage.input_tokens;
      totals.output     += usage.output_tokens;
      totals.cacheRead  += usage.cache_read_input_tokens ?? 0;
      totals.cacheWrite += usage.cache_creation_input_tokens ?? 0;

      saveResult(record.source as DataSource, record.source_id, AnalysisStatus.COMPLETE,
        result, rawText, usage.input_tokens + usage.output_tokens);
      complete++;

      const cost = calcCost(totals);
      process.stdout.write(
        `✓ (${usage.input_tokens}in ${usage.output_tokens}out ${usage.cache_read_input_tokens ?? 0}cached) — $${cost}\n`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      saveResult(record.source as DataSource, record.source_id, AnalysisStatus.FAILED,
        null, msg, 0);
      failed++;
      process.stdout.write(`✗ ${msg.slice(0, 80)}\n`);
    }
  }

  console.log(`\nDone — ${complete} complete, ${failed} failed`);
  console.log(`Cost: $${calcCost(totals)} (${fmtTokens(totals)})`);
}

async function callWithRetry(record: AnalysisRecord, retries = 3): Promise<Anthropic.Message> {
  const params = buildRequestParams(record);
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      return await client.messages.create(params);
    } catch (err) {
      const retryable =
        err instanceof Anthropic.RateLimitError ||
        err instanceof Anthropic.InternalServerError ||
        err instanceof Anthropic.APIConnectionError;
      if (retryable && attempt < retries - 1) {
        await sleep(Math.min(1500 * 2 ** attempt + Math.random() * 500, 30_000));
        continue;
      }
      throw err;
    }
  }
  throw new Error('Max retries exceeded');
}

// ── Batch mode ────────────────────────────────────────────────────────────────

async function runBatch(queue: AnalysisRecord[]): Promise<void> {
  console.log(`  Submitting ${queue.length} requests to Batch API…`);

  // Batch API max is 100,000 requests; split if needed
  const CHUNK = 10_000;
  const chunks: AnalysisRecord[][] = [];
  for (let i = 0; i < queue.length; i += CHUNK) chunks.push(queue.slice(i, i + CHUNK));

  for (let ci = 0; ci < chunks.length; ci++) {
    const chunk = chunks[ci];
    if (chunks.length > 1) console.log(`\n  Chunk ${ci + 1}/${chunks.length} (${chunk.length} records)`);

    const batch = await client.messages.batches.create({
      requests: chunk.map((record) => ({
        custom_id: `${record.source}::${record.source_id}`,
        params: buildRequestParams(record),
      })),
    });

    console.log(`  Batch ID : ${batch.id}`);
    console.log('  Polling every 60 s — Ctrl+C is safe, batch continues server-side.');
    console.log(`  Re-process results later with: npm run phase3 -- --batch-id ${batch.id}\n`);

    await pollAndProcess(batch.id, chunk);
  }
}

async function pollAndProcess(batchId: string, queue: AnalysisRecord[]): Promise<void> {
  // Build a lookup from custom_id → record
  const byId = new Map(queue.map((r) => [`${r.source}::${r.source_id}`, r]));

  while (true) {
    const status = await client.messages.batches.retrieve(batchId);
    const { processing, succeeded, errored, expired } = status.request_counts;
    process.stdout.write(
      `\r  ${status.processing_status}  processing:${processing}  done:${succeeded + errored + expired}   `
    );

    if (status.processing_status === 'ended') break;
    await sleep(60_000);
  }
  console.log('\n  Batch complete — writing results to DB…');

  let complete = 0;
  let failed = 0;
  let estimatedCost = 0;

  for await (const item of await client.messages.batches.results(batchId)) {
    const record = byId.get(item.custom_id);
    if (!record) continue;

    if (item.result.type === 'succeeded') {
      const msg = item.result.message;
      const rawText = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
      try {
        const result = extractJson(rawText);
        saveResult(record.source as DataSource, record.source_id, AnalysisStatus.COMPLETE,
          result, rawText, msg.usage.input_tokens + msg.usage.output_tokens);
        complete++;
        estimatedCost +=
          msg.usage.input_tokens  * PRICE.batchInput +
          msg.usage.output_tokens * PRICE.batchOutput;
      } catch (parseErr) {
        const msg2 = parseErr instanceof Error ? parseErr.message : String(parseErr);
        saveResult(record.source as DataSource, record.source_id, AnalysisStatus.FAILED,
          null, rawText, 0);
        failed++;
        console.error(`  Parse error ${record.source_id}: ${msg2}`);
      }
    } else {
      const errMsg = item.result.type === 'errored'
        ? item.result.error.type
        : 'expired';
      saveResult(record.source as DataSource, record.source_id, AnalysisStatus.FAILED,
        null, errMsg, 0);
      failed++;
    }
  }

  console.log(`  Written: ${complete} complete, ${failed} failed`);
  console.log(`  Estimated batch cost: $${estimatedCost.toFixed(4)}`);
}

async function reprocessBatch(batchId: string): Promise<void> {
  console.log(`Re-processing batch ${batchId}…`);
  const status = await client.messages.batches.retrieve(batchId);
  if (status.processing_status !== 'ended') {
    console.log(`Batch not complete yet (${status.processing_status}). Try again later.`);
    return;
  }

  // We need to reconstruct source_id from custom_id
  let complete = 0; let failed = 0; let cost = 0;

  for await (const item of await client.messages.batches.results(batchId)) {
    const [source, sourceId] = item.custom_id.split('::') as [DataSource, string];

    if (item.result.type === 'succeeded') {
      const msg = item.result.message;
      const rawText = msg.content[0]?.type === 'text' ? msg.content[0].text : '';
      try {
        const result = extractJson(rawText);
        saveResult(source, sourceId, AnalysisStatus.COMPLETE, result, rawText,
          msg.usage.input_tokens + msg.usage.output_tokens);
        complete++;
        cost += msg.usage.input_tokens * PRICE.batchInput + msg.usage.output_tokens * PRICE.batchOutput;
      } catch {
        saveResult(source, sourceId, AnalysisStatus.FAILED, null, rawText, 0);
        failed++;
      }
    } else {
      saveResult(source, sourceId, AnalysisStatus.FAILED, null, item.result.type, 0);
      failed++;
    }
  }

  console.log(`Done — ${complete} complete, ${failed} failed, ~$${cost.toFixed(4)}`);
}

// ── Report ────────────────────────────────────────────────────────────────────

function printReport(): void {
  const db = getDb();

  const counts = db.prepare(
    `SELECT status, COUNT(*) AS n FROM analysis_results GROUP BY status`
  ).all() as { status: string; n: number }[];

  const complete = counts.find((r) => r.status === 'complete')?.n ?? 0;
  const failed   = counts.find((r) => r.status === 'failed')?.n ?? 0;

  console.log('\n' + '═'.repeat(60));
  console.log('ANALYSIS REPORT');
  console.log('═'.repeat(60));
  console.log(`Records complete : ${complete.toLocaleString()}`);
  console.log(`Records failed   : ${failed.toLocaleString()}`);

  if (complete === 0) return;

  const rows = db.prepare(`
    SELECT themes, pain_points, product_requirements
    FROM analysis_results WHERE status = 'complete'
  `).all() as { themes: string; pain_points: string; product_requirements: string }[];

  const themeCounts = new Map<string, number>();
  const ppCounts    = new Map<string, number>();
  const reqMap      = new Map<string, { count: number; priority: string; category: string }>();

  for (const row of rows) {
    for (const t of (JSON.parse(row.themes || '[]') as string[])) {
      themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1);
    }
    for (const p of (JSON.parse(row.pain_points || '[]') as string[])) {
      const key = p.slice(0, 80);
      ppCounts.set(key, (ppCounts.get(key) ?? 0) + 1);
    }
    for (const r of (JSON.parse(row.product_requirements || '[]') as ProductRequirement[])) {
      const key = r.requirement.slice(0, 90);
      const ex = reqMap.get(key);
      reqMap.set(key, { count: (ex?.count ?? 0) + 1, priority: r.priority, category: r.category });
    }
  }

  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  console.log('\n── Top Themes ───────────────────────────────────────────');
  for (const [t, n] of top(themeCounts, 10)) console.log(`  ${String(n).padStart(4)}  ${t}`);

  console.log('\n── Top Pain Points ──────────────────────────────────────');
  for (const [p, n] of top(ppCounts, 8)) console.log(`  ${String(n).padStart(4)}  ${p}`);

  console.log('\n── High-Priority Requirements ───────────────────────────');
  const highReqs = [...reqMap.entries()]
    .filter(([, v]) => v.priority === 'high')
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 10);
  for (const [req, m] of highReqs) {
    console.log(`  ${String(m.count).padStart(4)}  [${m.category}] ${req}`);
  }

  console.log('\n' + '═'.repeat(60));
}

// ── Cost helpers ──────────────────────────────────────────────────────────────

function calcCost(t: TokenTotals): string {
  return (
    t.input      * PRICE.input +
    t.output     * PRICE.output +
    t.cacheRead  * PRICE.cacheRead +
    t.cacheWrite * PRICE.cacheWrite
  ).toFixed(4);
}

function fmtTokens(t: TokenTotals): string {
  return `${t.input.toLocaleString()}in ${t.output.toLocaleString()}out ${t.cacheRead.toLocaleString()}cached`;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { max, batch, batchId, reportOnly } = parseArgs();

  if (reportOnly) { printReport(); closeDb(); return; }
  if (batchId)    { await reprocessBatch(batchId); printReport(); closeDb(); return; }

  console.log('Phase 3 — Claude Analysis');
  console.log(`  Model : ${MODEL}${batch ? ' (Batch API — 50% off, async)' : ''}`);
  console.log(`  Max   : ${max ?? 'unlimited'}`);
  console.log();

  const queue = buildQueue(max);
  console.log(`  Queue : ${queue.length} unanalyzed records`);
  if (queue.length === 0) {
    console.log('  Nothing to do. Use --report to see results.');
    closeDb(); return;
  }

  // Cost estimate
  const estPerRecord = batch ? 0.0045 : 0.013;
  console.log(`  Est. cost: ~$${(queue.length * estPerRecord).toFixed(2)} (${batch ? 'batch' : 'real-time'})`);
  console.log();

  if (batch) {
    await runBatch(queue);
  } else {
    await runRealtime(queue);
  }

  closeDb();
  printReport();
}

// ── CLI arg parser ────────────────────────────────────────────────────────────
// Handles: --max 50  --max=50  --max50

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    max:        undefined as number | undefined,
    batch:      false,
    batchId:    undefined as string | undefined,
    reportOnly: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    // --max=50 or --max50
    const maxEq = arg.match(/^--max[=]?(\d+)$/);
    if (maxEq) { out.max = parseInt(maxEq[1], 10); continue; }

    switch (arg) {
      case '--max':      out.max = parseInt(args[++i], 10); break;
      case '--batch':    out.batch = true; break;
      case '--batch-id': out.batchId = args[++i]; break;
      case '--report':   out.reportOnly = true; break;
      case '--help':
        console.log([
          `Usage: npm run phase3 [-- options]`,
          '',
          'Options:',
          '  --max N         Process at most N records',
          '  --batch         Submit to Batch API (50% cheaper, ~1h turnaround)',
          '  --batch-id ID   Write results from a previously submitted batch',
          '  --report        Print report from existing results, no API calls',
          '',
          'Examples:',
          '  npm run phase3 -- --max 50              # quick real-time sample',
          '  npm run phase3 -- --batch               # full batch run (cheapest)',
          '  npm run phase3 -- --batch-id msgbatch_… # save results from batch',
          '  npm run phase3 -- --report              # view aggregated report',
          '',
          `Model: ${MODEL}  |  Est. cost: ~$0.0045/record (batch) or ~$0.013 (real-time)`,
        ].join('\n'));
        process.exit(0);
    }
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((err) => {
  console.error('\nFatal:', err instanceof Error ? err.message : String(err));
  closeDb();
  process.exit(1);
});
