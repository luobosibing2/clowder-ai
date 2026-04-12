---
topics: [sop, dev-flow, workflow]
doc_kind: guide
created: 2026-04-06
updated: 2026-04-06
---

# Clowder AI 开发流程全解 · Part 2：Quality Gate → 愿景守护

> 接续 [Part 1](./01-dev-flow-part1.md)。本部分覆盖开发完成后的全部流程：自检、review、合入、收尾。

---

## 五、Step ②：Quality Gate（自检门禁）

**位置**：开发完成后，提 review 请求之前。  
**目的**：证明你的实现满足铲屎官的原始愿景，而不只是让 AC checkbox 变绿。

### 铁律

```
NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE
```

"上次跑过" / "应该通过" / "probably works" 都不算证据。必须**这次**真实运行命令并附上输出。

### 完整流程（8 步）

**Step 0：愿景核对（最重要，不可跳过）**

1. 找原始 Discussion/Interview 文档（铲屎官原话所在）
2. 读核心痛点："我要…"、"我不想…"
3. 问自己：铲屎官坐在 Hub 前用这个功能，体验是什么样的？
4. AC 是否完整覆盖了铲屎官的原始需求？有遗漏 → 先补 AC 再继续

F041 教训：12 项 AC 全打勾，但铲屎官的原始需求（UI 可用性、多项目管理）根本没进 AC。  
**AC 是人写的，可能写偏。愿景核对是兜底。**

**Step 0.5：交付完整性检查**

- 这次交付的是完整 feat 还是一部分？是部分 → 有铲屎官明确同意分批的记录吗？没有 → 继续做完。
- 本次产出后续需要"重写"还是"扩展"？需要重写（且不是标注 Spike）→ 不通过，回去重做。

**Step 1–4：找文档 → 建清单 → 逐项检查 → 运行态保护**

- 找 feature spec + Discussion/Interview 文档
- 建检查清单：每个 AC + Discussion 里的 UX 描述 + 边界条件
- 逐项检查：代码在哪？测试覆盖了吗？边界处理了吗？
- 运行态保护：验证前先 `curl -sf http://localhost:3004/health`，复用现有 runtime，禁止在 runtime 会话里重启服务

**Step 5：设计稿对照（自动化检测）**

```bash
glob designs/**/*.pen  # 自动匹配当前 feat 编号
```

- 匹配到 `.pen` 文件 → 强制进入设计稿对照：截设计稿 + 截实现截图 → 逐区域对比（布局/颜色/间距/交互状态）
- 无匹配但有前端 UI 改动 → 报告中标注 "⚠️ 无设计稿，跳过对照"
- **此步骤用命令输出驱动，不靠猫猫"记得"**（三只猫同时跳过 .pen 对照的教训）

**Step 6–7：运行验证命令（必须这次真实运行）**

```bash
pnpm test                       # 必须全部通过
pnpm lint                       # 0 errors
pnpm check                      # 0 errors（biome format + lint）
pnpm -r --if-present run build  # exit 0
# Redis 相关改动额外跑：
pnpm --filter @cat-cafe/api test:redis
```

有 format 问题先跑 `pnpm check:fix` 自动修复。不能带着 biome errors 提 review。

**Step 7.5：Artifact Hygiene**

```bash
git status --short | rg '^\?\? [^/]+\.(png|jpe?g|webm|mp4)$'
```

有输出 → BLOCK：把媒体文件移到 `${TMPDIR}/cat-cafe-evidence/` 再继续。

**Step 8：输出合规报告**

```markdown
## Quality Gate Report
Spec: docs/features/F0xx-name.md
原始需求: feature-discussions/YYYY-MM-DD-xxx/README.md

### 愿景覆盖（Step 0）
| # | 铲屎官原始需求 | AC 覆盖？ | 实现？ |
|---|----------------|-----------|--------|
| 1 | "我要 XXX"     | AC#3      | ✅     |

### 验证命令输出
pnpm test  → 34/34 pass ✅
pnpm lint  → 0 errors ✅
pnpm check → 0 errors ✅
build      → exit 0 ✅
```

---

## 六、Step ③a：Request Review（发 review 请求）

**前置条件（三项缺一不可）**：

| 条件 | 未满足时 |
|------|----------|
| quality-gate 通过，有本轮 gate report | BLOCKED |
| 测试全绿，附这次真实运行输出 | BLOCKED |
| 原始需求可引用（Discussion 路径 + ≤5 行铲屎官原话） | BLOCKED |
| 前端改动已浏览器实测（Playwright/Chrome 截图） | BLOCKED |

**为什么原始需求是必填项**：reviewer 不只审代码质量，还要判断"这是铲屎官要的吗？"没有原始需求，reviewer 无法做愿景验证。F041 教训：10 轮云端 review 全在抓 edge case，没人说"UI 不可用"——因为 review 信里没有原始需求上下文。

### Reviewer 匹配规则

```
优先级（从高到低）：
1. 跨 family（author family ↔ reviewer family）
2. 有 peer-reviewer 角色标记
3. 当前可用（无正在进行的 review 任务）
```

动态从 `cat-config.json` 匹配，禁止 hardcode，禁止自审。

### Review 沙盒约定

review 请求中必须包含 `review-target-id`（从 branch name 提取 feature ID 或 slug），reviewer 按此在 `/tmp/cat-cafe-review/{id}/{reviewer-handle}` 创建只读沙盒。沙盒由 merge-gate Step 8.5 统一回收，不由 reviewer 清理。

---

## 七、Step ③b：Receive Review（处理 review 反馈）

**核心原则**：技术正确性 > 社交舒适。验证后再实现，禁止表演性同意。

### 两类反馈，处理方式不同

| 类型 | 特征 | 处理 |
|------|------|------|
| 代码级 | bug / edge case / 性能 / 命名 | Red→Green 修复 |
| 愿景级 | "这不是铲屎官要的" / "UI 不可用" | STOP → 回读原始需求 → 升级铲屎官 |

愿景级问题不能用代码 patch 修补设计问题。先对照铲屎官原话验证 reviewer 说得对不对；如确实偏离，升级铲屎官确认偏差范围，再重新设计。

### 禁止的响应（表演性同意）

```
❌ "You're absolutely right!"    ❌ "Great point!"
❌ "让我现在就改"（验证之前）
```

行动说明一切。直接修复，代码本身证明你听到了。

### VERIFY 三道门（改代码之前必须过）

1. **Spec Gate**：这条意见和现有 AC/需求冲突吗？冲突 → pushback 附 AC 原文
2. **Mechanism Gate**：reviewer 说"这不行"的证据是什么？只有"不优雅"但没有失败路径 → 当假设处理，pushback 要求证据
3. **Feature Gate**：按建议改完后，核心用户路径还活着吗？功能死了 → 回滚，review 建议作废

### Red→Green 修复流程

```
1. 理解问题
2. 写失败测试（Red）
3. 运行测试，确认红灯
4. 修复代码
5. 运行测试，确认绿灯（Green）
6. 运行完整测试套件，确认无 regression
```

### 修复后确认（硬规则）

```
❌ 错误：修复 → 自己判断"改对了" → 合入 main
✅ 正确：修复 → 回给 reviewer → reviewer 确认 → 进 merge-gate
```

云端 P1 修完必须重新触发云端 review，不能自判通过。

### Push Back 义务

当以下情况时**必须** push back：
- 建议会破坏现有功能
- Reviewer 缺少完整上下文
- 违反 YAGNI（过度设计）
- 建议会让实现更偏离铲屎官原始需求

**Review 有零分歧 = 走过场**。真正的 review 需要技术争论。

### TAKEOVER 降级

Reviewer 发现 author 触发以下任一条件，可宣布 TAKEOVER：
- 连续 3 轮无有效证据增量
- 连续 2 次假绿（声明 fixed 但复验失败）
- 被迫对同一验收点重复验证 2 次

TAKEOVER 后：原 author 停止试错，另一只猫接手修复，接管猫不得自审。

---

## 八、Step ④：Merge Gate（合入主干）

**位置**：reviewer 放行后，合入 main 之前。

### 门禁 5 硬条件（全部满足才能开 PR）

1. Reviewer 有明确放行信号（"放行"/"LGTM"/"通过"）
2. 所有 P1/P2 已修复且经 reviewer 确认
3. Review 针对当前分支（不是历史 review）
4. BACKLOG 涉及条目已在 feature branch 上标 `[x]`
5. `pnpm gate` 全绿（基于最新 `origin/main` rebase 后的全量验证）

### `pnpm gate`——为什么必须在合入前跑

quality-gate 和 request-review 时的测试基于旧 base SHA。并行开发中，其他猫的 PR 合入 main 后可能改变共享契约（类型/接口/store 结构），导致你的代码在新 main 上 break。

`pnpm gate` 在最终合流点做一次全量验证，堵住"每只猫都说绿，合流后一堆红"的系统性漏洞。

### PR 防呆规则

```bash
# PR body 禁止出现任何 @句柄（含 HTML 注释中的签名）
# 云端 review 触发句柄只能写在 PR comment，不能写在 body
```

PR #160 事故教训：PR body 里有 `@句柄`，触发了 `chatgpt-codex-connector` 的自动"Create an environment"回复，云端 review 没有实际执行，流程被噪声污染。

### 云端 review 流程

1. 开 PR → 注册 PR tracking（`cat_cafe_register_pr_tracking`）
2. 在 PR **comment** 中用标准模板触发云端 review（附短 SHA + P1/P2 only 约束）
3. 触发后 5 分钟查 👀（eyes reaction）：有 👀 = 已接单，PR tracking 自动通知；无 👀 = 允许 re-trigger
4. 收到结果：0 P1/P2 → 继续；有 P1/P2 → 修复 → push → 重新触发

**LL-033 教训**：云端 P1/P2 可能在 inline code comments 里，不在 review body 里。merge 前必须额外检查：

```bash
gh api --paginate repos/{OWNER}/{REPO}/pulls/{PR_NUMBER}/comments \
  --jq '.[] | select(.body | test("\\bP[012]\\b"; "i")) | {body: .body[:200], path: .path}'
```

### 合入与清理

```bash
# Squash merge（禁止本地手动 squash）
gh pr merge {PR_NUMBER} --squash --delete-branch

# 更新本地 main
git checkout main && git pull origin main

# 清理 worktree
git worktree remove ../cat-cafe-{feature-name}
git branch -d {branch-name} && git worktree prune

# 回收 review 沙盒
# → 清理 /tmp/cat-cafe-review/{review-target-id}/
```

### Step 7.5：Phase 文档同步（每次 merge 必做）

**为什么在每次 merge 做，而不是等 feature close**：一个 feature 拆 N 个 Phase，如果等 close 才更新文档，中间所有冷启动会话读到的都是过时状态。

每次 merge 后同步：
- feature doc 中本 Phase 标 ✅（📋/🚧 → ✅）
- 本次实际完成的 AC `[ ]` → `[x]`
- Timeline 加 `| {YYYY-MM-DD} | Phase {X} merged (PR #{N}) |`
- 如果是第一个 Phase，Status 行 `spec` → `in-progress`
- Commit：`docs(F{NNN}): sync phase progress after PR #{N} merge`

---

## 九、Step ⑤：愿景守护（Vision Guard）

**触发时机**：feature 最后一个 Phase 的 PR 合入后。  
**执行者**：非作者、非 reviewer 的第三只猫（动态从 `cat-config.json` roster 中选，禁止 hardcode）。

### 愿景三问

1. 铲屎官最初要解决的核心问题是什么？
2. 当前交付物解决了吗？
3. 铲屎官用这个功能的体验如何？

### 对照表（缺表 = BLOCKED）

守护猫必须输出以下格式的对照表：

```markdown
| 铲屎官原话（逐字引用） | 当前实际状态（截图/代码/命令输出） | 匹配？ |
|----------------------|-------------------------------|--------|
| "把旧 mode 删掉"      | [截图: mode 入口已无旧选项]       | ✅     |
| "狼人杀加到 mode 里"   | [截图: mode 入口有狼人杀]         | ✅     |
```

**BLOCKED 条件**：
- 对照表缺失 → BLOCKED
- 对照表中有未匹配项（❌）→ BLOCKED，踢回修改
- 找不到铲屎官原话（Discussion/Interview 缺失）→ BLOCKED，要求补充

### Feature Close 流程

愿景守护通过后，由 feat-lifecycle completion 闭环：
1. AC 全部 `[x]`
2. feature doc → `Status: done`，加 `Completed: YYYY-MM-DD`
3. 考虑演化关系（`Evolved from` / 有明确后续 → 触发新 kickoff）
4. 从 `docs/ROADMAP.md` 移除该行（聚合文件永久保留，不删）
5. Commit：`docs(Fxxx): mark feature as done [{猫猫签名}]`

**Step 0.5：反思胶囊**（愿景对照之后、AC 打勾之前）

每个 milestone/feature 完成都要写，不能省略：
- What Worked / What Failed / Trigger Missed / Doc Links / Rule Update Target
- 保存到 feature-discussions/，feature spec 只挂链接

---

## 十、例外路径

### 跳过云端 review

三个条件**全部满足**才可跳过：
1. 铲屎官在当前对话明确同意
2. 纯文档 / ≤10 行 bug fix / typo
3. 不涉及安全、鉴权、数据、API 变更

### 极微改动直接提交 main（跳过全流程）

四个条件**全部满足**：
1. 纯日志/配置/注释/文档（不涉及业务逻辑）
2. diff ≤ 5 行
3. 类型检查通过
4. 不涉及可测行为

---

## 十一、常见错误对照表

| 错误行为 | 正确做法 | 原则/教训 |
|----------|----------|-----------|
| AC 全打勾就声称完成 | Step 0 先回读铲屎官原话做愿景核对 | F041 教训 |
| "上次跑测试是通过的" | 这次重新跑，附输出 | 证据优先 |
| 只看 spec checkbox 就声称完成/未完成 | 核实 `git log --grep` + `gh pr list` | LL-029 |
| UX 没确认就开 worktree 写代码 | 先过 Design Gate 再动手 | 设计先行 |
| 每步停下来问铲屎官"可以继续吗？" | 全链路自驱，只在阻塞/close 时通知铲屎官 | §17 规则 |
| 修完自判"改对了"直接合入 | 必须回给 reviewer 确认 | 独立验证 |
| review 信只附 spec，不附原始需求 | 必须附铲屎官 Discussion 摘录 ≤5 行 | F041 教训 |
| PR body 里写了 @句柄 | 触发句柄只能在 PR comment | PR #160 教训 |
| 同一 commit 连续发多条触发 comment | 先做去重检查（Step 5.1） | 云端 review 防呆 |
| 截图顺手掉进仓库根目录 | 移到 `${TMPDIR}/cat-cafe-evidence/` | Artifact Hygiene |
| merge 后不做 Phase 文档同步 | Step 7.5 每次 merge 必做 | 文档实时性 |
| 愿景守护交给铲屎官手动协调 | 作者自己 @ 第三只猫发起守护 | F073 自动化 |
| 有 .pen 设计稿但没对照实现 | Step 5 自动 glob 检测，匹配到强制对照 | 三猫教训 |
| 批量给社区 issue 打 feature 标签 | 每个 issue 必须逐个过关联检测 | F114-F116 教训 |

---

## 十二、各 Skill 关系速查

| Skill | 作用 | 在流程中的位置 |
|-------|------|----------------|
| `feat-lifecycle` | 立项 / 讨论 / 收尾 | Kickoff + Completion |
| `worktree` | 创建隔离开发环境 | Step ① |
| `tdd` | 测试驱动开发 | Step ① 内 |
| `quality-gate` | 自检（spec 对照 + 证据） | Step ② |
| `request-review` | 发 review 请求 | Step ③a |
| `receive-review` | 处理 reviewer 反馈 | Step ③b |
| `merge-gate` | 合入主干全流程 | Step ④ |
| `collaborative-thinking` | 后端/架构设计讨论 | Design Gate 内 |
| `pencil-design` | 前端 wireframe | Design Gate 内 |
| `writing-plans` | 实现计划文档 | Design Gate 之后、开发之前 |

---

*← 返回 [Part 1](./01-dev-flow-part1.md)：核心原则与流程总览*
