import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = join(DATA_DIR, 'pipeline.db');

let instance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (instance) return instance;

  mkdirSync(DATA_DIR, { recursive: true });

  instance = new DatabaseSync(DB_PATH);
  instance.exec('PRAGMA journal_mode = WAL');
  instance.exec('PRAGMA foreign_keys = ON');
  instance.exec('PRAGMA busy_timeout = 5000');

  applySchema(instance);
  return instance;
}

export function closeDb(): void {
  instance?.close();
  instance = null;
}

function applySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cfpb_complaints (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_id     TEXT    UNIQUE NOT NULL,
      date_received    TEXT    NOT NULL,
      product          TEXT    NOT NULL,
      sub_product      TEXT,
      issue            TEXT    NOT NULL,
      sub_issue        TEXT,
      consumer_narrative TEXT,
      company          TEXT    NOT NULL,
      state            TEXT,
      status           TEXT    NOT NULL,
      tags             TEXT,
      ingested_at      TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reddit_posts (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id       TEXT    UNIQUE NOT NULL,
      subreddit     TEXT    NOT NULL,
      title         TEXT    NOT NULL,
      body          TEXT,
      author        TEXT    NOT NULL,
      created_utc   INTEGER NOT NULL,
      score         INTEGER NOT NULL DEFAULT 0,
      url           TEXT    NOT NULL,
      comment_count INTEGER NOT NULL DEFAULT 0,
      scraped_at    TEXT    NOT NULL
    );

    CREATE TABLE IF NOT EXISTS analysis_results (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      source               TEXT    NOT NULL,
      source_id            TEXT    NOT NULL,
      status               TEXT    NOT NULL DEFAULT 'pending',
      themes               TEXT,
      pain_points          TEXT,
      product_requirements TEXT,
      raw_response         TEXT,
      model                TEXT,
      tokens_used          INTEGER,
      analyzed_at          TEXT,
      UNIQUE(source, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_cfpb_date     ON cfpb_complaints(date_received);
    CREATE INDEX IF NOT EXISTS idx_cfpb_product  ON cfpb_complaints(product);
    CREATE INDEX IF NOT EXISTS idx_reddit_sub    ON reddit_posts(subreddit);
    CREATE INDEX IF NOT EXISTS idx_analysis_src  ON analysis_results(source, source_id);
    CREATE INDEX IF NOT EXISTS idx_analysis_stat ON analysis_results(status);
  `);
}

// Allow running directly to verify DB initialises cleanly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = getDb();
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
    .all() as { name: string }[];
  console.log('DB initialised at', DB_PATH);
  console.log('Tables:', tables.map((t) => t.name).join(', '));
  closeDb();
}
