---
feature_ids: [F102]
topics: [evidence, search, call-flow, mcp, fastify, sqlite, confidence, degradation]
doc_kind: architecture
created: 2026-03-30
---

# Evidence 调用流程图

## 1. 顶层调用链

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  猫猫 (Claude Agent)                                                         │
│  调用 MCP tool: cat_cafe_search_evidence(query, scope?, mode?, depth?)       │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ MCP protocol (stdio JSON-RPC)
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  packages/mcp-server/src/tools/evidence-tools.ts                            │
│  handleSearchEvidence()                                                      │
│                                                                              │
│  1. 构建 URLSearchParams { q, limit?, scope?, mode?, depth? }               │
│  2. fetch(`${CAT_CAFE_API_URL}/api/evidence/search?...`)                    │
│     CAT_CAFE_API_URL = http://localhost:3004 (默认)                          │
│  3. 格式化输出: "[mid] Title\n  anchor: ...\n  > snippet..."                │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ HTTP GET (localhost:3004)
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  packages/api/src/routes/evidence.ts                                        │
│  GET /api/evidence/search                                                    │
│                                                                              │
│  1. zod 参数校验 (q/limit/scope/mode/depth)                                 │
│  2. opts.evidenceStore.search(q, { limit, scope, mode, depth })             │
│  3. 映射结果: confidence = 'mid' as const  ←── 全局写死                     │
│  4. 异常时: { results: [], degraded: true }                                  │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ 方法调用
                                ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  packages/api/src/domains/memory/SqliteEvidenceStore.ts                     │
│  SqliteEvidenceStore.search()                                                │
│  (详见第 2 节)                                                               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. SqliteEvidenceStore.search() 内部流程

```
search(query, options)
│
├─ 计算 bm25Pool
│  ├─ hybrid 模式: min(max(limit×4, 20), 100)
│  └─ 其他模式:    limit
│
├─── [Step 1] 精确锚点查找 ──────────────────────────────────────────────────
│    SELECT * FROM evidence_docs WHERE anchor = ? COLLATE NOCASE
│    + kind/scope/status/keywords 过滤
│    │
│    ├─ 命中 → push to results, add to seenAnchors
│    └─ 未命中 → 继续
│
├─── [Step 2] FTS5 BM25 全文检索 ─────────────────────────────────────────
│    query → ["word1","word2"] FTS5短语格式
│    SELECT d.*, bm25(evidence_fts, 5.0, 1.0) AS rank
│    FROM evidence_fts JOIN evidence_docs
│    WHERE evidence_fts MATCH ?
│    ORDER BY superseded_by IS NOT NULL,
│             source_path LIKE 'archive/%',
│             rank ASC
│    LIMIT bm25Pool
│    │
│    ├─ 去重(seenAnchors) 后 push to results
│    └─ FTS5语法错误 → 静默跳过
│
├─── [Step 3] Keywords Fallback ─────────────────────────────────────────
│    仅在 results.length <= 1 时触发
│    SELECT * FROM evidence_docs
│    WHERE keywords LIKE '%word1%' OR keywords LIKE '%word2%'
│    ORDER BY superseded_by IS NOT NULL,
│             source_path LIKE 'archive/%',
│             updated_at DESC
│    LIMIT bm25Pool
│
├─── [Step 4] Passage FTS（depth=raw 且 scope 含 threads）─────────────────
│    SELECT p.doc_anchor, p.passage_id, p.content, p.speaker
│    FROM passage_fts JOIN evidence_passages
│    WHERE passage_fts MATCH ?
│    ORDER BY bm25(passage_fts)
│    LIMIT limit
│    │
│    └─ 为每个 passage 拼 EvidenceItem:
│       summary = "[passage match] speaker: content[:200]"
│
├─── [Short-circuit] depth=raw → 直接返回 ──────────────────────────────
│    enrichWithDrillDown(results[:limit])
│    (depth=raw 强制 lexical，不走向量路径)
│
└─── [Step 5] Mode 分叉 ─────────────────────────────────────────────────

     lexicalCandidates = results[:bm25Pool]   (for hybrid RRF)
     lexicalResults    = results[:limit]       (for lexical return)

     embeddingAvailable = embedDeps.embedding.isReady()
                       && embedDeps.mode === 'on'

     ┌─────────────┬────────────────────────────────────────────────────┐
     │   mode      │  行为                                              │
     ├─────────────┼────────────────────────────────────────────────────┤
     │  lexical    │  enrichWithDrillDown(lexicalResults)               │
     ├─────────────┼────────────────────────────────────────────────────┤
     │  semantic   │  if !embeddingAvailable → lexical fallback         │
     │             │  else semanticNNSearch(query, limit, options)      │
     │             │       └─ 失败 → lexical fallback                   │
     ├─────────────┼────────────────────────────────────────────────────┤
     │  hybrid     │  if !embeddingAvailable → lexical fallback         │
     │             │  else hybridRRFSearch(query,                       │
     │             │       lexicalCandidates, limit, options)           │
     │             │       └─ 失败 → lexical fallback                   │
     └─────────────┴────────────────────────────────────────────────────┘

     所有路径最终经过 enrichWithDrillDown()
     (为 thread/session 类型添加 drillDown 提示)
```

---

## 3. 三种检索模式详细流程

### 3.1 lexical 模式

```
query
  │
  ├─ Step1 精确锚点
  ├─ Step2 FTS5 BM25
  ├─ Step3 keywords fallback (可选)
  │
  └─► results[:limit]
        │
        └─► enrichWithDrillDown()
              └─► 返回给路由层
```

### 3.2 semantic 模式

```
query
  │
  ├─ Step1~3 (lexical部分，用于 embeddingAvailable=false 降级备用)
  │
  └─ [if embeddingAvailable]
       │
       ▼
  EmbeddingService.embed([query])
       │  HTTP POST http://127.0.0.1:9880/v1/embeddings
       │  { input: ["query text"] }
       │  ← { data: [{ embedding: [f32×768] }] }
       │  转换: number[] → Float32Array
       │
       ▼
  VectorStore.search(queryVec, pool)
       │  SELECT anchor, distance
       │  FROM evidence_vectors
       │  WHERE embedding MATCH queryVec AND k = pool
       │  (L2距离，升序)
       │
       ▼
  批量 Hydrate（无 N+1）
       │  SELECT * FROM evidence_docs
       │  WHERE anchor IN (a1, a2, ..., aN)
       │  + scope/kind/status/keywords 过滤
       │
       ▼
  按 NN 距离顺序重排 → 取 top limit
       │
       └─► enrichWithDrillDown() → 返回
```

### 3.3 hybrid 模式（BM25 + NN + RRF）

```
query
  │
  ├─────────────────────────────────────────┐
  │                                         │
  ▼                                         ▼
BM25 path                             Vector NN path
Step1~3 lexical                       EmbeddingService.embed([query])
(bm25Pool 大小候选)                        │
  │                                    VectorStore.search(queryVec, pool)
  │                                         │
  └──────────────┬──────────────────────────┘
                 │
                 ▼
        RRF Fusion (k=60)
        ─────────────────────────────────────────
        for i, anchor in lexicalCandidates:
          scores[anchor] += 1 / (60 + i)

        for i, anchor in nnResults:
          scores[anchor] += 1 / (60 + i)
        ─────────────────────────────────────────
        │
        ▼
        缺失 NN anchor → 批量 hydrate from evidence_docs
        (with scope/kind filters)
        │
        ▼
        allAnchors.sort by scores[b]-scores[a] DESC
        → take [:limit]
        │
        └─► enrichWithDrillDown() → 返回
```

---

## 4. 置信度赋值决策树

```
search 请求到达 evidence.ts
│
├─ try: evidenceStore.search() 调用
│   │
│   ├─ 成功返回 items
│   │   │
│   │   └─ items.map(item => {
│   │         confidence: 'mid' as const   ←── 无论哪种模式，一律 'mid'
│   │         sourceType: kind→type映射
│   │      })
│   │      return { results, degraded: false }
│   │
│   └─ 抛出异常
│       └─ return { results: [], degraded: true,
│                   degradeReason: 'evidence_store_error' }
│
│
│ [以下函数定义在 evidence-helpers.ts 但当前路由未调用]
│
├─ validateAnchors(results, docsRoot)      ← 未接入
│   for each result where anchor starts with 'docs/':
│     ├─ 文件存在 → confidence 不变
│     └─ 文件不存在 → confidence = 'low'
│
└─ searchDocs(docsRoot, query, limit)      ← 未接入（降级备用）
    grep docs/{decisions,phases,discussions}/*.md
    所有结果: confidence = 'low'（写死）


最终 MCP 输出给猫猫:
┌─────────────────────────────────────────────────────┐
│  正常: [mid] Title                                   │
│  降级: [DEGRADED] Evidence store error — ...         │
│        （results 为空）                              │
│                                                     │
│  'high' 从未出现（路由层无任何产生 high 的逻辑）     │
│  'low'  仅通过未接入的辅助函数可产生                 │
└─────────────────────────────────────────────────────┘
```

---

## 5. 启动初始化流程（嵌入一致性检查）

```
API 服务启动
│
├─ SqliteEvidenceStore.initialize()
│   ├─ new Database(dbPath)
│   ├─ PRAGMA journal_mode = WAL
│   ├─ PRAGMA foreign_keys = ON
│   ├─ PRAGMA busy_timeout = 5000
│   └─ applyMigrations(db)        ← 建表/迁移
│
├─ EmbeddingService.load()
│   │
│   ├─ GET http://127.0.0.1:9880/health
│   │   ← { status, model, backend, device, dim }
│   │
│   ├─ 成功
│   │   ├─ isReady() = true
│   │   ├─ 记录 modelId / modelRev / dim
│   │   │
│   │   └─ VectorStore.checkMetaConsistency(current)
│   │       │
│   │       │  SELECT key, value FROM embedding_meta
│   │       │
│   │       ├─ 无历史记录 → { consistent: true, reason: 'no prior meta' }
│   │       │                → initMeta()  写入当前模型信息
│   │       │
│   │       ├─ modelId 变更 → { consistent: false, reason: 'model changed: X→Y' }
│   │       │                 → clearAll()
│   │       │                   DELETE FROM evidence_vectors
│   │       │                   DELETE FROM embedding_meta
│   │       │                   → 触发全量重新嵌入所有文档
│   │       │
│   │       ├─ dim 变更    → { consistent: false, reason: 'dim changed: X→Y' }
│   │       │                 → clearAll() + 全量重建
│   │       │
│   │       └─ 一致        → { consistent: true, reason: 'ok' }
│   │                        → 直接使用现有向量索引
│   │
│   └─ 失败 (ECONNREFUSED / timeout)
│       ├─ isReady() = false
│       └─ fail-open: 系统继续运行，所有 semantic/hybrid 降级为 lexical
│
└─ IndexBuilder.buildAll() / incrementalUpdate()
    ├─ 扫描 docs/ 目录，解析 frontmatter
    ├─ 写入 evidence_docs + evidence_fts
    ├─ 写入 edges（related_features）
    └─ [if embeddingAvailable]
        ├─ 对每个新/变更的 doc 调用 EmbeddingService.embed([title+summary])
        └─ VectorStore.upsert(anchor, Float32Array)
            ├─ DELETE FROM evidence_vectors WHERE anchor = ?
            └─ INSERT INTO evidence_vectors (anchor, embedding) VALUES (?, ?)
            (vec0 不支持 ON CONFLICT，所以拆成两步)
```

---

## 6. VectorStore 内部操作流程

```
VectorStore
├─ constructor(db: Database, dim: number)
│
├─ upsert(anchor, embedding: Float32Array)
│   ├─ DELETE FROM evidence_vectors WHERE anchor = ?
│   └─ INSERT INTO evidence_vectors (anchor, embedding) VALUES (?, ?)
│      (embedding 作为 blob 传入 better-sqlite3)
│
├─ delete(anchor)
│   └─ DELETE FROM evidence_vectors WHERE anchor = ?
│
├─ search(queryVec: Float32Array, k: number)
│   └─ SELECT anchor, distance
│      FROM evidence_vectors
│      WHERE embedding MATCH queryVec AND k = k
│      → Array<{ anchor: string; distance: number }>
│        (L2 欧氏距离，升序，越小越相关)
│
├─ initMeta(info: EmbedModelInfo)
│   └─ transaction {
│        INSERT OR REPLACE INTO embedding_meta VALUES ('embedding_model_id', info.modelId)
│        INSERT OR REPLACE INTO embedding_meta VALUES ('embedding_model_rev', info.modelRev)
│        INSERT OR REPLACE INTO embedding_meta VALUES ('embedding_dim', String(info.dim))
│      }
│
├─ getMeta() → Record<string, string>
│   └─ SELECT key, value FROM embedding_meta
│
├─ checkMetaConsistency(current: EmbedModelInfo)
│   ├─ meta = getMeta()
│   ├─ !meta.embedding_model_id → { consistent: true, reason: 'no prior meta' }
│   ├─ modelId mismatch        → { consistent: false, reason: 'model changed: X→Y' }
│   ├─ dim mismatch            → { consistent: false, reason: 'dim changed: X→Y' }
│   └─ 全部一致               → { consistent: true, reason: 'ok' }
│
├─ clearAll()
│   ├─ DELETE FROM evidence_vectors   (清空向量索引)
│   └─ DELETE FROM embedding_meta     (清空版本锚点)
│
└─ count() → number
    └─ SELECT count(*) AS c FROM evidence_vectors
```

---

## 7. 数据源层级与可靠性对应关系

```
数据源                    当前置信度分配         备注
─────────────────────────────────────────────────────────────
evidence_docs             'mid'                  正常路径，写死
  └─ via FTS5 BM25        'mid'                  同上
  └─ via exact anchor     'mid'                  同上
  └─ via keywords         'mid'                  同上
  └─ via vector NN        'mid'                  同上（未区分算法）
  └─ via hybrid RRF       'mid'                  同上

evidence_passages         'mid'                  depth=raw，同上
  └─ via passage_fts      'mid'                  同上

docs/ 文件系统 grep       'low'                  searchDocs()，未接入
  (降级路径)

anchor 文件丢失           'low'                  validateAnchors()，未接入

store 完全失败            degraded=true，空结果   catch 块
─────────────────────────────────────────────────────────────
'high' 值:  当前代码无任何路径赋予 'high'
'low'  值:  仅两个未接入的辅助函数可产生
```

---

## 8. enrichWithDrillDown 流程（所有路径共用）

```
enrichWithDrillDown(results: EvidenceItem[])
│
for each item in results:
│
├─ item.kind === 'thread' && anchor.startsWith('thread-')
│   └─ item.drillDown = {
│        tool: 'cat_cafe_get_thread_context',
│        params: { threadId: anchor.replace('thread-', '') },
│        hint: '查看完整对话：get_thread_context(threadId="...")'
│      }
│
└─ item.kind === 'session' && anchor.startsWith('session-')
    └─ item.drillDown = {
         tool: 'cat_cafe_read_session_digest',
         params: { sessionId: anchor.replace('session-', '') },
         hint: '查看 session 摘要：read_session_digest(sessionId="...")'
       }

返回：带 drillDown 提示的 EvidenceItem[]
（feature/decision/plan/lesson 类型无 drillDown）
```

---

## 9. 关键文件位置速查

```
调用链位置                              文件路径
────────────────────────────────────────────────────────────────────────
MCP 工具入口                            packages/mcp-server/src/tools/evidence-tools.ts
Fastify 路由 + 置信度赋值               packages/api/src/routes/evidence.ts
置信度类型 + 辅助函数（未接入）         packages/api/src/routes/evidence-helpers.ts
SqliteEvidenceStore（三模式搜索）       packages/api/src/domains/memory/SqliteEvidenceStore.ts
VectorStore（sqlite-vec 封装）          packages/api/src/domains/memory/VectorStore.ts
EmbeddingService（HTTP 嵌入客户端）     packages/api/src/domains/memory/EmbeddingService.ts
IndexBuilder（文件扫描 + 索引写入）     packages/api/src/domains/memory/IndexBuilder.ts
SQLite 表结构定义                       packages/api/src/domains/memory/schema.ts
前端 EvidencePanel 渲染                 packages/web/src/components/EvidencePanel.tsx
前端 EvidenceCard（置信度徽章）         packages/web/src/components/EvidenceCard.tsx
```
