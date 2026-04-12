// memory-mcp: SQLite evidence store — BM25 + semantic + hybrid search
// Simplified from F102: no thread/session/scope/pack filtering

import Database from 'better-sqlite3';
import type { Edge, EvidenceItem, IEmbeddingService, IEvidenceStore, SearchOptions } from './interfaces.js';
import { applyMigrations } from './schema.js';
import type { VectorStore } from './VectorStore.js';

export interface PassageResult {
  docAnchor: string;
  passageId: string;
  content: string;
  speaker?: string;
  position?: number;
  createdAt?: string;
  context?: PassageResult[];
}

export interface EmbedDeps {
  embedding: IEmbeddingService;
  vectorStore: VectorStore;
  mode: 'off' | 'on';
}

export class SqliteEvidenceStore implements IEvidenceStore {
  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private embedDeps?: EmbedDeps;

  constructor(dbPath: string, embedDeps?: EmbedDeps) {
    this.dbPath = dbPath;
    this.embedDeps = embedDeps;
  }

  /** Allow late-binding of embed deps (factory sets after construction) */
  setEmbedDeps(deps: EmbedDeps): void {
    this.embedDeps = deps;
  }

  async initialize(): Promise<void> {
    this.db = new Database(this.dbPath);
    applyMigrations(this.db);
  }

  async search(query: string, options?: SearchOptions): Promise<EvidenceItem[]> {
    this.ensureOpen();
    const limit = options?.limit ?? 10;
    const bm25Pool = options?.mode === 'hybrid' ? Math.min(Math.max(limit * 4, 20), 100) : limit;
    const trimmed = query.trim();
    if (!trimmed) return [];

    const results: EvidenceItem[] = [];
    const seenAnchors = new Set<string>();

    // ── Build shared WHERE clause parts ──────────────────────────────
    const buildFilters = (prefix: string): { clauses: string[]; params: unknown[] } => {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (options?.kind) {
        clauses.push(`${prefix}kind = ?`);
        params.push(options.kind);
      }
      if (options?.status) {
        clauses.push(`${prefix}status = ?`);
        params.push(options.status);
      }
      if (options?.keywords?.length) {
        clauses.push(`(${options.keywords.map(() => `${prefix}keywords LIKE ?`).join(' OR ')})`);
        params.push(...options.keywords.map((kw) => `%"${kw}"%`));
      }
      return { clauses, params };
    };

    // ── Exact-anchor bypass ──────────────────────────────────────────
    {
      const f = buildFilters('');
      let sql = 'SELECT * FROM evidence_docs WHERE anchor = ? COLLATE NOCASE';
      const params: unknown[] = [trimmed];
      for (const c of f.clauses) {
        sql += ` AND ${c}`;
        params.push(...f.params);
      }
      const exactRow = this.db?.prepare(sql).get(...params) as RowShape | undefined;
      if (exactRow) {
        results.push(rowToItem(exactRow));
        seenAnchors.add(exactRow.anchor);
      }
    }

    // ── FTS5 full-text search ────────────────────────────────────────
    const ftsQuery = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' ');

    if (ftsQuery) {
      try {
        const f = buildFilters('d.');
        let sql = `
          SELECT d.*, bm25(evidence_fts, 5.0, 1.0) AS rank
          FROM evidence_fts f
          JOIN evidence_docs d ON d.rowid = f.rowid
          WHERE evidence_fts MATCH ?
        `;
        const params: unknown[] = [ftsQuery];
        for (const c of f.clauses) {
          sql += ` AND ${c}`;
        }
        params.push(...f.params);
        if (options?.dateFrom) {
          sql += ' AND d.updated_at >= ?';
          params.push(options.dateFrom);
        }
        if (options?.dateTo) {
          sql += ' AND d.updated_at <= ?';
          params.push(options.dateTo.length === 10 ? `${options.dateTo}T23:59:59` : options.dateTo);
        }
        sql +=
          " ORDER BY (d.superseded_by IS NOT NULL), (CASE WHEN d.provenance_tier = 'authoritative' THEN 0 WHEN d.provenance_tier IS NOT NULL THEN 1 ELSE 2 END), rank";
        sql += ' LIMIT ?';
        params.push(bm25Pool);

        const rows = this.db?.prepare(sql).all(...params) as RowShape[];
        for (const row of rows) {
          if (!seenAnchors.has(row.anchor)) {
            results.push(rowToItem(row));
            seenAnchors.add(row.anchor);
          }
        }
      } catch {
        // FTS5 syntax error — degrade to anchor-only results
      }
    }

    // ── Keyword fallback ─────────────────────────────────────────────
    if (results.length <= 1) {
      const words = trimmed.split(/\s+/).filter(Boolean);
      if (words.length > 0) {
        const f = buildFilters('');
        const kwConditions = words.map(() => 'keywords LIKE ?');
        let sql = `SELECT * FROM evidence_docs WHERE (${kwConditions.join(' OR ')})`;
        const params: unknown[] = words.map((w) => `%${w.toLowerCase()}%`);
        for (const c of f.clauses) {
          sql += ` AND ${c}`;
        }
        params.push(...f.params);
        sql +=
          " ORDER BY (superseded_by IS NOT NULL), (CASE WHEN provenance_tier = 'authoritative' THEN 0 WHEN provenance_tier IS NOT NULL THEN 1 ELSE 2 END), updated_at DESC LIMIT ?";
        params.push(bm25Pool);
        try {
          const kwRows = this.db?.prepare(sql).all(...params) as RowShape[];
          for (const row of kwRows) {
            if (!seenAnchors.has(row.anchor)) {
              results.push(rowToItem(row));
              seenAnchors.add(row.anchor);
            }
          }
        } catch {
          // keyword search failed
        }
      }
    }

    // ── Passage search (depth=raw) ────────────────────────────────────
    if (options?.depth === 'raw') {
      const cw = options?.contextWindow;
      const passages = this.searchPassages(
        trimmed,
        limit,
        { dateFrom: options?.dateFrom, dateTo: options?.dateTo },
        cw && cw > 0 ? { contextWindow: cw } : undefined,
      );
      const passagesByAnchor = new Map<string, typeof passages>();
      for (const p of passages) {
        const arr = passagesByAnchor.get(p.docAnchor) ?? [];
        arr.push(p);
        passagesByAnchor.set(p.docAnchor, arr);
      }
      for (const [anchor, pList] of passagesByAnchor) {
        let item = results.find((r) => r.anchor === anchor);
        if (!item) {
          const parentDoc = this.db?.prepare('SELECT * FROM evidence_docs WHERE anchor = ?').get(anchor) as
            | RowShape
            | undefined;
          if (parentDoc) {
            item = rowToItem(parentDoc);
            item.summary = `[passage match] ${pList[0]?.content.slice(0, 200) ?? ''}`;
            results.push(item);
            seenAnchors.add(anchor);
          }
        }
        if (item) {
          item.passages = pList.map((p) => ({
            passageId: p.passageId,
            content: p.content,
            speaker: p.speaker,
            createdAt: p.createdAt,
            ...(p.context
              ? {
                  context: p.context.map((c) => ({
                    passageId: c.passageId,
                    content: c.content,
                    speaker: c.speaker,
                    createdAt: c.createdAt,
                  })),
                }
              : {}),
          }));
        }
      }
      return results.slice(0, limit);
    }

    const lexicalCandidates = results.slice(0, bm25Pool);
    const lexicalResults = results.slice(0, limit);

    // ── Mode-based retrieval ─────────────────────────────────────────
    const searchMode = options?.mode ?? 'lexical';
    const embeddingAvailable = this.embedDeps?.embedding.isReady() && this.embedDeps.mode === 'on';

    if (searchMode === 'lexical') return lexicalResults;

    if (searchMode === 'semantic') {
      if (!embeddingAvailable) return lexicalResults;
      try {
        return await this.semanticNNSearch(query, limit, options);
      } catch {
        return lexicalResults;
      }
    }

    if (searchMode === 'hybrid') {
      if (!embeddingAvailable) return lexicalResults;
      try {
        return await this.hybridRRFSearch(query, lexicalCandidates, limit, options);
      } catch {
        return lexicalResults;
      }
    }

    return lexicalResults;
  }

  /** Pure vector nearest-neighbor search (mode=semantic) */
  private async semanticNNSearch(query: string, limit: number, options?: SearchOptions): Promise<EvidenceItem[]> {
    const pool = Math.min(Math.max(limit * 4, 20), 100);
    const queryVec = await this.embedDeps!.embedding.embed([query]);
    const nnResults = this.embedDeps!.vectorStore.search(queryVec[0]!, pool);
    if (nnResults.length === 0) return [];

    const anchors = nnResults.map((r) => r.anchor);
    const placeholders = anchors.map(() => '?').join(',');
    let sql = `SELECT * FROM evidence_docs WHERE anchor IN (${placeholders})`;
    const params: unknown[] = [...anchors];

    if (options?.kind) {
      sql += ' AND kind = ?';
      params.push(options.kind);
    }
    if (options?.status) {
      sql += ' AND status = ?';
      params.push(options.status);
    }

    const rows = this.db?.prepare(sql).all(...params) as RowShape[];
    const docMap = new Map(rows.map((r) => [r.anchor, rowToItem(r)]));

    return nnResults
      .filter((r) => docMap.has(r.anchor))
      .map((r) => docMap.get(r.anchor)!)
      .slice(0, limit);
  }

  /** Hybrid search — BM25 + vector NN dual-path recall → RRF fusion */
  private async hybridRRFSearch(
    query: string,
    lexicalResults: EvidenceItem[],
    limit: number,
    options?: SearchOptions,
  ): Promise<EvidenceItem[]> {
    const pool = Math.min(Math.max(limit * 4, 20), 100);
    const queryVec = await this.embedDeps!.embedding.embed([query]);
    const nnResults = this.embedDeps!.vectorStore.search(queryVec[0]!, pool);

    const RRF_K = 60;
    const scores = new Map<string, number>();

    for (let i = 0; i < lexicalResults.length; i++) {
      const anchor = lexicalResults[i]!.anchor;
      scores.set(anchor, (scores.get(anchor) ?? 0) + 1 / (RRF_K + i));
    }
    for (let i = 0; i < nnResults.length; i++) {
      const anchor = nnResults[i]!.anchor;
      scores.set(anchor, (scores.get(anchor) ?? 0) + 1 / (RRF_K + i));
    }

    const allAnchors = [...scores.keys()];
    const lexicalMap = new Map(lexicalResults.map((r) => [r.anchor, r]));

    const missingAnchors = allAnchors.filter((a) => !lexicalMap.has(a));
    if (missingAnchors.length > 0 && this.db) {
      const placeholders = missingAnchors.map(() => '?').join(',');
      let sql = `SELECT * FROM evidence_docs WHERE anchor IN (${placeholders})`;
      const params: unknown[] = [...missingAnchors];
      if (options?.kind) {
        sql += ' AND kind = ?';
        params.push(options.kind);
      }
      if (options?.status) {
        sql += ' AND status = ?';
        params.push(options.status);
      }
      const rows = this.db.prepare(sql).all(...params) as RowShape[];
      for (const row of rows) {
        lexicalMap.set(row.anchor, rowToItem(row));
      }
    }

    return allAnchors
      .filter((a) => lexicalMap.has(a))
      .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
      .map((a) => lexicalMap.get(a)!)
      .slice(0, limit);
  }

  async upsert(items: EvidenceItem[]): Promise<void> {
    this.ensureOpen();
    const db = this.db!;

    const stmt = db.prepare(`
      INSERT OR REPLACE INTO evidence_docs
      (anchor, kind, status, title, summary, keywords, source_path, source_hash,
       superseded_by, updated_at, provenance_tier, provenance_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = db.transaction((items: EvidenceItem[]) => {
      for (const item of items) {
        stmt.run(
          item.anchor,
          item.kind,
          item.status,
          item.title,
          item.summary ?? null,
          item.keywords ? JSON.stringify(item.keywords) : null,
          item.sourcePath ?? null,
          item.sourceHash ?? null,
          item.supersededBy ?? null,
          item.updatedAt,
          item.provenance?.tier ?? null,
          item.provenance?.source ?? null,
        );
      }
    });

    tx(items);
  }

  async deleteByAnchor(anchor: string): Promise<void> {
    this.ensureOpen();
    this.db?.prepare('DELETE FROM evidence_docs WHERE anchor = ?').run(anchor);
    this.db?.prepare('DELETE FROM evidence_passages WHERE doc_anchor = ?').run(anchor);
  }

  async getByAnchor(anchor: string): Promise<EvidenceItem | null> {
    this.ensureOpen();
    const row = this.db?.prepare('SELECT * FROM evidence_docs WHERE anchor = ? COLLATE NOCASE').get(anchor) as
      | RowShape
      | undefined;
    return row ? rowToItem(row) : null;
  }

  async health(): Promise<boolean> {
    try {
      if (!this.db || !this.db.open) return false;
      this.db.prepare('SELECT 1').get();
      return true;
    } catch {
      return false;
    }
  }

  /** Expose raw db for IndexBuilder */
  getDb(): Database.Database {
    this.ensureOpen();
    return this.db!;
  }

  // ── Edge operations ──────────────────────────────────────────────────

  async addEdge(edge: Edge): Promise<void> {
    this.ensureOpen();
    this.db
      ?.prepare('INSERT OR IGNORE INTO edges (from_anchor, to_anchor, relation) VALUES (?, ?, ?)')
      .run(edge.fromAnchor, edge.toAnchor, edge.relation);
  }

  async getRelated(anchor: string): Promise<Array<{ anchor: string; relation: string }>> {
    this.ensureOpen();
    return (this.db
      ?.prepare(
        `SELECT to_anchor AS anchor, relation FROM edges WHERE from_anchor = ?
         UNION
         SELECT from_anchor AS anchor, relation FROM edges WHERE to_anchor = ?`,
      )
      .all(anchor, anchor) ?? []) as Array<{ anchor: string; relation: string }>;
  }

  // ── Passage operations ───────────────────────────────────────────────

  searchPassages(
    query: string,
    limit = 10,
    timeFilter?: { dateFrom?: string; dateTo?: string },
    options?: { contextWindow?: number },
  ): PassageResult[] {
    this.ensureOpen();
    const trimmed = query.trim();
    if (!trimmed) return [];

    const ftsQuery = trimmed
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => `"${w.replace(/"/g, '""')}"`)
      .join(' ');
    if (!ftsQuery) return [];

    try {
      let sql = `SELECT p.doc_anchor, p.passage_id, p.content, p.speaker, p.position, p.created_at,
                   bm25(passage_fts) AS rank
           FROM passage_fts f
           JOIN evidence_passages p ON p.rowid = f.rowid
           WHERE passage_fts MATCH ?`;
      const params: unknown[] = [ftsQuery];

      if (timeFilter?.dateFrom) {
        sql += ' AND p.created_at >= ?';
        params.push(timeFilter.dateFrom);
      }
      if (timeFilter?.dateTo) {
        sql += ' AND p.created_at <= ?';
        params.push(timeFilter.dateTo.length === 10 ? `${timeFilter.dateTo}T23:59:59` : timeFilter.dateTo);
      }
      sql += ' ORDER BY rank LIMIT ?';
      params.push(limit);

      const rows = this.db?.prepare(sql).all(...params) as Array<{
        doc_anchor: string;
        passage_id: string;
        content: string;
        speaker: string | null;
        position: number | null;
        created_at: string | null;
      }>;

      const results: PassageResult[] = (rows ?? []).map((r) => ({
        docAnchor: r.doc_anchor,
        passageId: r.passage_id,
        content: r.content,
        speaker: r.speaker ?? undefined,
        position: r.position ?? undefined,
        createdAt: r.created_at ?? undefined,
      }));

      const cw = options?.contextWindow;
      if (cw && cw > 0 && this.db) {
        const ctxStmt = this.db.prepare(
          `SELECT doc_anchor, passage_id, content, speaker, position, created_at
           FROM evidence_passages
           WHERE doc_anchor = ? AND position BETWEEN ? AND ? AND passage_id != ?
           ORDER BY position`,
        );
        for (const r of results) {
          if (r.position != null) {
            const ctxRows = ctxStmt.all(r.docAnchor, r.position - cw, r.position + cw, r.passageId) as Array<{
              doc_anchor: string;
              passage_id: string;
              content: string;
              speaker: string | null;
              position: number | null;
              created_at: string | null;
            }>;
            r.context = ctxRows.map((c) => ({
              docAnchor: c.doc_anchor,
              passageId: c.passage_id,
              content: c.content,
              speaker: c.speaker ?? undefined,
              position: c.position ?? undefined,
              createdAt: c.created_at ?? undefined,
            }));
          }
        }
      }

      return results;
    } catch {
      return [];
    }
  }

  close(): void {
    if (this.db?.open) this.db.close();
    this.db = null;
  }

  private ensureOpen(): void {
    if (!this.db || !this.db.open) {
      throw new Error('SqliteEvidenceStore not initialized — call initialize() first');
    }
  }
}

// ── Row mapping ──────────────────────────────────────────────────────

interface RowShape {
  anchor: string;
  kind: string;
  status: string;
  title: string;
  summary: string | null;
  keywords: string | null;
  source_path: string | null;
  source_hash: string | null;
  superseded_by: string | null;
  updated_at: string;
  provenance_tier: string | null;
  provenance_source: string | null;
}

function rowToItem(row: RowShape): EvidenceItem {
  const item: EvidenceItem = {
    anchor: row.anchor,
    kind: row.kind as EvidenceItem['kind'],
    status: row.status as EvidenceItem['status'],
    title: row.title,
    updatedAt: row.updated_at,
  };
  if (row.summary != null) item.summary = row.summary;
  if (row.keywords != null) {
    try {
      item.keywords = JSON.parse(row.keywords);
    } catch {
      // malformed keywords — skip
    }
  }
  if (row.source_path != null) item.sourcePath = row.source_path;
  if (row.source_hash != null) item.sourceHash = row.source_hash;
  if (row.superseded_by != null) item.supersededBy = row.superseded_by;
  if (row.provenance_tier != null) {
    item.provenance = {
      tier: row.provenance_tier as 'authoritative' | 'derived' | 'soft_clue',
      source: row.provenance_source ?? '',
    };
  }
  return item;
}
