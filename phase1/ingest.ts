import 'dotenv/config';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getDb, closeDb } from '../shared/db.js';
import { streamComplaints, previewUrl } from './cfpb-client.js';
import { downloadBulk, extractBulk, streamObjects, isMedicalBilling } from './bulk.js';
import type { CfpbApiComplaint } from './cfpb-client.js';
import type { BulkComplaint } from './bulk.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const ZIP_PATH = join(DATA_DIR, 'complaints_bulk.zip');

// ── Shared helpers ───────────────────────────────────────────────────────────

function apiComplaintToParams(c: CfpbApiComplaint, now: string) {
  const tags = c.tags ? JSON.stringify(c.tags.split(',').map((t) => t.trim())) : null;
  return {
    $complaint_id: c.complaint_id,
    $date_received: c.date_received,
    $product: c.product,
    $sub_product: c.sub_product ?? null,
    $issue: c.issue,
    $sub_issue: c.sub_issue ?? null,
    $consumer_narrative: c.complaint_what_happened ?? null,
    $company: c.company,
    $state: c.state ?? null,
    $status: c.company_response ?? 'Unknown',
    $tags: tags,
    $ingested_at: now,
  };
}

function bulkComplaintToParams(c: BulkComplaint, now: string) {
  const tags = c.tags ? JSON.stringify(c.tags.split(',').map((t) => t.trim())) : null;
  return {
    $complaint_id: c.complaint_id,
    $date_received: c.date_received,
    $product: c.product,
    $sub_product: c.sub_product ?? null,
    $issue: c.issue,
    $sub_issue: c.sub_issue ?? null,
    $consumer_narrative: c.complaint_what_happened ?? null,
    $company: c.company,
    $state: c.state ?? null,
    $status: c.company_response ?? 'Unknown',
    $tags: tags,
    $ingested_at: now,
  };
}

function dateInRange(dateStr: string, min?: string, max?: string): boolean {
  if (min && dateStr < min) return false;
  if (max && dateStr > max) return false;
  return true;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const { source, dateMin, dateMax, max, dryRun } = parseArgs();

  console.log('CFPB Medical Billing Complaint Ingest');
  console.log(`  Source     : ${source}`);
  console.log(`  Date range : ${dateMin ?? 'any'} → ${dateMax ?? 'any'}`);
  console.log(`  Max records: ${max ?? 'unlimited'}`);
  console.log();

  if (dryRun) {
    if (source === 'api') {
      const url = previewUrl({ dateMin, dateMax });
      console.log('API URL:', url);
    } else {
      console.log('Bulk ZIP URL:', process.env.CFPB_BULK_URL ?? 'https://files.consumerfinance.gov/ccdb/complaints.json.zip');
      console.log('Local zip  :', ZIP_PATH);
    }
    return;
  }

  const db = getDb();
  const upsert = db.prepare(`
    INSERT INTO cfpb_complaints
      (complaint_id, date_received, product, sub_product, issue, sub_issue,
       consumer_narrative, company, state, status, tags, ingested_at)
    VALUES
      ($complaint_id, $date_received, $product, $sub_product, $issue, $sub_issue,
       $consumer_narrative, $company, $state, $status, $tags, $ingested_at)
    ON CONFLICT(complaint_id) DO UPDATE SET
      consumer_narrative = excluded.consumer_narrative,
      status             = excluded.status,
      ingested_at        = excluded.ingested_at
  `);

  let ingested = 0;
  let scanned = 0;

  try {
    if (source === 'api') {
      for await (const batch of streamComplaints({ dateMin, dateMax })) {
        const now = new Date().toISOString();
        const slice = max ? batch.slice(0, max - ingested) : batch;
        db.exec('BEGIN');
        try {
          for (const c of slice) { upsert.run(apiComplaintToParams(c, now)); ingested++; }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        process.stdout.write(`\r  Ingested: ${ingested.toLocaleString()}`);
        if (max && ingested >= max) break;
      }
    } else {
      // Bulk path
      await downloadBulk(ZIP_PATH);
      const jsonPath = extractBulk(ZIP_PATH, DATA_DIR);
      console.log('  Scanning and filtering...');

      const BATCH_SIZE = 500;
      let batch: BulkComplaint[] = [];

      const flush = () => {
        const now = new Date().toISOString();
        db.exec('BEGIN');
        try {
          for (const c of batch) { upsert.run(bulkComplaintToParams(c, now)); ingested++; }
          db.exec('COMMIT');
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        batch = [];
        process.stdout.write(`\r  Scanned: ${scanned.toLocaleString()}  Ingested: ${ingested.toLocaleString()}`);
      };

      for await (const complaint of streamObjects(jsonPath)) {
        scanned++;
        if (!isMedicalBilling(complaint)) continue;
        if (!dateInRange(complaint.date_received, dateMin, dateMax)) continue;
        if (!complaint.complaint_what_happened) continue;

        batch.push(complaint);
        if (batch.length >= BATCH_SIZE) flush();
        if (max && ingested >= max) break;
      }
      if (batch.length > 0) flush();
    }
  } finally {
    closeDb();
  }

  console.log(`\n\nComplete — ${ingested.toLocaleString()} records written to pipeline.db`);
  if (source === 'bulk') {
    console.log(`  (scanned ${scanned.toLocaleString()} total complaints)`);
  }
}

// ── CLI args ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const out = {
    source: 'bulk' as 'bulk' | 'api',
    dateMin: undefined as string | undefined,
    dateMax: undefined as string | undefined,
    max: undefined as number | undefined,
    dryRun: false,
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--source':   out.source = args[++i] as 'bulk' | 'api'; break;
      case '--date-min': out.dateMin = args[++i]; break;
      case '--date-max': out.dateMax = args[++i]; break;
      case '--max':      out.max = parseInt(args[++i], 10); break;
      case '--dry-run':  out.dryRun = true; break;
      case '--help':
        console.log([
          'Usage: npm run phase1 [-- options]',
          '',
          'Options:',
          '  --source bulk|api      Data source (default: bulk)',
          '  --date-min YYYY-MM-DD  Only include complaints from this date',
          '  --date-max YYYY-MM-DD  Only include complaints up to this date',
          '  --max N                Stop after ingesting N records',
          '  --dry-run              Print config without fetching',
          '',
          'Examples:',
          '  npm run phase1                                    # full bulk ingest',
          '  npm run phase1 -- --date-min 2022-01-01          # from 2022 onward',
          '  npm run phase1 -- --max 1000                     # first 1000 matches',
          '  npm run phase1 -- --source api --max 200         # live API (may be blocked)',
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
