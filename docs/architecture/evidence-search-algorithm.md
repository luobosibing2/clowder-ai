---
feature_ids: [F102]
topics: [evidence, search, fts5, bm25, vector, hybrid, rrf]
doc_kind: architecture
created: 2026-03-30
---

# Evidence 检索算法文档

## 1. 概述

`cat_cafe_search_evidence` 是一个 **MCP 工具**，为猫猫提供统一的项目知识检索入口。底层基于 SQLite FTS5（词法）+ sqlite-vec（向量）双引擎，支持三种检索模式：

| 模式 | 算法 | 适用场景 |
|------|------|---------|
| `lexical`（默认） | BM25 词频排序 | Feature ID、精确词（F042、Redis） |
| `semantic` | 向量最近邻 | 跨语言、同义词（英文查中文文档） |
| `hybrid`（推荐） | BM25 + 向量 + RRF 融合 | 大多数搜索，精确与语义兼顾 |

### 调用链

```
猫猫 → MCP Tool (evidence-tools.ts)
  → HTTP GET /api/evidence/search (Fastify)
    → SqliteEvidenceStore.search(q, {limit, scope, mode, depth})
      ├─ mode=lexical  → bm25Search()
      ├─ mode=semantic → semanticNNSearch()
      └─ mode=hybrid   → hybridSearch() [bm25 + NN + RRF]
```

---

## 2. SQLite Schema 与数据结构

> 文件位置：`packages/api/src/domains/memory/schema.ts`

### 2.1 核心表

```sql
-- 主文档表
CREATE TABLE evidence_docs (
  anchor        TEXT PRIMARY KEY,   -- 唯一标识（如 F042、LL-015）
  kind          TEXT,               -- feature/decision/plan/lesson/thread/session/...
  status        TEXT,               -- active/done/archived
  title         TEXT,
  summary       TEXT,
  keywords      TEXT,               -- JSON 数组
  source_path   TEXT,
  source_hash   TEXT,               -- SHA256 前 16 位（用于变更检测）
  superseded_by TEXT,               -- 被更新的锚点
  updated_at    TEXT,
  pack_id       TEXT                -- F129: pack 作用域隔离
)

-- FTS5 全文索引（外部内容表）
CREATE VIRTUAL TABLE evidence_fts USING fts5(
  title, summary,
  content=evidence_docs, content_rowid=rowid,
  tokenize="unicode61"              -- 支持 CJK
)

-- 依赖图（有向边）
CREATE TABLE edges (
  from_anchor TEXT,
  to_anchor   TEXT,
  relation    TEXT,                 -- related/evolved_from/blocked_by/supersedes/invalidates
  PRIMARY KEY (from_anchor, to_anchor, relation)
)
```

### 2.2 向量表（Phase C）

```sql
-- sqlite-vec 扩展
CREATE VIRTUAL TABLE evidence_vectors USING vec0(
  anchor    TEXT PRIMARY KEY,
  embedding float[768]              -- 维度由嵌入模型决定，默认 768
)

-- 嵌入一致性元数据
CREATE TABLE embedding_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
)
-- 存储: embedding_model_id / embedding_model_rev / embedding_dim
-- 模型变更时触发全量重建
```

### 2.3 消息粒度索引（Phase E）

```sql
-- 每条消息作为一个 passage
CREATE TABLE evidence_passages (
  id         INTEGER PRIMARY KEY,
  doc_anchor TEXT,       -- 指向 thread-{threadId}
  passage_id TEXT,       -- msg-{msgId}
  content    TEXT,
  speaker    TEXT,
  position   INTEGER,
  created_at TEXT,
  UNIQUE(doc_anchor, passage_id)
)

-- Passage FTS（tokenizer 额外支持 _ - 字符）
CREATE VIRTUAL TABLE passage_fts USING fts5(
  content,
  content=evidence_passages, content_rowid=rowid,
  tokenize="unicode61 tokenchars '_-'"
)
```

### 2.4 Evidence Kind 与 Scope 映射

| scope 参数 | 实际过滤 |
|-----------|---------|
| `docs` / `memory` | 排除 kind='thread' 和 kind='session' |
| `threads` | 只包含 kind='thread' |
| `sessions` | 只包含 kind='session' |
| `all` | 不过滤 kind |
| （所有 scope） | 始终排除 kind='pack-knowledge'（除非显式指定）|

---

## 3. Mode 1：Lexical（BM25）

> 文件位置：`packages/api/src/domains/memory/SqliteEvidenceStore.ts`

### 3.1 精确锚点绕过

若查询词完整匹配一个锚点（如 `F042`、`ADR-005`、`LL-015`），直接走精确查询，**跳过 FTS5**：

```sql
SELECT * FROM evidence_docs
WHERE anchor = ? COLLATE NOCASE
```

**原因**：FTS5 的 tokenizer 会把 `F042` 切成 `f` + `042`，导致精确 ID 查询精度下降。

### 3.2 FTS5 BM25 查询

```typescript
// 将查询词封装为 FTS5 短语查询
const ftsQuery = query.split(/\s+/)
  .map(w => `"${w.replace(/"/g, '""')}"`)
  .join(' ')

// BM25 查询，title 权重 5.0，summary 权重 1.0
SELECT d.*, bm25(evidence_fts, 5.0, 1.0) AS rank
FROM evidence_fts f
JOIN evidence_docs d ON d.rowid = f.rowid
WHERE evidence_fts MATCH ?
  AND [scope filters]
ORDER BY
  (d.superseded_by IS NOT NULL),      -- 已废弃条目排后
  (d.source_path LIKE 'archive/%'),   -- 归档条目排后
  rank ASC                            -- BM25 分数越小越相关
LIMIT bm25Pool
```

**候选池大小**：
- `lexical` 模式：`bm25Pool = limit`
- `hybrid` 模式：`bm25Pool = min(max(limit * 4, 20), 100)`（为 RRF 准备更多候选）

### 3.3 关键词 Fallback

若 FTS5 返回 ≤1 条结果，降级为关键词模糊匹配：

```sql
SELECT * FROM evidence_docs
WHERE (keywords LIKE '%word1%' OR keywords LIKE '%word2%' OR ...)
  AND [scope filters]
ORDER BY
  (superseded_by IS NOT NULL),
  (source_path LIKE 'archive/%'),
  updated_at DESC
LIMIT bm25Pool
```

**原因**：部分知识点的核心词只在 frontmatter `keywords` 字段中，未出现在 title/summary 里。

### 3.4 结果去重

```typescript
const seenAnchors = new Set<string>();
// 合并精确匹配 + FTS5 + keyword fallback 结果
// 跳过已在 seenAnchors 中的 anchor
```

---

## 4. Mode 2：Semantic（纯向量最近邻）

> 文件位置：`packages/api/src/domains/memory/SqliteEvidenceStore.ts`

### 4.1 查询向量化

```typescript
// 调用外部 HTTP 嵌入服务
const queryVec = await this.embedDeps.embedding.embed([query])
// 返回 Float32Array[768]（或配置的维度）
```

### 4.2 向量最近邻搜索

```typescript
const pool = Math.min(Math.max(limit * 4, 20), 100)
const nnResults = this.embedDeps.vectorStore.search(queryVec[0], pool)

// 内部执行 sqlite-vec 查询：
SELECT anchor, distance
FROM evidence_vectors
WHERE embedding MATCH ? AND k = ?
-- L2 距离，升序（越小越相关）
```

### 4.3 批量 Hydrate + 过滤

```sql
SELECT * FROM evidence_docs
WHERE anchor IN (?, ?, ?, ...)   -- 一次性批量查询，无 N+1
  AND [全部 SearchOptions 过滤条件：scope/status/keywords]
```

返回结果按 NN 距离顺序重排，取前 `limit` 条。

### 4.4 降级策略

嵌入服务不可用时（`isReady() === false` 或 `mode !== 'on'`），**自动降级为 lexical**。

---

## 5. Mode 3：Hybrid（BM25 + 向量 + RRF）

> 文件位置：`packages/api/src/domains/memory/SqliteEvidenceStore.ts`

### 5.1 双路并行召回

```typescript
const pool = Math.min(Math.max(limit * 4, 20), 100)

// 两路同时进行
const lexicalResults = bm25Search(query, pool, options)
const nnResults      = semanticNNSearch(queryVec, pool, options)
```

两路各自最多返回 `pool` 个候选，合并后共同参与 RRF 打分。

### 5.2 Reciprocal Rank Fusion（RRF）

```typescript
const RRF_K = 60;
const scores = new Map<string, number>();

// BM25 贡献
for (let i = 0; i < lexicalResults.length; i++) {
  const anchor = lexicalResults[i].anchor;
  scores.set(anchor, (scores.get(anchor) ?? 0) + 1 / (RRF_K + i));
}

// 向量 NN 贡献
for (let i = 0; i < nnResults.length; i++) {
  const anchor = nnResults[i].anchor;
  scores.set(anchor, (scores.get(anchor) ?? 0) + 1 / (RRF_K + i));
}

// 按 RRF 分数降序取 top limit
const finalResults = allAnchors
  .sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0))
  .map(a => docMap.get(a)!)
  .slice(0, limit);
```

**RRF 公式 `1/(k+rank)` 的设计意图**：

| 排名 | BM25 单独得分 | NN 单独得分 | 两路都排第 0 |
|------|-------------|------------|------------|
| rank=0  | 1/60 ≈ 0.0167 | 1/60 ≈ 0.0167 | 0.0333（最高）|
| rank=10 | 1/70 ≈ 0.0143 | — | — |
| rank=59 | 1/119 ≈ 0.0084 | — | — |

- `k=60` 使分数曲线平缓，防止单路头部结果一家独大
- 两路都靠前的文档得分最高（关键词精确匹配 + 语义相关）

### 5.3 降级策略

嵌入服务不可用 → 跳过 NN，直接返回 BM25 结果。

---

## 6. depth 参数：消息粒度搜索

> 文件位置：`packages/api/src/domains/memory/SqliteEvidenceStore.ts`

| depth | 行为 |
|-------|------|
| `summary`（默认） | 搜索 `evidence_docs`，snippet = item.summary（前 300 字符） |
| `raw` | 额外搜索 `passage_fts`（消息级索引），snippet = 消息原文（前 200 字符） |

`depth=raw` 时的额外查询（仅在 scope 包含 threads 时触发）：

```sql
SELECT p.doc_anchor, p.passage_id, p.content, p.speaker, p.position,
       bm25(passage_fts) AS rank
FROM passage_fts f
JOIN evidence_passages p ON p.rowid = f.rowid
WHERE passage_fts MATCH ?
ORDER BY rank
LIMIT limit
```

**限制**：`depth=raw` 强制使用 lexical，不走 semantic/hybrid。

---

## 7. 索引构建（IndexBuilder）

> 文件位置：`packages/api/src/domains/memory/IndexBuilder.ts`

### 7.1 文件扫描与 Kind 映射

```typescript
const DIR_TO_KIND = {
  'features'    → 'feature',
  'decisions'   → 'decision',
  'plans'       → 'plan',
  'phases'      → 'plan',
  'lessons'     → 'lesson',
  'discussions' → 'discussion',
  // archive/ 子目录同样支持
}
```

### 7.2 Frontmatter 解析

每个 `.md` 文件的 YAML frontmatter 提供索引数据：

```yaml
---
anchor: F042
status: active
doc_kind: feature
feature_ids: [F042, F043]
decision_id: ADR-005
topics: [redis, caching, performance]
related_features: [F041, F043, F044]
---
```

- `anchor` → 主键
- `topics` + `feature_ids` → `keywords` JSON 字段
- `related_features` → 自动写入 `edges` 表（`relation='related'`）

### 7.3 锚点优先级（防冲突）

```typescript
const KIND_PRIORITY = {
  feature:      4,  // 最高
  decision:     3,
  plan:         2,
  discussion:   2,
  lesson:       1,
  thread:       1,
  session:      1,
  'pack-knowledge': 0,  // 最低
}
// 高优先级文档"占有"某锚点，低优先级无法覆盖
// 除非高优先级的源文件已删除
```

### 7.4 哈希变更检测

```typescript
sourceHash = SHA256(content).slice(0, 16)
// 若 hash 未变 → 跳过重新索引（除非 force=true）
```

### 7.5 特殊文件处理

**Lessons-Learned 拆分**（E8）：
```markdown
# docs/public-lessons.md

### LL-015: 标题
内容...

### LL-016: 另一个教训
内容...
```
每个 `### LL-xxx` 段落拆分为独立 evidence_doc，`anchor='LL-015'`，`kind='lesson'`。

**Thread 索引**（E-1）：
- `anchor='thread-{threadId}'`，`kind='thread'`
- summary 从最近 100 条消息内容构建
- keywords 包含参与猫猫 ID + 消息中提到的 Feature ID

**Session Digest 索引**（D6）：
```
transcriptDataDir/threads/{threadId}/{catId}/sessions/{sessionId}/digest.extractive.json
→ anchor='session-{sessionId}', kind='session'
```

**消息 Passage 索引**（E-3）：
```typescript
// 每条消息 → evidence_passages 的一行
{ doc_anchor: 'thread-{threadId}', passage_id: 'msg-{msgId}',
  content, speaker: catId, position: index }
```

### 7.6 脏 Thread 去抖动（E-2）

```typescript
markThreadDirty(threadId)   // 有新消息时标记
flushDirtyThreads()         // 在下次请求时批量重索引
// 避免每条消息都触发重建，按需合并
```

### 7.7 增量重索引 API

```
POST /api/evidence/reindex  { paths: ["docs/features/F042.md", ...] }
// localhost-only（非 127.0.0.1 返回 403）
// 重索引前先收集旧 anchor，重索引后通过 edges 表找到依赖项并返回 invalidated 列表
```

---

## 8. 嵌入服务（EmbeddingService）

> 文件位置：`packages/api/src/domains/memory/EmbeddingService.ts`

### 8.1 架构：独立外部进程

嵌入计算运行在**独立 HTTP 服务**中，而非 API 进程内。

> **原因**（来自 LL-034）：ONNX 运行时不能运行在 API 主进程里，会阻塞事件循环。

```typescript
// 配置
baseUrl = process.env.EMBED_URL
       ?? `http://127.0.0.1:${process.env.EMBED_PORT ?? 9880}`

// 健康检查
GET {baseUrl}/health
→ { status, model, backend, device, dim }

// 嵌入请求
POST {baseUrl}/v1/embeddings
{ input: ["text1", "text2"] }
→ { data: [{ embedding: [...], index: 0 }] }
```

### 8.2 嵌入模型

| 模型 | 维度 | 特性 |
|------|------|------|
| `qwen3-embedding-0.6b`（默认） | 768 | CJK 优化，中英文混合表现好 |
| `multilingual-e5-small` | 384 | 跨语言通用，轻量 |

支持 **MRL（Matryoshka Representation Learning）截断**：768 维可截断为 256 维以节省存储和计算。

### 8.3 加载行为

```typescript
// 构造时：isReady() = false
// load() 调用时：探测 /health
//   成功 → isReady() = true
//   失败 → fail-open，isReady() = false（系统继续运行，降级 lexical）
```

### 8.4 嵌入一致性校验

`embedding_meta` 表存储当前模型元数据：

```
key='embedding_model_id'  → 'qwen3-embedding-0.6b'
key='embedding_model_rev' → 'http-client'
key='embedding_dim'       → '768'
```

每次启动时 `checkMetaConsistency(current)` 对比：
- 若模型/维度变更 → `clearAll()` 清空所有向量 + 重新嵌入所有文档
- 保证向量库与当前模型一致

---

## 9. 向量存储（VectorStore）

> 文件位置：`packages/api/src/domains/memory/VectorStore.ts`

基于 **sqlite-vec** 扩展，提供 L2 距离最近邻搜索：

```typescript
// 插入或更新
upsert(anchor: string, embedding: Float32Array): void
// DELETE FROM evidence_vectors WHERE anchor = ?
// INSERT INTO evidence_vectors VALUES (anchor, embedding)

// 最近邻搜索
search(queryVec: Float32Array, k: number): Array<{anchor, distance}>
// SELECT anchor, distance FROM evidence_vectors
// WHERE embedding MATCH queryVec AND k = ?
// 返回 L2 距离升序（越小越相关）

// 全量重置（模型切换时）
clearAll(): void

// 模型元数据初始化
initMeta(modelInfo): void
checkMetaConsistency(current): boolean
```

---

## 10. 性能设计

### 10.1 候选池大小计算

| 模式 | 候选池 `bm25Pool` | 最终返回 |
|------|-----------------|---------|
| lexical | `limit`（默认 5） | top `limit` |
| semantic | `min(max(limit×4, 20), 100)` | top `limit` |
| hybrid | `min(max(limit×4, 20), 100)`（两路各自）| RRF top `limit` |

示例（`limit=5`）：

| 模式 | 候选数 |
|------|--------|
| lexical | 5 |
| semantic | 20 |
| hybrid | BM25×20 + NN×20 → 最多 40 候选 → RRF → 5 |

### 10.2 N+1 防护

所有批量查询均使用 `IN(?, ?, ...)` 一次性获取：
- NN 结果 hydration：1 次 SQL
- Passage hydration：1 次 SQL
- 无单条循环查询

### 10.3 查询执行顺序

```
1. 精确锚点匹配（1 SQL）
2. FTS5 BM25（1 SQL JOIN）
3. 关键词 fallback（1 SQL，仅在 FTS5 结果不足时）
4. Passage 搜索（1 SQL，仅 depth=raw）
5. 向量 NN 搜索（1 sqlite-vec 查询，仅 semantic/hybrid）
6. NN 结果 hydration（1 SQL IN，仅 semantic/hybrid）
7. RRF 融合（内存排序 O(n log n)，仅 hybrid）
```

### 10.4 关键常量

| 常量 | 值 | 作用 |
|------|---|------|
| `RRF_K` | 60 | RRF 平衡常数 |
| BM25 title 权重 | 5.0 | 标题匹配权重高于摘要 |
| BM25 summary 权重 | 1.0 | 摘要匹配基础权重 |
| FTS5 tokenizer | unicode61 | 支持 CJK 分词 |
| 嵌入维度 | 768（默认） | qwen3-embedding-0.6b 输出维度 |
| 向量距离函数 | L2（欧氏距离） | sqlite-vec 默认 |
| hash 长度 | 16 字符 | SHA256 前 16 位 |

---

## 11. 嵌入服务工作模式

| Mode | 行为 |
|------|------|
| `off` | 不加载嵌入服务；semantic/hybrid 均降级为 lexical |
| `shadow` | 服务加载但不参与搜索；可用于测试向量索引构建 |
| `on` | 完整 semantic/hybrid 支持 |

环境变量：`EMBED_URL`（默认 `http://127.0.0.1:9880`）、`EMBED_PORT`。

---

## 12. 数据流全景

```
docs/*.md / threads / sessions
       │
       ▼ IndexBuilder
  ┌────────────────────────────────────┐
  │  SQLite                            │
  │  ├─ evidence_docs                  │
  │  ├─ evidence_fts (BM25 索引)       │
  │  ├─ evidence_passages              │
  │  ├─ passage_fts                    │
  │  ├─ edges (依赖图)                 │
  │  └─ evidence_vectors (sqlite-vec)  │
  └────────────────────────────────────┘
       │
       ▼ SqliteEvidenceStore.search()
  ┌──────────────────────┐
  │ mode=lexical         │  BM25 → 精确锚点/FTS5/keyword fallback
  │ mode=semantic        │  queryVec → NN → hydrate
  │ mode=hybrid          │  BM25 + NN → RRF 融合
  └──────────────────────┘
       │
       ▼ evidence.ts (Fastify)
  confidence='mid' as const    ← 目前固定中置信度
  degraded=false/true          ← store 出错时降级标志
       │
       ▼ HTTP → MCP Tool → 猫猫 context
  [mid] F102 Phase D — Evidence Search Pipeline
    anchor: docs/features/F102-...md
    type: decision
    > 统一检索入口...
```

---

## 13. 关键文件索引

| 文件 | 职责 |
|------|------|
| `packages/mcp-server/src/tools/evidence-tools.ts` | MCP 工具入口，HTTP 调用 + 格式化输出 |
| `packages/api/src/routes/evidence.ts` | Fastify 路由，参数校验，调用 store |
| `packages/api/src/routes/evidence-helpers.ts` | 降级搜索、锚点验证、置信度降级 |
| `packages/api/src/domains/memory/SqliteEvidenceStore.ts` | 三种搜索算法（lexical/semantic/hybrid） |
| `packages/api/src/domains/memory/IndexBuilder.ts` | 索引构建：文件扫描、frontmatter 解析、FTS5/向量写入 |
| `packages/api/src/domains/memory/EmbeddingService.ts` | HTTP 嵌入客户端，健康检查，一致性校验 |
| `packages/api/src/domains/memory/VectorStore.ts` | sqlite-vec 向量操作封装 |
| `packages/api/src/domains/memory/schema.ts` | SQLite 表结构定义 |
| `packages/api/src/domains/memory/interfaces.ts` | IEvidenceStore / IIndexBuilder 接口 |
