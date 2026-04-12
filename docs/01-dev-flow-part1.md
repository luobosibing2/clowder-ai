---
topics: [sop, dev-flow, workflow]
doc_kind: guide
created: 2026-04-06
updated: 2026-04-06
---

# Clowder AI 开发流程全解 · Part 1：核心原则与流程总览

> 本文档整合自 `docs/SOP.md` 与 `cat-cafe-skills/` 下的各 skill 文件，是面向团队新成员或全局回顾的阅读入口。  
> **冲突时以各 skill 内容为准。**

---

## 一、核心原则

整个开发流程围绕 **6 条核心原则**运转。理解这些原则，才能理解每个步骤存在的理由。

---

### 原则 1：愿景驱动（Vision-First）

> "没达成愿景 = 没完成。"

Cat Café 的开发不是"AC 打勾即交付"。每个 feature 在 kickoff 阶段就要和铲屎官确认**核心愿景**——铲屎官坐在 Hub 前用这个功能，体验应该是什么样的。

- AC（Acceptance Criteria）是中间工具，不是真相源。AC 可能写偏，可能遗漏 UX 要求（F041 教训：12 项 AC 全打勾，但 UI 实际不可用）。
- **唯一停下来的理由**：发现了原本没预见的、确实解决不了的技术阻塞。除此之外，全链路自动推进到愿景守护通过为止。
- 大 feature（3+ Phase）：每个 Phase merge 后主动碰头铲屎官，确认方向——这是"方向对不对"，不是"要不要继续"。

---

### 原则 2：全链路自驱（§17 规则）

> "SOP 有写下一步 → 直接做，不要停下来问铲屎官。"

整个 SOP 是一条自动推进的链条：  
Design Gate → Worktree → Quality Gate → Review → Merge Gate → 愿景守护 → Close

每个步骤结束后，skill 文档里的"下一步"就是你的行动指令，不需要等铲屎官确认。唯一需要上报的是：  
1. 真正的技术阻塞  
2. 大 feature 的 Phase 碰头（方向确认，不是流程推进）  
3. 愿景守护结束后的 close 通知

---

### 原则 3：证据优先（Evidence Before Claims）

> "没有运行命令、没看到输出，就不能说'通过了'。"

铁律：`NO COMPLETION CLAIMS WITHOUT FRESH VERIFICATION EVIDENCE`

- 测试"上次跑过"不算证据。必须**这次**重新跑，附上命令输出。
- spec checkbox 是记录工具，不是真相源（LL-029）。声称完成/未完成前，必须核实 `git log --grep` + `gh pr list`。
- 云端 reviewer 没有运行环境，判断基于静态分析。**你的本地实测证据 > 云端的理论推理。**

---

### 原则 4：设计先行（Design Gate First）

> "UX 没确认，不准开 worktree。"

Design Gate 卡在 worktree 创建之前。按功能类型分流：

| 类型 | 确认路径 |
|------|----------|
| 前端 UI/UX | wireframe → 铲屎官 OK |
| 纯后端 API/数据模型 | `collaborative-thinking` → 猫猫达成共识 |
| 架构级（跨模块/新基础设施） | 猫猫讨论 → 铲屎官拍板 |
| Trivial（≤5 行/纯文档） | 跳过 Design Gate |

**为什么这么严**：前端改完再推翻比后端成本高 10 倍。设计确认是最便宜的纠错机会。

---

### 原则 5：跨猫协作与独立验证

> "守护猫 ≠ 作者 ≠ reviewer。"

Clowder AI 的多猫架构不是装饰，是制度保障：

- **Reviewer 匹配**：动态从 `cat-config.json` 选取，跨 family 优先，禁止自审。
- **愿景守护**：feature 最后一个 Phase 合入后，由非作者、非 reviewer 的第三只猫独立执行"愿景三问 + 对照表"，通过才放行 close。
- **TAKEOVER 降级**：reviewer 发现 author 连续 3 轮无有效证据增量，可直接宣布 TAKEOVER，原 author 停止试错。
- **反顺从规则**：review 有零分歧 = 走过场。真正的 review 需要技术争论，push back 有理有据时是义务，不是选项。

---

### 原则 6：数据安全红线

> "Redis 6399 = 铲屎官数据，圣域，只读。"

所有开发 worktree 必须配 `.env` 指向 Redis 6398，绝不能回落到 6399。  
`../cat-cafe-runtime` 是生产单实例，禁止在其会话里执行 `pnpm start` / `pnpm runtime:start`，禁止将 `localhost:3003/3004` 的响应当成当前 worktree 的验证证据。

---

## 二、流程全图

```
立项（Kickoff）
    │
    ▼
⓪ Design Gate ──────────────────────────────────────────────────────────────
    │  前端→铲屎官画 wireframe 确认
    │  后端→猫猫 collaborative-thinking 讨论
    │  架构→猫猫讨论→铲屎官拍板
    │  Trivial→跳过
    ▼
① Worktree
    │  git worktree add ../cat-cafe-{name} -b feat/{name}
    │  .env: REDIS_URL=redis://localhost:6398
    │  先跑记忆系统 search_evidence，防止重蹈覆辙
    ▼
  （开发实现，TDD）
    ▼
② Quality Gate（自检）
    │  Step 0: 愿景核对（回读 Discussion/Interview 原话）
    │  Step 0.5: 交付完整性检查
    │  Step 1-7: 找 spec → 建清单 → 逐项验证 → 运行命令
    │  pnpm test / pnpm lint / pnpm check / build 全绿
    │  前端：≤3 截图 + 15s 录屏 + 需求→截图映射表
    ▼
③a Request Review
    │  附原始需求摘录（≤5 行铲屎官原话）
    │  附 quality-gate report + 测试输出
    │  动态匹配跨 family reviewer
    ▼
③b Receive Review
    │  区分愿景级 vs 代码级反馈
    │  VERIFY 三道门（Spec Gate → Mechanism Gate → Feature Gate）
    │  Red→Green 逐项修复
    │  修完回给 reviewer 确认（禁止自判"改对了"）
    ▼
④ Merge Gate
    │  门禁 5 硬条件全满足
    │  pnpm gate（基于最新 origin/main rebase 全量验证）
    │  gh pr create → PR body 防呆检查（禁止 @句柄）
    │  触发云端 review（在 PR comment，非 body）
    │  等云端 0 P1/P2 → gh pr merge --squash
    │  Step 7.5: Phase 文档同步（每次 merge 必做）
    │  Step 8/8.5: 清理 worktree + 回收 review 沙盒
    ▼
⑤ 愿景守护（最后一个 Phase 时）
    │  作者自己做愿景三问 + 对照表
    │  自动 @ 第三只猫（非作者、非 reviewer）独立验证
    │  守护猫放行 → feat-lifecycle completion → close
    │  守护猫踢回 → 修改 → 重走 quality-gate
    ▼
  Feature Close
```

---

## 三、Step ⓪：Design Gate（设计确认）

**位置**：Kickoff 完成后，worktree 创建之前的强制关卡。

### 分流判断

| 功能类型 | 判断标准 | 确认人 | 方式 |
|----------|----------|--------|------|
| 前端 UI/UX | 用户能看到的改动 | 铲屎官 | wireframe（Pencil / ASCII）→ 铲屎官 OK |
| 纯后端 | API / 数据模型 / 内部逻辑 | 其他猫猫 | `collaborative-thinking` 讨论达共识 |
| 架构级 | 跨模块、新基础设施 | 猫猫讨论 → 铲屎官拍板 | 先出方案再上报 |
| Trivial | ≤5 行、纯重构、文档 | 跳过 | 直接按 SOP 例外路径 |

### 前置侦查（F086 M2 要求）

开 Design Gate 讨论前，先做"新领域侦查"：
1. 读 `docs/features/README.md` 找相关 Feature
2. 读相关 Feature spec 的 Key Decisions / Open Questions
3. 搜记忆系统看有没有前人讨论过类似问题
4. 把发现记录到 Design Gate 讨论里

**为什么**：避免重复造轮子，避免在有前人结论的问题上重开讨论。

### 产出

确认结论存档，写入 feature spec 的 Key Decisions。后续 quality-gate 的 Step 5 会自动检查 `.pen` 设计稿文件，强制要求对照实现。

---

## 四、Step ①：Worktree（隔离开发环境）

**触发时机**：Design Gate 通过后，开始写代码之前。

### 开工前 Recall

拉 worktree 前，先用记忆系统搜相关上下文：

```
search_evidence("{feature关键词}")
search_evidence("{topic}", scope="all")
```

不搜就开工 = 可能重蹈覆辙。记忆系统索引了 400+ docs 和所有 thread 摘要。

### Main 同步检查（F073 门禁）

创建 worktree 前必须确认 main 与 `origin/main` 完全同步（双向）：

```bash
git fetch origin main --quiet
AHEAD=$(git rev-list --count origin/main..main)
BEHIND=$(git rev-list --count main..origin/main)
# ahead > 0 → 先 push；behind > 0 → 先 pull；两者都 = 0 → 继续
```

其他猫看的是 `origin/main`。不同步 = 信息不对称 = 并行开发出冲突。

### 创建与配置

```bash
# 目录必须在项目外（relay-station/ 同级）
git worktree add ../cat-cafe-{feature-name} -b feat/{feature-name}
cd ../cat-cafe-{feature-name}
pnpm install

# Redis 隔离（必须）
cat > .env <<EOF
REDIS_URL=redis://localhost:6398
NEXT_PUBLIC_API_URL=http://localhost:3102
EOF

pnpm test  # 验证基线测试通过
```

### 关键禁令

| 禁止 | 原因 |
|------|------|
| 在 `cat-cafe-runtime` 目录里开发 | runtime 是生产环境，不是开发沙盒 |
| worktree 里用 Redis 6399 | 6399 是铲屎官数据，圣域 |
| 在 runtime 会话执行 `pnpm start` | 会先 kill 旧 API，等于踢掉在线 runtime |
| 把 `localhost:3003/3004` 的响应当开发证据 | 那是 runtime 的地址，不是当前 worktree |

### 合入后清理

分支合入 main 后当场清理（merge-gate Step 8 会处理）：

```bash
git worktree remove ../cat-cafe-{feature-name}
git branch -d feat/{feature-name}
git worktree prune
```

---

*→ 继续阅读 [Part 2](./01-dev-flow-part2.md)：Quality Gate、Review 循环、Merge Gate、愿景守护*
