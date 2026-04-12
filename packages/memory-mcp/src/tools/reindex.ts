// memory-mcp: memory_reindex MCP tool

import { z } from 'zod';
import type { IndexBuilder } from '../indexer/IndexBuilder.js';

export const reindexInputSchema = {
  force: z.boolean().optional().describe('Force re-index all documents even if content is unchanged (default false)'),
};

export type ReindexInput = {
  force?: boolean;
};

export async function handleReindex(indexBuilder: IndexBuilder, input: ReindexInput) {
  try {
    const result = await indexBuilder.rebuild({ force: input.force ?? false });
    const lines = [
      'Reindex complete.',
      `  Documents indexed: ${result.docsIndexed}`,
      `  Documents skipped (unchanged): ${result.docsSkipped}`,
      `  Duration: ${result.durationMs}ms`,
    ];
    return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: 'text' as const, text: `Reindex failed: ${message}` }],
      isError: true,
    };
  }
}
