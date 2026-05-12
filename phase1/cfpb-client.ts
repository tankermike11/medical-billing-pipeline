// CFPB Consumer Complaint Database API client
// Spec: https://raw.githubusercontent.com/cfpb/ccdb5-api/main/swagger-config.yaml
// Base URL confirmed from swagger-config.yaml "servers" field.

const DEFAULT_BASE = 'https://www.consumerfinance.gov/data-research/consumer-complaints/search/api/v1/';

export interface CfpbApiComplaint {
  complaint_id: string;
  date_received: string;               // "YYYY-MM-DD"
  product: string;
  sub_product: string | null;
  issue: string;
  sub_issue: string | null;
  complaint_what_happened: string | null; // consumer narrative
  company: string;
  state: string | null;
  zip_code: string | null;
  tags: string | null;
  submitted_via: string | null;
  company_response: string | null;
  timely: string | null;
}

// Elasticsearch-style envelope returned by the API
interface EsHit {
  _source?: CfpbApiComplaint;
  // Some API versions surface fields directly on the hit object
  complaint_id?: string;
  [key: string]: unknown;
}

interface ApiResponse {
  hits?: {
    hits?: EsHit[];
    total?: { value: number; relation?: string } | number;
  };
  _meta?: { total_record_count?: number };
}

export interface StreamOptions {
  dateMin?: string;    // "YYYY-MM-DD"
  dateMax?: string;
  pageSize?: number;   // 1–100, default 100
  hasNarrative?: boolean;
}

function getBase(): string {
  const base = process.env.CFPB_API_BASE ?? DEFAULT_BASE;
  return base.endsWith('/') ? base : base + '/';
}

function buildUrl(base: string, qs: URLSearchParams): string {
  return `${base}?${qs}`;
}

function parseTotal(body: ApiResponse): number {
  const t = body.hits?.total;
  if (typeof t === 'number') return t;
  if (typeof t === 'object' && t !== null) return t.value;
  return body._meta?.total_record_count ?? 0;
}

function extractComplaints(body: ApiResponse): CfpbApiComplaint[] {
  const hits = body.hits?.hits ?? [];
  return hits.map((hit) => {
    // Standard ES format: fields live in _source
    if (hit._source) return hit._source;
    // Flattened: fields directly on the hit object
    return hit as unknown as CfpbApiComplaint;
  });
}

async function fetchPage(url: string): Promise<ApiResponse> {
  const res = await fetch(url, {
    headers: {
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'en-US,en;q=0.9',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      Origin: 'https://www.consumerfinance.gov',
      Referer:
        'https://www.consumerfinance.gov/data-research/consumer-complaints/',
    },
  });

  const raw = await res.text();

  if (!res.ok) {
    throw new Error(`CFPB API HTTP ${res.status} ${res.statusText}\nURL: ${url}`);
  }

  if (!raw.trimStart().startsWith('{')) {
    throw new Error(
      `CFPB API returned non-JSON (Content-Type: ${res.headers.get('content-type')})\n` +
      `URL: ${url}\n` +
      `First 300 chars:\n${raw.slice(0, 300)}`
    );
  }

  return JSON.parse(raw) as ApiResponse;
}

// Max records the API will paginate through (hardcoded in CFPB backend defaults.py)
const MAX_PAGINATION_DEPTH = 10_000;

export async function* streamComplaints(opts: StreamOptions = {}): AsyncGenerator<CfpbApiComplaint[]> {
  const { dateMin, dateMax, pageSize = 100, hasNarrative = true } = opts;
  const base = getBase();

  let frm = 0;
  let total: number | null = null;

  while (total === null || frm < Math.min(total, MAX_PAGINATION_DEPTH)) {
    const qs = new URLSearchParams({
      size: String(pageSize),
      frm: String(frm),
      sort: 'created_date_desc',
      // search_term avoids the bullet-separator product•subproduct format which
      // triggers WAF blocks. It also captures medical billing complaints across
      // all product categories (not just "Debt collection").
      search_term: 'medical billing',
      field: 'all',
    });
    if (hasNarrative) qs.set('has_narrative', 'yes');
    if (dateMin) qs.set('date_received_min', dateMin);
    if (dateMax) qs.set('date_received_max', dateMax);

    const url = buildUrl(base, qs);
    const body = await fetchPage(url);

    if (total === null) {
      total = parseTotal(body);
      if (total === 0) {
        console.error('  Warning: API returned 0 results. Check product filter or date range.');
        break;
      }
      console.log(`  Total matching complaints: ${total.toLocaleString()}`);
    }

    const batch = extractComplaints(body);
    if (batch.length === 0) break;

    yield batch;
    frm += batch.length;

    if (frm < total) await sleep(250);
  }
}

/** Returns the URL for the first page without making a request — useful for debugging. */
export function previewUrl(opts: StreamOptions = {}): string {
  const { dateMin, dateMax, pageSize = 100, hasNarrative = true } = opts;
  const base = getBase();
  const qs = new URLSearchParams({
    size: String(pageSize),
    frm: '0',
    sort: 'created_date_desc',
    search_term: 'medical billing',
    field: 'all',
  });
  if (hasNarrative) qs.set('has_narrative', 'yes');
  if (dateMin) qs.set('date_received_min', dateMin);
  if (dateMax) qs.set('date_received_max', dateMax);
  return buildUrl(base, qs);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
