// memory-mcp: Factory — wires together store, embedding, scanner, indexer

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { MemoryConfig } from './config.js';
import { EmbeddingService } from './core/EmbeddingService.js';
import { SqliteEvidenceStore } from './core/SqliteEvidenceStore.js';
import { ensureVectorTable } from './core/schema.js';
import { VectorStore } from './core/VectorStore.js';
import { IndexBuilder } from './indexer/IndexBuilder.js';
import { MarkdownScanner } from './scanner/MarkdownScanner.js';

export interface MemorySystem {
  store: SqliteEvidenceStore;
  indexBuilder: IndexBuilder;
  scanner: MarkdownScanner;
  embeddingService?: EmbeddingService;
  vectorStore?: VectorStore;
}

export async function createMemorySystem(config: MemoryConfig): Promise<MemorySystem> {
  // Ensure DB directory exists
  mkdirSync(dirname(config.dbPath), { recursive: true });

  const store = new SqliteEvidenceStore(config.dbPath);
  await store.initialize();

  let embeddingService: EmbeddingService | undefined;
  let vectorStore: VectorStore | undefined;

  if (config.embedMode === 'on') {
    embeddingService = new EmbeddingService({
      embedMode: 'on',
      embedUrl: config.embedUrl,
      embedModel: config.embedModel,
      embedDim: config.embedDim,
      embedTimeoutMs: 3000,
    });

    // Probe embedding server (fail-open)
    try {
      await embeddingService.load();
    } catch {
      // fail-open: server not available → isReady()=false → lexical-only
    }

    // Load sqlite-vec extension and ensure vec0 table (fail-open)
    try {
      const sqliteVecMod = await import('sqlite-vec');
      sqliteVecMod.load(store.getDb());
      const ok = ensureVectorTable(store.getDb(), config.embedDim);
      if (ok) {
        vectorStore = new VectorStore(store.getDb(), config.embedDim);
      }
    } catch {
      // fail-open: sqlite-vec not available → vector search disabled
    }

    if (embeddingService && vectorStore) {
      store.setEmbedDeps({
        embedding: embeddingService,
        vectorStore,
        mode: 'on',
      });
    }
  }

  const scanner = new MarkdownScanner();
  const embedDeps = embeddingService && vectorStore ? { embedding: embeddingService, vectorStore } : undefined;
  const indexBuilder = new IndexBuilder(store, config.folderPath, scanner, embedDeps);

  return { store, indexBuilder, scanner, embeddingService, vectorStore };
}
