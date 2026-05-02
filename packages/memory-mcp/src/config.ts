// memory-mcp: Configuration — reads env vars, produces typed config

import { join } from 'node:path';

export interface MemoryConfig {
  /** Project root for governance paths */
  projectRoot: string;
  /** Absolute path to the folder of .md files to index */
  folderPath: string;
  /** Path to SQLite database file */
  dbPath: string;
  /** Root for governance-local state (.gitignored except index.json) */
  knowledgeRoot: string;
  /** YAML marker queue path */
  markersPath: string;
  /** Materialized knowledge markdown path */
  knowledgeDocsPath: string;
  /** Committed derived read model */
  knowledgeIndexPath: string;
  /** Dirty marker for failed manifest sync */
  knowledgeIndexDirtyPath: string;
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
  const projectRoot = process.env['KNOWLEDGE_PROJECT_ROOT'] ?? process.cwd();
  const folderPath = process.env['MEMORY_FOLDER_PATH'] ?? projectRoot;
  const knowledgeRoot = process.env['KNOWLEDGE_ROOT'] ?? join(projectRoot, '.knowledge');

  const embedModeRaw = process.env['MEMORY_EMBED_MODE'] ?? 'off';
  if (embedModeRaw !== 'off' && embedModeRaw !== 'on') {
    console.error(`[memory-mcp] ERROR: MEMORY_EMBED_MODE must be 'off' or 'on', got '${embedModeRaw}'`);
    process.exit(1);
  }

  const defaultDbPath = join(knowledgeRoot, 'db', 'evidence.sqlite');

  return {
    projectRoot,
    folderPath,
    dbPath: process.env['MEMORY_DB_PATH'] ?? defaultDbPath,
    knowledgeRoot,
    markersPath: process.env['KNOWLEDGE_MARKERS_PATH'] ?? join(knowledgeRoot, 'markers'),
    knowledgeDocsPath: process.env['KNOWLEDGE_DOCS_PATH'] ?? join(projectRoot, 'docs', 'knowledge'),
    knowledgeIndexPath: process.env['KNOWLEDGE_INDEX_PATH'] ?? join(knowledgeRoot, 'index.json'),
    knowledgeIndexDirtyPath: process.env['KNOWLEDGE_INDEX_DIRTY_PATH'] ?? join(knowledgeRoot, 'index.dirty'),
    embedMode: embedModeRaw as 'off' | 'on',
    embedUrl: process.env['MEMORY_EMBED_URL'] ?? 'http://127.0.0.1:9880',
    embedDim: parseInt(process.env['MEMORY_EMBED_DIM'] ?? '768', 10),
    embedModel: process.env['MEMORY_EMBED_MODEL'] ?? 'qwen3-embedding-0.6b',
    autoIndex: (process.env['MEMORY_AUTO_INDEX'] ?? 'on') !== 'off',
  };
}
