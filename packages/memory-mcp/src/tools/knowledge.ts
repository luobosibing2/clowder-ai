// memory-mcp: knowledge governance MCP tools

import { z } from 'zod';
import type { EvidenceKind, IMarkerQueue, IMaterializationService, KnowledgeMarkerStatus } from '../core/interfaces.js';
import { EVIDENCE_KINDS, KNOWLEDGE_MARKER_STATUSES } from '../core/interfaces.js';
import type { KnowledgeIndexManager } from '../governance/KnowledgeIndex.js';

const kindEnum = z.enum(EVIDENCE_KINDS);
const statusEnum = z.enum(KNOWLEDGE_MARKER_STATUSES);

export const knowledgeFeedInputSchema = {
  status: statusEnum.optional().describe('Filter candidates by governance status'),
  limit: z.number().int().min(1).max(100).optional().describe('Max markers to return (default 20)'),
};

export const knowledgeCaptureInputSchema = {
  content: z.string().min(1).describe('Candidate knowledge content'),
  title: z.string().optional().describe('Short title for the candidate'),
  kind: kindEnum.optional().describe('Target knowledge kind'),
  source: z.string().optional().describe('Source label, e.g. opencode:session:<id>'),
};

export const knowledgeApproveInputSchema = {
  markerId: z.string().min(1).describe('Marker id to approve'),
  kind: kindEnum.optional().describe('Optional target knowledge kind override'),
};

export const knowledgeRejectInputSchema = {
  markerId: z.string().min(1).describe('Marker id to reject'),
  reason: z.string().optional().describe('Reason for rejection'),
};

export const knowledgeUndoInputSchema = {
  markerId: z.string().min(1).describe('Marker id to move back to needs_review'),
};

export const knowledgeMaterializeInputSchema = {
  markerId: z.string().min(1).describe('Approved marker id to materialize'),
  kind: kindEnum.optional().describe('Optional target knowledge kind override'),
};

export const knowledgeIndexSyncInputSchema = {};

export type KnowledgeFeedInput = {
  status?: KnowledgeMarkerStatus;
  limit?: number;
};

export type KnowledgeCaptureInput = {
  content: string;
  title?: string;
  kind?: EvidenceKind;
  source?: string;
};

export type KnowledgeApproveInput = {
  markerId: string;
  kind?: EvidenceKind;
};

export type KnowledgeRejectInput = {
  markerId: string;
  reason?: string;
};

export type KnowledgeUndoInput = {
  markerId: string;
};

export type KnowledgeMaterializeInput = {
  markerId: string;
  kind?: EvidenceKind;
};

export async function handleKnowledgeFeed(markerQueue: IMarkerQueue, input: KnowledgeFeedInput) {
  try {
    const markers = (await markerQueue.list(input.status ? { status: input.status } : undefined)).slice(
      0,
      input.limit ?? 20,
    );
    if (markers.length === 0) return text(`No knowledge candidates found${input.status ? ` (${input.status})` : ''}.`);
    return text(
      markers
        .map((marker) => {
          const title = marker.title ? ` — ${marker.title}` : '';
          const kind = marker.targetKind ? ` kind=${marker.targetKind}` : '';
          return `[${marker.status}] ${marker.id}${title}${kind}\n  source: ${marker.source}\n  ${marker.content.slice(0, 220).replace(/\n/g, ' ')}`;
        })
        .join('\n\n'),
    );
  } catch (err) {
    return errorResult('knowledge_feed failed', err);
  }
}

export async function handleKnowledgeCapture(markerQueue: IMarkerQueue, input: KnowledgeCaptureInput) {
  try {
    const marker = await markerQueue.submit({
      content: input.content,
      status: 'needs_review',
      source: input.source ?? 'manual',
      ...(input.title ? { title: input.title } : {}),
      ...(input.kind ? { targetKind: input.kind } : {}),
    });
    return text(`Captured candidate ${marker.id} (${marker.status}).`);
  } catch (err) {
    return errorResult('knowledge_capture failed', err);
  }
}

export async function handleKnowledgeApprove(markerQueue: IMarkerQueue, input: KnowledgeApproveInput) {
  try {
    await markerQueue.transition(input.markerId, 'approved', input.kind ? { targetKind: input.kind } : undefined);
    return text(`Approved candidate ${input.markerId}.`);
  } catch (err) {
    return errorResult('knowledge_approve failed', err);
  }
}

export async function handleKnowledgeReject(markerQueue: IMarkerQueue, input: KnowledgeRejectInput) {
  try {
    await markerQueue.transition(input.markerId, 'rejected', input.reason ? { reason: input.reason } : undefined);
    return text(`Rejected candidate ${input.markerId}.`);
  } catch (err) {
    return errorResult('knowledge_reject failed', err);
  }
}

export async function handleKnowledgeUndo(markerQueue: IMarkerQueue, input: KnowledgeUndoInput) {
  try {
    await markerQueue.transition(input.markerId, 'needs_review');
    return text(`Moved candidate ${input.markerId} back to needs_review.`);
  } catch (err) {
    return errorResult('knowledge_undo failed', err);
  }
}

export async function handleKnowledgeMaterialize(service: IMaterializationService, input: KnowledgeMaterializeInput) {
  try {
    const result = await service.materialize(input.markerId, input.kind ? { targetKind: input.kind } : undefined);
    const lines = [
      `Materialized ${result.markerId}.`,
      `  output: ${result.outputPath}`,
      `  anchor: ${result.anchor}`,
      `  reindexed: ${result.reindexed ? 'yes' : 'no'}`,
      `  index synced: ${result.indexSynced ? 'yes' : 'no'}`,
      `  dirty: ${result.dirty ? 'yes' : 'no'}`,
      ...result.warnings.map((warning) => `  warning: ${warning}`),
    ];
    return text(lines.join('\n'));
  } catch (err) {
    return errorResult('knowledge_materialize failed', err);
  }
}

export async function handleKnowledgeIndexSync(index: KnowledgeIndexManager) {
  try {
    const result = await index.generate();
    return text(
      [
        'Knowledge index synchronized.',
        `  entries: ${result.entries.length}`,
        `  pending candidates: ${result.candidate_summary.pending}`,
        `  approved candidates: ${result.candidate_summary.approved}`,
      ].join('\n'),
    );
  } catch (err) {
    return errorResult('knowledge_index_sync failed', err);
  }
}

function text(value: string) {
  return { content: [{ type: 'text' as const, text: value }] };
}

function errorResult(prefix: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: `${prefix}: ${message}` }],
    isError: true,
  };
}
