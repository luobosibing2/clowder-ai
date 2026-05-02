// memory-mcp: memory_status MCP tool

import { z } from 'zod';
import type { MemoryConfig } from '../config.js';
import type { EmbeddingService } from '../core/EmbeddingService.js';
import type { IMarkerQueue } from '../core/interfaces.js';
import type { SqliteEvidenceStore } from '../core/SqliteEvidenceStore.js';
import type { VectorStore } from '../core/VectorStore.js';
import type { KnowledgeIndexManager } from '../governance/KnowledgeIndex.js';
import type { IndexBuilder } from '../indexer/IndexBuilder.js';

export const statusInputSchema = {};

export type StatusInput = Record<string, never>;

export async function handleStatus(
  config: MemoryConfig,
  store: SqliteEvidenceStore,
  indexBuilder: IndexBuilder,
  embeddingService?: EmbeddingService,
  vectorStore?: VectorStore,
  markerQueue?: IMarkerQueue,
  knowledgeIndex?: KnowledgeIndexManager,
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
      `Knowledge: ${config.knowledgeDocsPath}`,
      `Manifest:  ${config.knowledgeIndexPath}`,
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

    if (markerQueue && knowledgeIndex) {
      const markers = await markerQueue.list();
      const pending = markers.filter((marker) => marker.status === 'needs_review').length;
      const approved = markers.filter((marker) => marker.status === 'approved').length;
      const manifest = await knowledgeIndex.read();
      lines.push('');
      lines.push('Knowledge governance:');
      lines.push(`  pending: ${pending}`);
      lines.push(`  approved: ${approved}`);
      lines.push(`  materialized entries: ${manifest?.entries.length ?? 0}`);
      lines.push(`  index dirty: ${knowledgeIndex.isDirty() ? 'yes' : 'no'}`);
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
