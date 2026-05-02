// memory-mcp: Core interfaces and types (simplified from F102)

// ── Data types ───────────────────────────────────────────────────────

export const EVIDENCE_KINDS = ['document', 'decision', 'plan', 'lesson', 'research'] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export type EvidenceStatus = 'active' | 'done' | 'archived';

export const KNOWLEDGE_MARKER_STATUSES = [
  'needs_review',
  'approved',
  'rejected',
  'materialized',
  'indexed',
] as const;
export type KnowledgeMarkerStatus = (typeof KNOWLEDGE_MARKER_STATUSES)[number];

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

export interface KnowledgeMarker {
  id: string;
  title?: string;
  content: string;
  source: string;
  status: KnowledgeMarkerStatus;
  targetKind?: EvidenceKind;
  reason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeMarkerFilter {
  status?: KnowledgeMarkerStatus;
  targetKind?: EvidenceKind;
  source?: string;
}

export interface KnowledgeIndexEntry {
  id: string;
  title: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  governanceStatus: 'materialized' | 'indexed';
  sourcePath: string;
  markerId?: string;
  updatedAt: string;
  keywords: string[];
}

export interface KnowledgeIndex {
  version: 1;
  generated_at: string;
  dirty: boolean;
  entries: KnowledgeIndexEntry[];
  candidate_summary: {
    pending: number;
    approved: number;
    rejected: number;
    materialized: number;
    indexed: number;
  };
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

export interface IMarkerQueue {
  submit(marker: Omit<KnowledgeMarker, 'id' | 'createdAt' | 'updatedAt'>): Promise<KnowledgeMarker>;
  list(filter?: KnowledgeMarkerFilter): Promise<KnowledgeMarker[]>;
  transition(id: string, to: KnowledgeMarkerStatus, patch?: Partial<Pick<KnowledgeMarker, 'reason' | 'targetKind'>>): Promise<void>;
}

export interface MaterializeResult {
  markerId: string;
  outputPath: string;
  anchor: string;
  reindexed: boolean;
  indexSynced: boolean;
  dirty: boolean;
  warnings: string[];
}

export interface IMaterializationService {
  canMaterialize(markerId: string): Promise<boolean>;
  materialize(markerId: string, options?: { targetKind?: EvidenceKind }): Promise<MaterializeResult>;
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
