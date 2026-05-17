// Generates data/report.html AND docs/index.html — fully self-contained
// (Chart.js embedded inline, no CDN dependency, works offline and on GitHub Pages).
// Run:  npm run phase3:html

import 'dotenv/config';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { getDb, closeDb } from '../shared/db.js';
import type { ProductRequirement } from '../shared/schema.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_OUT = join(__dirname, '..', 'data', 'report.html');
const DOCS_OUT = join(__dirname, '..', 'docs', 'index.html');

// ── Types ─────────────────────────────────────────────────────────────────────

interface AggRow {
  source: string;
  themes: string;
  pain_points: string;
  product_requirements: string;
  tokens_used: number;
}

interface BrowseRow {
  source: string;
  source_id: string;
  themes: string;
  pain_points: string;
  product_requirements: string;
  // CFPB
  date_received: string | null;
  product: string | null;
  sub_product: string | null;
  state: string | null;
  narrative: string | null;
  // Reddit
  subreddit: string | null;
  title: string | null;
  score: number | null;
  body: string | null;
  created_utc: number | null;
}

// ── Data loading ──────────────────────────────────────────────────────────────

function loadData() {
  const db = getDb();

  // Summary counts
  const meta = db.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status='complete' THEN 1 ELSE 0 END) AS complete,
      SUM(CASE WHEN status='failed'   THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN source='CFPB'   AND status='complete' THEN 1 ELSE 0 END) AS cfpb,
      SUM(CASE WHEN source='REDDIT' AND status='complete' THEN 1 ELSE 0 END) AS reddit,
      SUM(tokens_used) AS total_tokens
    FROM analysis_results
  `).get() as { total: number; complete: number; failed: number; cfpb: number; reddit: number; total_tokens: number };

  // Aggregation rows
  const aggRows = db.prepare(`
    SELECT source, themes, pain_points, product_requirements, tokens_used
    FROM analysis_results WHERE status = 'complete'
  `).all() as unknown as AggRow[];

  // CFPB date range and totals
  const cfpbMeta = db.prepare(`
    SELECT MIN(date_received) AS min_date, MAX(date_received) AS max_date, COUNT(*) AS total
    FROM cfpb_complaints
  `).get() as { min_date: string; max_date: string; total: number };

  // Reddit subreddit breakdown
  const subreddits = db.prepare(`
    SELECT r.subreddit,
           COUNT(*) AS total,
           SUM(CASE WHEN ar.status='complete' THEN 1 ELSE 0 END) AS analyzed
    FROM reddit_posts r
    LEFT JOIN analysis_results ar ON ar.source='REDDIT' AND ar.source_id=r.post_id
    GROUP BY r.subreddit ORDER BY total DESC
  `).all() as unknown as { subreddit: string; total: number; analyzed: number }[];

  // Full record browser rows (join back to source tables)
  const browseRows = db.prepare(`
    SELECT
      ar.source, ar.source_id, ar.themes, ar.pain_points, ar.product_requirements,
      c.date_received, c.product, c.sub_product, c.state, c.consumer_narrative AS narrative,
      NULL AS subreddit, NULL AS title, NULL AS score, NULL AS body, NULL AS created_utc
    FROM analysis_results ar
    JOIN cfpb_complaints c ON ar.source = 'CFPB' AND ar.source_id = c.complaint_id
    WHERE ar.status = 'complete'

    UNION ALL

    SELECT
      ar.source, ar.source_id, ar.themes, ar.pain_points, ar.product_requirements,
      NULL AS date_received, NULL AS product, NULL AS sub_product, NULL AS state, NULL AS narrative,
      r.subreddit, r.title, r.score, r.body, r.created_utc
    FROM analysis_results ar
    JOIN reddit_posts r ON ar.source = 'REDDIT' AND ar.source_id = r.post_id
    WHERE ar.status = 'complete'

    ORDER BY source DESC, date_received DESC
  `).all() as unknown as BrowseRow[];

  closeDb();

  // Aggregation
  const themeCounts = new Map<string, number>();
  const ppCounts    = new Map<string, number>();
  const catCounts   = new Map<string, number>();
  const priCounts   = { high: 0, medium: 0, low: 0 };
  const reqMap      = new Map<string, { category: string; priority: string; count: number; cfpb: number; reddit: number; fullReq: string }>();

  for (const row of aggRows) {
    const isCFPB   = row.source === 'CFPB';
    const themes: string[]           = JSON.parse(row.themes || '[]');
    const pps: string[]              = JSON.parse(row.pain_points || '[]');
    const reqs: ProductRequirement[] = JSON.parse(row.product_requirements || '[]');

    for (const t of themes) themeCounts.set(t, (themeCounts.get(t) ?? 0) + 1);
    for (const p of pps) {
      const k = p.slice(0, 100);
      ppCounts.set(k, (ppCounts.get(k) ?? 0) + 1);
    }
    for (const r of reqs) {
      catCounts.set(r.category, (catCounts.get(r.category) ?? 0) + 1);
      if (r.priority in priCounts) priCounts[r.priority as keyof typeof priCounts]++;
      const k = r.requirement.slice(0, 120);
      const ex = reqMap.get(k);
      reqMap.set(k, {
        category: r.category,
        priority: r.priority,
        count:  (ex?.count  ?? 0) + 1,
        cfpb:   (ex?.cfpb   ?? 0) + (isCFPB ? 1 : 0),
        reddit: (ex?.reddit ?? 0) + (isCFPB ? 0 : 1),
        fullReq: ex?.fullReq ?? r.requirement,
      });
    }
  }

  const reqList = [...reqMap.entries()]
    .map(([req, v]) => ({ req, ...v }))
    .sort((a, b) => {
      const po = { high: 0, medium: 1, low: 2 };
      const d = po[a.priority as keyof typeof po] - po[b.priority as keyof typeof po];
      return d !== 0 ? d : b.count - a.count;
    });

  const top = (m: Map<string, number>, n: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);

  const trimmedReqList = reqList.slice(0, 80);

  // Map each requirement index → browse record indices that matched it
  const reqKeyToIdx = new Map<string, number>();
  trimmedReqList.forEach((r, i) => reqKeyToIdx.set(r.req, i));

  const reqIndex: number[][] = trimmedReqList.map(() => []);
  browseRows.forEach((row, rowIdx) => {
    const reqs: ProductRequirement[] = JSON.parse(row.product_requirements || '[]');
    for (const r of reqs) {
      const k = r.requirement.slice(0, 120);
      const i = reqKeyToIdx.get(k);
      if (i !== undefined) reqIndex[i].push(rowIdx);
    }
  });

  return {
    meta,
    cfpbMeta,
    subreddits,
    topThemes: top(themeCounts, 15),
    topPPs:    top(ppCounts, 12),
    topCats:   top(catCounts, 12),
    priCounts,
    reqList:   trimmedReqList,
    reqIndex,
    browseRows,
    allThemes: [...themeCounts.keys()].sort(),
  };
}

// ── HTML ──────────────────────────────────────────────────────────────────────

function esc(s: string) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function priorityBadge(p: string) {
  const bg: Record<string,string> = { high:'#E64B38', medium:'#d97706', low:'#16a34a' };
  return `<span class="badge" style="background:${bg[p]??'#968694'}">${p}</span>`;
}

function buildHtml(d: ReturnType<typeof loadData>): string {
  const { meta, cfpbMeta, subreddits, topThemes, topPPs, topCats, priCounts, reqList, reqIndex, browseRows, allThemes } = d;
  const now = new Date().toLocaleString();

  // Serialise browse data as JSON for the in-page JS
  const browseData = browseRows.map(r => ({
    source:     r.source,
    id:         r.source_id,
    themes:     JSON.parse(r.themes || '[]') as string[],
    pps:        JSON.parse(r.pain_points || '[]') as string[],
    reqs:       JSON.parse(r.product_requirements || '[]') as ProductRequirement[],
    // CFPB
    date:       r.date_received ?? null,
    product:    r.sub_product ?? r.product ?? null,
    state:      r.state ?? null,
    narrative:  r.narrative ?? null,
    // Reddit
    subreddit:  r.subreddit ?? null,
    title:      r.title ?? null,
    score:      r.score ?? null,
    body:       r.body ?? null,
  }));

  const reqRows = reqList.map((r, i) => `
    <tr>
      <td style="vertical-align:top;padding-top:10px">${priorityBadge(r.priority)}</td>
      <td style="vertical-align:top;padding-top:10px"><span class="cat-badge">${esc(r.category)}</span></td>
      <td style="font-size:13px;white-space:normal;word-break:break-word;line-height:1.5">${esc(r.fullReq)}</td>
      <td class="num" style="vertical-align:top;padding-top:10px">${r.count}</td>
      <td class="num" style="color:#0071CE;vertical-align:top;padding-top:10px">${r.cfpb}</td>
      <td class="num" style="color:#968694;vertical-align:top;padding-top:10px">${r.reddit}</td>
      <td style="vertical-align:top;padding-top:8px"><button class="show-ex-btn" onclick="toggleReqExamples(${i},this)">Examples ▾</button></td>
    </tr>
    <tr class="req-ex-row" id="req-ex-${i}" style="display:none">
      <td colspan="7" style="padding:0 10px 12px 10px">
        <div class="req-ex-list" id="req-ex-list-${i}"></div>
      </td>
    </tr>`).join('');

  const subRedditRows = subreddits.map(s =>
    `<tr><td>r/${esc(s.subreddit)}</td><td class="num">${s.total.toLocaleString()}</td><td class="num">${s.analyzed.toLocaleString()}</td></tr>`
  ).join('');

  const topThemePreview = topThemes.slice(0, 5).map(([t, n]) =>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #E8E3E8">
      <span class="theme-tag">${esc(t)}</span>
      <span style="font-size:12px;color:#968694;font-weight:600">${n} records</span>
    </div>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Medical Billing Complaint Intelligence</title>
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@500;600;700&family=Open+Sans:wght@400;600&display=swap" rel="stylesheet">
<script>CHARTJS_PLACEHOLDER</script>
<style>
:root{--masa-horizon:#230871;--masa-tide:#0071CE;--masa-flare:#E64B38;--masa-shine:#FFD040;--masa-harbor:#968694;--masa-harbor-tint:#E8E3E8;--masa-body:#262626;--masa-white:#FFFFFF;--font-heading:'Poppins',sans-serif;--font-body:'Open Sans',sans-serif;--radius-card:8px;--radius-btn:4px;--shadow-card:0 2px 8px rgba(35,8,113,0.10)}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font-body);background:#f4f2f8;color:var(--masa-body);font-size:14px}
/* ── Nav ── */
.nav{background:var(--masa-horizon);border-bottom:none;padding:0 24px;display:flex;align-items:center;gap:0;position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(35,8,113,0.25)}
.nav-brand{font-family:var(--font-heading);font-size:15px;font-weight:700;color:var(--masa-white);padding:16px 20px 16px 0;border-right:1px solid rgba(255,255,255,0.2);margin-right:8px;white-space:nowrap}
.tab-btn{font-family:var(--font-heading);padding:16px 18px;border:none;background:none;cursor:pointer;font-size:13px;font-weight:500;color:rgba(255,255,255,0.65);border-bottom:2px solid transparent;transition:all .15s;white-space:nowrap}
.tab-btn:hover{color:var(--masa-white)}
.tab-btn.active{color:var(--masa-white);border-bottom-color:var(--masa-tide)}
.tab-content{display:none;padding:28px 24px;max-width:1200px;margin:0 auto}
.tab-content.active{display:block}
/* ── Shared ── */
h2{font-family:var(--font-heading);font-size:15px;font-weight:600;margin-bottom:14px;color:var(--masa-horizon)}
.panel{background:var(--masa-white);border:1px solid var(--masa-harbor-tint);border-radius:10px;padding:20px;margin-bottom:20px;box-shadow:var(--shadow-card)}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:20px;margin-bottom:20px}
.grid3{display:grid;grid-template-columns:1fr 1fr 1fr;gap:20px;margin-bottom:20px}
canvas{max-height:280px}
table{width:100%;border-collapse:collapse}
th{font-family:var(--font-heading);text-align:left;padding:8px 10px;border-bottom:2px solid var(--masa-harbor-tint);font-size:11px;color:var(--masa-harbor);text-transform:uppercase;letter-spacing:.5px;white-space:nowrap}
td{padding:8px 10px;border-bottom:1px solid var(--masa-harbor-tint);vertical-align:top}
tr:last-child td{border-bottom:none}
tr:hover td{background:#f7f5f9}
.num{text-align:center;font-weight:600;font-variant-numeric:tabular-nums}
.badge{color:#fff;padding:2px 8px;border-radius:9999px;font-size:11px;font-weight:700;font-family:var(--font-heading);text-transform:uppercase;display:inline-block}
.cat-badge{font-family:var(--font-heading);font-size:11px;background:var(--masa-harbor-tint);color:var(--masa-horizon);padding:2px 7px;border-radius:4px;white-space:nowrap}
.src-cfpb{background:var(--masa-tide);color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;font-family:var(--font-heading)}
.src-reddit{background:var(--masa-harbor);color:#fff;padding:2px 7px;border-radius:4px;font-size:11px;font-weight:700;font-family:var(--font-heading)}
/* ── Overview ── */
.hero{background:linear-gradient(135deg,var(--masa-horizon) 0%,var(--masa-tide) 100%);color:#fff;border-radius:14px;padding:40px;margin-bottom:24px}
.hero h1{font-family:var(--font-heading);font-size:26px;font-weight:700;margin-bottom:8px}
.hero p{font-size:15px;opacity:.85;line-height:1.6;max-width:680px}
.stat-row{display:flex;gap:32px;margin-top:24px;flex-wrap:wrap}
.stat-row .s{text-align:center}
.stat-row .s .v{font-family:var(--font-heading);font-size:28px;font-weight:700}
.stat-row .s .l{font-size:11px;opacity:.7;text-transform:uppercase;letter-spacing:.5px;margin-top:2px}
.step-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:24px}
.step{background:var(--masa-white);border:1px solid var(--masa-harbor-tint);border-top:3px solid var(--masa-tide);border-radius:10px;padding:20px;box-shadow:var(--shadow-card)}
.step .icon{font-size:28px;margin-bottom:10px}
.step h3{font-family:var(--font-heading);font-size:13px;font-weight:700;margin-bottom:6px;color:var(--masa-horizon)}
.step p{font-size:12px;color:var(--masa-harbor);line-height:1.6}
.source-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:24px}
.source-card{background:var(--masa-white);border:1px solid var(--masa-harbor-tint);border-radius:10px;padding:20px;box-shadow:var(--shadow-card)}
.source-card .src-header{display:flex;align-items:center;gap:10px;margin-bottom:12px}
.source-card h3{font-family:var(--font-heading);font-size:14px;font-weight:700;color:var(--masa-horizon)}
.source-card p{font-size:12px;color:var(--masa-body);line-height:1.6;margin-bottom:10px}
.theme-tag{background:rgba(0,113,206,0.10);color:var(--masa-tide);padding:2px 8px;border-radius:9999px;font-size:11px;font-family:var(--font-heading)}
/* ── Browser ── */
.browser-controls{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px;align-items:center}
.browser-controls input{font-family:var(--font-body);padding:8px 12px;border:1px solid var(--masa-harbor-tint);border-radius:var(--radius-btn);font-size:13px;width:260px;outline:none}
.browser-controls input:focus{border-color:var(--masa-tide)}
.filter-btn{font-family:var(--font-heading);padding:6px 14px;border:1px solid var(--masa-harbor-tint);border-radius:var(--radius-btn);background:var(--masa-white);cursor:pointer;font-size:12px;font-weight:500;color:var(--masa-body)}
.filter-btn.active{background:var(--masa-horizon);color:#fff;border-color:var(--masa-horizon)}
.filter-btn:hover:not(.active){background:var(--masa-harbor-tint)}
select.filter-select{font-family:var(--font-body);padding:6px 10px;border:1px solid var(--masa-harbor-tint);border-radius:var(--radius-btn);font-size:12px;background:var(--masa-white);cursor:pointer}
.record-count{font-size:12px;color:var(--masa-harbor);margin-left:auto}
.record-list{display:flex;flex-direction:column;gap:10px;max-height:700px;overflow-y:auto;padding-right:4px}
.record-card{background:var(--masa-white);border:1px solid var(--masa-harbor-tint);border-radius:10px;padding:16px;transition:border-color .15s;box-shadow:var(--shadow-card)}
.record-card:hover{border-color:var(--masa-tide)}
.record-header{display:flex;align-items:flex-start;gap:10px;margin-bottom:8px;cursor:pointer}
.record-header .meta{flex:1;min-width:0}
.record-header .rec-title{font-family:var(--font-heading);font-weight:600;font-size:13px;margin-bottom:3px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--masa-horizon)}
.record-header .subtitle{font-size:11px;color:var(--masa-harbor)}
.themes-row{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}
.toggle-btn{font-family:var(--font-heading);font-size:11px;color:var(--masa-tide);cursor:pointer;background:none;border:none;padding:0;margin-top:2px;text-decoration:underline;white-space:nowrap}
.detail{display:none;margin-top:10px;border-top:1px solid var(--masa-harbor-tint);padding-top:10px}
.detail.open{display:block}
.detail-section{margin-bottom:8px}
.detail-section h4{font-family:var(--font-heading);font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--masa-harbor);margin-bottom:4px}
.detail-section p{font-size:13px;line-height:1.6;color:var(--masa-body);white-space:pre-wrap;word-break:break-word}
.detail-section ul{list-style:none;padding:0;display:flex;flex-direction:column;gap:4px}
.detail-section ul li{font-size:12px;color:var(--masa-body);padding-left:12px;position:relative}
.detail-section ul li::before{content:"•";position:absolute;left:0;color:var(--masa-tide)}
.req-item{background:var(--masa-harbor-tint);border-radius:6px;padding:8px 10px;margin-bottom:5px;font-size:12px}
.req-cat{font-family:var(--font-heading);font-size:10px;color:var(--masa-harbor);text-transform:uppercase;letter-spacing:.5px}
.req-text{font-family:var(--font-heading);font-weight:500;margin:2px 0}
.req-evidence{color:var(--masa-harbor);font-style:italic}
/* ── Download button ── */
.dl-btn{display:inline-flex;align-items:center;gap:5px;padding:6px 14px;background:var(--masa-tide);color:#fff;border:none;border-radius:var(--radius-btn);font-size:12px;font-weight:700;font-family:var(--font-heading);cursor:pointer;white-space:nowrap;transition:background .15s}
.dl-btn:hover{background:var(--masa-horizon)}
/* ── Requirements examples ── */
.show-ex-btn{font-family:var(--font-heading);font-size:11px;color:var(--masa-tide);cursor:pointer;background:none;border:1px solid rgba(0,113,206,0.3);border-radius:var(--radius-btn);padding:3px 8px;white-space:nowrap;transition:all .15s}
.show-ex-btn:hover{background:rgba(0,113,206,0.08)}
.show-ex-btn.open{color:var(--masa-horizon);background:rgba(0,113,206,0.08)}
.req-ex-row td{background:#f7f5f9}
.req-ex-list{display:flex;flex-direction:column;gap:8px;padding:4px 0}
.req-ex-card{background:var(--masa-white);border:1px solid var(--masa-harbor-tint);border-radius:var(--radius-card);padding:12px 14px}
.req-ex-card-header{display:flex;align-items:center;gap:8px;margin-bottom:6px;flex-wrap:wrap}
.req-ex-card-title{font-family:var(--font-heading);font-size:13px;font-weight:600;color:var(--masa-horizon);flex:1;min-width:0}
.req-ex-pps{list-style:none;padding:0;display:flex;flex-direction:column;gap:3px}
.req-ex-pps li{font-size:12px;color:var(--masa-body);padding-left:12px;position:relative}
.req-ex-pps li::before{content:"•";position:absolute;left:0;color:var(--masa-tide)}
@media(max-width:720px){.grid2,.grid3,.step-grid,.source-grid{grid-template-columns:1fr}}
</style>
</head>
<body>

<nav class="nav">
  <div class="nav-brand">Medical Billing Intelligence</div>
  <button class="tab-btn active" data-tab="overview" onclick="switchTab('overview',this)">Overview</button>
  <button class="tab-btn" data-tab="insights" onclick="switchTab('insights',this)">Insights</button>
  <button class="tab-btn" data-tab="browse" onclick="switchTab('browse',this)">Browse Records</button>
  <button class="tab-btn" data-tab="requirements" onclick="switchTab('requirements',this)">Requirements</button>
</nav>

<!-- ══ TAB: OVERVIEW ══════════════════════════════════════════════════════════ -->
<div class="tab-content active" id="tab-overview">

  <div class="hero">
    <h1>Medical Billing Complaint Intelligence</h1>
    <p>This report aggregates consumer complaints about medical billing from two public sources — the CFPB Complaint Database and Reddit — and uses Claude AI to extract structured product intelligence: recurring pain points, complaint themes, and actionable product requirements.</p>
    <div class="stat-row">
      <div class="s"><div class="v">${meta.complete.toLocaleString()}</div><div class="l">Records analyzed</div></div>
      <div class="s"><div class="v">${meta.cfpb.toLocaleString()}</div><div class="l">CFPB complaints</div></div>
      <div class="s"><div class="v">${meta.reddit.toLocaleString()}</div><div class="l">Reddit posts</div></div>
      <div class="s"><div class="v">${topThemes.length}</div><div class="l">Distinct themes</div></div>
      <div class="s"><div class="v">${priCounts.high}</div><div class="l">High-priority reqs</div></div>
    </div>
  </div>

  <div class="step-grid">
    <div class="step">
      <div class="icon">📥</div>
      <h3>Phase 1 — CFPB Data</h3>
      <p>The Consumer Financial Protection Bureau publishes its full complaint database as a public bulk download. We filtered for medical billing complaints with consumer narratives, yielding ${cfpbMeta.total.toLocaleString()} complaints spanning ${cfpbMeta.min_date} to ${cfpbMeta.max_date}.</p>
    </div>
    <div class="step">
      <div class="icon">📡</div>
      <h3>Phase 2 — Reddit Posts</h3>
      <p>We scraped ${subreddits.reduce((a, s) => a + s.total, 0).toLocaleString()} posts from ${subreddits.length} medical billing and personal finance subreddits using Reddit's public JSON API, filtering for self-posts with substantive body text.</p>
    </div>
    <div class="step">
      <div class="icon">🤖</div>
      <h3>Phase 3 — Claude AI Analysis</h3>
      <p>Each complaint and post was individually analyzed by Claude (claude-haiku-4-5). The model extracted complaint themes, specific pain points, and actionable product requirements with priority levels and evidence quotes.</p>
    </div>
  </div>

  <div class="source-grid">
    <div class="source-card">
      <div class="src-header">
        <span class="src-cfpb">CFPB</span>
        <h3>Consumer Financial Protection Bureau</h3>
      </div>
      <p>The CFPB accepts consumer complaints against financial companies. Medical billing complaints are filed under <em>Debt collection → Medical debt</em> and related products. Narratives are written by consumers in their own words and are part of the public record.</p>
      <p><strong>Date range:</strong> ${cfpbMeta.min_date} → ${cfpbMeta.max_date}<br/>
      <strong>Total in DB:</strong> ${cfpbMeta.total.toLocaleString()} complaints<br/>
      <strong>Analyzed:</strong> ${meta.cfpb.toLocaleString()} complaints</p>
    </div>
    <div class="source-card">
      <div class="src-header">
        <span class="src-reddit">Reddit</span>
        <h3>Reddit Communities</h3>
      </div>
      <p>Reddit posts capture real-time consumer experiences in communities dedicated to medical billing help, hospital bills, and personal finance. Posts often include specific dollar amounts, timelines, and emotional context absent from formal complaints.</p>
      <table style="margin-top:8px;font-size:12px">
        <thead><tr><th>Subreddit</th><th>Posts</th><th>Analyzed</th></tr></thead>
        <tbody>${subRedditRows}</tbody>
      </table>
    </div>
  </div>

  <div class="panel">
    <h2>Top Complaint Themes — Preview</h2>
    <p style="font-size:12px;color:#64748b;margin-bottom:14px">The most frequently identified themes across all analyzed records. See the Insights tab for full charts.</p>
    ${topThemePreview}
    <p style="font-size:12px;color:#0071CE;margin-top:12px;cursor:pointer;font-family:'Poppins',sans-serif;font-weight:600" onclick="switchTab('insights',document.querySelector('[data-tab=insights]'))">View all themes in Insights →</p>
  </div>

  <p style="font-size:12px;color:#968694;text-align:center;padding:16px 0">
    Generated ${esc(now)} · Data is public record (CFPB) and public posts (Reddit) · Analysis model: claude-haiku-4-5
  </p>
</div>

<!-- ══ TAB: INSIGHTS ═════════════════════════════════════════════════════════ -->
<div class="tab-content" id="tab-insights">
  <div class="grid2">
    <div class="panel"><h2>Top Complaint Themes</h2><canvas id="themeChart"></canvas></div>
    <div class="panel"><h2>Product Requirement Categories</h2><canvas id="catChart"></canvas></div>
  </div>
  <div class="grid2">
    <div class="panel"><h2>Top Pain Points</h2><canvas id="ppChart"></canvas></div>
    <div class="panel"><h2>Requirement Priority Mix</h2><canvas id="priChart"></canvas></div>
  </div>
</div>

<!-- ══ TAB: BROWSE ════════════════════════════════════════════════════════════ -->
<div class="tab-content" id="tab-browse">
  <p style="color:#968694;font-size:13px;margin-bottom:16px">Browse the full text of every analyzed complaint and post. Filter by source or theme, search by keyword.</p>
  <div class="panel" style="padding:20px">
    <div class="browser-controls">
      <input type="text" id="searchBox" placeholder="Search titles, text, themes…" oninput="filterRecords()"/>
      <button class="filter-btn active" onclick="setSource('all',this)">All</button>
      <button class="filter-btn" onclick="setSource('CFPB',this)">CFPB</button>
      <button class="filter-btn" onclick="setSource('REDDIT',this)">Reddit</button>
      <select class="filter-select" id="themeFilter" onchange="filterRecords()">
        <option value="">All themes</option>
        ${allThemes.map(t => `<option value="${esc(t)}">${esc(t)}</option>`).join('')}
      </select>
      <span class="record-count" id="recordCount"></span>
      <button class="dl-btn" id="dlBtn" style="display:none" onclick="downloadThemeCsv()">⬇ Download CSV</button>
    </div>
    <div class="record-list" id="recordList"></div>
  </div>
</div>

<!-- ══ TAB: REQUIREMENTS ═════════════════════════════════════════════════════ -->
<div class="tab-content" id="tab-requirements">
  <p style="color:#968694;font-size:13px;margin-bottom:16px">Product requirements extracted across all records, ranked by priority then frequency. CFPB and Reddit columns show how many records from each source surfaced this requirement. Click Examples to see the specific records behind each requirement.</p>
  <div class="panel">
    <table>
      <thead><tr><th>Priority</th><th>Category</th><th>Requirement</th><th title="Total">#</th><th title="From CFPB" style="color:#0071CE">CFPB</th><th title="From Reddit" style="color:#968694">Reddit</th><th></th></tr></thead>
      <tbody>${reqRows}</tbody>
    </table>
  </div>
</div>

<script>
const COLORS=['#0071CE','#230871','#968694','#E64B38','#4A90D9','#1A4A8A','#6B8DB5','#B0C8E8','#FFD040','#F0A030','#3D6B9A','#8AAECF','#5A3A8A','#9070B0','#C0A0D0'];
const PRI_COLOR={high:'#E64B38',medium:'#d97706',low:'#16a34a'};

// ── Tabs ──────────────────────────────────────────────────────────────────────
function switchTab(name, btn) {
  document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('tab-' + name).classList.add('active');
  if (btn) btn.classList.add('active');
  else document.querySelector('[data-tab="' + name + '"]').classList.add('active');
}

// ── Charts ────────────────────────────────────────────────────────────────────
new Chart(document.getElementById('themeChart'),{type:'bar',data:{labels:${JSON.stringify(topThemes.map(([t])=>t))},datasets:[{data:${JSON.stringify(topThemes.map(([,n])=>n))},backgroundColor:COLORS,borderRadius:4}]},options:{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,ticks:{precision:0}}}}});
new Chart(document.getElementById('catChart'),{type:'bar',data:{labels:${JSON.stringify(topCats.map(([c])=>c))},datasets:[{data:${JSON.stringify(topCats.map(([,n])=>n))},backgroundColor:COLORS,borderRadius:4}]},options:{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,ticks:{precision:0}}}}});
new Chart(document.getElementById('ppChart'),{type:'bar',data:{labels:${JSON.stringify(topPPs.map(([p])=>p.length>60?p.slice(0,57)+'…':p))},datasets:[{data:${JSON.stringify(topPPs.map(([,n])=>n))},backgroundColor:'#0071CE',borderRadius:4}]},options:{indexAxis:'y',plugins:{legend:{display:false}},scales:{x:{beginAtZero:true,ticks:{precision:0}}}}});
new Chart(document.getElementById('priChart'),{type:'doughnut',data:{labels:['High','Medium','Low'],datasets:[{data:[${priCounts.high},${priCounts.medium},${priCounts.low}],backgroundColor:['#E64B38','#FFD040','#0071CE'],borderWidth:0}]},options:{plugins:{legend:{position:'bottom'}},cutout:'60%'}});

// ── Record browser ────────────────────────────────────────────────────────────
const ALL_RECORDS = ${JSON.stringify(browseData)};
const REQ_INDEX = ${JSON.stringify(reqIndex)};
let sourceFilter = 'all';
let lastVisible = [];

function setSource(s, btn) {
  sourceFilter = s;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  filterRecords();
}

function filterRecords() {
  const q = document.getElementById('searchBox').value.toLowerCase();
  const theme = document.getElementById('themeFilter').value;
  const themeLower = theme.toLowerCase();
  const visible = ALL_RECORDS.filter(r => {
    if (sourceFilter !== 'all' && r.source !== sourceFilter) return false;
    if (themeLower && !r.themes.some(t => t.toLowerCase().includes(themeLower))) return false;
    if (q) {
      const hay = [r.title, r.narrative, r.body, ...r.themes, ...r.pps].join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  lastVisible = visible;
  document.getElementById('recordCount').textContent = visible.length + ' records';
  const dlBtn = document.getElementById('dlBtn');
  dlBtn.style.display = theme ? 'inline-flex' : 'none';
  if (theme) dlBtn.textContent = '⬇ Download CSV — ' + theme + ' (' + visible.length + ')';
  renderRecords(visible);
}

function renderRecords(records) {
  const list = document.getElementById('recordList');
  list.innerHTML = records.slice(0, 200).map((r, i) => {
    const isReddit = r.source === 'REDDIT';
    const srcBadge = isReddit ? '<span class="src-reddit">Reddit</span>' : '<span class="src-cfpb">CFPB</span>';
    const titleText = isReddit ? (r.title || r.id) : ('Medical Debt Complaint · ' + (r.state || '') + (r.date ? ' · ' + r.date : ''));
    const subText = isReddit ? 'r/' + r.subreddit + ' · score ' + (r.score ?? '?') : (r.product || '');
    const themes = r.themes.map(t => '<span class="theme-tag">' + esc(t) + '</span>').join('');
    const bodyText = isReddit ? (r.body || '') : (r.narrative || '');
    const pps = r.pps.map(p => '<li>' + esc(p) + '</li>').join('');
    const reqs = r.reqs.map(req => \`<div class="req-item"><div class="req-cat">\${esc(req.category)}</div><div class="req-text" style="color:\${PRI_COLOR[req.priority]||'#374151'}">\${esc(req.requirement)}</div>\${req.evidence?'<div class="req-evidence">"'+esc(req.evidence)+'"</div>':''}</div>\`).join('');
    return \`<div class="record-card" id="card\${i}">
      <div class="record-header" onclick="toggleDetail(\${i})">
        <div class="meta">
          <div class="rec-title">\${srcBadge} \${esc(titleText)}</div>
          <div class="subtitle">\${esc(subText)}</div>
        </div>
        <button class="toggle-btn" id="toggle\${i}">Show ▾</button>
      </div>
      <div class="themes-row">\${themes}</div>
      <div class="detail" id="detail\${i}">
        <div class="detail-section"><h4>Full \${isReddit?'Post':'Complaint'}</h4><p>\${esc(bodyText)}</p></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px">
          <div class="detail-section"><h4>Pain Points</h4><ul>\${pps}</ul></div>
          <div class="detail-section"><h4>Product Requirements</h4>\${reqs}</div>
        </div>
      </div>
    </div>\`;
  }).join('');
  if (records.length > 200) {
    list.innerHTML += '<p style="text-align:center;color:#64748b;padding:12px;font-size:12px">Showing first 200 of ' + records.length + ' — use filters to narrow down</p>';
  }
}

function toggleDetail(i) {
  const d = document.getElementById('detail' + i);
  const t = document.getElementById('toggle' + i);
  d.classList.toggle('open');
  t.textContent = d.classList.contains('open') ? 'Hide ▴' : 'Show ▾';
}

function esc(s) {
  if (!s) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Theme CSV export ──────────────────────────────────────────────────────────
function downloadThemeCsv() {
  const theme = document.getElementById('themeFilter').value;
  if (!theme || !lastVisible.length) return;

  const maxPps = lastVisible.reduce((m, r) => Math.max(m, r.pps.length), 0);

  const headers = ['Theme', 'Source', 'Title'];
  for (let i = 1; i <= maxPps; i++) headers.push('Pain Point ' + i);

  function csvCell(v) {
    const s = v == null ? '' : String(v);
    if (s.includes(',') || s.includes('"') || s.includes('\\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  const rows = lastVisible.map(r => {
    const isReddit = r.source === 'REDDIT';
    const title = isReddit
      ? (r.title || r.id)
      : 'Medical Debt Complaint · ' + (r.state || '') + (r.date ? ' · ' + r.date : '');
    const cells = [theme, r.source, title, ...r.pps];
    while (cells.length < headers.length) cells.push('');
    return cells.map(csvCell).join(',');
  });

  const csv = '\\uFEFF' + [headers.map(csvCell).join(','), ...rows].join('\\r\\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'theme-' + theme.replace(/[^a-z0-9]+/gi, '-').toLowerCase() + '.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Requirements examples ─────────────────────────────────────────────────────
function toggleReqExamples(i, btn) {
  const row = document.getElementById('req-ex-' + i);
  const list = document.getElementById('req-ex-list-' + i);
  const isOpen = row.style.display !== 'none';
  if (isOpen) {
    row.style.display = 'none';
    btn.textContent = 'Examples ▾';
    btn.classList.remove('open');
    return;
  }
  const indices = REQ_INDEX[i] || [];
  const records = [...new Set(indices)].map(idx => ALL_RECORDS[idx]).filter(Boolean);
  list.innerHTML = records.slice(0, 25).map(r => {
    const isReddit = r.source === 'REDDIT';
    const srcBadge = isReddit ? '<span class="src-reddit">Reddit</span>' : '<span class="src-cfpb">CFPB</span>';
    const title = isReddit
      ? esc(r.title || r.id)
      : 'Medical Debt Complaint · ' + esc(r.state || '') + (r.date ? ' · ' + esc(r.date) : '');
    const pps = r.pps.slice(0, 3).map(p => '<li>' + esc(p) + '</li>').join('');
    return '<div class="req-ex-card">'
      + '<div class="req-ex-card-header">'
      + srcBadge
      + '<span class="req-ex-card-title">' + title + '</span>'
      + '</div>'
      + (pps ? '<ul class="req-ex-pps">' + pps + '</ul>' : '')
      + '</div>';
  }).join('') || '<p style="color:#94a3b8;font-size:12px">No examples found.</p>';
  if (records.length > 25) {
    list.innerHTML += '<p style="font-size:11px;color:#94a3b8;margin-top:4px">Showing 25 of ' + records.length + ' examples</p>';
  }
  row.style.display = 'table-row';
  btn.textContent = 'Examples ▴';
  btn.classList.add('open');
}

filterRecords();
</script>
</body>
</html>`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

const data = loadData();

if (data.meta.complete === 0) {
  console.error('No complete results yet. Run `npm run phase3 -- --max 50` first.');
  process.exit(1);
}

// Fetch Chart.js once and embed it inline — no internet needed to view the file
console.log('Fetching Chart.js for offline embedding…');
let chartJs = '';
try {
  const res = await fetch('https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js');
  chartJs = await res.text();
  console.log(`  Chart.js fetched (${(chartJs.length / 1024).toFixed(0)} KB)`);
} catch {
  console.warn('  Could not fetch Chart.js — falling back to CDN (requires internet to view charts)');
  chartJs = 'FALLBACK';
}

let html = buildHtml(data);

if (chartJs === 'FALLBACK') {
  html = html.replace(
    '<script>CHARTJS_PLACEHOLDER</script>',
    '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.0/dist/chart.umd.min.js"></script>',
  );
} else {
  html = html.replace('<script>CHARTJS_PLACEHOLDER</script>', `<script>${chartJs}</script>`);
}

// Write data/report.html (local use / email)
writeFileSync(DATA_OUT, html, 'utf8');
console.log(`\nReport written : ${DATA_OUT}`);

// Write docs/index.html (GitHub Pages)
mkdirSync(dirname(DOCS_OUT), { recursive: true });
writeFileSync(DOCS_OUT, html, 'utf8');
console.log(`Report written : ${DOCS_OUT}`);
console.log(`Records        : ${data.browseRows.length}`);

try {
  if (process.platform === 'win32') execSync(`start "" "${DATA_OUT}"`);
  else if (process.platform === 'darwin') execSync(`open "${DATA_OUT}"`);
  else execSync(`xdg-open "${DATA_OUT}"`);
} catch {
  console.log('Open data/report.html in your browser.');
}
