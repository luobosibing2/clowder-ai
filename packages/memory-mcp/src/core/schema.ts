// memory-mcp: SQLite schema — single clean migration (no Cat-Cafe-specific tables)

import type Database from 'better-sqlite3';

export const CURRENT_SCHEMA_VERSION = 1;

const SCHEMA_V1_DOCS = `
CREATE TABLE IF NOT EXISTS evidence_docs (
  anchor TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  keywords TEXT,
  source_path TEXT,
  source_hash TEXT,
  superseded_by TEXT,
  updated_at TEXT NOT NULL,
  provenance_tier TEXT,
  provenance_source TEXT
);

CREATE VIRTUAL TABLE IF NOT EXISTS evidence_fts USING fts5(
  title, summary,
  content=evidence_docs, content_rowid=rowid,
  tokenize="unicode61 tokenchars '_-'"
);

CREATE TABLE IF NOT EXISTS edges (
  from_anchor TEXT NOT NULL,
  to_anchor TEXT NOT NULL,
  relation TEXT NOT NULL,
  PRIMARY KEY (from_anchor, to_anchor, relation)
);

CREATE TABLE IF NOT EXISTS embedding_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence_passages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_anchor TEXT NOT NULL,
  passage_id TEXT NOT NULL,
  content TEXT NOT NULL,
  speaker TEXT,
  position INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE(doc_anchor, passage_id)
);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
`;

const EVIDENCE_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_ai AFTER INSERT ON evidence_docs BEGIN
  INSERT INTO evidence_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_ad AFTER DELETE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_docs_au AFTER UPDATE ON evidence_docs BEGIN
  INSERT INTO evidence_fts(evidence_fts, rowid, title, summary) VALUES ('delete', old.rowid, old.title, old.summary);
  INSERT INTO evidence_fts(rowid, title, summary) VALUES (new.rowid, new.title, new.summary);
END`,
];

const PASSAGE_FTS_TABLE =
  'CREATE VIRTUAL TABLE IF NOT EXISTS passage_fts USING fts5(content, content=evidence_passages, content_rowid=rowid, tokenize="unicode61 tokenchars \'_-\'")';

const PASSAGE_FTS_TRIGGERS = [
  `CREATE TRIGGER IF NOT EXISTS evidence_passages_ai AFTER INSERT ON evidence_passages BEGIN
  INSERT INTO passage_fts(rowid, content) VALUES (new.rowid, new.content);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_passages_ad AFTER DELETE ON evidence_passages BEGIN
  INSERT INTO passage_fts(passage_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END`,
  `CREATE TRIGGER IF NOT EXISTS evidence_passages_au AFTER UPDATE ON evidence_passages BEGIN
  INSERT INTO passage_fts(passage_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO passage_fts(rowid, content) VALUES (new.rowid, new.content);
END`,
];

export function applyMigrations(db: Database.Database): void {
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);

  const currentVersion =
    (db.prepare('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null })?.v ?? 0;

  if (currentVersion < 1) {
    db.exec(SCHEMA_V1_DOCS);
    for (const stmt of EVIDENCE_FTS_TRIGGERS) db.exec(stmt);
    db.exec(PASSAGE_FTS_TABLE);
    for (const stmt of PASSAGE_FTS_TRIGGERS) db.exec(stmt);
    db.prepare('INSERT OR IGNORE INTO schema_version (version, applied_at) VALUES (?, ?)').run(
      1,
      new Date().toISOString(),
    );
  }
}

/**
 * Ensure vec0 virtual table exists — called after sqlite-vec extension is loaded.
 * Safe to call multiple times (IF NOT EXISTS).
 * Returns true if table was created/exists, false if extension unavailable.
 */
export function ensureVectorTable(db: Database.Database, dim: number): boolean {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS evidence_vectors USING vec0(
        anchor TEXT PRIMARY KEY,
        embedding float[${dim}]
      )
    `);
    return true;
  } catch {
    return false;
  }
}
