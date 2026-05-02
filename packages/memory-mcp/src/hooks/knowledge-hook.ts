#!/usr/bin/env node

// memory-mcp: shared lifecycle hook runner for Codex/opencode-style hooks

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { MarkerQueue } from '../governance/MarkerQueue.js';

const CANDIDATE_RE = /<knowledge_candidate>\s*([\s\S]*?)\s*<\/knowledge_candidate>/g;

interface HookPayload {
  cwd?: string;
  session_id?: string;
  sessionId?: string;
  turn_id?: string;
  turnId?: string;
  hook_event_name?: string;
  hookEventName?: string;
  last_assistant_message?: string;
  lastAssistantMessage?: string;
  transcript_path?: string;
  transcriptPath?: string;
}

async function main(): Promise<number> {
  const payload = readPayload();
  const projectRoot = payload.cwd ?? process.env.KNOWLEDGE_PROJECT_ROOT ?? process.cwd();
  const knowledgeRoot = process.env.KNOWLEDGE_ROOT ?? join(projectRoot, '.knowledge');
  ensureKnowledgeGitignore(knowledgeRoot);

  const eventName = inferEventName(payload);
  appendLedger(knowledgeRoot, payload, eventName);

  if (isSessionStart(eventName)) {
    printContinue(buildContextMessage(knowledgeRoot));
    return 0;
  }

  if (isStop(eventName)) {
    const captured = await captureExplicitCandidates(projectRoot, knowledgeRoot, payload);
    if (captured.length > 0) {
      printContinue(`Knowledge hook captured ${captured.length} candidate(s): ${captured.join(', ')}`);
      return 0;
    }
  }

  printContinue();
  return 0;
}

function readPayload(): HookPayload {
  const raw = readFileSync(0, 'utf-8');
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw) as HookPayload;
  } catch {
    return {};
  }
}

function inferEventName(payload: HookPayload): string {
  return (
    payload.hook_event_name ??
    payload.hookEventName ??
    process.env.KNOWLEDGE_HOOK_EVENT ??
    (payload.last_assistant_message || payload.lastAssistantMessage ? 'Stop' : 'SessionStart')
  );
}

function isSessionStart(eventName: string): boolean {
  return /sessionstart|session_start|start/i.test(eventName);
}

function isStop(eventName: string): boolean {
  return /^stop$/i.test(eventName) || /sessionstop|session_stop/i.test(eventName);
}

function appendLedger(knowledgeRoot: string, payload: HookPayload, eventName: string): void {
  const hooksDir = join(knowledgeRoot, 'hooks');
  mkdirSync(hooksDir, { recursive: true });
  const sessionId = payload.session_id ?? payload.sessionId ?? 'unknown-session';
  const safeSessionId = sessionId.replace(/[^a-zA-Z0-9._-]+/g, '-');
  const record = {
    ts: new Date().toISOString(),
    event: eventName,
    session_id: sessionId,
    turn_id: payload.turn_id ?? payload.turnId ?? null,
    transcript_path: payload.transcript_path ?? payload.transcriptPath ?? null,
  };
  appendFileSync(join(hooksDir, `${safeSessionId}.jsonl`), `${JSON.stringify(record)}\n`, 'utf-8');
}

function buildContextMessage(knowledgeRoot: string): string | undefined {
  const indexPath = join(knowledgeRoot, 'index.json');
  if (!existsSync(indexPath)) return undefined;
  try {
    const index = JSON.parse(readFileSync(indexPath, 'utf-8')) as {
      dirty?: boolean;
      entries?: Array<{ title?: string; kind?: string; sourcePath?: string; source_path?: string }>;
      candidate_summary?: { pending?: number };
    };
    const entries = Array.isArray(index.entries) ? index.entries.slice(0, 8) : [];
    const lines = ['Knowledge index summary:'];
    lines.push(`- entries: ${index.entries?.length ?? 0}`);
    if (index.candidate_summary?.pending) lines.push(`- pending candidates: ${index.candidate_summary.pending}`);
    if (index.dirty) lines.push('- index status: dirty; run knowledge_index_sync');
    for (const entry of entries) {
      const source = entry.sourcePath ?? entry.source_path ?? '(unknown source)';
      lines.push(`- [${entry.kind ?? 'document'}] ${entry.title ?? source} (${source})`);
    }
    lines.push('Use memory_search for details; do not treat pending candidates as settled knowledge.');
    return lines.join('\n');
  } catch {
    return undefined;
  }
}

async function captureExplicitCandidates(
  projectRoot: string,
  knowledgeRoot: string,
  payload: HookPayload,
): Promise<string[]> {
  const message = payload.last_assistant_message ?? payload.lastAssistantMessage ?? '';
  const captured: string[] = [];
  const markersPath = process.env.KNOWLEDGE_MARKERS_PATH ?? join(knowledgeRoot, 'markers');
  const queue = new MarkerQueue(markersPath);

  for (const match of message.matchAll(CANDIDATE_RE)) {
    const raw = match[1]?.trim();
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as {
        title?: string;
        content?: string;
        kind?: 'document' | 'decision' | 'plan' | 'lesson' | 'research';
        source?: string;
      };
      if (!parsed.content) continue;
      const marker = await queue.submit({
        content: parsed.content,
        status: 'needs_review',
        source: parsed.source ?? `hook:${payload.session_id ?? payload.sessionId ?? projectRoot}`,
        ...(parsed.title ? { title: parsed.title } : {}),
        ...(parsed.kind ? { targetKind: parsed.kind } : {}),
      });
      captured.push(marker.id);
    } catch {
      continue;
    }
  }

  return captured;
}

function ensureKnowledgeGitignore(knowledgeRoot: string): void {
  mkdirSync(knowledgeRoot, { recursive: true });
  const gitignorePath = join(knowledgeRoot, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, ['*', '!index.json', '!.gitignore', ''].join('\n'), 'utf-8');
  }
}

function printContinue(systemMessage?: string): void {
  const payload = systemMessage ? { continue: true, systemMessage } : { continue: true };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    const message = err instanceof Error ? err.message : String(err);
    printContinue(`Knowledge hook skipped: ${message}`);
    process.exitCode = 0;
  },
);
