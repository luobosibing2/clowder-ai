// memory-mcp: YAML-backed knowledge candidate queue

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  EvidenceKind,
  IMarkerQueue,
  KnowledgeMarker,
  KnowledgeMarkerFilter,
  KnowledgeMarkerStatus,
} from '../core/interfaces.js';
import { EVIDENCE_KINDS, KNOWLEDGE_MARKER_STATUSES } from '../core/interfaces.js';

const SAFE_ID_RE = /^[a-z0-9-]+$/i;
const VALID_STATUSES = new Set<string>(KNOWLEDGE_MARKER_STATUSES);
const VALID_KINDS = new Set<string>(EVIDENCE_KINDS);

function validateMarkerId(id: string): void {
  if (!SAFE_ID_RE.test(id)) throw new Error(`Invalid marker id: ${id}`);
}

function parseScalar(line: string): [string, string] | null {
  const match = line.match(/^([a-z_]+):\s*(.*)$/i);
  if (!match?.[1]) return null;
  return [match[1], (match[2] ?? '').trim()];
}

function readBlock(lines: string[], start: number): { value: string; next: number } {
  const out: string[] = [];
  let index = start;
  for (; index < lines.length; index++) {
    const line = lines[index] ?? '';
    if (line.startsWith('  ')) {
      out.push(line.slice(2));
      continue;
    }
    if (line.trim() === '') {
      out.push('');
      continue;
    }
    break;
  }
  return { value: out.join('\n').trimEnd(), next: index };
}

export class MarkerQueue implements IMarkerQueue {
  constructor(private readonly markersDir: string) {}

  async submit(input: Omit<KnowledgeMarker, 'id' | 'createdAt' | 'updatedAt'>): Promise<KnowledgeMarker> {
    const now = new Date().toISOString();
    const marker: KnowledgeMarker = {
      id: randomUUID().slice(0, 12),
      content: input.content,
      source: input.source,
      status: input.status,
      createdAt: now,
      updatedAt: now,
      ...(input.title ? { title: input.title } : {}),
      ...(input.targetKind ? { targetKind: input.targetKind } : {}),
      ...(input.reason ? { reason: input.reason } : {}),
    };
    this.validate(marker);
    this.writeYaml(marker);
    return marker;
  }

  async list(filter?: KnowledgeMarkerFilter): Promise<KnowledgeMarker[]> {
    const markers = this.readAll().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    if (!filter) return markers;
    return markers.filter((marker) => {
      if (filter.status && marker.status !== filter.status) return false;
      if (filter.targetKind && marker.targetKind !== filter.targetKind) return false;
      if (filter.source && marker.source !== filter.source) return false;
      return true;
    });
  }

  async transition(
    id: string,
    to: KnowledgeMarkerStatus,
    patch?: Partial<Pick<KnowledgeMarker, 'reason' | 'targetKind'>>,
  ): Promise<void> {
    validateMarkerId(id);
    if (!VALID_STATUSES.has(to)) throw new Error(`Invalid marker status: ${to}`);

    const filePath = join(this.markersDir, `${id}.yaml`);
    if (!existsSync(filePath)) throw new Error(`Marker not found: ${id}`);

    const marker = this.parseYaml(readFileSync(filePath, 'utf-8'));
    if (!marker) throw new Error(`Marker not found: ${id}`);

    marker.id = id;
    marker.status = to;
    marker.updatedAt = new Date().toISOString();
    if (patch?.reason !== undefined) marker.reason = patch.reason;
    if (patch?.targetKind !== undefined) marker.targetKind = patch.targetKind;
    this.validate(marker);
    this.writeYaml(marker);
  }

  private ensureDir(): void {
    if (!existsSync(this.markersDir)) mkdirSync(this.markersDir, { recursive: true });
  }

  private readAll(): KnowledgeMarker[] {
    let files: string[];
    try {
      files = readdirSync(this.markersDir).filter((file) => file.endsWith('.yaml'));
    } catch {
      return [];
    }

    const markers: KnowledgeMarker[] = [];
    for (const file of files) {
      const marker = this.parseYaml(readFileSync(join(this.markersDir, file), 'utf-8'));
      if (marker) markers.push(marker);
    }
    return markers;
  }

  private validate(marker: KnowledgeMarker): void {
    validateMarkerId(marker.id);
    if (!VALID_STATUSES.has(marker.status)) throw new Error(`Invalid marker status: ${marker.status}`);
    if (marker.targetKind && !VALID_KINDS.has(marker.targetKind)) {
      throw new Error(`Invalid marker targetKind: ${marker.targetKind}`);
    }
  }

  private writeYaml(marker: KnowledgeMarker): void {
    this.ensureDir();
    const lines = [
      `id: ${marker.id}`,
      `status: ${marker.status}`,
      `source: ${marker.source}`,
      `created_at: ${marker.createdAt}`,
      `updated_at: ${marker.updatedAt}`,
    ];
    if (marker.title) {
      lines.push('title: |');
      for (const line of marker.title.split('\n')) lines.push(`  ${line}`);
    }
    if (marker.targetKind) lines.push(`target_kind: ${marker.targetKind}`);
    if (marker.reason) {
      lines.push('reason: |');
      for (const line of marker.reason.split('\n')) lines.push(`  ${line}`);
    }
    lines.push('content: |');
    for (const line of marker.content.split('\n')) lines.push(`  ${line}`);

    const outPath = join(this.markersDir, `${marker.id}.yaml`);
    const tempPath = `${outPath}.tmp-${process.pid}`;
    writeFileSync(tempPath, `${lines.join('\n')}\n`, 'utf-8');
    renameSync(tempPath, outPath);
  }

  private parseYaml(text: string): KnowledgeMarker | null {
    const fields: Record<string, string> = {};
    const lines = text.split('\n');

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index] ?? '';
      if (line === 'content: |' || line === 'title: |' || line === 'reason: |') {
        const key = line.slice(0, line.indexOf(':'));
        const block = readBlock(lines, index + 1);
        fields[key] = block.value;
        index = block.next - 1;
        continue;
      }
      const scalar = parseScalar(line);
      if (scalar) fields[scalar[0]] = scalar[1];
    }

    const id = fields.id;
    const status = fields.status;
    const source = fields.source;
    const createdAt = fields.created_at;
    const updatedAt = fields.updated_at ?? createdAt;
    const content = fields.content;
    if (!id || !status || !source || !createdAt || !updatedAt || !content) return null;

    const marker: KnowledgeMarker = {
      id,
      status: status as KnowledgeMarkerStatus,
      source,
      createdAt,
      updatedAt,
      content,
      ...(fields.title ? { title: fields.title } : {}),
      ...(fields.target_kind ? { targetKind: fields.target_kind as EvidenceKind } : {}),
      ...(fields.reason ? { reason: fields.reason } : {}),
    };

    try {
      this.validate(marker);
      return marker;
    } catch {
      return null;
    }
  }
}
