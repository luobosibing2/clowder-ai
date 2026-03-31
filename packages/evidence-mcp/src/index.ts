#!/usr/bin/env node

/**
 * Clowder AI — Evidence MCP Server
 * 独立 MCP server，只暴露 cat_cafe_search_evidence 工具。
 * 通过环境变量 CAT_CAFE_API_URL 指向 Fastify API（默认 http://localhost:3004）。
 */

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
