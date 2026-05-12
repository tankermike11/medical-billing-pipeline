import type { AnalysisStatus, DataSource, RequirementPriority } from './enums.js';

// --- Raw ingestion rows ---

export interface CfpbComplaint {
  id?: number;
  complaint_id: string;
  date_received: string;         // ISO date string
  product: string;
  sub_product: string | null;
  issue: string;
  sub_issue: string | null;
  consumer_narrative: string | null;
  company: string;
  state: string | null;
  status: string;                // CfpbComplaintStatus value
  tags: string | null;           // JSON-serialised string[]
  ingested_at: string;           // ISO datetime
}

export interface RedditPost {
  id?: number;
  post_id: string;               // Reddit base-36 ID (e.g. "t3_abc123")
  subreddit: string;
  title: string;
  body: string | null;
  author: string;
  created_utc: number;           // Unix timestamp
  score: number;
  url: string;
  comment_count: number;
  scraped_at: string;            // ISO datetime
}

// --- Analysis layer ---

export interface ProductRequirement {
  category: string;              // e.g. "Billing Transparency", "Dispute Resolution"
  requirement: string;           // The extracted requirement statement
  priority: RequirementPriority;
  evidence: string;              // Quote or paraphrase from the source text
}

export interface AnalysisResult {
  id?: number;
  source: DataSource;
  source_id: string;             // CfpbComplaint.complaint_id or RedditPost.post_id
  status: AnalysisStatus;
  themes: string | null;         // JSON-serialised string[]
  pain_points: string | null;    // JSON-serialised string[]
  product_requirements: string | null; // JSON-serialised ProductRequirement[]
  raw_response: string | null;
  model: string | null;
  tokens_used: number | null;
  analyzed_at: string | null;    // ISO datetime
}

// --- Convenience deserialisers ---

export function parseThemes(row: AnalysisResult): string[] {
  return row.themes ? (JSON.parse(row.themes) as string[]) : [];
}

export function parsePainPoints(row: AnalysisResult): string[] {
  return row.pain_points ? (JSON.parse(row.pain_points) as string[]) : [];
}

export function parseProductRequirements(row: AnalysisResult): ProductRequirement[] {
  return row.product_requirements
    ? (JSON.parse(row.product_requirements) as ProductRequirement[])
    : [];
}

export function parseTags(row: CfpbComplaint): string[] {
  return row.tags ? (JSON.parse(row.tags) as string[]) : [];
}
