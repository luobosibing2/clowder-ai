---
feature_ids: [F102]
topics: [evidence, search, fts5, bm25, vector, hybrid, rrf]
doc_kind: architecture
created: 2026-03-30
---
  SqliteEvidenceStore 实现

  用 better-sqlite3 库操作 SQLite，全同步 API（不是 async），构造很简单：

  export class SqliteEvidenceStore implements IEvidenceStore {
    private db: Database.Database | null = null;
    private embedDeps?: EmbedDeps;  // 向量化依赖，可后绑定

    constructor(dbPath: string, embedDeps?: EmbedDeps) { ... }

    async initialize(): Promise<void> {
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');   // 写前日志，提升并发
      this.db.pragma('foreign_keys = ON');
      this.db.pragma('busy_timeout = 5000');
      applyMigrations(this.db);               // 跑 schema 迁移
    }
  }

  EmbedDeps 是后绑定的向量化依赖包：

  export interface EmbedDeps {
    embedding: IEmbeddingService;  // 向量化接口
    vectorStore: VectorStore;      // sqlite-vec 操作
    mode: 'off' | 'shadow' | 'on';
  }

  ---
  向量化接口调用链

  1. IEmbeddingService.embed() — 生成向量

  SqliteEvidenceStore 在 semantic/hybrid 模式下这样调用：

  // semanticNNSearch()
  const queryVec = await this.embedDeps!.embedding.embed([query]);
  // 返回 Float32Array[]，取第 0 个

  const nnResults = this.embedDeps!.vectorStore.search(queryVec[0], pool);

  embedding.embed() 的实现在 EmbeddingService，是一个 HTTP 请求：

  async embed(texts: string[]): Promise<Float32Array[]> {
    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: texts }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = (await res.json()) as EmbedApiResponse;

    // number[] → Float32Array，顺便做 MRL 维度截断
    return body.data
      .sort((a, b) => a.index - b.index)
      .map((d) => {
        const arr = new Float32Array(targetDim);  // targetDim = 768
        for (let i = 0; i < Math.min(d.embedding.length, targetDim); i++)
          arr[i] = d.embedding[i]!;
        return arr;
      });
  }

  嵌入服务是独立 Python 进程（scripts/embed-api.py），运行在 :9880，API 进程只是个 HTTP 客户端。

  原因（LL-034）：ONNX/模型推理不能在 Node.js 事件循环里跑，会阻塞 API。

  2. VectorStore.search() — 最近邻查询

  search(queryVec: Float32Array, k: number) {
    return this.db
      .prepare(`SELECT anchor, distance FROM evidence_vectors
                WHERE embedding MATCH ? AND k = ?`)
      .all(queryVec, k);
    // 返回 [{anchor, distance}]，L2 距离升序
  }

  WHERE embedding MATCH ? 是 sqlite-vec 扩展的语法，传入 Float32Array 直接作为查询向量。

  3. 启动时一致性校验

  每次启动，VectorStore.checkMetaConsistency() 对比当前模型和 DB 里记录的模型：

  checkMetaConsistency(current: EmbedModelInfo) {
    const meta = this.getMeta();
    if (meta.embedding_model_id !== current.modelId)
      return { consistent: false, reason: `model changed: ...` };
    if (meta.embedding_dim !== String(current.dim))
      return { consistent: false, reason: `dim changed: ...` };
    return { consistent: true, reason: 'ok' };
  }

  不一致 → clearAll() 清空 evidence_vectors + 重新嵌入所有文档。

  ---
  完整调用栈（hybrid 模式）

  search(query, { mode: 'hybrid' })
    │
    ├─ BM25（同步，better-sqlite3）
    │     db.prepare("SELECT ... FROM evidence_fts ... bm25(5.0, 1.0)").all()
    │
    └─ hybridRRFSearch()
          │
          ├─ embedding.embed([query])          ← async HTTP POST :9880/v1/embeddings
          │     → Python 进程推理
          │     → 返回 Float32Array[768]
          │
          ├─ vectorStore.search(queryVec, pool) ← sqlite-vec MATCH 查询
          │     → [{anchor, distance}, ...]
          │
          ├─ 批量 hydrate 缺失文档
          │     db.prepare("SELECT * FROM evidence_docs WHERE anchor IN (...)").all()
          │
          └─ RRF 融合（内存排序）
                score = Σ 1/(60 + rank)
                取 top-N

  ---
  关键细节
  ┌──────────────────────────────────────┬────────────────────────────────────────────────────────┐
  │                 问题                 │                          答案                          │
  ├──────────────────────────────────────┼────────────────────────────────────────────────────────┤
  │ 用什么 SQLite 库？                   │ better-sqlite3（同步 API）                             │
  ├──────────────────────────────────────┼────────────────────────────────────────────────────────┤
  │ 向量化谁做？                         │ 独立 Python 进程（embed-api.py），Node.js 只 HTTP 调用 │
  ├──────────────────────────────────────┼────────────────────────────────────────────────────────┤
  │ 向量存储引擎？                       │ sqlite-vec 扩展，vec0 虚拟表，L2 距离                  │
  ├──────────────────────────────────────┼────────────────────────────────────────────────────────┤
  │ 向量维度？                           │ 768（qwen3-embedding-0.6b），支持 MRL 截断到 256       │
  ├──────────────────────────────────────┼────────────────────────────────────────────────────────┤
  │ 嵌入服务挂了怎么办？                 │ isReady()=false，semantic/hybrid 自动降级为 lexical    │
  ├──────────────────────────────────────┼────────────────────────────────────────────────────────┤
  │ upsert 怎么写的？                    │ INSERT OR REPLACE，事务批量写入                        │
  ├──────────────────────────────────────┼────────────────────────────────────────────────────────┤
  │ 向量 upsert 为什么不用 ON CONFLICT？ │ vec0 不支持，只能 DELETE + INSERT                      │
  └──────────────────────────────────────┴────────────────────────────────────────────────────────┘