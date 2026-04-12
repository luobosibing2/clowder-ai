// memory-mcp: MarkdownScanner — recursive .md scanner with three-tier provenance
// Evolved from GenericRepoScanner (F152 Phase A)

import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { EvidenceKind, ProvenanceTier, RepoScanner, ScannedEvidence } from '../core/interfaces.js';
import { extractAnchor, extractFrontmatter } from './frontmatter.js';

/** Directories to always skip */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '__pycache__',
  '.tox',
  'target',
  'vendor',
  '.claude',
  '.memory',
]);

/** Authoritative top-level file name patterns (case-insensitive) */
const AUTHORITATIVE_PATTERNS: RegExp[] = [/^readme/i, /^architecture/i, /^contributing/i, /^adr[-_]?\d/i];

/** Manifest files → derived tier */
const DERIVED_MANIFESTS = new Set([
  'package.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'pubspec.yaml',
  'pnpm-workspace.yaml',
  'lerna.json',
  'rush.json',
]);

/** Soft-clue top-level file name patterns */
const SOFT_CLUE_PATTERNS: RegExp[] = [/^changelog/i, /^history/i, /^release/i];

export interface MarkdownScanOptions {
  skipSoftClues?: boolean;
}

/**
 * Scans a folder recursively for .md files and manifest files,
 * assigning provenance tiers (authoritative → derived → soft_clue).
 */
export class MarkdownScanner implements RepoScanner {
  discover(projectRoot: string, options?: MarkdownScanOptions): ScannedEvidence[] {
    const results: ScannedEvidence[] = [];
    const seen = new Set<string>();

    // Layer 1: Authoritative — README, docs/**, ARCHITECTURE, CONTRIBUTING, ADRs
    this.scanAuthoritativeTopLevel(projectRoot, results, seen);
    this.scanDirRecursive(join(projectRoot, 'docs'), projectRoot, 'authoritative', 'plan', results, seen, 0);

    // Layer 2: Derived — package manifests
    this.scanDerivedManifests(projectRoot, results, seen);

    // Layer 3: Soft clues — CHANGELOG, .github/ISSUE_TEMPLATE/
    if (!options?.skipSoftClues) {
      this.scanSoftClues(projectRoot, results, seen);
    }

    // Layer 4: Remaining .md files in root (not already picked up)
    this.scanDirRecursive(projectRoot, projectRoot, 'authoritative', 'document', results, seen, 0);

    return results;
  }

  /** Parse a single file — used by IndexBuilder.incrementalUpdate() */
  parseSingle(filePath: string, projectRoot: string): ScannedEvidence | null {
    const rel = relative(projectRoot, filePath);
    const basename = rel.split('/').pop() ?? '';

    if (DERIVED_MANIFESTS.has(basename)) {
      try {
        const content = readFileSync(filePath, 'utf-8');
        const nameNoExt = basename.replace(/\.[^.]+$/, '');
        const parsed = this.parseManifest(basename, content);
        return {
          item: {
            anchor: `doc:${nameNoExt}`,
            kind: 'research',
            status: 'active',
            title: parsed.title,
            sourcePath: rel,
            updatedAt: new Date().toISOString(),
            ...(parsed.summary ? { summary: parsed.summary } : {}),
          },
          provenance: { tier: 'derived', source: rel },
          rawContent: content,
        };
      } catch {
        return null;
      }
    }

    const isUnderDocs = rel.startsWith('docs/') || rel.startsWith('docs\\');
    const isTopLevel = !rel.includes('/') && !rel.includes('\\');
    const nameNoExt = basename.replace(/\.md$/, '');
    const isAuthoritative = isUnderDocs || (isTopLevel && AUTHORITATIVE_PATTERNS.some((p) => p.test(nameNoExt)));
    const isSoftClue =
      rel.startsWith('.github/ISSUE_TEMPLATE/') || (isTopLevel && SOFT_CLUE_PATTERNS.some((p) => p.test(nameNoExt)));

    const tier: ProvenanceTier = isSoftClue ? 'soft_clue' : isAuthoritative ? 'authoritative' : 'authoritative';
    const defaultKind: EvidenceKind = isSoftClue ? 'lesson' : 'document';

    return this.parseMarkdown(filePath, projectRoot, tier, defaultKind);
  }

  private scanAuthoritativeTopLevel(root: string, results: ScannedEvidence[], seen: Set<string>): void {
    try {
      for (const entry of readdirSync(root)) {
        if (!entry.endsWith('.md')) continue;
        if (!AUTHORITATIVE_PATTERNS.some((p) => p.test(entry.replace(/\.md$/, '')))) continue;
        const fullPath = join(root, entry);
        if (seen.has(fullPath)) continue;
        const evidence = this.parseMarkdown(fullPath, root, 'authoritative');
        if (evidence) {
          results.push(evidence);
          seen.add(fullPath);
        }
      }
    } catch {
      // root dir doesn't exist or unreadable
    }
  }

  private scanDerivedManifests(root: string, results: ScannedEvidence[], seen: Set<string>): void {
    try {
      for (const entry of readdirSync(root)) {
        if (!DERIVED_MANIFESTS.has(entry)) continue;
        const fullPath = join(root, entry);
        if (seen.has(fullPath)) continue;
        try {
          const content = readFileSync(fullPath, 'utf-8');
          const sourcePath = relative(root, fullPath);
          const parsed = this.parseManifest(entry, content);
          results.push({
            item: {
              anchor: `doc:${sourcePath.replace(/\.[^.]+$/, '')}`,
              kind: 'research',
              status: 'active',
              title: parsed.title,
              summary: parsed.summary,
              sourcePath,
              updatedAt: new Date().toISOString(),
            },
            provenance: { tier: 'derived', source: sourcePath },
            rawContent: content,
          });
          seen.add(fullPath);
        } catch {
          // unreadable
        }
      }
    } catch {
      // root dir doesn't exist
    }
  }

  private scanSoftClues(root: string, results: ScannedEvidence[], seen: Set<string>): void {
    try {
      for (const entry of readdirSync(root)) {
        if (!entry.endsWith('.md')) continue;
        if (!SOFT_CLUE_PATTERNS.some((p) => p.test(entry.replace(/\.md$/, '')))) continue;
        const fullPath = join(root, entry);
        if (seen.has(fullPath)) continue;
        const evidence = this.parseMarkdown(fullPath, root, 'soft_clue', 'lesson');
        if (evidence) {
          results.push(evidence);
          seen.add(fullPath);
        }
      }
    } catch {
      // skip
    }
    this.scanDirRecursive(join(root, '.github', 'ISSUE_TEMPLATE'), root, 'soft_clue', 'lesson', results, seen, 0);
  }

  private scanDirRecursive(
    dirPath: string,
    root: string,
    tier: ProvenanceTier,
    defaultKind: EvidenceKind,
    results: ScannedEvidence[],
    seen: Set<string>,
    depth: number,
  ): void {
    if (depth > 10) return;
    try {
      for (const entry of readdirSync(dirPath)) {
        if (SKIP_DIRS.has(entry)) continue;
        const fullPath = join(dirPath, entry);
        try {
          const lst = lstatSync(fullPath);
          if (lst.isSymbolicLink()) continue;
          if (lst.isFile() && entry.endsWith('.md') && !seen.has(fullPath)) {
            const evidence = this.parseMarkdown(fullPath, root, tier, defaultKind);
            if (evidence) {
              results.push(evidence);
              seen.add(fullPath);
            }
          } else if (lst.isDirectory()) {
            this.scanDirRecursive(fullPath, root, tier, defaultKind, results, seen, depth + 1);
          }
        } catch {
          // skip inaccessible
        }
      }
    } catch {
      // dir doesn't exist
    }
  }

  private parseMarkdown(
    filePath: string,
    root: string,
    tier: ProvenanceTier,
    defaultKind: EvidenceKind = 'document',
  ): ScannedEvidence | null {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      return null;
    }

    const sourcePath = relative(root, filePath);
    const fm = extractFrontmatter(content);
    const anchor = (fm ? extractAnchor(fm) : null) ?? `doc:${sourcePath.replace(/\.md$/, '')}`;

    const titleMatch = content.match(/^#\s+(.+)$/m);
    const title = titleMatch?.[1]?.trim() ?? sourcePath;

    const afterFm = content.replace(/^---[\s\S]*?---\s*/, '');
    const afterTitle = afterFm.replace(/^#.*$/m, '');
    const paragraphs = afterTitle.split(/\n\n+/).filter((p) => {
      const t = p.trim();
      return t && !t.startsWith('#') && !t.startsWith('>') && !t.startsWith('|') && !t.startsWith('```');
    });
    const summary = paragraphs[0]?.trim().replace(/\n/g, ' ').slice(0, 300) || undefined;

    // Infer kind from frontmatter or path
    let kind: EvidenceKind = defaultKind;
    if (fm) {
      const docKind = fm['doc_kind'] as string | undefined;
      if (docKind === 'decision' || filePath.includes('/decisions/')) kind = 'decision';
      else if (docKind === 'plan' || filePath.includes('/plans/') || filePath.includes('/phases/')) kind = 'plan';
      else if (docKind === 'lesson' || filePath.includes('/lessons/')) kind = 'lesson';
      else if (docKind === 'research' || filePath.includes('/research/')) kind = 'research';
    }

    const topics = fm?.['topics'];

    return {
      item: {
        anchor,
        kind,
        status: 'active',
        title,
        sourcePath,
        updatedAt: new Date().toISOString(),
        ...(summary ? { summary } : {}),
        ...(Array.isArray(topics) ? { keywords: topics as string[] } : {}),
      },
      provenance: { tier, source: sourcePath },
      rawContent: content,
    };
  }

  private parseManifest(filename: string, content: string): { title: string; summary: string } {
    if (filename === 'package.json') {
      try {
        const pkg = JSON.parse(content);
        return {
          title: `${pkg.name ?? 'package'} v${pkg.version ?? '?'}`,
          summary: [
            pkg.description,
            pkg.dependencies ? `Dependencies: ${Object.keys(pkg.dependencies).join(', ')}` : null,
          ]
            .filter(Boolean)
            .join('. '),
        };
      } catch {
        return { title: 'package.json', summary: content.slice(0, 300) };
      }
    }
    const lines = content.split('\n').slice(0, 10).join(' ').trim();
    return {
      title: `Manifest: ${filename}`,
      summary: lines.length > 300 ? `${lines.slice(0, 297)}...` : lines,
    };
  }
}
