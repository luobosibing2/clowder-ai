// memory-mcp: committed read model for materialized knowledge

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type {
  EvidenceKind,
  EvidenceStatus,
  IMarkerQueue,
  KnowledgeIndex,
  KnowledgeIndexEntry,
  KnowledgeMarker,
} from '../core/interfaces.js';
import { EVIDENCE_KINDS } from '../core/interfaces.js';
import { extractFrontmatter } from '../scanner/frontmatter.js';

const VALID_KINDS = new Set<string>(EVIDENCE_KINDS);

export interface KnowledgeIndexPaths {
  projectRoot: string;
  docsPath: string;
  indexPath: string;
  dirtyPath: string;
}

export class KnowledgeIndexManager {
  constructor(
    private readonly paths: KnowledgeIndexPaths,
    private readonly markerQueue: IMarkerQueue,
  ) {}

  async generate(): Promise<KnowledgeIndex> {
    const markers = await this.markerQueue.list();
    const index: KnowledgeIndex = {
      version: 1,
      generated_at: new Date().toISOString(),
      dirty: false,
      entries: this.readEntries(markers),
      candidate_summary: this.summarizeCandidates(markers),
    };

    mkdirSync(dirname(this.paths.indexPath), { recursive: true });
    const tempPath = `${this.paths.indexPath}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${JSON.stringify(index, null, 2)}\n`, 'utf-8');
    renameSync(tempPath, this.paths.indexPath);
    this.clearDirty();
    return index;
  }

  async read(): Promise<KnowledgeIndex | null> {
    if (!existsSync(this.paths.indexPath)) return null;
    try {
      const index = JSON.parse(readFileSync(this.paths.indexPath, 'utf-8')) as KnowledgeIndex;
      return { ...index, dirty: this.isDirty() };
    } catch {
      return null;
    }
  }

  markDirty(reason: string): void {
    mkdirSync(dirname(this.paths.dirtyPath), { recursive: true });
    writeFileSync(this.paths.dirtyPath, `${new Date().toISOString()} ${reason}\n`, 'utf-8');
  }

  isDirty(): boolean {
    return existsSync(this.paths.dirtyPath);
  }

  private clearDirty(): void {
    if (existsSync(this.paths.dirtyPath)) rmSync(this.paths.dirtyPath, { force: true });
  }

  private readEntries(markers: KnowledgeMarker[]): KnowledgeIndexEntry[] {
    const markerById = new Map<string, KnowledgeMarker>(markers.map((marker) => [marker.id, marker] as const));
    return this.listMarkdownFiles(this.paths.docsPath)
      .map((filePath) => this.entryFromMarkdown(filePath, markerById))
      .filter((entry): entry is KnowledgeIndexEntry => Boolean(entry))
      .sort((a, b) => a.sourcePath.localeCompare(b.sourcePath));
  }

  private entryFromMarkdown(filePath: string, markerById: Map<string, KnowledgeMarker>): KnowledgeIndexEntry | null {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const fm = extractFrontmatter(content) ?? {};
    const sourcePath = relative(this.paths.projectRoot, filePath).replace(/\\/g, '/');
    const markerId = typeof fm.materialized_from === 'string' ? fm.materialized_from : undefined;
    const marker = markerId ? markerById.get(markerId) : undefined;
    const rawKind = typeof fm.doc_kind === 'string' && VALID_KINDS.has(fm.doc_kind) ? fm.doc_kind : 'document';
    const title =
      (typeof fm.title === 'string' && fm.title.trim()) ||
      content.match(/^#\s+(.+)$/m)?.[1]?.trim() ||
      sourcePath;
    const rawStatus = typeof fm.status === 'string' ? fm.status : 'active';
    const status = rawStatus === 'done' || rawStatus === 'archived' ? rawStatus : 'active';
    const updatedAt =
      (typeof fm.updated_at === 'string' && fm.updated_at) ||
      (typeof fm.created === 'string' && fm.created) ||
      new Date().toISOString();
    const keywords = Array.isArray(fm.keywords)
      ? fm.keywords.filter((item): item is string => typeof item === 'string')
      : Array.isArray(fm.topics)
        ? fm.topics.filter((item): item is string => typeof item === 'string')
        : [];
    const governanceStatus = marker?.status === 'indexed' ? 'indexed' : 'materialized';

    return {
      id: typeof fm.anchor === 'string' ? fm.anchor : sourcePath.replace(/\.md$/i, ''),
      title,
      kind: rawKind as EvidenceKind,
      status: status as EvidenceStatus,
      governanceStatus,
      sourcePath,
      ...(markerId ? { markerId } : {}),
      updatedAt,
      keywords,
    };
  }

  private listMarkdownFiles(root: string): string[] {
    const out: string[] = [];
    const visit = (dir: string, depth: number) => {
      if (depth > 6) return;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = join(dir, entry);
        let children: string[];
        try {
          children = readdirSync(full);
          visit(full, depth + 1);
          void children;
        } catch {
          if (entry.endsWith('.md')) out.push(full);
        }
      }
    };
    visit(root, 0);
    return out;
  }

  private summarizeCandidates(markers: KnowledgeMarker[]): KnowledgeIndex['candidate_summary'] {
    return {
      pending: markers.filter((marker) => marker.status === 'needs_review').length,
      approved: markers.filter((marker) => marker.status === 'approved').length,
      rejected: markers.filter((marker) => marker.status === 'rejected').length,
      materialized: markers.filter((marker) => marker.status === 'materialized').length,
      indexed: markers.filter((marker) => marker.status === 'indexed').length,
    };
  }
}
