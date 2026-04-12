// memory-mcp: memory_search MCP tool

import { z } from 'zod';
import type { EvidenceItem } from '../core/interfaces.js';
import type { SqliteEvidenceStore } from '../core/SqliteEvidenceStore.js';

export const searchInputSchema = {
  query: z.string().min(1).describe('Search query'),
  limit: z.number().int().min(1).max(50).optional().describe('Max results (default 10)'),
  mode: z
    .enum(['lexical', 'semantic', 'hybrid'])
    .optional()
    .describe(
      'Search mode: lexical (BM25, default), semantic (vector NN), hybrid (BM25 + vector + RRF fusion, recommended for most searches)',
    ),
  kind: z.enum(['document', 'decision', 'plan', 'lesson', 'research']).optional().describe('Filter by document kind'),
  dateFrom: z.string().optional().describe('ISO8601 date lower bound (inclusive), e.g. 2026-01-01'),
  dateTo: z.string().optional().describe('ISO8601 date upper bound (inclusive), e.g. 2026-12-31'),
  depth: z
    .enum(['summary', 'raw'])
    .optional()
    .describe('Result depth: summary (default) or raw (includes passage-level matches)'),
};

export type SearchInput = {
  query: string;
  limit?: number;
  mode?: 'lexical' | 'semantic' | 'hybrid';
  kind?: 'document' | 'decision' | 'plan' | 'lesson' | 'research';
  dateFrom?: string;
  dateTo?: string;
  depth?: 'summary' | 'raw';
};

export async function handleSearch(store: SqliteEvidenceStore, input: SearchInput) {
  try {
    const results = await store.search(input.query, {
      limit: input.limit ?? 10,
      mode: input.mode ?? 'lexical',
      kind: input.kind,
      dateFrom: input.dateFrom,
      dateTo: input.dateTo,
      depth: input.depth,
    });

    if (results.length === 0) {
      return { content: [{ type: 'text' as const, text: `No results found for: ${input.query}` }] };
    }

    const lines: string[] = [`Found ${results.length} result(s) for: ${input.query}`, ''];

    for (const r of results) {
      lines.push(formatResult(r));
    }

    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Search failed: ${message}` }],
      isError: true,
    };
  }
}

function formatResult(r: EvidenceItem): string {
  const lines: string[] = [];
  lines.push(`[${r.kind}] ${r.title}`);
  lines.push(`  anchor: ${r.anchor}`);
  if (r.sourcePath) lines.push(`  source: ${r.sourcePath}`);
  if (r.summary) {
    const snippet = r.summary.length > 200 ? `${r.summary.slice(0, 200)}...` : r.summary;
    lines.push(`  > ${snippet.replace(/\n/g, ' ')}`);
  }
  if (r.passages && r.passages.length > 0) {
    lines.push('  passages:');
    for (const p of r.passages) {
      const text = p.content.length > 150 ? `${p.content.slice(0, 150)}...` : p.content;
      lines.push(`    [${p.passageId}]: ${text.replace(/\n/g, ' ')}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}
