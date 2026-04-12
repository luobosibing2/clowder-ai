// memory-mcp: Core interfaces and types (simplified from F102)

// ── Data types ───────────────────────────────────────────────────────

export const EVIDENCE_KINDS = ['document', 'decision', 'plan', 'lesson', 'research'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type EvidenceStatus = 'active' | 'done' | 'archived';

export type ProvenanceTier = 'authoritative' | 'derived' | 'soft_clue';

export interface Provenance {
  tier: ProvenanceTier;
  source: string;
}

export interface EvidenceItem {
  anchor: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  title: string;
  summary?: string;
  keywords?: string[];
  sourcePath?: string;
  sourceHash?: string;
  supersededBy?: string;
  updatedAt: string;
  provenance?: Provenance;
  /** Passage-level detail when depth=raw */
  passages?: Array<{
    passageId: string;
    content: string;
    speaker?: string;
    createdAt?: string;
    context?: Array<{
      passageId: string;
      content: string;
      speaker?: string;
      createdAt?: string;
    }>;
  }>;
}

export interface Edge {
  fromAnchor: string;
  toAnchor: string;
  relation: 'evolved_from' | 'blocked_by' | 'related' | 'supersedes' | 'invalidates';
}

export interface SearchOptions {
  kind?: EvidenceKind;
  status?: EvidenceStatus;
  keywords?: string[];
  limit?: number;
  /** Retrieval mode */
  mode?: 'lexical' | 'semantic' | 'hybrid';
  /** Result depth */
  depth?: 'summary' | 'raw';
  /** ISO8601 date lower bound (inclusive) */
  dateFrom?: string;
  /** ISO8601 date upper bound (inclusive) */
  dateTo?: string;
  /** Number of surrounding passages to include per match (depth=raw only) */
  contextWindow?: number;
}

// ── Result types ─────────────────────────────────────────────────────

export interface RebuildResult {
  docsIndexed: number;
  docsSkipped: number;
  durationMs: number;
}

export interface ConsistencyReport {
  ok: boolean;
  docCount: number;
  ftsCount: number;
  mismatches: string[];
}

// ── Interfaces ───────────────────────────────────────────────────────

export interface IEvidenceStore {
  search(query: string, options?: SearchOptions): Promise<EvidenceItem[]>;
  upsert(items: EvidenceItem[]): Promise<void>;
  deleteByAnchor(anchor: string): Promise<void>;
  getByAnchor(anchor: string): Promise<EvidenceItem | null>;
  health(): Promise<boolean>;
  initialize(): Promise<void>;
}

export interface IIndexBuilder {
  rebuild(options?: { force?: boolean }): Promise<RebuildResult>;
  incrementalUpdate(changedPaths: string[]): Promise<void>;
  checkConsistency(): Promise<ConsistencyReport>;
}

// ── Embedding / Vector types ──────────────────────────────────────────

export interface EmbedConfig {
  embedMode: 'off' | 'on';
  embedUrl: string;
  embedModel: string;
  embedDim: number;
  embedTimeoutMs: number;
}

export interface EmbedModelInfo {
  modelId: string;
  modelRev: string;
  dim: number;
}

export interface IEmbeddingService {
  load(): Promise<void>;
  embed(texts: string[]): Promise<Float32Array[]>;
  isReady(): boolean;
  getModelInfo(): EmbedModelInfo;
  dispose(): void;
}

// ── Scanner types ─────────────────────────────────────────────────────

export interface ScannedEvidence {
  item: Omit<EvidenceItem, 'sourceHash'>;
  provenance: Provenance;
  rawContent: string;
}

export interface RepoScanner {
  discover(projectRoot: string, options?: Record<string, unknown>): ScannedEvidence[];
}
