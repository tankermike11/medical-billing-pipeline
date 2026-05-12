// Bulk download and stream-parse of the CFPB full complaint dataset.
// The API is behind a WAF that blocks external clients; the bulk export is open.
// Download URL: https://files.consumerfinance.gov/ccdb/complaints.json.zip
//   (~400 MB compressed, ~2 GB uncompressed, ~5 M complaints)
// We stream-parse the JSON so we never load the full file into memory.

import { createWriteStream, createReadStream, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

export const BULK_URL =
  process.env.CFPB_BULK_URL ??
  'https://files.consumerfinance.gov/ccdb/complaints.json.zip';

// Field names confirmed from the actual bulk JSON file
export interface BulkComplaint {
  complaint_id: string;
  date_received: string;
  product: string;
  sub_product: string | null;
  issue: string;
  sub_issue: string | null;
  complaint_what_happened: string | null;   // the consumer narrative
  company: string;
  state: string | null;
  zip_code: string | null;
  tags: string | null;
  submitted_via: string | null;
  company_response: string | null;          // company's response
  timely: string | null;
}

// ── Download ────────────────────────────────────────────────────────────────

export async function downloadBulk(zipPath: string): Promise<void> {
  if (existsSync(zipPath)) {
    console.log(`  Zip already present: ${zipPath}`);
    return;
  }

  console.log(`  Downloading ${BULK_URL}`);
  console.log('  (This is ~400 MB — may take a few minutes)');

  const res = await fetch(BULK_URL, {
    headers: { 'User-Agent': 'sam-billing-pipeline/0.1' },
  });
  if (!res.ok || !res.body) {
    throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  }

  const out = createWriteStream(zipPath);
  let downloaded = 0;

  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    downloaded += chunk.length;
    await new Promise<void>((resolve, reject) =>
      out.write(chunk, (err) => (err ? reject(err) : resolve()))
    );
    process.stdout.write(
      `\r  Downloaded: ${(downloaded / 1_048_576).toFixed(1)} MB`
    );
  }

  await new Promise<void>((resolve, reject) =>
    out.end((err: Error | null | undefined) => (err ? reject(err) : resolve()))
  );
  console.log('\n  Download complete.');
}

// ── Extract ─────────────────────────────────────────────────────────────────

export function extractBulk(zipPath: string, destDir: string): string {
  // Look for a previously extracted JSON first
  const existing = findJsonIn(destDir);
  if (existing) {
    console.log(`  Already extracted: ${existing}`);
    return existing;
  }

  console.log('  Extracting ZIP (may take a minute)...');
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force"`,
      { stdio: 'pipe' }
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${destDir}"`, { stdio: 'pipe' });
  }

  const extracted = findJsonIn(destDir);
  if (!extracted) throw new Error('Could not find extracted JSON in ' + destDir);
  console.log(`  Extracted to: ${extracted}`);
  return extracted;
}

function findJsonIn(dir: string): string | null {
  try {
    const found = readdirSync(dir).find(
      (f) => f.endsWith('.json') && !f.startsWith('pipeline')
    );
    return found ? join(dir, found) : null;
  } catch {
    return null;
  }
}

// ── Stream-parse ─────────────────────────────────────────────────────────────
// Reads the top-level JSON array one object at a time without buffering the
// whole file. Uses brace-depth counting; handles strings + escape sequences.

export async function* streamObjects(
  jsonPath: string
): AsyncGenerator<BulkComplaint> {
  const fileStream = createReadStream(jsonPath, {
    encoding: 'utf8',
    highWaterMark: 512 * 1024, // 512 KB chunks
  });

  let obj = '';
  let depth = 0;
  let inStr = false;
  let esc = false;

  for await (const chunk of fileStream) {
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i];

      if (esc) {
        esc = false;
        if (depth > 0) obj += ch;
        continue;
      }

      if (inStr) {
        if (depth > 0) obj += ch;
        if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }

      if (ch === '"') {
        inStr = true;
        if (depth > 0) obj += ch;
      } else if (ch === '{') {
        depth++;
        obj += ch;
      } else if (ch === '}') {
        obj += ch;
        depth--;
        if (depth === 0) {
          yield JSON.parse(obj) as BulkComplaint;
          obj = '';
        }
      } else if (depth > 0) {
        obj += ch;
      }
    }
  }
}

// ── Filter ───────────────────────────────────────────────────────────────────

export function isMedicalBilling(c: BulkComplaint): boolean {
  const prod = (c.product ?? '').toLowerCase();
  const sub = (c.sub_product ?? '').toLowerCase();
  return (
    sub.includes('medical') ||
    prod.includes('medical') ||
    prod === 'debt collection' && sub === 'medical debt'
  );
}
