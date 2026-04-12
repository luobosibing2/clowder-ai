// memory-mcp: IndexBuilder — scan folder, hash-compare, upsert into SQLite
// Simplified from F102: markdown-only, no threads/sessions/transcripts

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  ConsistencyReport,
  EvidenceItem,
  IEmbeddingService,
  IIndexBuilder,
  RebuildResult,
} from '../core/interfaces.js';
import type { SqliteEvidenceStore } from '../core/SqliteEvidenceStore.js';
import type { VectorStore } from '../core/VectorStore.js';
import type { MarkdownScanner } from '../scanner/MarkdownScanner.js';

/** Kind priority for anchor ownership — higher wins on conflict */
const KIND_PRIORITY: Record<string, number> = {
  decision: 4,
  plan: 3,
  lesson: 2,
  research: 2,
  document: 1,
};

interface EmbedDeps {
  embedding: IEmbeddingService;
  vectorStore: VectorStore;
}

export class IndexBuilder implements IIndexBuilder {
  constructor(
    private readonly store: SqliteEvidenceStore,
    private readonly folderPath: string,
    private readonly scanner: MarkdownScanner,
    private readonly embedDeps?: EmbedDeps,
  ) {}

  async rebuild(options?: { force?: boolean }): Promise<RebuildResult> {
    const start = Date.now();

    // Ensure DB directory exists
    mkdirSync(dirname(this.store.getDb().name), { recursive: true });

    const discovered = this.scanner.discover(this.folderPath, { skipSoftClues: false });

    let docsIndexed = 0;
    let docsSkipped = 0;

    const toEmbed: Array<{ anchor: string; text: string }> = [];

    for (const { item, rawContent, provenance } of discovered) {
      const contentHash = createHash('sha256').update(rawContent).digest('hex').slice(0, 16);

      if (!options?.force) {
        const existing = await this.store.getByAnchor(item.anchor);
        if (existing?.sourceHash === contentHash) {
          docsSkipped++;
          continue;
        }
      }

      // Kind-priority guard: don't overwrite a higher-priority kind
      const existing = await this.store.getByAnchor(item.anchor);
      if (existing) {
        const existingPriority = KIND_PRIORITY[existing.kind] ?? 0;
        const newPriority = KIND_PRIORITY[item.kind] ?? 0;
        if (existingPriority > newPriority) {
          docsSkipped++;
          continue;
        }
      }

      const evidenceItem: EvidenceItem = {
        ...item,
        sourceHash: contentHash,
        provenance,
      };

      await this.store.upsert([evidenceItem]);
      docsIndexed++;

      if (this.embedDeps) {
        const embedText = [item.title, item.summary].filter(Boolean).join(' ');
        toEmbed.push({ anchor: item.anchor, text: embedText });
      }
    }

    // Remove stale docs (present in DB but not in current scan)
    await this.pruneStale(discovered.map((d) => d.item.anchor));

    // Batch embed new/updated docs
    if (this.embedDeps && toEmbed.length > 0) {
      await this.embedBatch(toEmbed);
    }

    return { docsIndexed, docsSkipped, durationMs: Date.now() - start };
  }

  async incrementalUpdate(changedPaths: string[]): Promise<void> {
    for (const filePath of changedPaths) {
      const scanned = this.scanner.parseSingle(filePath, this.folderPath);
      if (!scanned) {
        // File deleted or unparseable — find anchor by source_path and delete
        await this.deleteBySourcePath(filePath);
        continue;
      }

      const { item, rawContent, provenance } = scanned;
      const contentHash = createHash('sha256').update(rawContent).digest('hex').slice(0, 16);

      const existing = await this.store.getByAnchor(item.anchor);
      if (existing?.sourceHash === contentHash) continue;

      await this.store.upsert([{ ...item, sourceHash: contentHash, provenance }]);

      if (this.embedDeps) {
        const embedText = [item.title, item.summary].filter(Boolean).join(' ');
        await this.embedBatch([{ anchor: item.anchor, text: embedText }]);
      }
    }
  }

  async checkConsistency(): Promise<ConsistencyReport> {
    const db = this.store.getDb();
    const docCount = (db.prepare('SELECT count(*) as c FROM evidence_docs').get() as { c: number }).c;
    const ftsCount = (db.prepare('SELECT count(*) as c FROM evidence_fts').get() as { c: number }).c;
    const ok = docCount === ftsCount;
    return {
      ok,
      docCount,
      ftsCount,
      mismatches: ok ? [] : [`doc count ${docCount} ≠ fts count ${ftsCount}`],
    };
  }

  private async pruneStale(currentAnchors: string[]): Promise<void> {
    const db = this.store.getDb();
    const dbAnchors = (db.prepare('SELECT anchor FROM evidence_docs').all() as Array<{ anchor: string }>).map(
      (r) => r.anchor,
    );
    const currentSet = new Set(currentAnchors);
    for (const anchor of dbAnchors) {
      if (!currentSet.has(anchor)) {
        await this.store.deleteByAnchor(anchor);
        this.embedDeps?.vectorStore.delete(anchor);
      }
    }
  }

  private async deleteBySourcePath(filePath: string): Promise<void> {
    const db = this.store.getDb();
    const row = db.prepare('SELECT anchor FROM evidence_docs WHERE source_path = ?').get(filePath) as
      | { anchor: string }
      | undefined;
    if (row) {
      await this.store.deleteByAnchor(row.anchor);
      this.embedDeps?.vectorStore.delete(row.anchor);
    }
  }

  private async embedBatch(items: Array<{ anchor: string; text: string }>): Promise<void> {
    if (!this.embedDeps) return;
    const { embedding, vectorStore } = this.embedDeps;
    if (!embedding.isReady()) return;

    // Check model version anchor consistency before embedding
    const modelInfo = embedding.getModelInfo();
    const consistency = vectorStore.checkMetaConsistency(modelInfo);
    if (!consistency.consistent) {
      console.error(`[memory-mcp] Embedding model changed (${consistency.reason}) — clearing vectors`);
      vectorStore.clearAll();
    }

    const BATCH_SIZE = 32;
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const batch = items.slice(i, i + BATCH_SIZE);
      try {
        const vectors = await embedding.embed(batch.map((b) => b.text));
        for (let j = 0; j < batch.length; j++) {
          vectorStore.upsert(batch[j]!.anchor, vectors[j]!);
        }
        // Update meta after first successful embed
        if (i === 0) vectorStore.initMeta(modelInfo);
      } catch {
        // fail-open: embedding failed for this batch
        break;
      }
    }
  }
}
