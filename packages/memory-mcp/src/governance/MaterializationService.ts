// memory-mcp: approved marker -> docs/knowledge markdown -> reindex -> manifest sync

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EvidenceKind,
  IIndexBuilder,
  IMarkerQueue,
  IMaterializationService,
  MaterializeResult,
} from '../core/interfaces.js';
import { EVIDENCE_KINDS } from '../core/interfaces.js';
import type { KnowledgeIndexManager } from './KnowledgeIndex.js';

const VALID_KINDS = new Set<string>(EVIDENCE_KINDS);

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug || 'knowledge';
}

function inferTitle(content: string, fallback: string): string {
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return heading;
  const firstLine = content
    .split('\n')
    .map((line) => line.trim())
    .find(Boolean);
  return firstLine ? firstLine.slice(0, 120) : fallback;
}

export class MaterializationService implements IMaterializationService {
  constructor(
    private readonly markerQueue: IMarkerQueue,
    private readonly docsPath: string,
    private readonly indexBuilder: Pick<IIndexBuilder, 'incrementalUpdate'> | undefined,
    private readonly knowledgeIndex: KnowledgeIndexManager,
  ) {}

  async canMaterialize(markerId: string): Promise<boolean> {
    const markers = await this.markerQueue.list();
    return markers.some((marker) => marker.id === markerId && marker.status === 'approved');
  }

  async materialize(markerId: string, options?: { targetKind?: EvidenceKind }): Promise<MaterializeResult> {
    const markers = await this.markerQueue.list();
    const marker = markers.find((item) => item.id === markerId);
    if (!marker) throw new Error(`Marker not found: ${markerId}`);
    if (marker.status !== 'approved') throw new Error(`Marker ${markerId} is not approved (status: ${marker.status})`);

    const kind = options?.targetKind ?? marker.targetKind ?? 'lesson';
    if (!VALID_KINDS.has(kind)) throw new Error(`Invalid targetKind: ${kind}`);

    mkdirSync(this.docsPath, { recursive: true });
    const title = marker.title ?? inferTitle(marker.content, `${kind} ${marker.id}`);
    const anchor = `${kind}:${marker.id}`;
    const baseName = `${kind}-${slugify(title)}-${marker.id}`;
    let outputPath = join(this.docsPath, `${baseName}.md`);
    if (existsSync(outputPath)) {
      let suffix = 2;
      while (existsSync(join(this.docsPath, `${baseName}-${suffix}.md`))) suffix++;
      outputPath = join(this.docsPath, `${baseName}-${suffix}.md`);
    }

    const today = new Date().toISOString().slice(0, 10);
    const markdown = [
      '---',
      `anchor: ${anchor}`,
      `title: ${title.replace(/\n/g, ' ')}`,
      `doc_kind: ${kind}`,
      'status: active',
      'governance_status: materialized',
      `materialized_from: ${marker.id}`,
      `created: ${today}`,
      '---',
      '',
      `# ${title}`,
      '',
      marker.content,
      '',
    ].join('\n');
    writeFileSync(outputPath, markdown, 'utf-8');

    await this.markerQueue.transition(marker.id, 'materialized', { targetKind: kind });

    const warnings: string[] = [];
    let reindexed = false;
    if (this.indexBuilder) {
      try {
        await this.indexBuilder.incrementalUpdate([outputPath]);
        reindexed = true;
        await this.markerQueue.transition(marker.id, 'indexed', { targetKind: kind });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        warnings.push(`reindex failed: ${message}`);
      }
    }

    let indexSynced = false;
    try {
      await this.knowledgeIndex.generate();
      indexSynced = true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      warnings.push(`index sync failed: ${message}`);
      this.knowledgeIndex.markDirty(message);
    }

    return {
      markerId: marker.id,
      outputPath,
      anchor,
      reindexed,
      indexSynced,
      dirty: this.knowledgeIndex.isDirty(),
      warnings,
    };
  }
}
