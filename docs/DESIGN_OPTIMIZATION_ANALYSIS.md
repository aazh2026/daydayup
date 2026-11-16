# 智学中枢 · 设计优化分析（对标 cn-math-taxonomy）

> 分析对象：本仓库（`daydayup`，智学中枢 · 上海初三 AI 提分操作系统）
> 对标项目：`resources/cn-math-taxonomy`（中小学·高中知识图谱，870+ 知识点、1459 先修边、10607 道题）
> 结论摘要：当前项目的**产品闭环设计（诊断→归因→规划→教练→复测→验证）显著优于对标项目**，其短板不在产品逻辑，而在**知识底座的规模、颗粒度与可信度**，以及**决策引擎的证据化程度**。对标项目最值得借鉴的不是功能，而是**「可验证的数据资产 + 可回溯的证据链 + 纯函数可测试引擎」**这三条工程纪律。

---

## 一、两个项目的能力对照

| 维度 | 本项目 (daydayup) | cn-math-taxonomy | 差距判定 |
| --- | --- | --- | --- |
| 知识点数量 | **17 个**（数学 6 / 英语 3 / 物理 3 / 化学 3 / 语文 3） | 870（数学）+ 791（英语）+ 269（物理）+ 68（化学）+ 682（语文） | ⚠️ **差 2 个数量级** |
| 先修边 | 10 条，`string[]` 无强度 | 1459+ 条，含 `hard/soft` 强度 + `reason` | ⚠️ 无强度语义 |
| 题库 | 15 道手写题 | 10607 道，95% 自动核验 | ⚠️ **差 3 个数量级** |
| 知识点字段 | `definition` / `prerequisites` / `commonExamForms` / `commonTraps` / `examWeight` / `learningCostHours` | `mastery_criteria[]` / `diagnostic_question` / `standards[]` / `grade` / `semester` / `chapter` | ⚠️ 缺课标锚点与掌握标准 |
| 判题 | 全靠 LLM（`/api/practice/evaluate`） | 纯函数引擎（数值/分数/单位/坐标/选择/多答案） | ⚠️ **成本高、不确定、不可复现** |
| 诊断引擎 | 试卷→AI 直接映射知识点 | 自适应出题→连续答对确认→回溯先修→根因定位→学习路径 | ✅ 本项目更贴合产品 |
| 决策模型 | `Priority = ExpectedGain×Conf×Weight/Cost`（确定性） | 无（只做诊断图谱） | ✅ 本项目更强 |
| 掌握状态机 | 6 阶 + 延迟复测锁 + 回退 | 4 态（mastered/shaky/weak/unknown） | ✅ 本项目更严格 |
| 可测试性 | 无测试 | `tests/` 目录，引擎纯函数化 | ⚠️ **本项目无任何单测** |
| 状态持久化 | `localStorage` 单 key | JSON 文件 + Git 版本化 | ⚠️ 单设备、无迁移 |

---

## 二、核心问题诊断（P0 → P2）

### P0-1　知识底座是「手写 17 条」，不是「可扩展本体」

`src/data/shanghaiCurriculum.ts` 把**本体、题库、数据结构、种子数据**四件事耦合在一个 589 行的 TS 文件里。这带来三个后果：

1. **不可扩展**：新增一个知识点需要同时改 TS 类型、导出常量、初始化 `masteryRecords`。数学中考有 ~90 个真实考点，现在只有 6 个，任何真实试卷诊断的覆盖率不到 10%。
2. **不可换源**：产品定位是「上海初三」，但上海教材版本（沪教版/牛津上海版）、区域考纲差异极大，hardcode 在 TS 里意味着每次换考纲都要改代码。
3. **无来源可信度**：`examWeight`（0.9–1.4）和 `learningCostHours`（1.5–8.0）都是**拍脑袋的魔法数字**，没有来源标注。参考项目里每个知识点都写明「对齐课标第 X 条、教材第 Y 章、官网已核/第三方待核」，数据可信度可以逐条追溯。

**优化方向**：把知识本体外置为 JSON（对齐参考项目的 `topics.json` + `dependencies.json` + `questions.json` 三件套），TS 侧只保留类型定义 + 运行时校验 + 加载器。本体变成**数据资产**后，才谈得上 V2 的「跨年级/跨地区」。

### P0-2　判题完全依赖 LLM，是最大的不确定性与成本黑洞

`/api/practice/evaluate` 每次作答都调一次 Gemini 判对错 + 归因 + 给提示。这意味着：

- **每次练习 = 一次 API 调用 + 数秒延迟 + 一份费用**，7 天计划 × 3 任务 × 5 个步骤 = 每周近百次调用。
- **判定不可复现**：同一份答案两次调用可能得到不同 `isCorrect`，而 `evaluateMasteryTransition` 会直接用它推进/回退状态机 —— **状态机的正确性建立在一个非确定性函数上**。
- **无法离线/降级**：没有 API key 时练习模块完全不可用（`createAiClient` 直接 throw）。

参考项目的 `diagnose/engine.js` 提供了成熟答案：**纯函数判题**。`normalizeText` → `parseNumeric`（支持整数/小数/分数/带分数/百分数/带符号/带单位）→ `compareParsed`（变量名无关的数值等价）→ `judgeAnswer` 返回 `correct | wrong | manual`。三态而非二态（`manual` = 让用户对照答案自评）是关键设计：**宁可承认不确定，也不要给假确定性**。

**优化方向**：引入 `src/engine/judge.ts` 作为**第一道判题层**（纯函数、确定性、免费、离线），LLM 降级为**第二道判题层**（仅当纯函数返回 `manual` 或需要错因归因时才调用）。这是投入产出比最高的一项优化。

### P0-3　先修边无「强度」语义，诊断无法回溯根因

本项目的 `prerequisites: string[]` 是一个扁平的字符串数组。对比参考项目：

```json
{ "topicId": "cnm_p002", "prerequisiteId": "cnm_p001",
  "strength": "hard", "reason": "学习「5以内数的大小」需要先掌握「1到5各数的认识」。" }
```

`hard` 边意味着「不掌握这个，学不了那个」；`soft` 边只是「有帮助」。这个区分直接决定了：

- 根因定位的准确性：学生二次函数压轴题失分，往回追是「二次函数本身不会」（hard）还是「一次函数图像性质模糊」（soft）？
- **推断掌握的正确性**：参考项目里，答对一个知识点只沿 `hard` 边推断祖先掌握（`hardAncestorSet`），沿 `soft` 边绝不推断。
- 规划器的降权逻辑：本项目 `computePriorityOpportunities` 用 `prerequisiteModifier = 0.45` 一刀切，无法区分「完全阻塞」和「轻微影响」。

**优化方向**：`prerequisites: Array<{ id: string; strength: 'hard' | 'soft'; reason?: string }>`。这一改动会连带影响规划器、思维导图的状态推断、以及报告页的根因链路。

### P0-4　状态机推进逻辑存在实质性 Bug

`src/engine/planner.ts:407-411`：

```ts
if (mode === '诊断微测' || mode === '基础练习') {
  if (current.state === '未诊断' || current.state === '待学习' || current.state === '学习中') {
    nextState = '初步掌握';   // ← 一道基础题对，直接跳「初步掌握」
  }
```

**「一道基础题做对 = 初步掌握」** 是明显过松的判定。参考项目要求**连续答对 3 题**（`needConfirm`）才判掌握，且区分 `mastered / shaky / weak` 三态：

- 连续答对但不满额 → 继续出题，**不下结论**（避免"1/3 概率蒙对"被当成掌握）
- 第一次错 → 不下结论，再出一道**确认题**（同难度或更简单）
- 确认题对 → `shaky`（不稳，不向先修回溯）
- 确认题也错 → `weak`（薄弱，**把先修压到出题栈顶**，主动回溯根因）

本项目缺少 `shaky` 这一档，也缺少「答错后主动回溯先修」这一动作 —— 规划器只是把先修知识点**排在后面**（`prerequisiteModifier = 0.45` 降权），而不是**主动诊断它**。这正是「提分操作系统」与「知识点列表」的本质差别。

另外 `evaluateMasteryTransition` 里 `lostScoreEvidence` 的衰减是硬编码魔数（`×0.75` / `×0.45`），没有依据，且**答对时把 `lostScoreEvidence` 减到 0.5 下限后仍在优先级公式里生效**。

### P0-5　状态持久化：单 localStorage key，无迁移、无多端、无可回溯

```ts
const STORAGE_KEY = 'shanghai_ai_score_os_v5';
```

- `loadInitialState` 里 `JSON.parse` 后**没有任何 schema 校验**，一个损坏的 localStorage 就会让整个应用白屏（只有 try/catch 兜底到初始态，丢失全部学生数据）。
- **无版本迁移**：改一次 `types.ts` 的字段名，历史数据全部字段丢失。
- **无多端**：手机拍照诊断 → 电脑规划 → 手机复测 的核心工作流无法跨设备。
- **无导出**：家长/老师无法带走数据，学生换浏览器即失去全部学习档案 —— 对一个「长期能力模型」产品是致命的。

---

## 三、可直接落地的优化清单

### 第一梯队：数据契约与可信度（改动小、收益大）

| # | 优化项 | 参考来源 | 落地方式 |
| --- | --- | --- | --- |
| 1 | **本体外置为 JSON** | `data/topics.json` | 新建 `data/knowledge/topics.json` / `dependencies.json` / `questions.json`，TS 侧改 `import ... assert { type: 'json' }` 或运行时 fetch + zod 校验 |
| 2 | **先修边加强度与理由** | `dependencies.json` | `prerequisites: { id, strength, reason }[]` |
| 3 | **知识点补 `standards[]` 课标锚点** | `cms-2022:*` | 每条挂课标编号 + `confidence: exact\|approx\|unverified` |
| 4 | **`examWeight` / `learningCostHours` 标注来源** | 参考项目 README 的核实状态表 | 加 `provenance` 字段，区分「教材已核 / 第三方推定 / 教师经验值」 |
| 5 | **加 `mastery_criteria[]`** | `mastery_criteria` | 替代 `definition` 单句，变为可判定的行为标准列表 |

### 第二梯队：确定性引擎（引入纯函数，提升质量与成本）

| # | 优化项 | 参考来源 | 落地方式 |
| --- | --- | --- | --- |
| 6 | **纯函数判题层** | `diagnose/engine.js` 的 `normalizeText`/`parseNumeric`/`judgeQuestion` | 新建 `src/engine/judge.ts`，LLM 降级为第二道 |
| 7 | **掌握确认改为「连续答对 N 题」** | `needConfirm` | `evaluateMasteryTransition` 增加 streak 计数，N 可配（2/3/5） |
| 8 | **增加 `shaky`（不稳）档** | `shaky` 状态 | 状态机扩为 7 阶；`shaky` 不阻塞先修回溯，但降低优先级 |
| 9 | **答错主动回溯先修** | `applyAnswer` 的 `stack.push(prereqs)` | 答错时不只降权，而是**在诊断队列里插队**先修知识点 |
| 10 | **自适应出题（难度随作答调整）** | `pickQuestion` 的难度分档 | 首题 standard、连对后 challenge、答错后 basic |
| 11 | **先修图环检测 + 拓扑排序** | `ancestorSet` 的 `visiting` 环检测 | 本项目 17 个点不会成环，但本体外置后必须加这个防线 |

### 第三梯队：产品闭环深化（借鉴参考项目的「验证层」）

| # | 优化项 | 参考来源 | 说明 |
| --- | --- | --- | --- |
| 12 | **诊断结论的人工校验台** | 参考项目大量 `docs/feedback-*.md` 与 issue 模板 | 本项目已有 `confidence`/`verificationMethod` 字段，但**没有让老师/学生去校验它的界面**。加一个「待校验队列」，把 `待验证` 置信度的结论聚合成列表，一键人工确认/修正 |
| 13 | **按章汇总（薄弱章节排序）** | `chapterSummary` | 报告页现在按知识点平铺，应加「按章/按板块」聚合视图，薄弱章排前面 |
| 14 | **学习路径图（拓扑序 + 分层布局）** | `layout()` 的重心法分层 | 思维导图目前是**静态的树**（学科→板块→考点→子技能），**完全没有画先修边**。应增加「先修依赖图」视图，用参考项目的分层布局 + 重心法排序，凸显「学不动某题的真正卡点在哪」 |
| 15 | **根因回溯链路** | `roots` / `pendingPrereqs` | 报告页应能从「某道压轴题失分」一路回溯到「因为初中某基础点没掌握」，形成可行动的最短路径 |
| 16 | **题库答案自动核验脚本** | `scripts/verify_questions.py`（AST 白名单沙箱 + Fraction 精确比较） | 本项目的 15 道题是手写答案。接入同类脚本，把题库答案与 `verify` 表达式机械比对，产出 `verification_report.json` |
| 17 | **盲解复核流程** | `second_pass.py` + `second_pass_log.json` | 记录每次题库/本体变更的独立复核轮次与不一致裁决，写入 changelog |
| 18 | **拦截器质量提升（distractor 审计）** | `scripts/rewrite_en_distractors.py` / `_distractor_changelog.json` | 生成选择题时，**干扰项必须与正确答案语义可区分**。当前 `/api/practice/generate` 只要求「4 个清晰选项」，不检查干扰项质量 |

### 第四梯队：架构与工程化

| # | 优化项 | 说明 |
| --- | --- | --- |
| 19 | **状态持久化改为 IndexedDB / 服务端 + 版本化迁移** | 带 `schemaVersion` 的迁移函数链；导出/导入 JSON；跨设备同步 |
| 20 | **引擎纯函数化 + 单元测试** | 参考项目有 `tests/`。至少覆盖：`evaluateMasteryTransition` 的全部状态转移、`computePriorityOpportunities` 的排序不变量、`buildSevenDayPlan` 的**预算不超支不变量**（当前实现里 `mins` 的计算存在溢出风险：`Math.max(15, ...)` 可能让总时长超过 `effectiveBudget`） |
| 21 | **规划器：把「先修阻塞」提升为硬约束** | 当前 `blockedByPrerequisite` 只降权到 0.45，且仍会被选入计划（`fallbackPool`）。应区分「本周可学」与「须先解锁」两类队列 |
| 22 | **成本与限流** | 判题下沉到纯函数后，只有归因/教练/生成题需要 LLM。应加请求去重、缓存（同一知识点同一错因不重复归因）、以及降级路径 |
| 23 | **知识图谱数据版本化** | 参考项目本体随课标修订频繁变更（2026-10-21、2026-11-06 多轮）。本项目需引入 `ontologyVersion` + 迁移，否则改一次本体就要清空所有学生数据 |

---

## 四、针对当前 UI 的具体改进点

| 现状 | 问题 | 建议 |
| --- | --- | --- |
| `SubjectKnowledgeMindMap` 画的是**分类树**（学科→板块→考点→子技能） | **先修依赖完全没有可视化**，而这是产品的核心价值 | 增加「先修依赖视图」切换：拓扑分层布局 + 重心法排序，红线表示 hard 阻塞 |
| 子技能匹配靠 `SUBSKILL_ALIAS_MAP` 硬编码关键词表 | 关键词表不随知识点增长而维护，且中文分词靠 `includes` 极易误命中 | 让 AI 在诊断时**直接返回命中的 subSkill**，作为结构化字段（与 `knowledgeId` 并列），而非事后猜测 |
| `KNOWLEDGE_MAP` / `SHANGHAI_CURRICULUM` 直接 import | 引入循环依赖与体积膨胀，且无法热更新本体 | 改为运行时加载 + 缓存 + schema 校验 |
| 计划生成用 `slice` 旋转做「明天」的排布 | 这是**伪随机**，与 priority 语义脱节；`deferredOpps` 被放在 `priorityFront` 强制进队 | 改为真正的约束求解：预算 + 每日上限 + 先修就绪 + 学科轮转，用贪心 + 局部搜索 |
| `TaskStep` 的 4 个步骤是**固定比例**切分（20%/20%/45%/15%） | 与知识点实际难点无关。压轴题（8 小时成本）和基础题（1.5 小时）用同一套步骤 | 步骤模板应随 `masteryState` + `errorType` 变化：审题问题 → 审题专项；计算问题 → 限时计算专项 |
| `learningCostHours` 用「小时」，任务用「分钟」 | 单位不统一，规划器无法跨粒度分配 | 统一为分钟成本，或引入「知识点单位成本」概念（每个知识点被掌握所需的练习题数） |
| `LostScore` 来自 AI 估算的 `scoreLost` | 估算值进入优先级公式的分子 | 区分 `scoreLost_observed`（试卷标注为事实）与 `scoreLost_estimated`（AI 推断），后者降低置信度权重 |
| 无「待校验」队列 | `confidence: 待验证` 的结论被直接喂给规划器 | 增加校验队列，未校验的结论不进入优先级计算（或大幅降权） |

---

## 五、建议的落地顺序

**第一轮（2 周，零后端改动，收益最高）**
1. 本体外置为 JSON + 引入 `strength`/`standards`/`provenance` 字段（第 1–5 项）
2. 纯函数判题层 `src/engine/judge.ts` 落地（第 6 项）→ 显著降低 LLM 调用量与不确定性
3. 掌握确认改为连续答对 N 题 + 新增 `shaky` 档（第 7–8 项）
4. 引擎纯函数化 + 关键不变量单测（第 20 项）

**第二轮（3–4 周）**
5. 答错主动回溯先修 + 自适应出题（第 9–10 项）
6. 先修依赖可视化 + 根因回溯链路（第 14–15 项）
7. 按章汇总视图（第 13 项）

**第三轮（4 周+）**
8. 状态持久化改造（IndexedDB + 版本迁移 + 导出导入）（第 19、23 项）
9. 人工校验台 + 题库自动核验脚本（第 12、16–18 项）
10. 规划器约束求解重写（第 21 项）

---

## 六、一句话总结

> 本项目已经把「**产品闭环**」做对了 —— 诊断 → 结构化归因 → 边际提分排序 → 预算约束排程 → 苏格拉底教练 → 变式/延迟复测 → 三层效果验证，这套链路比 `cn-math-taxonomy` 更接近真实可交付的产品形态。
>
> `cn-math-taxonomy` 值得借鉴的是它背后的**工程纪律**：本体即数据、边有强度与理由、答案必须机器可验、引擎纯函数且可测试、每条数据都标注来源与核实状态。
>
> 当前最大的结构性风险是：**一个 17 点的手写知识表 + 依赖 LLM 的非确定性判题 + 无任何测试**，撑不起「提分操作系统」这个承诺。优先补上**可扩展本体、确定性判题、证据化状态机**三件事，比继续打磨 UI 或增加 AI 功能的收益大得多。
