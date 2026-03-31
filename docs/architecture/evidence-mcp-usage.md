---
feature_ids: [F102]
topics: [evidence, mcp, setup, api-dependency]
doc_kind: guide
created: 2026-03-31
---

# Evidence MCP Server 使用说明

`@cat-cafe/evidence-mcp` 是一个独立的 MCP server，只暴露一个工具：
`cat_cafe_search_evidence`——面向项目知识库的检索入口。
> 工具注册：`packages/evidence-mcp/src/index.ts:18-23`

---

## 外部 API 依赖

该 MCP server **本身不直接访问数据库**，所有检索逻辑在 Fastify API 侧执行。
> 依据：`packages/evidence-mcp/src/tool.ts:11,61,64`——tool 层只有一次 `fetch(url)`，无任何 DB 引用

```
MCP client（猫猫）
  └─► evidence-mcp server（stdio）
        └─► HTTP GET  CAT_CAFE_API_URL/api/evidence/search      ← tool.ts:61,64
              └─► packages/api  Fastify server（默认 :3004）    ← evidence.ts:55
                    ├─► SQLite evidence.db（BM25 / exact anchor）
                    └─► Python embedding service（默认 :9880，可选）
```

### 必需服务

| 服务 | 说明 | 默认地址 | 代码位置 |
|------|------|----------|----------|
| Clowder AI Fastify API | 提供 `/api/evidence/search` 路由 | `http://localhost:3004` | `packages/api/src/routes/evidence.ts:55` |

### 可选服务（影响检索模式）

| 服务 | 说明 | 默认地址 | 缺少时的影响 | 代码位置 |
|------|------|----------|-------------|----------|
| Python embedding service | 向量嵌入 sidecar | `http://127.0.0.1:9880` | `semantic`/`hybrid` 自动降级为 `lexical` | `packages/api/src/domains/memory/EmbeddingService.ts:41-42` |

**只要 Fastify API 在线，MCP server 即可正常工作。**
embedding service 不在线时 `isReady()=false`，fail-open 降级，BM25 全文检索仍然可用。
> 降级逻辑：`packages/api/src/domains/memory/EmbeddingService.ts:62-64`（catch → `ready=false`）
> 降级判断：`packages/api/src/domains/memory/SqliteEvidenceStore.ts:234-235`（`embeddingAvailable` 为 false 时走 lexical 分支）

---

## 环境变量

| 变量 | 必须 | 默认值 | 说明 | 代码位置 |
|------|------|--------|------|----------|
| `CAT_CAFE_API_URL` | 否 | `http://localhost:3004` | Fastify API 地址 | `packages/evidence-mcp/src/tool.ts:11` |
| `EMBED_PORT` | 否 | `9880` | embedding sidecar 端口（API 侧读取） | `packages/api/src/domains/memory/EmbeddingService.ts:41` |
| `EMBED_URL` | 否 | `http://127.0.0.1:{EMBED_PORT}` | embedding sidecar 完整地址，优先于 EMBED_PORT | `packages/api/src/domains/memory/EmbeddingService.ts:42` |

---

## 安装与构建

```bash
# 在 monorepo 根目录
pnpm install
pnpm --filter @cat-cafe/evidence-mcp build
```

构建产物输出至 `packages/evidence-mcp/dist/`。
> 构建配置：`packages/evidence-mcp/tsconfig.json`

---

## MCP 客户端配置

### Claude Desktop / Cursor

编辑 MCP 配置文件（通常在 `~/.claude/mcp.json` 或客户端设置中）：

```json
{
  "mcpServers": {
    "evidence": {
      "command": "node",
      "args": ["/absolute/path/to/clowder-ai/packages/evidence-mcp/dist/index.js"],
      "env": {
        "CAT_CAFE_API_URL": "http://localhost:3004"
      }
    }
  }
}
```

> stdio transport 启动：`packages/evidence-mcp/src/index.ts:25,27`
> 入口点检测（import 时不自动启动）：`packages/evidence-mcp/src/index.ts:31-38`

### 直接运行（调试）

```bash
# 运行 server（会监听 stdio）
node packages/evidence-mcp/dist/index.js

# 测试 tools/list（需要 API 在线）
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
  | node packages/evidence-mcp/dist/index.js
```

---

## 工具说明：cat_cafe_search_evidence

> 工具名称与 description：`packages/evidence-mcp/src/tool.ts:117-125`

### 参数

| 参数 | 类型 | 必须 | 说明 | 代码位置 |
|------|------|------|------|----------|
| `query` | string | 是 | 搜索关键词或自然语言描述 | `packages/evidence-mcp/src/tool.ts:31` |
| `limit` | number | 否 | 返回结果数，1–20，默认 5 | `packages/evidence-mcp/src/tool.ts:32` / 路由校验 `packages/api/src/routes/evidence.ts:15` |
| `scope` | enum | 否 | 搜索范围，见下表 | `packages/evidence-mcp/src/tool.ts:33-38` / 路由校验 `packages/api/src/routes/evidence.ts:17` |
| `mode` | enum | 否 | 检索模式，见下表 | `packages/evidence-mcp/src/tool.ts:39-43` / 路由校验 `packages/api/src/routes/evidence.ts:18` |
| `depth` | enum | 否 | 结果详细程度，默认 `summary` | `packages/evidence-mcp/src/tool.ts:44` / 路由校验 `packages/api/src/routes/evidence.ts:19` |

### scope 取值

| 值 | 含义 | 代码位置 |
|----|------|----------|
| `docs` | features / ADRs / plans / lessons | `packages/api/src/domains/memory/SqliteEvidenceStore.ts:73`（excludeSession=true） |
| `memory` | 同 docs，排除 session + thread | `packages/api/src/domains/memory/SqliteEvidenceStore.ts:73` |
| `threads` | 对话历史（thread 级） | `packages/api/src/domains/memory/SqliteEvidenceStore.ts:68-69`（effectiveKind='thread'） |
| `sessions` | 会话摘要（session 级） | `packages/api/src/domains/memory/SqliteEvidenceStore.ts:70-71`（effectiveKind='session'） |
| `all` | 全部类型，无 kind 过滤 | `packages/api/src/domains/memory/SqliteEvidenceStore.ts:66-72` |

### mode 取值

| 值 | 算法 | 适用场景 | 代码位置 |
|----|------|----------|----------|
| `lexical`（默认） | FTS5 BM25，title 权重 5.0 / summary 权重 1.0 | Feature ID、精确词（F042、Redis） | `packages/api/src/domains/memory/SqliteEvidenceStore.ts:117-118,238` |
| `hybrid` | BM25 + 向量 NN + RRF（k=60） | **大多数场景推荐**，同时命中精确和语义 | `packages/api/src/domains/memory/SqliteEvidenceStore.ts:253-262,358-421` |
| `semantic` | 纯向量 NN，L2 距离升序 | 跨语言检索（英文 query → 中文文档）、同义词匹配 | `packages/api/src/domains/memory/SqliteEvidenceStore.ts:242-250,297-342` |

> 不确定用哪种时，选 `mode=hybrid`。
> mode 缺省值：`packages/api/src/domains/memory/SqliteEvidenceStore.ts:234`（`options?.mode ?? 'lexical'`）

### 输出格式

> 格式化逻辑：`packages/evidence-mcp/src/tool.ts:97-103`

```
Found 2 result(s):

[mid] F102 — SQLite Evidence Store
  anchor: docs/features/F102.md
  type: decision
  > 全文检索 + 向量检索双路召回，hybrid 模式使用 RRF 融合...

[mid] ADR-012 — 选择 sqlite-vec 作为向量存储
  anchor: docs/decisions/ADR-012.md
  type: decision
  > 考量了 pgvector / Chroma / sqlite-vec，最终选择...
```

置信度标签含义：

| 标签 | 含义 | 代码位置 |
|------|------|----------|
| `[mid]` | 正常检索结果（当前所有成功路径均为此级） | `packages/api/src/routes/evidence.ts:71`（`confidence: 'mid' as const`，写死） |
| `[DEGRADED]` | Fastify API 异常，结果不完整或为空 | `packages/evidence-mcp/src/tool.ts:67,72` / `packages/api/src/routes/evidence.ts:79-84` |

> `'high'` 当前无任何产生路径；`'low'` 仅通过 `validateAnchors()` / `searchDocs()` 可产生，但这两个函数当前未被路由调用。
> 参见：`packages/api/src/routes/evidence-helpers.ts:118,61`

---

## 与完整 MCP server 的区别

| 对比项 | `@cat-cafe/mcp-server` | `@cat-cafe/evidence-mcp` | 代码位置 |
|--------|------------------------|--------------------------|----------|
| 包含工具数 | 全套（collab + memory + signals + limb） | 仅 `cat_cafe_search_evidence` | `packages/mcp-server/src/server-toolsets.ts:23-38` |
| evidence 工具所在 toolset | `memoryTools` | 独立 server | `packages/mcp-server/src/server-toolsets.ts:30-35` |
| 内部依赖 | `@cat-cafe/shared` | 无（零内部依赖） | `packages/mcp-server/package.json:16` vs `packages/evidence-mcp/package.json` |
| 启动入口 | `packages/mcp-server/src/index.ts:22-26` | `packages/evidence-mcp/src/index.ts:15-29` | — |
| 环境变量 | 多个（Redis、API、callback 等） | 只需 `CAT_CAFE_API_URL` | `packages/evidence-mcp/src/tool.ts:11` |
