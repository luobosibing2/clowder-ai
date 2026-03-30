---
feature_ids: [F102]
topics: [evidence, confidence, governance, memory]
doc_kind: architecture
created: 2026-03-23
updated: 2026-03-30
---

# 置信度与依据系统架构文档

## 1. 概述

Clowder AI 中猫猫的回答始终附带"依据"和"置信度等级"，这并非单一功能点，而是一套**贯穿七个技术层级**的协同设计体系。从行为规则注入、检索管线标注、数据模型传递、到前端 UI 可视化，形成了完整的"证据闭环"。

核心设计哲学：**不信任 AI 的"凭空回答"，所有结论都必须可追溯、可验证，且置信度从数据源到展示层一路透传。**

### 架构总览

```
┌─────────────────────────────────────────────────────────┐
│  Layer 1: System Prompt 行为铁律                         │
│  (shared-rules.md → GOVERNANCE_L0_DIGEST)               │
├─────────────────────────────────────────────────────────┤
│  Layer 2: Governance Pack 外部传播                       │
│  (governance-pack.ts → CLAUDE.md/AGENTS.md/GEMINI.md)   │
├─────────────────────────────────────────────────────────┤
│  Layer 3: Evidence 检索工具 + 置信度标注                  │
│  (evidence-tools.ts ↔ evidence.ts ↔ evidence-helpers.ts)│
├─────────────────────────────────────────────────────────┤
│  Layer 4: 数据模型层                                     │
│  (chat-types.ts: EvidenceData / EvidenceResultData)      │
├─────────────────────────────────────────────────────────┤
│  Layer 5: UI 展示层                                      │
│  (EvidenceCard.tsx + EvidencePanel.tsx)                  │
├─────────────────────────────────────────────────────────┤
│  Layer 6: 记忆蒸馏层                                     │
│  (AbstractiveSummaryClient.ts → schema.ts)               │
├─────────────────────────────────────────────────────────┤
│  Layer 7: 意图卡片层                                     │
│  (intent-card.ts: IntentCard.confidence)                 │
└─────────────────────────────────────────────────────────┘
```

---

## 2. Layer 1：System Prompt 行为铁律

### 2.1 真相来源

行为规则的单一真相源是 `cat-cafe-skills/refs/shared-rules.md`。其中与置信度/依据直接相关的有三条核心原则。

#### P5. 可验证才算完成

> 文件位置：`cat-cafe-skills/refs/shared-rules.md:49-57`

```
LL-006："工程沟通的最小诚信单位是'可复现证据'，不是'信心表达'。"

说"完成了"必须附证据（测试通过、截图、日志）。没有验证 = 没有完成。

推论：Bug 先红后绿（先有失败用例再修）。前端功能产出截图。Review 附复现步骤。
```

**Fail-closed 证据契约**（第 57 行）是关键约束：

> 凡是 bug 诊断、`fixed`、`没问题`、`完美`、`完成了` 这类结论性声明，必须附本轮实际检查过的证据（文件路径+行号、测试输出、截图）。拿不出证据，只能说"还没查完"并继续查。

这意味着猫猫如果无法提供证据，**不允许给出确定性结论**，只能回复"还没查完"。

#### 规则 16. 实事求是

> 文件位置：`cat-cafe-skills/refs/shared-rules.md:357-363`

```
结论必须基于多源证据，不能只看一个文件就下判断。

- 查证据链：.md 只是入口——顺藤摸瓜查 commit、PR、代码、讨论，直到理解全貌
- 不断章取义：一个文件可能是链条的一环，看到引用/依赖就跟进，不要半路停下
- 证据不够就说："我还没查完" / "不确定" — 永远好过编一个看似合理的答案
```

### 2.2 注入机制

上述规则通过 `SystemPromptBuilder.ts` 中的 `GOVERNANCE_L0_DIGEST` 常量**编译为精简摘要**，注入到每个猫猫的每次调用中。

> 文件位置：`packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts:232-251`

```typescript
/**
 * L0 Governance Digest — always-on first principles & operational floor.
 * Compiled from cat-cafe-skills/refs/shared-rules.md (single source of truth).
 * F086 post-completion: cats couldn't see shared-rules content, only a link.
 * Design decision: inject compact L0 digest, not full text. See F086 spec.
 */
const GOVERNANCE_L0_DIGEST = `## 家规（shared-rules.md）
原则：P1每步产物是终态基座不是脚手架 P2自主跑完SOP不每步问铲屎官
(...) P5可验证才算完成
世界观：W1猫是Agent不是API (...)
  W7 Knowledge Feed自动提取知识，猫不写标签——主动澄清决策/教训是否成立+提醒铲屎官看Feed
  W8共享视图——产物端上桌：写完文件/页面/报告→主动用navigate/preview/rich block帮铲屎官打开
纪律：(...) 实事求是——结论基于多源证据（代码+commit+PR+文档），
顺藤摸瓜查完再下判断，不够就说"还没查完"
(...)
质量覆盖：
- Bug先定位根因再修，禁止猜测修补
- 不确定方向：停→搜→问→确认→再动手，禁止"先做了再说"
- "完成"附证据（测试/截图/日志）。Bug先红后绿
- scope失控→记录；同类错误→提案；有价值经验→Episode→蒸馏→Eval`;
```

其中 W7（Knowledge Feed）与置信度系统有直接关联：Knowledge Feed 自动提取知识后，猫猫需要主动澄清决策/教训是否成立，这是 `DurableCandidate.confidence` 的上游人工确认环节。

**设计决策**：不注入全文（太长），而是编译为精简摘要。这样既保证了每次调用都能看到核心规则，又不浪费 context window。

---

## 3. Layer 2：Governance Pack 外部传播

### 3.1 作用范围

Governance Pack 将核心规则自动注入到外部项目的 AI 配置文件中（`CLAUDE.md`、`AGENTS.md`、`GEMINI.md`），确保猫猫在操作外部项目时也遵守证据纪律。

> 文件位置：`packages/api/src/config/governance/governance-pack.ts:33-36`

```typescript
const HARD_CONSTRAINTS = `(...)
### Quality Discipline (overrides "try simplest approach first")
- **Bug: find root cause before fixing**. No guess-and-patch.
  Steps: reproduce → logs → call chain → confirm root cause → fix
- **Uncertain direction: stop → search → ask → confirm → then act**.
  Never "just try it first"
- **"Done" requires evidence** (tests pass / screenshot / logs).
  Bug fix = red test first, then green`;
```

### 3.2 传播机制

`getGovernanceManagedBlock()` 函数将上述规则包装为 managed block，写入目标项目的 provider 指令文件。通过 `computePackChecksum()` 实现幂等性 — 内容未变则跳过写入。

---

## 4. Layer 3：Evidence 检索工具与置信度标注

### 4.1 类型定义

> 文件位置：`packages/api/src/routes/evidence-helpers.ts:1-15`

```typescript
export type EvidenceSourceType = 'decision' | 'phase' | 'discussion' | 'commit';
export type EvidenceConfidence = 'high' | 'mid' | 'low';
export type EvidenceStatus = 'draft' | 'pending' | 'published' | 'archived';

export interface EvidenceResult {
  title: string;
  anchor: string;
  snippet: string;
  confidence: EvidenceConfidence;
  sourceType: EvidenceSourceType;
  status?: EvidenceStatus;
}
```

置信度共三个等级：

| 等级 | 含义 | 赋值场景 |
|------|------|----------|
| `high` | 高置信度 | 预留给未来的高质量验证通过的结果 |
| `mid` | 中置信度 | SQLite evidence store 正常搜索的默认值 |
| `low` | 低置信度 | 降级搜索或锚点失效时自动降级 |

### 4.2 API 路由 — 默认赋值

> 文件位置：`packages/api/src/routes/evidence.ts:54-86`

```typescript
export const evidenceRoutes: FastifyPluginAsync<EvidenceRoutesOptions> = async (app, opts) => {
  app.get('/api/evidence/search', async (request, reply) => {
    const { q, limit, scope, mode, depth } = parseResult.data;
    const items = await opts.evidenceStore.search(q, { ... });
    const results: EvidenceResult[] = items.map((item) => ({
      title: item.title,
      anchor: item.anchor,
      snippet: item.summary ?? '',
      confidence: 'mid' as const,       // ← 默认中置信度
      sourceType: (item.kind === 'decision'
        ? 'decision'
        : item.kind === 'plan'
          ? 'phase'
          : 'discussion') as EvidenceResult['sourceType'],
    }));
    return { results, degraded: false };
  });
};
```

正常路径下所有结果默认为 `'mid'`。当 evidence store 出错时返回 `degraded: true`。

### 4.3 置信度降级机制

置信度不是固定不变的，有两个自动降级场景：

#### 场景一：降级搜索（Degraded Search）

> 文件位置：`packages/api/src/routes/evidence-helpers.ts:60-112`

当 SQLite evidence store 不可用（网络错误、超时等）时，系统 fallback 到本地 docs 目录直接 grep 搜索。此时所有结果的置信度强制设为 `'low'`：

```typescript
export async function searchDocs(docsRoot: string, query: string, limit: number):
  Promise<EvidenceResult[]> {
  // ... 遍历 docs/decisions, docs/phases, docs/discussions ...
  results.push({
    title: firstLine,
    anchor: relPath,
    snippet,
    confidence: 'low',        // ← 降级搜索 = 低置信度
    sourceType: classifySource(relative('', relPath)),
  });
}
```

降级条件由 `shouldDegradeToDocs()` 判断：

```typescript
export function shouldDegradeToDocs(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('etimedout') ||
      msg.includes('timeout') ||
      msg.includes('aborted') ||
      msg.includes('network') ||
      msg.includes('fetch failed')
    );
  }
  return false;
}
```

#### 场景二：锚点验证失败（Anchor Validation）

> 文件位置：`packages/api/src/routes/evidence-helpers.ts:114-141`

搜索结果引用的文档文件如果在磁盘上已不存在（被删除或移动），置信度自动降为 `'low'`：

```typescript
export async function validateAnchors(
  results: EvidenceResult[], docsRoot: string
): Promise<EvidenceResult[]> {
  return Promise.all(
    results.map(async (result) => {
      if (!result.anchor.startsWith('docs/')) return result;
      // ... 解析路径 ...
      try {
        await access(filePath);    // 文件存在 → 保持原置信度
        return result;
      } catch {
        return { ...result, confidence: 'low' as EvidenceConfidence };
        // ↑ 文件不存在 → 降级为 low
      }
    }),
  );
}
```

**设计理念**：不删除结果（搜索结果本身可能仍有参考价值），只降低信任信号。

### 4.4 MCP 工具 — 猫猫可见的格式

> 文件位置：`packages/mcp-server/src/tools/evidence-tools.ts:77-110`

猫猫通过 `cat_cafe_search_evidence` MCP 工具调用搜索，返回文本格式直接包含置信度标签：

```typescript
for (const r of data.results) {
  lines.push(`[${r.confidence}] ${r.title}`);    // 例：[mid] F102 Memory Adapter
  lines.push(`  anchor: ${r.anchor}`);
  lines.push(`  type: ${r.sourceType}`);
  const snippet = r.snippet.length > 200
    ? `${r.snippet.slice(0, 200)}...` : r.snippet;
  lines.push(`  > ${snippet.replace(/\n/g, ' ')}`);
}
```

工具描述中还包含了 **mode 选择指南**，引导猫猫选择合适的检索模式：

```
MODE SELECTION:
- lexical (default) = BM25 keyword match, best for Feature IDs / exact terms (F042, Redis)
- hybrid = BM25 + vector NN + RRF fusion, RECOMMENDED for most searches
- semantic = pure vector nearest-neighbor, best for cross-language or synonym matching
TIP: When unsure, use mode=hybrid.
```

这意味着猫猫在使用 `hybrid` 或 `semantic` 模式时，检索结果的语义准确性可能更高，但当前所有模式返回的置信度仍统一为 `'mid'`（未来可根据模式区分赋值）。

猫猫在 context 中看到的是这样的文本：

```
Found 3 result(s):

[mid] F102 Phase D — Evidence Search Pipeline
  anchor: docs/features/F102-memory-adapter.md
  type: decision
  > 统一检索入口，支持 scope/mode/depth 分层...

[low] F086 Shared Rules Injection
  anchor: docs/features/F086-shared-rules.md
  type: discussion
  > 猫猫无法直接看到 shared-rules 内容...
```

这使猫猫能够根据置信度等级判断是否需要进一步查证。

---

## 5. Layer 4：数据模型层

### 5.1 ChatMessage 中的 Evidence 字段

> 文件位置：`packages/web/src/stores/chat-types.ts:42-54, 191-214`

Evidence 是 `ChatMessage` 的一等字段，与消息内容同级传递：

```typescript
export interface EvidenceResultData {
  title: string;
  anchor: string;
  snippet: string;
  confidence: 'high' | 'mid' | 'low';
  sourceType: 'decision' | 'phase' | 'discussion' | 'commit';
}

export interface EvidenceData {
  results: EvidenceResultData[];
  degraded: boolean;
  degradeReason?: string;
}

export interface ChatMessage {
  id: string;
  type: 'user' | 'assistant' | 'system' | 'summary' | 'connector';
  variant?: 'error' | 'info' | 'tool' | 'evidence' | 'a2a_followup'
          | 'governance_blocked';
  // ...
  evidence?: EvidenceData;    // ← Evidence 作为一等字段
}
```

当 `variant` 为 `'evidence'` 时，前端渲染 `EvidencePanel` 组件而非普通消息气泡。

### 5.2 数据流

```
SQLite FTS5 → evidence.ts (API) → WebSocket → chat store → EvidencePanel → EvidenceCard
                 ↓                                              ↑
          confidence: 'mid'                              confidence badge
          (+ validateAnchors)                          (高/中/低 + 颜色)
```

---

## 6. Layer 5：UI 展示层

### 6.1 EvidenceCard — 单条证据卡片

> 文件位置：`packages/web/src/components/EvidenceCard.tsx:49-60`

每条搜索结果渲染为一个卡片，右上角显示彩色置信度徽章：

```typescript
const CONFIDENCE_STYLES: Record<EvidenceConfidence, {
  bg: string; text: string; label: string
}> = {
  high: {
    bg: 'bg-emerald-900/50',
    text: 'text-emerald-300',
    label: '高置信度'          // 绿色
  },
  mid: {
    bg: 'bg-amber-900/50',
    text: 'text-amber-300',
    label: '中置信度'          // 黄色
  },
  low: {
    bg: 'bg-slate-700',
    text: 'text-slate-400',
    label: '低置信度'          // 灰色
  },
};
```

卡片结构：

```
┌──────────────────────────────────────┐
│ [决策图标]  F102 Phase D ...  [中置信度] │
│                                      │
│ 统一检索入口，支持 scope/mode/...      │
│                                      │
│ 决策 · docs/features/F102-...md      │
└──────────────────────────────────────┘
```

来源类型也有独立图标和中文标签：

```typescript
const SOURCE_CONFIG = {
  decision: { icon: DecisionIcon, label: '决策' },
  phase:    { icon: PhaseIcon,    label: '阶段' },
  discussion: { icon: DiscussionIcon, label: '讨论' },
  commit:   { icon: CommitIcon,   label: '提交' },
};
```

> 注：卡片中的辅助 CSS class 已迁移到设计系统 token（如 `text-cafe-muted`、`bg-cafe-surface-elevated`），但置信度徽章仍使用语义化的 Tailwind 颜色（emerald/amber/slate），保持视觉辨识度。

### 6.2 EvidencePanel — 证据面板

> 文件位置：`packages/web/src/components/EvidencePanel.tsx:1-58`

面板将多个 `EvidenceCard` 组合展示，标题为 **"Hindsight 检索结果"**：

```typescript
export function EvidencePanel({ data }: { data: EvidenceData }) {
  return (
    <div className="...">
      {/* Header */}
      <span className="...">Hindsight 检索结果</span>
      <span className="...">{data.results.length}</span>

      {/* 降级提示 */}
      {data.degraded && (
        <div className="...">
          "哎呀，有些记忆暂时找不到了，正在为您从本地文档中努力搜寻..."
        </div>
      )}

      {/* 空状态 */}
      {data.results.length === 0 ? (
        <div>喵... 翻遍了猫砂盆也没找到相关证据</div>
      ) : (
        <div>{data.results.map(r => <EvidenceCard result={r} />)}</div>
      )}
    </div>
  );
}
```

降级场景的 UX 处理：

| 状态 | 显示 |
|------|------|
| 正常搜索 | 标题 + 结果卡片列表 |
| 降级搜索（`degraded: true`） | 黄色警告 + "哎呀..." 提示 + 卡片（`低置信度`） |
| 无结果 | "喵... 翻遍了猫砂盆也没找到相关证据" |

---

## 7. Layer 6：记忆蒸馏层

### 7.1 话题分段置信度

> 文件位置：`packages/api/src/domains/memory/AbstractiveSummaryClient.ts:16-27`

当系统将聊天历史压缩为摘要时，每个话题分段（`TopicSegment`）都带有边界置信度：

```typescript
export interface TopicSegment {
  summary: string;
  topicKey: string;
  topicLabel: string;
  boundaryReason: string;
  boundaryConfidence: 'high' | 'medium' | 'low';   // ← 边界置信度
  fromMessageId: string;
  toMessageId: string;
  messageCount: number;
  relatedSegmentIds?: string[];
  candidates?: DurableCandidate[];
}
```

该值持久化到 SQLite：

> 文件位置：`packages/api/src/domains/memory/schema.ts:124`

```sql
boundary_confidence TEXT DEFAULT 'medium',
```

### 7.2 持久化候选项置信度

> 文件位置：`packages/api/src/domains/memory/AbstractiveSummaryClient.ts:29-37`

从对话中提取的长期知识（决策、教训、方法）各自带有置信度：

```typescript
export interface DurableCandidate {
  kind: 'decision' | 'lesson' | 'method';
  title: string;
  claim: string;
  why_durable: string;
  evidence: Array<{
    threadId: string;
    messageId: string;
    span: string;           // ← 原始文本片段
  }>;
  relatedAnchors: string[];
  confidence: 'explicit' | 'inferred';   // ← 二元置信度
}
```

置信度判定规则由 system prompt 指定（第 62-63 行）：

| 等级 | 条件 |
|------|------|
| `explicit` | 标签带 `!` 后缀（如 `[decision!]`）—— 负责人/CVO 明确确认 / 团队共识 / 已合入代码或文档 |
| `inferred` | 标签不带 `!`（如 `[decision]`）—— 其余所有情况 |

**设计理念**：长期知识的置信度用二元判定而非三级，因为只有"有明确决策依据"和"推断得出"的区别对长期存储有意义。

### 7.3 自然语言输出 + 程序解析架构

记忆蒸馏层采用了"**LLM 输出自然语言，程序负责结构化**"的架构（铲屎官原话："我们就不能让他返回自然语言直接帮他加格式吗？格式就是程序加。"）。

LLM 的输出格式如下：

```markdown
# 讨论标题

200-400 字符的摘要...

## Durable Knowledge (if any)

[decision!] 短标题 — 使用 ! 表示人类明确确认
[decision] 短标题 — 不带 ! 表示推断
[lesson!] / [lesson] — 同样的约定
[method!] / [method] — 同样的约定
```

程序端 `parseNaturalLanguageOutput()` 负责：
1. 从 `#` 标题行提取 `topicLabel`
2. 从标题后到候选项前的文本提取 `summary`
3. 通过正则 `extractCandidates()` 提取 `[kind!?]` 标签

> 文件位置：`packages/api/src/domains/memory/AbstractiveSummaryClient.ts:218-246`

```typescript
function extractCandidates(text: string, input: AbstractiveInput): DurableCandidate[] {
  const candidates: DurableCandidate[] = [];
  // Match [decision!] (explicit) or [decision] (inferred)
  const candidateRegex = /\[(decision|lesson|method)(!?)\]\s*(.+?)(?:\s*[—–-]\s*(.+))?$/gim;
  let match;
  while ((match = candidateRegex.exec(text)) !== null) {
    const kind = match[1].toLowerCase() as 'decision' | 'lesson' | 'method';
    const isExplicit = match[2] === '!';   // ← ! 后缀 = explicit
    const title = match[3].trim();
    const claim = match[4]?.trim() || title;
    if (isImplementationNoise(title, claim)) continue;  // ← 噪声过滤
    candidates.push({
      kind, title, claim,
      why_durable: 'Extracted from thread summary',
      evidence: [{ threadId: input.threadId, messageId: input.messages[0]?.id ?? '', span: '' }],
      relatedAnchors: [],
      confidence: isExplicit ? 'explicit' : 'inferred',
    });
  }
  // Cap: explicit 优先，最多保留 2 个
  if (candidates.length > MAX_CANDIDATES_PER_SEGMENT) {
    candidates.sort((a, b) =>
      (a.confidence === 'explicit' ? 0 : 1) - (b.confidence === 'explicit' ? 0 : 1));
    candidates.length = MAX_CANDIDATES_PER_SEGMENT;
  }
  return candidates;
}
```

### 7.4 实现噪声过滤（Implementation Noise Gate）

> 文件位置：`packages/api/src/domains/memory/AbstractiveSummaryClient.ts:194-213`

为了防止 LLM 把代码变更细节（如"加了 mkdirSync"）当作持久知识提取，系统有一个**噪声过滤门**：

```typescript
export function isImplementationNoise(title: string, claim: string): boolean {
  const text = `${title} ${claim}`;
  if (title.length < MIN_TITLE_LENGTH) return true;       // 标题太短
  if (CODE_ACTION_RE.test(title)) return true;             // 代码动作词开头
  if (FILE_EXT_RE.test(title)) return true;                // 包含文件扩展名
  if (CODE_IDENT_RE.test(title)) return true;              // 包含驼峰标识符
  const artifactHits = (text.match(CODE_ARTIFACT_RE) || []).length;
  return artifactHits >= 2;                                 // 多个代码工件名
}
```

过滤规则：

| 规则 | 匹配示例 | 目的 |
|------|---------|------|
| `CODE_ACTION_RE` | "加了..." "修复..." "rewrote..." | 排除代码动作描述 |
| `FILE_EXT_RE` | "*.tsx" "*.mjs" | 排除文件级变更 |
| `CODE_IDENT_RE` | "writeFileSync" "parseNaturalLanguageOutput" | 排除代码标识符 |
| `CODE_ARTIFACT_RE` ×2 | "regex + parser" | 排除多代码工件堆叠 |

### 7.5 Knowledge Admission Standards（知识准入标准）

System prompt 还定义了三问门槛（第 79-83 行），LLM 在提取候选项前必须自问：

1. **3 个月后新成员是否受益？** — 临时性知识不提取
2. **脱离当前文件/PR/Bug 是否仍成立？** — 上下文绑定的知识不提取
3. **能否防止未来重复争论或重复犯错？** — 一次性事件不提取

并附有 GOOD/BAD 对照表：

| 类型 | BAD（不提取） | GOOD（提取） |
|------|-------------|-------------|
| decision | "Rewrote JSON parser to use parseNaturalLanguageOutput" | "Knowledge Feed uses YAML as truth source, not SQLite — for git-trackability" |
| lesson | "writeFileSync throws ENOENT when directory does not exist" | "Fail-open catch blocks must log errors, not silently swallow" |
| method | "Used JSON.parse to extract candidates" | "Let the model output natural language; program adds structural fields afterward" |

---

## 8. Layer 7：意图卡片层

### 8.1 需求级别的数值置信度

> 文件位置：`packages/shared/src/types/intent-card.ts:34-52`

每个产品需求（IntentCard）都有 1-3 的数值置信度：

```typescript
export interface IntentCard {
  readonly id: string;
  readonly projectId: string;

  // Core slots (6)
  readonly actor: string;
  readonly contextTrigger: string;
  readonly goal: string;
  readonly objectState: string;
  readonly successSignal: string;
  readonly nonGoal: string;

  // Metadata
  readonly sourceTag: SourceTag;
  readonly confidence: 1 | 2 | 3;           // ← 需求置信度
  readonly riskSignals: readonly RiskSignal[];
  // ...
}
```

`TriageResult` 中的多个维度也使用 1-3 评分：

```typescript
export interface TriageResult {
  readonly clarity: 1 | 2 | 3;        // 需求清晰度
  readonly groundedness: 1 | 2 | 3;   // 需求根据性
  readonly necessity: 1 | 2 | 3;      // 必要性
  readonly coupling: 1 | 2 | 3;       // 耦合度
  readonly sizeBand: SizeBand;
  readonly bucket: TriageBucket;
  readonly resolutionPath: ResolutionPath;
}
```

### 8.2 风险信号

`RiskSignal` 类型定义了可自动检测的风险信号，每个也带有 severity：

```typescript
export type RiskSignal =
  | 'hollow_verbs'              // 空洞动词
  | 'missing_actors'            // 缺少行为主体
  | 'unknown_data_source'       // 未知数据来源
  | 'missing_success_signal'    // 缺少成功信号
  | 'missing_edge_cases'        // 缺少边界情况
  | 'hidden_dependencies'       // 隐藏依赖
  | 'ai_fake_specificity'       // AI 伪精确性
  | 'scope_creep';              // 范围蔓延

export interface RiskDetectionResult {
  readonly signal: RiskSignal;
  readonly severity: 'critical' | 'high' | 'medium';
  readonly evidence: string;     // ← 风险也必须有证据
  readonly autoDetected: boolean;
}
```

---

## 9. 各层置信度类型对比

| 层级 | 置信度类型 | 取值范围 | 用途 |
|------|-----------|---------|------|
| System Prompt | 行为规则 | 布尔（有/无证据） | 控制猫猫是否能下结论 |
| Evidence Search | `EvidenceConfidence` | `'high' \| 'mid' \| 'low'` | 标注搜索结果可靠度 |
| Chat Message | `EvidenceData.confidence` | `'high' \| 'mid' \| 'low'` | 前端展示传递 |
| UI Badge | 颜色编码 | 绿/黄/灰 | 用户可视化 |
| Topic Segment | `boundaryConfidence` | `'high' \| 'medium' \| 'low'` | 话题分段边界确定性 |
| Durable Candidate | `confidence` | `'explicit' \| 'inferred'` | 长期知识可靠度 |
| Intent Card | `confidence` | `1 \| 2 \| 3` | 需求确定性数值评分 |
| Risk Detection | `severity` | `'critical' \| 'high' \| 'medium'` | 风险严重程度 |

---

## 10. 数据流全景

```
用户提问
  │
  ▼
猫猫 System Prompt（含 GOVERNANCE_L0_DIGEST）
  │ "结论基于多源证据，不够就说还没查完"
  │
  ▼
cat_cafe_search_evidence (MCP Tool)
  │
  ▼
GET /api/evidence/search
  │
  ├─ 正常路径 → SQLite FTS5 搜索 → confidence: 'mid'
  │                                    │
  │                              validateAnchors()
  │                                    │
  │                              文件存在 → 保持 'mid'
  │                              文件缺失 → 降级 'low'
  │
  └─ 异常路径 → shouldDegradeToDocs()
                    │
                    ▼
               searchDocs() → confidence: 'low'
                              degraded: true
  │
  ▼
WebSocket 推送到前端
  │
  ├─ ChatMessage.evidence = EvidenceData
  │
  ▼
EvidencePanel
  ├─ Header: "Hindsight 检索结果"
  ├─ 降级警告（如有）
  └─ EvidenceCard × N
       └─ 置信度徽章：高置信度(绿) / 中置信度(黄) / 低置信度(灰)
```

---

## 11. 设计决策与权衡

### 11.1 为什么默认是 `mid` 而非 `high`？

SQLite FTS5 搜索基于词法匹配，语义准确性有限。默认 `mid` 表示"内容相关但需进一步验证"，留给未来语义搜索（`mode: 'semantic'` 或 `mode: 'hybrid'`）提升到 `high` 的空间。

### 11.2 为什么降级不删除结果？

`validateAnchors()` 只降低置信度不删除结果，因为：
- 文件可能被重命名而非删除，内容仍有参考价值
- 降级结果仍可帮助猫猫定位线索
- 删除会导致"静默丢失"，不如显式标注

### 11.3 为什么记忆层用 `explicit/inferred` 而非三级？

长期知识只需要区分"有明确决策支撑"和"推断得出"。三级会引入模糊的中间地带，对于持久化存储来说，二元判定更容易维护和检索。

### 11.4 为什么行为规则是"编译注入"而非"全文引用"？

`GOVERNANCE_L0_DIGEST` 是 `shared-rules.md` 的精简编译版。全文约 400+ 行，直接注入会占用大量 context window。精简版约 20 行，覆盖了核心规则，是 F086 的设计决策。

---

## 12. 相关文件索引

| 文件 | 职责 |
|------|------|
| `cat-cafe-skills/refs/shared-rules.md` | 行为规则真相源 |
| `packages/api/src/domains/cats/services/context/SystemPromptBuilder.ts` | System prompt 构建 + L0 注入 |
| `packages/api/src/config/governance/governance-pack.ts` | 外部项目规则传播 |
| `packages/api/src/routes/evidence.ts` | Evidence 搜索 API 路由 |
| `packages/api/src/routes/evidence-helpers.ts` | 置信度类型 + 降级 + 锚点验证 |
| `packages/mcp-server/src/tools/evidence-tools.ts` | MCP 工具（猫猫调用入口） |
| `packages/web/src/stores/chat-types.ts` | 数据模型（EvidenceData） |
| `packages/web/src/components/EvidenceCard.tsx` | 单条证据卡片 UI |
| `packages/web/src/components/EvidencePanel.tsx` | 证据面板 UI |
| `packages/api/src/domains/memory/AbstractiveSummaryClient.ts` | 记忆蒸馏 + 候选项置信度 |
| `packages/api/src/domains/memory/schema.ts` | SQLite schema（boundary_confidence） |
| `packages/shared/src/types/intent-card.ts` | 意图卡片（需求级置信度） |
