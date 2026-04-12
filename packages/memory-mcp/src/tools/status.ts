// memory-mcp: memory_status MCP tool

import { z } from 'zod';
import type { MemoryConfig } from '../config.js';
import type { EmbeddingService } from '../core/EmbeddingService.js';
import type { SqliteEvidenceStore } from '../core/SqliteEvidenceStore.js';
import type { VectorStore } from '../core/VectorStore.js';
import type { IndexBuilder } from '../indexer/IndexBuilder.js';

export const statusInputSchema = {};

export type StatusInput = Record<string, never>;

export async function handleStatus(
  config: MemoryConfig,
  store: SqliteEvidenceStore,
  indexBuilder: IndexBuilder,
  embeddingService?: EmbeddingService,
  vectorStore?: VectorStore,
) {
  try {
    const healthy = await store.health();
    const consistency = await indexBuilder.checkConsistency();
    const db = store.getDb();
    const docCount = (db.prepare('SELECT count(*) as c FROM evidence_docs').get() as { c: number }).c;

    const lines: string[] = [
      '## Memory MCP Status',
      '',
      `Folder:    ${config.folderPath}`,
      `Database:  ${config.dbPath}`,
      `DB health: ${healthy ? 'OK' : 'ERROR'}`,
      '',
      `Documents indexed: ${docCount}`,
      `FTS consistency:   ${consistency.ok ? 'OK' : 'MISMATCH'}`,
      ...(consistency.mismatches.length > 0 ? consistency.mismatches.map((m) => `  ⚠ ${m}`) : []),
      '',
      `Embed mode: ${config.embedMode}`,
    ];

    if (config.embedMode === 'on') {
      const ready = embeddingService?.isReady() ?? false;
      lines.push(`Embed server: ${ready ? 'READY' : 'UNAVAILABLE (degraded to lexical)'}`);
      if (ready && embeddingService) {
        const info = embeddingService.getModelInfo();
        lines.push(`Embed model:  ${info.modelId} (dim=${info.dim})`);
      }
      if (vectorStore) {
        const vecCount = vectorStore.count();
        lines.push(`Vectors indexed: ${vecCount}`);
      }
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Status check failed: ${message}` }],
      isError: true,
    };
  }
}

// Zod schema placeholder for MCP registration (no params)
export const _statusSchema = z.object({}).optional();
