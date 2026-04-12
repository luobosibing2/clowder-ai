# Plan: 提取 F102 Memory System 为独立 MCP Server

## Context

F102 Memory System 是 Clowder AI 的知识检索引擎，基于 SQLite FTS5 + 可选向量搜索（sqlite-vec）实现 BM25/语义/混合三模式检索。当前它深度耦合在 Cat Cafe API 中（MCP 工具通过 HTTP 调 API，API 再调 SQLite）。

**目标**：将核心检索能力提取为一个独立的 MCP Server `packages/memory-mcp`，可被 Claude Code / Cursor 等任意 MCP 客户端使用。用户指定一个文件夹路径，MCP Server 自动索引其中的 `.md` 文件并提供搜索。

**约束**：
- 只提供搜索功能（search + reindex + status），不提供写入/创建文档的 MCP 工具
- 向量搜索保留但有开关（`MEMORY_EMBED_MODE=off|on`，默认 off）
- Python embedding server 不提取，只在 README 中说明如何部署兼容服务
- 零依赖 `@cat-cafe/api` 和 `@cat-cafe/shared`

---

## 包结构

```
packages/memory-mcp/
  package.json
  tsconfig.json
  src/
    index.ts                    # MCP Server 入口 (stdio)
    config.ts                   # 环境变量 → 类型化配置
    factory.ts                  # 组装 store/scanner/indexer
    tools/
      search.ts                 # memory_search 工具
      reindex.ts                # memory_reindex 工具
      status.ts                 # memory_status 工具
    core/
      interfaces.ts             # 精简后的类型定义
      schema.ts                 # 精简后的 DDL (单步迁移)
      SqliteEvidenceStore.ts    # BM25 + semantic + hybrid 搜索引擎
      VectorStore.ts            # vec0 向量存储
      EmbeddingService.ts       # HTTP 客户端 → embedding server
      SemanticReranker.ts       # 余弦相似度重排
    scanner/
      frontmatter.ts            # YAML frontmatter 解析 (从 CatCafeScanner 提取)
      MarkdownScanner.ts        # 递归 .md 扫描器 (从 GenericRepoScanner 演化)
    indexer/
      IndexBuilder.ts           # 精简后的索引构建器
  test/
    sqlite-evidence-store.test.js
    markdown-scanner.test.js
    index-builder.test.js
    integration.test.js
```

---

## MCP 工具定义 (3 个)

### 1. `memory_search`
搜索已索引的 markdown 文档。

```
inputSchema:
  query: string (required) — 搜索查询
  limit: number (1-50, default 10) — 最大结果数
  mode: "lexical" | "semantic" | "hybrid" (default "lexical") — 检索模式
  kind: "document" | "decision" | "plan" | "lesson" | "research" (optional)
  dateFrom: string (optional) — ISO8601 日期下界
  dateTo: string (optional) — ISO8601 日期上界
```

关键：直接调用 `SqliteEvidenceStore.search()`，不走 HTTP。

### 2. `memory_reindex`
从配置文件夹重建搜索索引。

```
inputSchema:
  force: boolean (optional, default false) — 是否强制全量重建
```

### 3. `memory_status`
查看系统状态：文档数、FTS 一致性、向量模式、embedding server 状态。

```
inputSchema: {} (无参数)
```

---

## 配置方式 (环境变量)

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `MEMORY_FOLDER_PATH` | **是** | — | 要索引的 .md 文件夹路径 |
| `MEMORY_DB_PATH` | 否 | `{folder}/.memory/evidence.sqlite` | SQLite 数据库路径 |
| `MEMORY_EMBED_MODE` | 否 | `off` | `off` = 纯 BM25; `on` = 启用向量搜索 |
| `MEMORY_EMBED_URL` | 否 | `http://127.0.0.1:9880` | Embedding server 地址 |
| `MEMORY_EMBED_DIM` | 否 | `768` | 向量维度 |
| `MEMORY_EMBED_MODEL` | 否 | `qwen3-embedding-0.6b` | 模型标识 |
| `MEMORY_AUTO_INDEX` | 否 | `on` | 启动时是否自动索引 |

**Claude Code 配置示例** (纯 BM25):
```json
{
  "mcpServers": {
    "memory": {
      "command": "node",
      "args": ["packages/memory-mcp/dist/index.js"],
      "env": { "MEMORY_FOLDER_PATH": "/path/to/my/docs" }
    }
  }
}
```

---

## 实现步骤

### Phase 1: 基础设施
1. 创建 `packages/memory-mcp/package.json` + `tsconfig.json`
   - 依赖: `@modelcontextprotocol/sdk`, `better-sqlite3`, `zod`
   - 可选依赖: `sqlite-vec`
   - `pnpm install`
2. 创建 `src/config.ts` — 读取环境变量，校验 `MEMORY_FOLDER_PATH`
3. 创建 `src/core/interfaces.ts` — 精简类型
   - **来源**: `packages/api/src/domains/memory/interfaces.ts`
   - **保留**: `EvidenceItem`, `SearchOptions`, `IEvidenceStore`, `IEmbeddingService`, `EmbedConfig`, `Edge`, `RebuildResult`, `ConsistencyReport`, `IIndexBuilder`
   - **删除**: `IMarkerQueue`, `IMaterializationService`, `IReflectionService`, `IKnowledgeResolver`, `Marker*`, `MaterializeResult`, `KnowledgeResult`, `ReflectionContext`, 所有 DI Symbol
   - **简化 `SearchOptions`**: 删除 `scope`, `threadId`, `dimension`, `provenanceTier`
   - **简化 `EvidenceKind`**: `'document' | 'decision' | 'plan' | 'lesson' | 'research'`
4. 创建 `src/core/schema.ts` — 单步迁移
   - **来源**: `packages/api/src/domains/memory/schema.ts`
   - **保留**: evidence_docs, evidence_fts + triggers, embedding_meta, evidence_passages + passage_fts + triggers, edges, schema_version, `ensureVectorTable()`
   - **删除**: V4-V12 的所有表 (summary_segments, summary_state, task_run_ledger, dynamic_task_defs, scheduler 相关, pack_id 列, provenance 列, index_state, generalizable)
   - 合并为单一 `SCHEMA_V1`，`CURRENT_SCHEMA_VERSION = 1`

### Phase 2: 核心存储
5. 创建 `src/core/VectorStore.ts`
   - **策略**: 从 `packages/api/src/domains/memory/VectorStore.ts` **原样复制** (68 行)
6. 创建 `src/core/EmbeddingService.ts`
   - **来源**: `packages/api/src/domains/memory/EmbeddingService.ts`
   - **策略**: 复制 + 改为从 config 对象读取 URL（而非直接读 `process.env`）
7. 创建 `src/core/SemanticReranker.ts`
   - **策略**: 从现有代码**原样复制**
8. 创建 `src/core/SqliteEvidenceStore.ts`
   - **来源**: `packages/api/src/domains/memory/SqliteEvidenceStore.ts`
   - **策略**: 复制 + 大幅精简
   - **保留**: `search()` 的 BM25 + semantic + hybrid 三路径, `upsert()`, `deleteByAnchor()`, `getByAnchor()`, `health()`, `initialize()`, `setEmbedDeps()`, `close()`
   - **删除**: `scope` 过滤逻辑, `threadId` 过滤, `excludePackKnowledge`, `enrichWithDrillDown()`, `deleteByPackId()`
   - 预计从 ~300+ 行精简到 ~150 行
9. 写测试 `test/sqlite-evidence-store.test.js`

### Phase 3: 扫描器 + 索引器
10. 创建 `src/scanner/frontmatter.ts`
    - **来源**: `packages/api/src/domains/memory/CatCafeScanner.ts` 中的 `extractFrontmatter()` + `extractAnchor()` (约 40 行)
11. 创建 `src/scanner/MarkdownScanner.ts`
    - **来源**: `packages/api/src/domains/memory/GenericRepoScanner.ts`
    - **策略**: 复制 + 改 import 路径 + 类名改为 `MarkdownScanner`
    - 保留三层扫描: authoritative → derived → soft_clue
12. 创建 `src/indexer/IndexBuilder.ts`
    - **来源**: `packages/api/src/domains/memory/IndexBuilder.ts`
    - **策略**: 重写 (~150 行)
    - **保留**: `rebuild()` (扫描 → hash 对比 → upsert → 提取 edges → batch embed), `incrementalUpdate()`, `checkConsistency()`, `embedIndexedItems()`
    - **删除**: 所有 thread/session/passage/transcript/summary 相关逻辑, `ThreadListFn`, `MessageListFn`, `markThreadDirty()`, `flushDirtyThreads()`, `discoverSessionDigests()`
13. 写测试 `test/markdown-scanner.test.js` + `test/index-builder.test.js`

### Phase 4: MCP 工具 + 组装
14. 创建 `src/factory.ts`
    - 组装: config → SqliteEvidenceStore → (可选) EmbeddingService + VectorStore → MarkdownScanner → IndexBuilder
    - fail-open: embedding/sqlite-vec 失败不阻塞启动
15. 创建 `src/tools/search.ts` — `memory_search` 工具
    - 直接调用 `store.search()`，格式化结果为 MCP text content
16. 创建 `src/tools/reindex.ts` — `memory_reindex` 工具
17. 创建 `src/tools/status.ts` — `memory_status` 工具
18. 创建 `src/index.ts` — MCP Server 入口
    - 启动时: loadConfig → createMemorySystem → (auto-index if on) → register tools → connect stdio
19. 写测试 `test/integration.test.js`
    - 临时目录 + .md 文件 → 启动完整系统 → 调用 search → 验证结果

### Phase 5: 收尾
20. 在 `pnpm-workspace.yaml` 中确认 `packages/*` 已覆盖
21. `pnpm check` + `pnpm lint` 确保代码质量
22. 用 Claude Code 实际配置 `.mcp.json` 端到端测试
23. 测试 fail-open: 不配置 embedding server 时，纯 BM25 正常工作

---

## 关键复用文件 (源路径)

| 目标文件 | 源文件 | 策略 |
|----------|--------|------|
| `core/SqliteEvidenceStore.ts` | `packages/api/src/domains/memory/SqliteEvidenceStore.ts` | 复制+精简 |
| `core/VectorStore.ts` | `packages/api/src/domains/memory/VectorStore.ts` | 原样复制 |
| `core/EmbeddingService.ts` | `packages/api/src/domains/memory/EmbeddingService.ts` | 复制+微调 |
| `core/SemanticReranker.ts` | `packages/api/src/domains/memory/SemanticReranker.ts` | 原样复制 |
| `core/schema.ts` | `packages/api/src/domains/memory/schema.ts` | 重写 (精简) |
| `core/interfaces.ts` | `packages/api/src/domains/memory/interfaces.ts` | 复制+精简 |
| `scanner/frontmatter.ts` | `packages/api/src/domains/memory/CatCafeScanner.ts:242-275` | 提取2函数 |
| `scanner/MarkdownScanner.ts` | `packages/api/src/domains/memory/GenericRepoScanner.ts` | 复制+改import |
| `indexer/IndexBuilder.ts` | `packages/api/src/domains/memory/IndexBuilder.ts` | 重写 |

---

## 验证方案

1. **单元测试**: `node --test packages/memory-mcp/test/*.test.js`
2. **端到端测试**: 创建临时文件夹含 .md 文件 → 启动 MCP Server → 通过 MCP SDK Client 调用 search → 验证结果
3. **Claude Code 集成测试**: 配置 `.mcp.json` 指向本地 build → 在 Claude Code 中实际调用 `memory_search`
4. **Fail-open 验证**: `MEMORY_EMBED_MODE=on` 但无 embedding server → 确认降级到 lexical 搜索正常
5. **Biome**: `pnpm check` 通过
6. **TypeScript**: `pnpm lint` 通过
