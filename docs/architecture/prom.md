# CLAUDE.md

## Web Search & Research
- **禁止** 使用 `fetch` 或通用 `search` 工具
- **必须** 使用以下 MCP 工具替代：
  | 工具 | 用途 |
  |------|------|
  | `web_search_exa` | 通用网页搜索 |
  | `web_search_advanced_exa` | 高级搜索（含过滤器、日期范围） |
  | `get_code_context_exa` | 代码示例与文档查找 |
  | `crawling_exa` | 读取指定 URL 完整内容 |
  | `company_research_exa` | 公司信息研究 |
  | `people_search_exa` | 人物信息查找 |
  | `deep_researcher_start` / `deep_researcher_check` | 深度研究任务（异步，需轮询结果） |

## 文档写作规范
1. **存放位置**：所有文档写入 `docs/` 目录
2. **分批写入**：每次写入约 6000 字，超出部分拆分为多次写入
3. **结论置信度**：文档中每个结论必须标注：
   - `【有明确证据支撑】`：附上依据（代码片段或材料摘要）
   - `【推断得出】`：说明推断逻辑
