// memory-mcp: Integration test — end-to-end indexing + search
// Uses Node.js built-in test runner (no external deps)

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// We import the built dist (tsc output)
import { SqliteEvidenceStore } from '../dist/core/SqliteEvidenceStore.js';
import { MarkdownScanner } from '../dist/scanner/MarkdownScanner.js';
import { IndexBuilder } from '../dist/indexer/IndexBuilder.js';
import { handleSearch } from '../dist/tools/search.js';

// ── Helpers ──────────────────────────────────────────────────────────

function mkTempDir() {
  const dir = join(tmpdir(), `memory-mcp-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true });
}

function writeDoc(dir, filename, content) {
  writeFileSync(join(dir, filename), content, 'utf-8');
}

async function buildSystem(folderPath) {
  const dbPath = join(folderPath, '.memory', 'evidence.sqlite');
  mkdirSync(join(folderPath, '.memory'), { recursive: true });
  const store = new SqliteEvidenceStore(dbPath);
  await store.initialize();
  const scanner = new MarkdownScanner();
  const indexBuilder = new IndexBuilder(store, folderPath, scanner);
  return { store, indexBuilder };
}

// ── Tests ─────────────────────────────────────────────────────────────

test('indexes markdown files and finds them via search', async () => {
  const dir = mkTempDir();
  try {
    writeDoc(dir, 'README.md', '# My Project\n\nThis is a test project about data processing.');
    writeDoc(
      dir,
      'ARCHITECTURE.md',
      '# Architecture\n\nWe use event-driven microservices with Kafka and PostgreSQL.',
    );
    writeDoc(dir, 'notes.md', '# Notes\n\nSome random notes about meetings and planning.');

    const { store, indexBuilder } = await buildSystem(dir);
    const result = await indexBuilder.rebuild();

    assert.ok(result.docsIndexed >= 2, `Expected at least 2 docs indexed, got ${result.docsIndexed}`);
    assert.equal(result.durationMs >= 0, true);

    // Search for something that should match README
    const results = await store.search('data processing');
    assert.ok(results.length >= 1, 'Should find at least 1 result');
    const titles = results.map((r) => r.title);
    assert.ok(
      titles.some((t) => t.toLowerCase().includes('project') || t.toLowerCase().includes('readme')),
      `Expected README-related result, got: ${titles.join(', ')}`,
    );

    store.close();
  } finally {
    cleanup(dir);
  }
});

test('second rebuild skips unchanged files', async () => {
  const dir = mkTempDir();
  try {
    writeDoc(dir, 'README.md', '# Stable\n\nThis content does not change.');
    const { store, indexBuilder } = await buildSystem(dir);

    const r1 = await indexBuilder.rebuild();
    assert.ok(r1.docsIndexed >= 1);

    // Second rebuild — same content, nothing changes
    const r2 = await indexBuilder.rebuild();
    assert.equal(r2.docsIndexed, 0, 'Should skip all unchanged docs');
    assert.ok(r2.docsSkipped >= 1, 'Should report skipped docs');

    store.close();
  } finally {
    cleanup(dir);
  }
});

test('force rebuild re-indexes all docs', async () => {
  const dir = mkTempDir();
  try {
    writeDoc(dir, 'README.md', '# Force Test\n\nContent here.');
    const { store, indexBuilder } = await buildSystem(dir);

    await indexBuilder.rebuild();
    const r2 = await indexBuilder.rebuild({ force: true });
    assert.ok(r2.docsIndexed >= 1, 'Force rebuild should re-index');

    store.close();
  } finally {
    cleanup(dir);
  }
});

test('search with kind filter returns only matching kind', async () => {
  const dir = mkTempDir();
  try {
    mkdirSync(join(dir, 'decisions'), { recursive: true });
    writeDoc(
      join(dir, 'decisions'),
      'ADR-001.md',
      '---\ndoc_kind: decision\n---\n# Use PostgreSQL\n\nDecision to use PostgreSQL as our database.',
    );
    writeDoc(dir, 'README.md', '# Project\n\nWe considered PostgreSQL among other databases.');

    const { store, indexBuilder } = await buildSystem(dir);
    await indexBuilder.rebuild();

    const allResults = await store.search('PostgreSQL');
    assert.ok(allResults.length >= 1, 'Should find results for PostgreSQL');

    const decisionResults = await store.search('PostgreSQL', { kind: 'decision' });
    for (const r of decisionResults) {
      assert.equal(r.kind, 'decision', `All results should be decisions, got kind=${r.kind}`);
    }

    store.close();
  } finally {
    cleanup(dir);
  }
});

test('handleSearch tool returns formatted text content', async () => {
  const dir = mkTempDir();
  try {
    writeDoc(dir, 'README.md', '# Testing Framework\n\nThis project uses a custom testing framework.');
    const { store, indexBuilder } = await buildSystem(dir);
    await indexBuilder.rebuild();

    const toolResult = await handleSearch(store, { query: 'testing framework' });

    assert.ok(Array.isArray(toolResult.content), 'Should return content array');
    assert.equal(toolResult.content[0].type, 'text', 'Content should be text');
    assert.ok(toolResult.content[0].text.length > 0, 'Text should not be empty');
    assert.ok(!toolResult.isError, 'Should not be an error');

    store.close();
  } finally {
    cleanup(dir);
  }
});

test('search with no results returns no-results message', async () => {
  const dir = mkTempDir();
  try {
    writeDoc(dir, 'README.md', '# Hello\n\nThis is about cats.');
    const { store, indexBuilder } = await buildSystem(dir);
    await indexBuilder.rebuild();

    const toolResult = await handleSearch(store, { query: 'quantum entanglement physics laser' });
    assert.ok(toolResult.content[0].text.includes('No results'), 'Should report no results');

    store.close();
  } finally {
    cleanup(dir);
  }
});

test('consistency check passes after clean rebuild', async () => {
  const dir = mkTempDir();
  try {
    writeDoc(dir, 'README.md', '# Consistency\n\nTesting FTS consistency.');
    writeDoc(dir, 'ARCHITECTURE.md', '# Architecture\n\nSystem design overview.');
    const { store, indexBuilder } = await buildSystem(dir);
    await indexBuilder.rebuild();

    const report = await indexBuilder.checkConsistency();
    assert.equal(report.ok, true, `Consistency check failed: ${report.mismatches.join(', ')}`);
    assert.ok(report.docCount >= 2, `Expected at least 2 docs, got ${report.docCount}`);
    assert.equal(report.docCount, report.ftsCount, 'doc count should match FTS count');

    store.close();
  } finally {
    cleanup(dir);
  }
});
