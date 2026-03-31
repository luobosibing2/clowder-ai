# 计划：创建独立 Evidence MCP Server 包

## Context

当前 `cat_cafe_search_evidence` 工具嵌在 `packages/mcp-server`（all-in-one 服务）的 `memoryTools` 中。
用户需要将其提取为一个独立 MCP server 包，可单独运行，原有代码不改动。

---

## 目标结构

```
packages/evidence-mcp/
├─ src/
│   ├─ index.ts     MCP server 入口（stdio transport）
│   └─ tool.ts      evidence search 工具逻辑
├─ package.json
└─ tsconfig.json
```

---

## 新包依赖

只需两个外部依赖，不依赖任何内部 `@cat-cafe/*` 包：
- `@modelcontextprotocol/sdk` — MCP server + stdio transport
- `zod` — schema 定义

---

## 文件内容

### package.json

```json
{
  "name": "@cat-cafe/evidence-mcp",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "bin": { "evidence-mcp": "./dist/index.js" },
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/index.ts",
    "start": "node dist/index.js",
    "clean": "rm -rf dist",
    "lint": "tsc --noEmit"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "tsx": "^4.7.0",
    "typescript": "^5.3.3"
  }
}
```

### tsconfig.json

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### src/tool.ts

将 `evidence-tools.ts` 的逻辑原样复制，唯一变化：
- 不再 `import { errorResult, successResult } from './file-tools.js'`
- 在文件顶部内联定义 `ToolResult` / `errorResult` / `successResult`（三行，与原 file-tools.ts 完全一致）

逻辑零改动：schema、handleSearchEvidence、evidenceTools 导出全部保留。

### src/index.ts

```typescript
#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { evidenceTools } from './tool.js';

async function main(): Promise<void> {
  const server = new McpServer({ name: 'cat-cafe-evidence', version: '0.1.0' });

  for (const tool of evidenceTools) {
    server.tool(tool.name, tool.description, tool.inputSchema, async (args) => {
      const result = await tool.handler(args as never);
      return result as { content: Array<{ type: 'text'; text: string }>; isError?: boolean };
    });
  }

  const transport = new StdioServerTransport();
  console.error('[evidence-mcp] starting...');
  await server.connect(transport);
  console.error('[evidence-mcp] running on stdio');
}

const isEntryPoint =
  process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isEntryPoint) {
  main().catch((err) => {
    console.error('[evidence-mcp] fatal:', err);
    process.exit(1);
  });
}
```

---

## 不改动的文件

- `packages/mcp-server/src/tools/evidence-tools.ts` — 原封不动
- `packages/mcp-server/src/tools/index.ts` — 原封不动
- `packages/mcp-server/src/server-toolsets.ts` — 原封不动
- `packages/mcp-server/src/index.ts` — 原封不动

---

## 执行步骤

1. 新建 `packages/evidence-mcp/package.json`
2. 新建 `packages/evidence-mcp/tsconfig.json`
3. 新建 `packages/evidence-mcp/src/tool.ts`（复制逻辑 + 内联 helper）
4. 新建 `packages/evidence-mcp/src/index.ts`（MCP server 入口）

---

## 验证方式

```bash
# 安装依赖
pnpm install

# 构建
pnpm --filter @cat-cafe/evidence-mcp build

# 手动测试（需要 API 运行在 3004）
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node packages/evidence-mcp/dist/index.js

# 在 MCP 客户端配置中指向新入口
node packages/evidence-mcp/dist/index.js
```
