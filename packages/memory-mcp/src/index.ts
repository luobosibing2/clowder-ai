#!/usr/bin/env node

/**
 * memory-mcp: Standalone Memory MCP Server
 *
 * Indexes a folder of markdown files into SQLite and exposes search via MCP tools.
 * Supports BM25 full-text search and optional vector search (sqlite-vec).
 *
 * Configuration (environment variables):
 *   MEMORY_FOLDER_PATH  (required) — folder of .md files to index
 *   MEMORY_DB_PATH      (optional) — SQLite DB path (default: <folder>/.memory/evidence.sqlite)
 *   MEMORY_EMBED_MODE   (optional) — "off" (default) or "on"
 *   MEMORY_EMBED_URL    (optional) — embedding server URL (default: http://127.0.0.1:9880)
 *   MEMORY_EMBED_DIM    (optional) — embedding dimension (default: 768)
 *   MEMORY_EMBED_MODEL  (optional) — model identifier (default: qwen3-embedding-0.6b)
 *   MEMORY_AUTO_INDEX   (optional) — "on" (default) or "off"
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { createMemorySystem } from './factory.js';
import { handleReindex, reindexInputSchema } from './tools/reindex.js';
import { handleSearch, searchInputSchema } from './tools/search.js';
import { handleStatus } from './tools/status.js';

async function main(): Promise<void> {
  const config = loadConfig();
  console.error(`[memory-mcp] Starting — folder: ${config.folderPath}`);
  console.error(`[memory-mcp] Database: ${config.dbPath}`);
  console.error(`[memory-mcp] Embed mode: ${config.embedMode}`);

  const system = await createMemorySystem(config);

  if (config.autoIndex) {
    console.error('[memory-mcp] Indexing documents...');
    try {
      const result = await system.indexBuilder.rebuild();
      console.error(
        `[memory-mcp] Indexed ${result.docsIndexed} docs, skipped ${result.docsSkipped} (${result.durationMs}ms)`,
      );
    } catch (err) {
      console.error('[memory-mcp] Warning: initial indexing failed:', err);
    }
  }

  const server = new McpServer({ name: 'memory-mcp', version: '0.1.0' });

  // ── Tool: memory_search ──────────────────────────────────────────────
  server.tool(
    'memory_search',
    'Search indexed markdown documents using BM25 full-text search, optional vector semantic search, ' +
      'or hybrid (BM25 + vector + RRF fusion). ' +
      'MODE SELECTION: lexical (default) = BM25 keyword match, fast and reliable. ' +
      'hybrid = BM25 + vector NN + RRF fusion, RECOMMENDED for most searches — finds exact AND semantic matches. ' +
      'semantic = pure vector nearest-neighbor, best for synonym/cross-language matching. ' +
      'NOTE: semantic and hybrid modes require MEMORY_EMBED_MODE=on and a running embedding server.',
    searchInputSchema,
    async (input) => handleSearch(system.store, input as Parameters<typeof handleSearch>[1]),
  );

  // ── Tool: memory_reindex ─────────────────────────────────────────────
  server.tool(
    'memory_reindex',
    'Rebuild the search index from markdown files in the configured folder. ' +
      'Run this after adding, modifying, or deleting documents. ' +
      'Returns count of documents indexed and skipped.',
    reindexInputSchema,
    async (input) => handleReindex(system.indexBuilder, input as Parameters<typeof handleReindex>[1]),
  );

  // ── Tool: memory_status ──────────────────────────────────────────────
  server.tool(
    'memory_status',
    'Show memory system health: folder path, database path, document count, ' +
      'FTS consistency check, and embedding server status.',
    {},
    async () => handleStatus(config, system.store, system.indexBuilder, system.embeddingService, system.vectorStore),
  );

  const transport = new StdioServerTransport();
  console.error('[memory-mcp] MCP Server starting on stdio...');
  await server.connect(transport);
  console.error('[memory-mcp] Ready.');
}

main().catch((err) => {
  console.error('[memory-mcp] Fatal error:', err);
  process.exit(1);
});
