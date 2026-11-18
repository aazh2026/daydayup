# 设计与实现的差距分析

> 对照基准：`docs/PRODUCT_DESIGN_SPEC.md`（产品设计规格，MVP 范围）
> 辅助基准：`docs/frontend-backend-separation.md`（分离方案）、`docs/separation-implementation-status.md`（自称的完成状态）
> 分析日期：2026-11-17
> 方法：规格逐条核对 + 代码链路追踪 + 缺陷实际复现

---

## 修复状态总览（2026-11-17 更新）

本报告为**分析快照**，正文保留原始发现（便于追溯「当时是什么样」）。
下表是后续修复的落地状态，详见
[`docs/separation-implementation-status.md` 的 Phase 10](separation-implementation-status.md)。

| # | 缺陷 | 状态 | 验证方式 |
|---|---|---|---|
| P0-1 | 诊断失分不写服务端 MasteryRecord | ✅ 已修复 | `gap-fixes.test.ts` 3 例 + E2E |
| P0-2 | ExamResult 无持久化、targetScore 恒等 score | ✅ 已修复 | `gap-fixes.test.ts` 1 例 + E2E |
| P0-3 | 示例卷未进入上传链路（TC-01 断链） | ✅ 已修复 | E2E「不得出现请提供试卷图片」 |
| P0-4 | 调节预算不重排计划（TC-02 断链） | ✅ 已修复 | E2E「实际排期立即缩减」 |
| P0-5 | 30/35 分钟档位排期超支 | ✅ 已修复 | `gap-fixes.test.ts` 全档位 30–120 |
| P1-1 | 先修锁定漏判「未诊断」 | ✅ 已修复 | `gap-fixes.test.ts` 3 例 |
| P1-2 | 多模态路径绕过 schema 校验 | ✅ 已修复 | `gap-fixes.test.ts` 4 例 |
| P1-3 | LearningAttempt 丢 4 字段 | ✅ 已修复 | `gap-fixes.test.ts` 1 例 |
| P1-4 | `QuestionKnowledge` 零使用方空壳 | ⏳ 未修 | 保留为技术债（见实施状态文档） |
| P1-5 | 思维导图子技能归因靠关键词硬匹配 | ⏳ 未修 | 保留为技术债（见实施状态文档） |
| P1-6 | 微测置信度硬编码「确定」 | ✅ 已修复 | `gap-fixes.test.ts` 3 例 |
| P1-7 | 错题「待复测」无写入路径 | ✅ 已修复 | `gap-fixes.test.ts` 1 例 |

**新增强制验收准则**（针对本报告 §四 指出的方法论问题）：

> 每个 TC 用例必须有一条**从 UI 操作出发**的浏览器级断言，
> 且断言「用户可见的结果」而非「API 返回值」。
> 服务端单元测试通过**不构成**该用例通过。

已由 `tests/e2e/gap-user-paths.mjs` 落实（22 条断言）。

---

## 零、结论摘要

**架构分层是真的，测试通过数是真的，但「完成」这个判断不成立。**

`separation-implementation-status.md` 把 60 个 Phase 全标为 ✅ 完成，并记录「579/579 通过、24/24 断言通过、5 个页面渲染零错误」。
本报告的核查结果：

| 维度 | 核查结论 |
|---|---|
| 架构重构（前后端分离） | ✅ **确实完成**，质量高，是本仓最大资产 |
| 契约与领域模型（13 实体） | ✅ 8/13 高保真，类型与规格逐字段对齐 |
| 服务端算法（优先级公式/预算/状态机） | ✅ 规格公式精确落地 |
| **前端 → 服务端的数据闭环** | ❌ **多处断裂**，3 条 P0 |
| **服务端权威性** | ❌ **诊断路径在前端本地推导掌握度**，违反契约明文约束 |
| **验收用例 TC-01~TC-09** | ⚠️ 全部 9 条有服务端测试，但 **TC-01/TC-02/TC-06 在真实链路上不成立** |
| **知识资产覆盖度** | ❌ 18 个知识点 vs 规格「全面覆盖五门学科」 |

**一句话**：把「组件存在、接口存在」当成了「功能可用」。
文档自己写过这句话（#19/#20「服务端化了却忘了拉」「补齐接口 ≠ 功能可用」），
但结论只应用在了单个用例上，没有作为**全局验收准则**执行。

**最严重的单点**：`ExamResult`（成绩基线）在服务端**没有任何持久化**，
`targetScore` 被直接抄成 `score`，导致「距离目标分差值」永远是 0 ——
规格 §模块06 第三层评估的核心指标是死的。

---

## 一、P0 缺陷（阻断验收用例，必须先修）

### P0-1　诊断产生的失分证据不写服务端 → 诊断→提分闭环在服务端断开

**规格要求**（TC-01）：「新增对应 `ErrorRecord` **并更新相关知识点 `MasteryRecord`** 与 7 天排序」

**事实**：

| 位置 | 行为 |
|---|---|
| `packages/server/src/api/routes/exam.routes.ts:112-219` | 落库 ExamPaper + ErrorRecord，**完全不写 MasteryRecord，不产生 MasteryTransitionEvent** |
| `web/src/App.tsx:497-531` | 前端**自行**计算 `nextState` / `lostScoreEvidence` / `evidenceLogs` / 迁移事件，写入本地 state |

证据：`grep -n "mastery\|Mastery" packages/server/src/api/routes/exam.routes.ts` → **零命中**。

**双重后果**：
1. 前端推导的掌握度**刷新即丢**（localStorage 业务数据已在 `local-state.ts:71-87` 清空）。
2. 服务端 `plan.routes.ts` 的 7 天排序读 `db/mastery/{studentId}.json` ——
   服务端文件里从来没有诊断产生的失分证据，**7 天排序看不到任何诊断结果**。

**架构违例**：`packages/contracts/src/domain/index.ts:313-318` 明文写着
「**状态迁移规则属服务端 MasteryEngine，前端不得本地推导**」。
当前实现直接违反了自己的契约。

**修复方向**：把 `App.tsx:497-531` 的推导逻辑下沉到 `mastery-engine.ts`，
在 `POST /exams/:examId/papers` 中调用（同路径已有 `evaluateMasteryTransition`）。

---

### P0-2　`ExamResult` 无实体持久化 → 「目标分差值」恒为 0

**规格要求**（§模块06 第三层）：「全科历次考试成绩趋势对比矩阵、**距离目标分差值**」

**事实**：`packages/server/src/api/routes/exam.routes.ts:397-406` 在**读取时从 ExamPaper 现场合成**：

```ts
results.push({
  id: `res-${paper.id}`,
  score: paper.score ?? 0,
  fullScore: paper.fullScore ?? 100,
  targetScore: paper.score ?? 0,   // ← 目标分被抄成了实际分
  date: paper.date,
});
```

`grep -rn "ExamResult" packages/server/src` → **零命中**（无实体、无存储、无写入端点）。

**断链点**：
- 前端「成绩录入」`App.tsx:333-379` `handleAddExamResult` —— 只改 React state，**不发任何 API 请求**。
- `POST /api/v1/exams` 端点存在（`exam.routes.ts:65`）但**前端零调用**。
- seed 里的 10 条 `examResults` 也因 `seed.ts:63-98` 未写该循环而从未落库。

**后果**：`targetScore ≡ score` ⇒ 差值恒为 0 ⇒
报告页「距离目标分差值」、TC-06「多场考试趋势」、第三层评估全部失真。
且新建考试场次只在内存，刷新即丢。

---

### P0-3　TC-01 断链：「载入示例数学试卷」→ 启动诊断必然被服务端拒绝

**链路**：
1. `DiagnosisPage.tsx:325-336` `handleLoadSamplePaper` 只置 `usingSampleImage=true`，
   **清空** `uploadedImages` 与 `rawTextInput`。
2. `DiagnosisPage.tsx:410-424` 上传循环仅在 `uploadedImages.length > 0` 时执行 ——
   示例图不在其中 ⇒ `fileIds=[]`、`rawText=''`。
3. 服务端 `upload.routes.ts:211-216` 拒绝：
   ```ts
   if (imagePaths.length === 0 && !rawText) {
     throw new ApiException('VALIDATION_FAILED', '请提供试卷图片，或粘贴/导入已识别的试卷文本与错题解析内容。');
   }
   ```

示例图资产 `web/src/assets/images/sample_math_exam_paper_1794838486492.jpg` **确实存在**，
但只用于 `:787` 的 `<img src>` 本地预览，**从未 base64 上传**。

对照：同页「载入AI解析文本示例」（`:338-365`）会填 `rawTextInput`，**这条路径可用**。

**修复方向**：`handleLoadSamplePaper` 里 fetch 示例图 → base64 → 走同一条上传路径。

---

### P0-4　TC-02 断链：调节每日时间/作业量/疲劳度 → 计划不重排

**规格要求**（§六 PlanningPage）：「**实时**调节每日时间/作业量/疲劳度」；
（TC-02）「每日排期预算**立即**缩减」

**三处断链**：

| # | 断点 | 证据 |
|---|---|---|
| 1 | 前端只改本地 state，**不调** `PUT /students/:id/profile` | `grep -rn "profile" web/src/` → 零命中（端点存在：`student.routes.ts:103`） |
| 2 | 计划拉取 effect 依赖不含 student 预算 | `App.tsx:146-164` 依赖 `[hydrationStudentId, completedTaskIds, deferredKnowledgeIds]` |
| 3 | `POST /students/:id/plans`（重新生成的唯一入口）**前端从未调用** | `grep -rn "/plans" web/src/` → 只有 `PATCH /plans/:id/tasks/:taskId` |

且服务端 `plan.routes.ts:88-93` 的 `GET /plans/current` **优先返回已持久化的 plan**，不随 student 变更重算。

**讽刺之处**：TC-02 的服务端测试（`acceptance.test.ts:295-336`）断言的正是这个不变量，
但它直接调 `POST /students/:id/plans` 绕过了前端链路 —— **测试通过，产品不通过**。

---

### P0-5　30/35 分钟档位每日排期超出预算（实测复现）

**规格要求**（§7.1 质量指标）：「每日时间预算满足率 **100%**」
（§模块02 §3：可调区间 **30–120 分钟**）

**实测结果**（用真实 `buildSevenDayPlan` 跑，18 个知识点全入池）：

```
budget=30 effective=30 overDays=7/7 maxDay=40 day0=15+15+10   ← 40 > 30，超支 33%
budget=35 effective=35 overDays=7/7 maxDay=40 day0=15+15+10   ← 40 > 35，超支 14%
budget=40 effective=40 overDays=0/7 maxDay=40
budget=45 effective=45 overDays=0/7 maxDay=45
budget=60 effective=60 overDays=0/7 maxDay=60
```

**根因**：`planning-engine.ts:371-375`
```ts
const mins = idx === dayCandidates.length - 1
  ? Math.max(10, remainingMinutes)
  : Math.max(15, Math.round((effectiveBudget * ratios[idx]) / 5) * 5);
```
每个任务有 **15 分钟硬下限**，末位 10 分钟 —— 当预算 < 3×15 时必然超支。

**为什么没被发现**：现有单测 `engines.test.ts:58-77` 只用 `dailyBudgetMinutes: 60`，
恰好是唯一不触发该 bug 的档位。

**修复方向**：改为预算感知的分配（先按比例算，再按剩余预算钳制总时长），
而非给单任务设固定下限。

---

## 二、P1 缺陷（规格语义未落地）

### P1-1　先修知识锁定漏判「未诊断」（实测复现）

**规格要求**（§模块02 §3）：「若某知识点的前置先修知识处于 `未诊断` 或 `待学习`，自动降权并引导先修基础内容」

**实现**：`planning-engine.ts:159-168`
```ts
for (const preId of kp.prerequisites) {
  const preRec = masteryRecords[preId];
  if (preRec && (preRec.state === '未诊断' || preRec.state === '待学习')) {   // ← preRec &&
    blockedBy = knowledgeMap[preId]?.name ?? preId;
    break;
  }
}
```

**Bug**：`preRec &&` 短路 —— 当前置知识点**根本没有 MasteryRecord**
（即从未诊断 = 规格语义下的「未诊断」）时，条件不成立，**锁定完全不触发**。

实测复现：
```
math-eq-ineq    prio=1.47 tier=高 blockedBy=undefined   ← 未被降权！
math-func-linear prio=0.56 tier=低 blockedBy=一元二次方程与分式方程
```
而当 `preRec.state === '待学习'` 时，`math-eq-ineq` 正确降为 `prio=0.66 tier=低`。

**这恰恰是最常见的初始状态** —— 诊断前所有前置知识点都无 record。
规格的「先修知识锁定」这条防失败设计，在真实初始状态下**完全无效**。

### P1-2　多模态（图片）诊断路径绕过 schema 校验

**规格要求**（§7.1）：「证据与置信度完整率 **100%**」

| 路径 | 校验行为 |
|---|---|
| 纯文本 `GeminiProvider.generateJson` | ✅ `gemini-provider.ts:55` 调 `validateAgainstSchema`，失败重试 |
| 多模态 `runMultimodalDiagnosis` | ❌ `ai.routes.ts:448` 裸 `JSON.parse` |
| 异步诊断 Job | ❌ `diagnosis-job.ts:107` 裸 `JSON.parse` |

**而图片试卷诊断是主路径**（`ai.routes.ts:139-186` 走 inlineData）。
因此「四结构化字段（证据/判断/置信度/验证方式）100% 完整率」**没有服务端保障**，
完全依赖 LLM 自觉。

补充：`confidence` 枚举（`确定/较可能/待验证`）在 schema 层无 ENUM 支持 ——
`provider.ts:28` 的 `AIJsonSchema.type` 只有 5 种基础类型，无 enum 透传。
枚举归一化只在**前端**做（`DiagnosisPage.tsx:545`）。

### P1-3　`LearningAttempt` 运行时丢 4 个字段

**规格要求**（§模块06 第一层）：「无提示独立作答率、累计有效学习分钟数」

`mastery.routes.ts:250-262` 写入 JSONL 时只有 9 个字段，缺
`questionStem`、`userAnswer`、`aiFeedback`、`taskId`：

```ts
JSON.stringify({
  id, studentId, knowledgeId, mode, isCorrect,
  hintsUsed, timeSpentSeconds, independent, timestamp,
})
```

`POST .../attempt` 的请求体也**不接收**这四个字段。

**后果**：报告页「评测记录」从服务端刷新后**题干与作答为空**。
seed 数据是全字段（15 字段），所以**刷新前看起来正常，真实使用后就丢失** ——
这正是典型「演示能过、上线即挂」。

### P1-4　`QuestionKnowledge` 是零使用方的纯空壳

规格 §四把它列为 13 个核心实体之一。实际只有两处出现：定义处 + `web/src/types.ts` 重导出，
**无任何读写方**。

替代实现是 `Question.knowledgeIds: string[]` —— 一对一反向数组，**无 `weight` 权重概念**。
多知识点题目的权重信息完全丢失，`LostScore` 也没有按权重向知识点分摊的机制。

### P1-5　思维导图「子技能失分归因」靠关键词硬匹配

`SubjectKnowledgeMindMap.tsx:81-126` 的 `SUBSKILL_ALIAS_MAP` 是约 30 条手写别名表，
`matchesSubSkill()` 用 `haystack.includes(keyword)` 判断命中。

规格 §3.1 要求「失分题与子技能的映射」，当前是模糊字符串启发式 —— 误判与漏判都可能。
（注意：四级**结构**与四态配色本身是达标的，此处问题在**归因准确性**。）

### P1-6　微测「置信度分级」被服务端抹平

`mastery-engine.ts:100-106`：无论对错，`confidence` 硬编码为 `'确定'`。
规格 §模块01「为低置信度假设补充独立能力证据」的**分级语义**未落地 ——
微测只是把置信度拉满，没有区分对待。

### P1-7　错题「待复测」状态永不出现

状态枚举含 `待复测`（`domain/index.ts:170`），筛选器也提供该项，
但**写入侧只有** `已订正` 与 `已闭环`，`待复测` 无任何写入路径 ⇒ 该筛选恒为空。

---

## 三、规格覆盖度盘点

### 3.1 13 个核心实体（规格 §四）

| 实体 | 类型完整性 | 持久化 | API 读写 | 保真度 |
|---|---|---|---|---|
| `Student` | ✅ 9/9 | ✅ | ✅ | **高** |
| `Exam` | ✅ 4/4 | ⚠️ 仅 seed | ⚠️ 端点在，前端零调用 | 中 |
| `ExamResult` | ✅ 8/8 | ❌ **无** | ❌ | **低（P0-2）** |
| `ExamPaper` | ✅ 19/19 | ✅ | ✅ | **高** |
| `Question` | ✅ 11/11 | ⚠️ 只读静态题库 | ⚠️ AI 生成题不落库 | 中 |
| `KnowledgePoint` | ✅ 12/12 | ✅ 版本化资产 | ✅ | **高** |
| `QuestionKnowledge` | ✅ 3/3 | ❌ | ❌ | **无（空壳 P1-4）** |
| `ErrorRecord` | ✅ 17/17 | ✅ | ✅ | **高** |
| `MasteryRecord` | ✅ 11/11 | ✅ | ✅ | **高** |
| `MasteryTransitionEvent` | ✅ 7/7 | ✅ | ✅ | **高** |
| `LearningPlan` | ✅ 5/5 | ✅ | ✅ | **高** |
| `LearningTask` | ✅ 11/11 | ⚠️ 嵌在 plan 内 | ✅ PATCH | 中高 |
| `LearningAttempt` | ✅ 13/13 | ⚠️ JSONL | ⚠️ **丢 4 字段（P1-3）** | 中 |

### 3.2 五大核心页面（规格 §六）

前端组件层**全部真实存在并真实调用后端**，是本仓第二强的部分：

- **TodayPage**：倒计时、预算、Top 3、开始学习/打卡/重排 —— ✅
- **DiagnosisPage**：四大 Tab、自动识别元信息、场次对比、状态机列表 —— ✅
- **PlanningPage**：优先级表 + 公式解释、7 天日程、先修锁定提示 —— ✅
- **CoachPage**：5 阶苏格拉底、双逃生通道、4 阶练习、评测、跃迁显示 —— ✅
- **ReportPage**：三层评估、成绩矩阵、存档库检索、五维统计、重复漏洞排行、多维错题筛选 —— ✅

**思维导图**：四级结构 + 红/琥珀/绿/灰四态 + 右侧透视面板（证据链/先修漏洞链/教练入口）—— ✅ 结构达标，归因准确性存疑（P1-5）。

### 3.3 服务端算法（规格 §模块02）

| 规格要求 | 实现 | 判定 |
|---|---|---|
| `Priority = ExpectedGain × Confidence × ExamWeight / LearningCost × PrereqMod` | `planning-engine.ts:154-180` | ✅ **精确匹配**（另加 2 项合理增强：连续失误 ×1.25、延迟复测 ×1.15） |
| 每日基准 60 分钟（30–120 可调） | `planning-engine.ts:127-133` | ✅ |
| 作业量「较重」自动下调 15% | `:129` | ✅（实测 60→50） |
| 疲劳度「高」压缩当日任务量 | `:131` | ⚠️ 压缩的是**时长**而非**任务数**，语义解释差异 |
| 先修知识锁定（`未诊断`/`待学习` 降权） | `:159-168` | ❌ **「未诊断」漏判（P1-1）** |
| 每日任务硬性封顶 3 项 | `:335-351` | ✅ |
| 每日总时长 ≤ 预算 | `:371-375` | ❌ **30/35 档位超支（P0-5）** |

### 3.4 知识资产（规格 §3.1「全面覆盖五门学科」）

**实际投产**：`packages/server/data/knowledge/shanghai-junior-2026.1.json` —— **18 个知识点**
（数 6 / 英 3 / 物 3 / 化 3 / 语 3），题库 `bank.json` **15 题**（14 个知识点被覆盖）。

规格要求「内置版本化人工审核知识树，全面覆盖数学代数/方程/一次函数/二次函数/几何辅助线/统计概率、
英语词汇词转/时态从句/首字母阅读、物理压强浮力/动态电路/电功率实验、
化学用语方程式/溶液计算/气体实验探究、语文文言实词迁移/现代文赏析与结构/作文审题立意」
—— 当前只能算**骨架级覆盖**（「几何辅助线」仅 1 个知识点）。

**层级深度**：实际 3 层（`subject` / `domain` / `name` + `subSkills: string[]`）。
`chapter` 字段与 `domain` **1:1 完全冗余**（17 个 distinct chapter ↔ 17 个 distinct domain），
且服务端从未使用 `chapter`。规格 §3.1 要 5 层，TC-09 要 4 层，前端导图渲染 4 列（其中前 2 级合并）。

**未接入的高质量资产**（`resources/` 三目录，`grep` 全仓 **零引用**，且被 `.gitignore` 排除）：

| 目录 | 规模 | 价值 |
|---|---|---|
| `cn-math-taxonomy/` | topics **3557**（含 357 初三）、questions **14375** | 人工编排 + 诊断题 + 依赖边 |
| `chinese-k12-knowledge-graph/` | shanghai-graph **3503 节点**、grade9 **507** | 沪教版教材页图 → 概念/先修边 |
| `china-skill-taxonomy/` | topics **1273**、dependencies **1647 边** | manifest v0.49.5 含 **sha256** 校验 |

这些正是规格 §七.2 防线 1「采用**人工编排**的上海中考考纲结构化本体」所需，
但产品**完全没用到**，也没有任何构建脚本把 `resources/` 转换成 `packages/server/data/`。

### 3.5 规格 §七 质量防线逐条

| 防线 | 判定 | 说明 |
|---|---|---|
| 每日任务硬性封顶 3 项 | ✅ | `planning-engine.ts:314,352` |
| 每日总时长 ≤ 预算 | ❌ | 30/35 档位超支（P0-5） |
| 生成题强制输出 `verificationCheck` | ✅ | `ai.routes.ts:311-340` Pass2 独立盲解审计 |
| 诊断结论 100% 绑定证据 | ❌ | 多模态主路径绕过 schema 校验（P1-2） |
| 讲解可逃生率 100% | ✅ | `CoachPage.tsx:698-710` + `registry.ts:148` |
| 拒绝虚假提分指标 | ✅ | `ReportPage.tsx:115-119` 仅 `掌握/稳定掌握` 计入已修复 |
| 知识体系人工编排不临场编造 | ⚠️ | 版本戳完整（资产 + prompt 双版本），但 KP **无 `reviewedBy`/`reviewedAt` 等审核痕迹**，且数据量仅 18 点 |

---

## 四、为什么「579/579 通过、24/24 断言通过」没能发现问题

这是本次分析最值得记录的**方法论问题**。

### 4.1 E2E 测试的作用域太窄

`tests/e2e/teacher-dashboard.mjs`（461 行，24 条断言）只覆盖：
登录 → 教师工作台 → localStorage 边界 → 畸形知识体系快照 → 畸形会话 → 运行时错误 → API 调用。

**它从未点击**：诊断页的「启动 AI 试卷诊断」、规划页的滑块、报告页的成绩录入。
于是 P0-1~P0-4 这 4 个断链**没有一个会被 E2E 捕获**。

### 4.2 验收测试 TC-01~TC-09 是「服务端视角」的

`acceptance.test.ts` 逐条覆盖了 9 个用例，看起来完备。但它们都直接调服务端 API，
**不经过前端**。而本次发现的 P0 几乎全在「前端 → 服务端」的接缝上：

| 用例 | 测试做法 | 真实链路是否成立 |
|---|---|---|
| TC-01 | 直接 POST 诊断端点（Mock Provider） | ❌ 前端上传路径断链（P0-3） |
| TC-02 | 直接 POST `/plans` + 直接改 student JSON | ❌ 前端不调这两个端点（P0-4） |
| TC-06 | 服务端读 mastery/exam-results | ❌ 诊断不写 mastery（P0-1）、ExamResult 不落库（P0-2） |

**TC 测试通过 ≠ 用户路径可用。** 这是文档 #19/#20 已经总结过的教训，
但没有上升为**所有用例的验收准则**。

### 4.3 测试数据恰好避开了边界

| Bug | 为什么漏掉 |
|---|---|
| 预算超支（P0-5） | `engines.test.ts` 只测 `dailyBudgetMinutes: 60` —— 唯一不触发的档位 |
| 先修「未诊断」漏判（P1-1） | 测试用的 `makeMastery()` **总是构造出 record**，恰好构造出「待学习」而非「未诊断」 |
| `LearningAttempt` 丢字段（P1-3） | seed 数据是全字段，测试读的是 seed 而非运行时写入 |
| 多模态绕过校验（P1-2） | 校验测试走的是纯文本路径 |

**模式**：测试用「典型值」，生产用「边界值」；测试直接调 API，生产走 UI。

---

## 五、值得肯定的部分（不要在修复时破坏）

1. **架构分层干净**：后端零依赖 `web/`，前端零依赖后端实现。
   契约包 `packages/contracts/` 只含类型与纯校验函数，不含业务逻辑 —— 判断正确，
   这直接保护了「掌握度/提分优先级/预算约束不可被学生篡改」。
2. **服务端权威性设计正确**：优先级公式、预算公式、6 阶状态机全部下沉服务端，
   延迟复测用服务端时钟（`RETEST_INTERVAL_DAYS = 3`）。
3. **安全修复有真实价值**：归属校验用 `existing.studentId` 而非请求体自述值、
   `db.withExclusive()` 逻辑键排他锁、`sanitizeSegment()` + `resolvePath()` 双重路径穿越防护、
   魔数校验、备份恢复路径校验 —— 这些是能落地的生产级加固。
4. **并发缺陷有实测记录**：「5 个并发作答只剩 1 条」「同一 key 并发产生 10 个任务」
   都是真实复现后修复的，不是想象出来的风险。
5. **localStorage 边界已收紧**：`purgeLegacyState()` 清理遗留全量 AppState，
   业务数据一律服务端化。

---

## 六、修复优先级建议

### 第一梯队（解除验收阻塞，约 60 行改动）

| # | 修复 | 位置 | 成本 |
|---|---|---|---|
| 1 | 诊断落库时调用 `mastery-engine` 更新 MasteryRecord + 迁移事件 | `exam.routes.ts:112-219` | 中 |
| 2 | 删除前端 `App.tsx:497-531` 本地推导 | `web/src/App.tsx` | 小 |
| 3 | `ExamResult` 建实体 + 持久化 + `POST` 写入端点 | `exam.routes.ts` | 中 |
| 4 | `handleUpdateStudent` 调 `PUT /students/:id/profile`，并把 student 加入计划拉取依赖 + 调 `POST /plans` | `web/src/App.tsx:186-192` | 小 |
| 5 | 示例试卷走 base64 上传路径 | `DiagnosisPage.tsx:325-336` | 小 |
| 6 | 预算分配改为预算感知（去掉 15 分钟硬下限） | `planning-engine.ts:371-375` | 小 |
| 7 | 先修锁定：`preRec` 缺失时视作「未诊断」 | `planning-engine.ts:162` | **1 行** |

第 6、7 项合计约 20 行改动 + 3 个回归测试，收益最大。

### 第二梯队（补齐测试盲区）

| # | 修复 | 说明 |
|---|---|---|
| 8 | E2E 扩到覆盖诊断/滑块/成绩录入三条用户路径 | 把 TC-01/02/06 改成**浏览器级**用例 |
| 9 | 边界档位测试：预算 30/35、先修无 record | 防止同类 bug 再现 |
| 10 | 验收测试改为**经前端链路**断言，而非直调 API | 根治「接口通过≠功能可用」 |

### 第三梯队（补齐规格语义）

| # | 修复 |
|---|---|
| 11 | 多模态与 Job 路径复用 `validateAgainstSchema`；schema 加 ENUM 支持 |
| 12 | `LearningAttempt` 补齐 4 个字段的接收与写入 |
| 13 | 错题 `待复测` 状态写入路径 |
| 14 | 微测置信度分级（不要硬编码 `确定`） |
| 15 | `QuestionKnowledge` 落地或从规格中移除（勿留空壳） |
| 16 | 建立 `resources/` → `packages/server/data/` 的知识资产构建脚本，导入 3557 topics / 14375 题，KnowledgePoint 补 `reviewedBy`/`reviewedAt`/来源溯源 |

---

## 七、给文档的一句话修正建议

`separation-implementation-status.md` 的 60 个 ✅ 应当区分两类：

- **架构类 Phase**（1、4、5、8 的安全修复与解耦）—— ✅ 属实，且质量高。
- **功能闭环类 Phase**（7a~7c、Phase 4e、Phase 6f）—— ⚠️ **接口齐备 ≠ 功能可用**，
  至少 TC-01、TC-02、TC-06 三条在真实链路上不成立。

建议在验收标准中补一条**强制准则**：

> 每个 TC 用例必须有一条**从 UI 操作出发**的浏览器级断言，
> 且断言「用户可见的结果」而非「API 返回值」。
> 服务端单元测试通过**不构成**该用例通过。

---

## 附录：核查方法与可信度

- **静态核查**：规格逐条对照代码，定位到 file:line。
- **动态复现**：P0-5（预算超支）与 P1-1（先修漏判）**实际跑通** `buildSevenDayPlan` 复现，
  非静态推断（复现脚本已清理，未改动仓库）。
- **测试基线**：server 408/408、web 130/130、contracts 41/41 —— **全部通过，与文档声称一致**。
  也就是说，**本文的所有缺陷都是在"测试全绿"的前提下存在的**，这本身就是测试有效性的证据。
- **未覆盖**：未启动应用做运行时点击验证；AI 真实调用质量、模型返回稳定性未评估
  （无 `GEMINI_API_KEY` 的 Mock 环境下不可测）。
