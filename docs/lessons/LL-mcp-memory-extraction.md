---
feature_ids: [F102]
topics: [memory, mcp, sqlite, vector-search, extraction]
doc_kind: lesson
created: 2026-04-12
---

# Lesson: F102 Memory System Extraction — Standalone MCP Server

## 背景

F102 Memory System 原本深度耦合在 Cat Cafe API 中（MCP 工具通过 HTTP 调 API，API 再调 SQLite）。目标是提取核心检索能力为独立 MCP Server，可被任意 MCP 客户端（Claude Code / Cursor）使用，用户指定文件夹路径即可索引和搜索。

---

## 实现内容

### 新包结构

```
packages/memory-mcp/
  src/
    index.ts              ← MCP Server 入口 (stdio)
    config.ts             ← 环境变量 → 类型化配置
    factory.ts            ← 组装 store/scanner/indexer
    tools/
      search.ts           ← memory_search 工具
      reindex.ts          ← memory_reindex 工具
      status.ts           ← memory_status 工具
    core/
      interfaces.ts       ← 精简类型 (无 Cat-Cafe 特有类型)
      schema.ts           ← 单步 SQLite 迁移
      SqliteEvidenceStore.ts  ← BM25 + semantic + hybrid 搜索引擎
      VectorStore.ts      ← vec0 向量存储 (sqlite-vec)
      EmbeddingService.ts ← HTTP client → embedding server
      SemanticReranker.ts ← 余弦相似度重排
    scanner/
      frontmatter.ts      ← YAML frontmatter 解析
      MarkdownScanner.ts  ← 递归 .md 扫描器
    indexer/
      IndexBuilder.ts     ← 增量索引构建
```

### MCP 工具 (3 个)

| 工具 | 功能 |
|------|------|
| `memory_search` | 搜索已索引的 markdown 文档，支持 lexical/semantic/hybrid 三种模式 |
| `memory_reindex` | 从配置文件夹重建搜索索引 |
| `memory_status` | 查看系统状态：文档数、FTS 一致性、向量模式、embedding server 状态 |

### 配置 (环境变量)

| 变量 | 必填 | 默认值 | 说明 |
|------|------|--------|------|
| `MEMORY_FOLDER_PATH` | **是** | — | 要索引的 .md 文件夹路径 |
| `MEMORY_DB_PATH` | 否 | `{folder}/.memory/evidence.sqlite` | SQLite 数据库路径 |
| `MEMORY_EMBED_MODE` | 否 | `off` | `off` = 纯 BM25; `on` = 启用向量搜索 |
| `MEMORY_EMBED_URL` | 否 | `http://127.0.0.1:9880` | Embedding server 地址 |
| `MEMORY_EMBED_DIM` | 否 | `768` | 向量维度 |
| `MEMORY_EMBED_MODEL` | 否 | `qwen3-embedding-0.6b` | 模型标识 |
| `MEMORY_AUTO_INDEX` | 否 | `on` | 启动时是否自动索引 |

### 核心改动点

**架构差异**：原来 `cat_cafe_search_evidence` 是 HTTP 客户端调 API；现在 `memory_search` 直接持有 SQLite 连接，进程内调用。

**精简内容**（从 F102 删除）：
- MarkerQueue, MaterializationService, ReflectionService
- KnowledgeResolver, GlobalIndexBuilder
- SummaryCompactionTask, summary 表
- CatCafeScanner (13 KIND_DIRS)
- Thread/session/message 索引逻辑
- 所有 Cat-Cafe 特有的 scope/threadId/packId 过滤

---

## 遇到的坑

### 1. LM Studio embedding server 没有 `/health` endpoint

原 `EmbeddingService.load()` 只 probe `/health`，这在 cat-cafe 的 `embed-api.py` 上能用，但 LM Studio / llama.cpp 等兼容服务没有这个端点。

**修复**：增加 fallback 探测逻辑 —— `/health` 失败后尝试发一条真实 embed 请求验证服务存活。

```typescript
// 先试 /health，失败则 probe embed
try {
  const healthRes = await fetch(`${this.baseUrl}/health`, ...);
  // ...
} catch {
  // fallback: probe embed
  const probeRes = await fetch(`${this.baseUrl}/v1/embeddings`, {
    body: JSON.stringify({ model: this.config.embedModel, input: ['ping'] }),
  });
}
```

### 2. OpenAI-compatible embedding API 需要 `model` 字段

原代码 `embed()` 只传 `input`，LM Studio 要求同时传 `model`。

**修复**：每次请求带上 `model` 字段。

```typescript
body: JSON.stringify({ model: this.config.embedModel, input: texts }),
```

### 3. Biome 格式问题

新建文件有 import 排序和行宽问题，需要 `biome check --write` 修复。

### 4. MCP 工具在 Claude Code 重连后断开

Claude Code 重启或 `/reload-plugins` 后 MCP 工具可能消失，需要重新确认 MCP server 连接状态。

---

## 与 Plan 的对应情况

**Plan 文件**：`AI-Plans/tingly-painting-toast.md`

| Phase | 内容 | 状态 |
|-------|------|------|
| Phase 1 | 包基础设施 (package.json, tsconfig, config.ts, interfaces.ts, schema.ts) | ✅ 完成 |
| Phase 2 | 核心存储层 (SqliteEvidenceStore, VectorStore, EmbeddingService, SemanticReranker) | ✅ 完成 |
| Phase 3 | 扫描器 + 索引器 (frontmatter, MarkdownScanner, IndexBuilder) | ✅ 完成 |
| Phase 4 | MCP 工具 + 入口 (factory, tools, index.ts) | ✅ 完成 |
| Phase 5 | 测试 + 构建验证 | ✅ 完成 (7/7 tests pass) |

**无偏离**：所有步骤按 plan 执行，没有遗漏或新增内容。

---

## 验证结果

- `tsc --noEmit` — 零错误
- `tsc` — 构建成功
- `node --test test/integration.test.js` — **7/7 通过**
- 实际 MCP 调用验证：
  - `memory_status` → 181 文档索引，embedding server READY，181 向量
  - `memory_reindex(force=true)` → 194 文档索引 (9 跳过)，耗时 7.5s
  - `memory_search("猫猫大乱斗", mode=hybrid)` → 正确召回 F090 像素猫猫大作战

---

## 后续可优化项

1. **文件 watcher**：当前只在启动时索引，后续可加 fs.watch 监听文件变更自动增量更新
2. **分页/游标**：`memory_search` 最大 limit=50，超大批量检索可加分页参数
3. **写工具**：目前只读，后续可加 `memory_create` / `memory_update` 写入 .md 并更新索引
4. **多语言 tokenizer**：FTS5 unicode61 对中文分词效果有限，可考虑换用 jieba 或 icu tokenizer

---

## 配置示例

**纯 BM25（无需 embedding server）：**
```json
{
  "command": "node",
  "args": ["packages/memory-mcp/dist/index.js"],
  "env": { "MEMORY_FOLDER_PATH": "/path/to/docs" }
}
```

**开启向量搜索（LM Studio / 任意 OpenAI-compatible）：**
```json
{
  "command": "node",
  "args": ["packages/memory-mcp/dist/index.js"],
  "env": {
    "MEMORY_FOLDER_PATH": "/path/to/docs",
    "MEMORY_EMBED_MODE": "on",
    "MEMORY_EMBED_URL": "http://127.0.0.1:1234",
    "MEMORY_EMBED_MODEL": "text-embedding-qwen3-embedding-0.6b"
  }
}
```