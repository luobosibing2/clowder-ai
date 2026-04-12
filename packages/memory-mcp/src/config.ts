// memory-mcp: Configuration — reads env vars, produces typed config

import { join } from 'node:path';

export interface MemoryConfig {
  /** Absolute path to the folder of .md files to index */
  folderPath: string;
  /** Path to SQLite database file */
  dbPath: string;
  /** Enable vector search (requires external embedding server) */
  embedMode: 'off' | 'on';
  /** Embedding server base URL */
  embedUrl: string;
  /** Embedding vector dimension */
  embedDim: number;
  /** Embedding model identifier */
  embedModel: string;
  /** Auto-index on server startup */
  autoIndex: boolean;
}

export function loadConfig(): MemoryConfig {
  const folderPath = process.env['MEMORY_FOLDER_PATH'];
  if (!folderPath) {
    console.error('[memory-mcp] ERROR: MEMORY_FOLDER_PATH environment variable is required.');
    console.error('[memory-mcp] Example: MEMORY_FOLDER_PATH=/path/to/my/docs');
    process.exit(1);
  }

  const embedModeRaw = process.env['MEMORY_EMBED_MODE'] ?? 'off';
  if (embedModeRaw !== 'off' && embedModeRaw !== 'on') {
    console.error(`[memory-mcp] ERROR: MEMORY_EMBED_MODE must be 'off' or 'on', got '${embedModeRaw}'`);
    process.exit(1);
  }

  const defaultDbPath = join(folderPath, '.memory', 'evidence.sqlite');

  return {
    folderPath,
    dbPath: process.env['MEMORY_DB_PATH'] ?? defaultDbPath,
    embedMode: embedModeRaw as 'off' | 'on',
    embedUrl: process.env['MEMORY_EMBED_URL'] ?? 'http://127.0.0.1:9880',
    embedDim: parseInt(process.env['MEMORY_EMBED_DIM'] ?? '768', 10),
    embedModel: process.env['MEMORY_EMBED_MODEL'] ?? 'qwen3-embedding-0.6b',
    autoIndex: (process.env['MEMORY_AUTO_INDEX'] ?? 'on') !== 'off',
  };
}
