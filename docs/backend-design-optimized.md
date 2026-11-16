# 后端设计优化方案（结合现有前端实现）

> 本文是对 `docs/backend-design.md` 的**增量修订**，不是重写。
>
> 原文档是"从零开始的理想架构"。但仓库里**已经有一套可运行的前端 + 一个 583 行的单文件后端**。
> 原文档的最大问题不是架构错，而是**与现状脱节**：它描述了一个不存在的项目。
>
> 本文的每一条优化都基于对现有代码的实际审计，目标是：
> **让后端设计能真正接住前端已经实现的业务闭环，而不是重写一个前端等三年。**

---

## 零、先看清现状：文档假设 vs 代码现实

审计了 `server.ts`(583行)、`src/types.ts`(295行)、`src/engine/planner.ts`(449行)、`src/App.tsx`(653行)、`src/components/*`(约 5800 行)。

| 维度 | 原文档的假设 | 代码现实 | 差距性质 |
|---|---|---|---|
| 运行时依赖 | **零第三方运行时依赖** | `express`、`@google/genai`、`dotenv` 已安装并重度使用 | 🔴 直接冲突 |
| AI 接入 | AI 是"可选增强"，Mock/Rule/Manual Provider 先行 | `gemini-4-hydrogen` 是**唯一诊断引擎**，5 个接口全部直连模型 | 🔴 完全相反 |
| 业务逻辑位置 | 全部在服务端 Domain/Application 层 | **提分算法、7天计划、掌握度状态机全在前端** `planner.ts` | 🔴 位置错位 |
| 持久化 | 服务端 JSON 文件 + Repository | **全部在浏览器 localStorage**（`App.tsx:29`） | 🔴 位置错位 |
| 实体模型 | Student/Exam/Diagnosis/Plan/Task/Mastery 等独立聚合 | 前端 `AppState` 已是**一个扁平大对象**（16 个字段） | 🟡 模型可对齐 |
| 知识体系 | 服务端知识本体 + `knowledgeDependencies` | 前端 `shanghaiCurriculum.ts` **硬编码 589 行**，prerequisites 已建模 | 🟢 可平滑迁移 |
| 试卷识别 | "无 OCR 就不假装实现" | **已实现**，Gemini 视觉 + responseSchema 强约束 | 🟢 已超越文档 |
| 错因分类 | 9 类 `ErrorType`（英文枚举） | 前端已用 **5 类中文**（知识/方法/计算/熟练度/审题） | 🟡 需对齐枚举 |
| 双轮验算 | 文档未提 | `practice/generate` 已实现 **Pass1生成 + Pass2盲解审计** | 🟢 已超越文档 |
| 认证授权 | 提到但列为 P4 | **完全没有**，`/api/*` 无鉴权、无限流 | 🔴 生产阻断 |

**结论**：原文档的架构哲学（分层、纯函数引擎、Repository 抽象、版本化、证据可追溯）是对的且有价值，
但它的**技术选型前提**（零依赖、无模型）和**业务边界**（逻辑在服务端）与现状直接冲突。

优化策略：**保留原文档的架构内核，替换其与现实冲突的部分。**

---

## 一、最大的架构问题：业务逻辑放错了位置

这是本次优化要解决的第一优先级问题。

### 1.1 现状问题

前端 `src/engine/planner.ts` 承担了全部核心业务算法：

| 函数 | 位置 | 业务含义 | 应属于 |
|---|---|---|---|
| `computePriorityOpportunities()` | planner.ts:84 | 提分机会优先级计算 | **ScoreEngine** |
| `buildSevenDayPlan()` | planner.ts:243 | 7天计划生成 + 时间预算约束 | **PlanningEngine** |
| `evaluateMasteryTransition()` | planner.ts:364 | 掌握度状态机迁移 | **MasteryEngine** |
| `getEffectiveDailyBudget()` | planner.ts:71 | 每日预算因子 | **PlanningEngine** |
| `getDelayedRetestStatus()` | planner.ts:31 | 3天延迟复测解锁 | **MasteryEngine** |

这带来四个具体问题：

1. **数据无法跨设备**。学生换浏览器/清缓存，`localStorage` 全丢，学习轨迹、错题记录、掌握度全部归零。
2. **多端不一致**。同一份数据在手机和电脑上算出不同的计划，因为 `planner.ts` 依赖 `Date.now()`（planner.ts:53, 401）——不同设备时区/时间不同，结果就不同。
3. **无法审计**。前端算法没有任何版本号和日志。用户问"为什么这周计划变了"，无法回答。
4. **无法验证**。规划引擎的"每天不超过 60 分钟"这个硬约束，目前**没有任何测试守护**（原文档 §10.1 TC08 要求有）。

而 `src/App.tsx:71` 每当 `appState` 变化就重算整个计划：

```ts
const plan = useMemo(() => buildSevenDayPlan(appState), [appState]);
```

`appState` 里任何字段变化（包括 `coachHistoryByKnowledge` 的聊天记录）都会触发**全量 7 天计划重算**。在 React 里这还算能接受，但一旦移到服务端，每次聊天都要重算并持久化整份计划——这是设计缺陷。

### 1.2 优化方案：引擎上移，但保持"纯函数 + 服务端权威"

**原则**：引擎是纯 TypeScript 函数，**同时**被服务端（权威计算 + 持久化）和前端（乐观预览）使用。
一份代码，两个运行位置，通过共享包保证一致性。

```
packages/
├── shared/                 # 前后端共享（纯 TS，零依赖）
│   ├── domain/             # 实体、值对象、枚举
│   │   ├── mastery.ts      # MasteryState 状态机 + 迁移规则
│   │   ├── planning.ts     # 时间预算、任务步骤拆分
│   │   └── scoring.ts      # 提分优先级公式
│   ├── engines/            # 纯函数引擎（无 IO）
│   │   ├── score-engine.ts
│   │   ├── planning-engine.ts
│   │   └── mastery-engine.ts
│   ├── contracts/          # API 请求/响应类型（单一事实源）
│   └── curriculum/         # 知识体系（从 src/data 迁移过来）
├── server/                 # Node.js 服务端
└── web/                    # React 前端
```

关键收益：
- **消除重复实现**。当前 `planner.ts` 的逻辑迁移到 `shared/engines/` 后，服务端用来算权威结果，前端直接 import 同一份做本地预览，**永远不会出现两边算法不一致**。
- **可测试**。纯函数放进 `packages/shared/engines/`，用 `node:test` 直接测，不依赖 HTTP、文件系统、模型（原文档 §12.3 的要求，且现在能真正做到）。
- **引擎可以按需上移到服务端**。第一阶段前端继续算（体验不变、零迁移成本），第二阶段服务端成为唯一权威，前端只做乐观渲染 + 服务端结果覆盖。

**迁移策略（渐进、不破坏现状）**：

```
阶段 A  抽取：把 planner.ts 三个引擎函数原样搬到 packages/shared/engines/
         前端改为 import { buildSevenDayPlan } from '@shared/engines/planning-engine'
         → 代码零行为变化，但已经可测了
阶段 B  加测试：为三个引擎补 node:test，覆盖原文档 TC06/TC07/TC08/TC11
阶段 C  上移：服务端增加 /api/v1/plans/weekly，前端改为调用
         前端保留本地计算作为乐观渲染，服务端返回为权威值
阶段 D  收敛：服务端返回结果与前端本地计算不一致时，告警 + 记录
```

**不要**一步到位把前端逻辑全删了。前端本地预算是必要的（点击"生成计划"要有即时反馈），真正要消除的是"**两处独立的逻辑副本**"。

---

## 二、AI 接入层：原文档最大的误判

### 2.1 现状问题

原文档 §7 说"AI Provider 接口...初期使用规则引擎、Mock Provider 和本地能力实现"，并把 AI 定位为"可选增强"。

但代码现实是：

- `server.ts` 的 **5 个业务接口全部依赖 Gemini**，`createAiClient()` 在缺少 `GEMINI_API_KEY` 时直接 throw，**整个后端无法启动**。
- `server.ts:130-155` 的诊断 prompt 本身就是核心业务逻辑载体——它定义了 5 类错因、证据要求、置信度分级。
- `server.ts:400-435` 的双轮独立验算是**产品质量的关键机制**（防止模型给出错误标准答案），这个逻辑已经比文档描述的先进。

所以正确的做法不是"引入 Provider 抽象以摆脱模型依赖"，而是**引入 Provider 抽象以统一管理模型依赖**。

### 2.2 优化方案：保留 Provider 抽象，但补齐缺失的横切能力

现有代码的痛点（都在 `server.ts` 重复出现）：

```ts
// server.ts:62, 263, 455, 500 —— 每个接口都重复
const ai = createAiClient();
const response = await ai.models.generateContent({ model: 'gemini-4-hydrogen', ... });
const parsed = JSON.parse((response.text ?? '{}').trim());
res.json(parsed);
```

问题清单：

| 问题 | 具体表现 | 后果 |
|---|---|---|
| **无重试** | 单次网络抖动 = 整个请求 500 | 用户白等 30 秒 |
| **无超时** | 模型 hang 住则请求永久挂起 | 连接池耗尽，服务不可用 |
| **无降级** | 模型返回非法 JSON 直接 `JSON.parse` 崩 | 整个诊断流程中断 |
| **无成本控制** | 每次 `practice/generate` 调 2 次模型，每次诊断传 4 张图 | token 成本失控 |
| **无提示词版本** | prompt 硬编码在 `server.ts` 里 | 改了 prompt 无法回溯"上周为什么这样诊断" |
| **无缓存** | 同一张试卷重复诊断重复付费 | 浪费 |
| **无并发限制** | 10 个学生同时诊断 = 10 个模型请求同时打 | 触发配额限流 |

### 2.3 具体改造

**（1）统一的 AI 调用层**

```ts
// packages/server/src/infrastructure/ai/gemini-provider.ts
export interface AIProvider {
  generateJson<T>(req: GenerateJsonRequest<T>): Promise<GenerateJsonResult<T>>;
  generateText(req: GenerateTextRequest): Promise<GenerateTextResult>;
}

export interface GenerateJsonRequest<T> {
  prompt: string;
  systemInstruction?: string;
  schema: JSONSchema;
  // ---- 新增：横切能力所需 ----
  temperature?: number;
  maxRetries?: number;        // 默认 3，指数退避
  timeoutMs?: number;         // 默认 120s
  idempotencyKey?: string;    // 用于缓存与去重
  purpose: AIPurpose;         // 'diagnosis' | 'practice-gen' | 'evaluation' | 'coach' | 'microquiz'
}
```

`generateJson` 内部负责：超时控制 → 指数退避重试 → JSON 解析容错 → **schema 校验**（不合法则重试）→ 返回 `validated: boolean` 标记。

**（2）Schema 校验必须补上**

现在依赖 Gemini 的 `responseSchema` 保证输出格式，但 `responseSchema` 是**软约束**（模型仍可能偏离）。当前 `JSON.parse` 后直接 `res.json(parsed)`，没有二次校验。

应在 `generateJson` 中用自研轻量 validator 校验返回结构，失败则重试或降级：

```ts
// 校验失败时的降级路径
if (!validateSchema(parsed, schema)) {
  logger.warn('ai.schema_invalid', { purpose, attempt });
  // 重试仍失败 → 降级到 RuleProvider 或返回结构化错误给前端
}
```

**（3）提示词版本化 + 外置**

原文档 §12.1 的"业务规则版本化"想法很好，但应该**先用在 prompt 上**，因为这是当前唯一会变的业务逻辑载体。

```ts
// packages/server/src/infrastructure/ai/prompts/registry.ts
export const PROMPTS = {
  'diagnosis.v1': (ctx: DiagnosisPromptContext) => `...`,
  'practice-generate.v1': (ctx: PracticeGenContext) => `...`,
  'coach.v1': (ctx: CoachContext) => `...`,
} as const;
```

诊断结果中记录 `promptVersion: 'diagnosis.v1'` + `model: 'gemini-4-hydrogen'`。
这样"上周和本周诊断结果变化"就有了解释依据——直接满足原文档 §12.2。

**（4）分层缓存策略**

| 场景 | 缓存键 | TTL |
|---|---|---|
| 知识本体摘要 `ontologyText` | 静态 | 进程内永久 |
| 同一张试卷重复诊断 | 图片内容 hash | 24h |
| 同一知识点的练习题生成 | `knowledgeId + level + sourceErrorId` | 7d |
| 教练回复 | 不缓存（对话有上下文） | — |

`server.ts:64` 每次请求都调 `buildOntologySummary()` 拼 589 行知识本体进 prompt——这部分是静态的，提到进程内缓存。

**（5）成本护栏**

```ts
// 每次请求带预算上下文
const ctx = {
  remainingTokens: await quota.getRemaining(studentId),  // 每日 token 配额
};
if (ctx.remainingTokens <= 0) {
  return res.status(429).json({ error: '今日 AI 用量已达上限，请明天再试' });
}
```

这直接解决"家长/学生刷爆 token"的现实问题，也是原文档完全没覆盖的运营维度。

---

## 三、数据模型：从扁平 AppState 到聚合模型

### 3.1 现状问题

前端 `AppState`（types.ts:276-295）是一个 16 字段的扁平对象，包含了**所有实体的混合**：

```ts
export interface AppState {
  student: Student;
  exams: Exam[];
  examResults: ExamResult[];
  examPapers: ExamPaper[];
  errorRecords: ErrorRecord[];
  masteryRecords: Record<string, MasteryRecord>;
  masteryHistory: MasteryTransitionEvent[];
  learningAttempts: LearningAttempt[];
  variantQuestions: VariantQuestion[];
  completedTaskIds: string[];
  deferredKnowledgeIds: string[];
  coachHistoryByKnowledge: Record<string, CoachMessage[]>;
  taskProgressByKnowledge: Record<string, {...}>;
}
```

问题：
- `localStorage` 每次 `appState` 变化就整体 `JSON.stringify` 全量写入（App.tsx:65）——**包含全部聊天记录和试卷**，一次小操作就重写几十 KB。
- `masteryHistory` 和 `masteryHistoryByKnowledge` 无上限增长。
- `examResults` 和 `examPapers` 存在**数据冗余**：`ExamPaper` 里又有 `examTitle`、`subject`、`date`，`ExamResult` 里也有。两者可通过 `examId` 关联，但被拍平复制了。

### 3.2 优化方案：实体化 + 聚合边界

原文档 §4.1 的目录设计是对的，直接采用，但要做几个针对前端的适配：

```
data/
├── students/{studentId}.json          # 聚合根：档案 + 预算偏好
├── exams/{examId}.json                # 聚合根：考试元信息 + 成绩 + 关联试卷ID
├── papers/{paperId}.json              # 聚合根：试卷 + 识别结果 + 诊断条目
├── questions/{questionId}.json        # 生成的练习/变式题（含双轮验算结果）
├── mastery/{studentId}.json           # 聚合根：掌握度记录 + 迁移历史
├── attempts/{studentId}/{date}.jsonl # 追加写：作答流水
├── plans/{studentId}/{planId}.json    # 聚合根：7天计划（快照）
├── coaching/{studentId}/{knowledgeId}.json  # 教练会话（按知识点切分）
├── events/{yyyy-MM-dd}.jsonl          # 事件日志
└── jobs/{jobId}.json
```

**关键适配点 1：拆开 `ExamPaper` 与 `ExamResult`**

```ts
// 修正后：ExamPaper 不再重复存 examTitle/subject/date
interface ExamPaper {
  id: string;
  examId: string;              // ← 关联 Exam，不重复
  subject: Subject;            // 保留（试卷识别时可能先于考试创建）
  sourceFormat: '试卷拍照' | '文本试卷' | '单题录入';
  status: '已识别' | '待校验';
  totalLostScore: number;
  questionsCount: number;
  summary: string;
  detectedMetadata: DetectedMetadata;  // AI 提取的原始元信息（未确认）
  confirmedMetadata?: ConfirmedMetadata; // 人工确认后的元信息
  knowledgeIds: string[];
  createdAt: string;
}
```

这直接对应原文档 §9 的"提取题目、答案、学生作答和得分；**不能自动识别的部分进入人工确认**"——现在代码里 `detectedMetadata` 的 `confidence: '待验证'` 已经在做这件事，但**没有数据结构承载"人工确认后的覆盖值"**，人工在 UI 上改了就直接丢。

**关键适配点 2：诊断结果从 Paper 中独立出来**

当前 `diagnosedItems` 是 `diagnose-paper` 接口的返回值，前端 `DiagnosisPage` 拿到后塞进 `errorRecords`。这些条目有独立生命周期（订正状态 `未订正|已订正|待复测|已闭环`、订正备注），**不该埋在 paper 文件里**：

```ts
interface ErrorRecord {
  id: string;
  paperId: string;
  questionNumber: string;
  subject: Subject;
  stem: string;
  studentAnswer: string;
  correctAnswer: string;
  scoreLost: number;
  errorType: ErrorType;          // 5 类中文枚举，与前端一致
  knowledgeId: string;
  knowledgeName: string;
  aiAnalysis: string;
  evidence: string;
  confidence: ConfidenceLevel;   // 确定|较可能|待验证
  verificationMethod: string;
  status: '未订正' | '已订正' | '待复测' | '已闭环';
  correctionNote?: string;
  // ---- 可追溯性（原文档 §12.2）----
  promptVersion: string;
  model: string;
  reviewStatus: 'unreviewed' | 'confirmed' | 'corrected';
  createdAt: string;
}
```

**关键适配点 3：掌握度聚合**

`masteryRecords` + `masteryHistory` + `learningAttempts` 强相关，属于同一聚合：

```ts
interface MasteryAggregate {
  studentId: string;
  records: Record<string, MasteryRecord>;   // knowledgeId → record
  history: MasteryTransitionEvent[];         // 有上限（保留最近 N 条 + 归档）
  lastComputedAt: string;
}
```

历史事件无上限增长是 localStorage 方案的必然产物，迁到服务端后可以：
- 按月分文件归档
- 只保留状态**变更**事件（当前 `masteryHistory` 记的应该是这个）
- 便于按原文档 §4.4 做轨迹还原

**关键适配点 4：任务进度归位**

```ts
// 当前：completedTaskIds: string[] + deferredKnowledgeIds: string[] + taskProgressByKnowledge
// 这些都是 plan 的派生状态，应该放在 Plan 聚合内
interface LearningPlan {
  id: string;
  studentId: string;
  weekLabel: string;
  effectiveDailyBudget: number;
  generatedAt: string;
  engineVersion: string;        // ← 计划算法版本（可追溯）
  priorities: PriorityOpportunity[];
  days: DailySchedule[];
  taskStates: Record<string, TaskState>;  // 完成/延后/步骤进度
}
```

`completedTaskIds` 和 `deferredKnowledgeIds` 脱离 plan 单独存，导致**多份 plan 之间状态串味**（当前只存一份所以没暴露）。

---

## 四、枚举与契约对齐：避免前后端两套真相

这是**最容易立刻见效**的一类优化。

### 4.1 错因分类不一致

| 位置 | 取值 |
|---|---|
| 原文档 §6.1 | 9 类英文：`KNOWLEDGE_GAP` / `CONCEPT_MISUNDERSTANDING` / `METHOD_ERROR` / `CALCULATION_ERROR` / `READING_ERROR` / `EXPRESSION_ERROR` / `TIME_MANAGEMENT` / `CARELESSNESS` / `UNKNOWN` |
| 前端 types.ts:8-13 | 5 类中文：`知识问题` / `方法问题` / `计算问题` / `熟练度问题` / `审题问题` |
| server.ts:144-148 | 5 类中文（与前端一致） |

**后端实际已经用了 5 类中文**。原文档的 9 类是纯设计推演，从未落地。

**优化**：统一为 5 类中文枚举（保持现状），但**补上英文 code 字段**用于稳定标识：

```ts
export const ERROR_TYPES = [
  { code: 'KNOWLEDGE',    label: '知识问题' },
  { code: 'METHOD',       label: '方法问题' },
  { code: 'CALCULATION',  label: '计算问题' },
  { code: 'FAMILIARITY',  label: '熟练度问题' },
  { code: 'COMPREHENSION',label: '审题问题' },
] as const;
```

理由：中文 label 是展示给用户看的，英文 code 是给代码和日志用的。混用中文做标识符会导致后续做 i18n、统计聚合、Prompt 注入时都要做转换。

同理，`MasteryState`（6 个中文状态）、`ConfidenceLevel`（3 级）、`PracticeMode`（5 种）都应采用 `{ code, label }` 双轨。

### 4.2 契约单一事实源

当前前端**手写**了所有 API 的响应类型（`DiagnosisPage.tsx:400` 用 `as Record<string, unknown>` 强转），这是典型的运行时炸弹：

```ts
const meta = (data.detectedMetadata ?? {}) as Record<string, unknown>;
const aiSubject = ALL_SUBJECTS.includes(String(meta.subject) as Subject) ? ... : ...
```

前端在**每个字段上做防御性校验**，因为它不知道后端返回什么。

**优化**：在 `packages/shared/contracts/` 定义 Zod-free 的手写类型 + 运行时校验器（保持零运行时依赖），前端与服务端共用：

```ts
// packages/shared/contracts/diagnosis.ts
export interface DiagnosePaperResponse {
  detectedMetadata: DetectedMetadata;
  paperSummary: string;
  questionsDetectedCount: number;
  totalLostScore: number;
  diagnosedItems: DiagnosedItem[];
}

export function parseDiagnosePaperResponse(raw: unknown): DiagnosePaperResponse | null {
  // 运行时校验，失败返回 null → 前端显示"服务返回格式异常"而非白屏
}
```

前端从"信任 + 防御"变成"解析 + 显式降级"。

### 4.3 API 响应结构统一

原文档 §8.2 定义了 `ApiResponse<T>` 包裹结构。**建议不要照搬**——现有 5 个接口都直接返回裸对象，前端已经依赖这个形态。

折中方案：

```ts
// 成功：保持裸对象，与现有前端兼容
// 失败：统一错误结构
interface ApiError {
  error: {
    code: string;         // 'AI_TIMEOUT' | 'VALIDATION_FAILED' | 'QUOTA_EXCEEDED' | ...
    message: string;      // 面向用户的中文
    details?: unknown;    // 面向开发
  };
  requestId: string;
}
```

**理由**：包裹成功响应的收益（统一元信息）远小于它带来的前端改造量和迁移风险。错误结构统一才是刚需——现在 5 个接口的错误都是 `{ error: string }`，没有错误码，前端无法区分"模型超时"和"参数错误"。

---

## 五、原文档中值得保留但需要调整的部分

### 5.1 Job Engine：保留，但明确优先级

原文档 §5 的 Job Engine 设计与当前场景**匹配度不高**。

当前 5 个接口全是**同步请求**，前端 `DiagnosisPage` 调 `/api/diagnose-paper` 后 `await resp.json()`，UI 转圈等待。

如果试卷诊断要上 Job Engine（异步 + 轮询/SSE），前端必须改造成：
1. POST 提交 → 拿 `jobId`
2. 轮询 `/api/jobs/:id` 或订阅 SSE
3. 拿到结果后渲染

**这是一次实质性的前端改造**，不能只改后端。

**建议分阶段**：

| 阶段 | 场景 | 方案 |
|---|---|---|
| 现在 | 诊断（通常 < 60s） | 保持同步 + 前端 loading + 超时重试提示 |
| 现在 | 练习生成（双轮模型调用，约 30s） | 保持同步 |
| P2 | 试卷解析（多图大试卷，可能 > 2min） | Job Engine + SSE 推送 |
| P2 | 周报生成 | Job Engine |

**同步 → 异步的契约设计**（提前定好，避免返工）：

```ts
// 统一响应：前端按 jobId 是否存在判断
type DiagnosePaperResult =
  | { mode: 'sync'; data: DiagnosePaperResponse }
  | { mode: 'async'; jobId: string; streamUrl: string };
```

SSE 端点（用 `node:http` 原生实现，符合零第三方目标）：

```
GET /api/v1/jobs/{jobId}/events
→ event: progress  data: { stage: '识别试卷结构', pct: 40 }
→ event: done      data: { result: DiagnosePaperResponse }
```

**保留原文档的价值**：Job 持久化到 `data/db/jobs/`、`attempts` 字段、`nextRetryAt` 退避、启动时恢复 RUNNING 任务——这些是真实需要的，因为模型调用确实会失败，必须能重试。

### 5.2 事件日志：保留，这是最被低估的价值

原文档 §4.4 的事件日志设计很好。结合前端看，**事件日志比文档说的更有价值**：

当前前端有完整的 `learningAttempts`（含 `hintsUsed`、`timeSpentSeconds`、`independent` 标记）和 `masteryHistory`（含 `fromState`/`toState`/`trigger`）。这些就是事件流，只是当前以"当前状态"的形式被存储——**中间过程丢失了**。

事件日志能直接支撑：
- **掌握度重算**：用事件流离线重放，验证 MasteryEngine 的正确性（原文档 TC11）
- **诊断结果更新**：新一次考试后，旧错题记录仍应保留并影响优先级
- **教学效果分析**：`hintsUsed` 趋势 vs 最终掌握度

**关键约束**（原文档已提到，但要强调）：**先持久化业务结果，再记录事件**。当前顺序不能反，否则会出现"事件说学生做对了，但掌握度没更新"的不一致。

### 5.3 知识体系：保持在服务端，但要改造成"可版本化资产"

`src/data/shanghaiCurriculum.ts` 是 589 行的硬编码知识本体，`server.ts:27` 直接 import 它。

这在当前是**合理的**（前后端共用同一份，避免 ID 不一致），但原文档 §12.1 的版本化想法在这里很有价值：

```ts
interface CurriculumVersion {
  version: string;          // 'shanghai-junior-2026.1'
  publishedAt: string;
  status: 'DRAFT' | 'ACTIVE' | 'DEPRECATED';
  subjects: Subject[];
  knowledgePoints: KnowledgePoint[];
}
```

原因：
1. 上海中考考纲会调整（每年新考纲），知识点需要增删
2. 诊断结果引用 `knowledgeId`，如果 ID 被复用或删除，历史诊断就失去语义
3. 原文档 §12.1 说"这样才能解释为什么学生上周和本周的诊断结果发生变化"——**知识体系版本是诊断结果变化的第一嫌疑原因**，必须记录

具体做法：诊断结果记录 `curriculumVersion: 'shanghai-junior-2026.1'`。

### 5.4 Repository + 文件存储：保留

原文档 §4.3 的四个要求（原子写、并发串行化、版本号、备份）都正确且必要。当前**完全没有实现**——所有数据在 localStorage。

补充一条原文档没提但同样重要的：**文件大小监控**。`mastery` 和 `events` 文件会持续增长，需要：
- 单文件超过阈值（如 5MB）时自动分片
- `events/` 按月轮转

---

## 六、原文档中需要修正或删除的部分

诚实地说，原文档有几处**过度设计**或**已被现实证伪**，照做会浪费时间。

### 6.1 「零第三方运行时依赖」应当放弃

原文档反复强调这个约束（"零第三方运行时依赖"是核心原则之一）。但：
- `express` 已在用，且 `server.ts:38-39` 用它做 35MB body limit + JSON 解析，写得挺简洁
- 自研 Router + 自研 Schema Validator + 自研 Logger + 自研 Job Queue + 自研 Migration Runner，**合计至少 2000 行胶水代码**
- 这些胶水代码的维护成本，会超过未来迁移到数据库/框架的成本

**建议**：保留"不引入外部基础设施"（数据库、MQ、Redis、向量库）——这个约束是合理的、也是真实的价值。但**放宽运行时库限制**：

| 能力 | 现状 | 建议 |
|---|---|---|
| HTTP 框架 | express | ✅ 保留 express，不要自研 Router |
| 校验 | 手写 | 考虑 `zod`（零运行时负担，前后端都能用，解决 §4.2 的契约校验） |
| 测试 | 无 | 保留 `node:test`（Node 内置，无依赖） |
| ORM | 无 | ✅ 继续不用，Repository 抽象保留 |
| 日志 | console.error | 建议加 `pino` 或保留自研轻量版 |
| AI SDK | `@google/genai` | ✅ 保留，Provider 抽象包在外面 |
| 调度 | 无 | `node:timers` 够用 |

**一句话**：架构解耦（Repository、Provider、纯函数引擎）是真正有价值的；**"不用库"不是**。用库实现解耦，比手写胶水实现解耦更便宜、更可靠。

### 6.2 「AI 是可选增强」应当删除

原文档 §7 的整段前提是"没有模型也能开发"。但项目**已经有模型能力且用得很好**（双轮验算、结构化输出、置信度分级）。

**正确表述**：AI 是**必需的**（当前），但必须是**可替换的**（Provider 抽象）、**可追溯的**（版本化）、**可校验的**（schema 校验 + 证据要求）、**有成本护栏的**（配额）。

原文档 §7.2 "不要让大模型负责学生成绩计算、任务状态迁移和提分时间预算"这条**非常正确，且应保留**——它正好对应前端 `planner.ts` 的正确做法：算法在前端/后端都是确定性 TS，不交给模型。前端现状是对的。

### 6.3 四层目录结构可以适当扁平

原文档 §3.1 要求每个业务模块都有 domain/application/infrastructure/presentation 四个子目录，12 个模块 = 48 个目录。

对一个 MVP 来说，**目录层级本身是成本**。建议按实际复杂度分档：

```
packages/server/src/
├── domain/          # 跨模块共享的实体与枚举（types.ts 的服务端版本）
├── engines/         # 纯函数引擎（共享包，这里只放服务端的）
├── modules/
│   ├── diagnosis/   # 复杂模块：完整四层
│   ├── mastery/     # 复杂模块：完整四层
│   ├── planning/    # 中等：domain + application + infrastructure（无独立 presentation）
│   └── practice/    # 简单：单文件 controller + service
├── infrastructure/  # ai / persistence / jobs / logging
├── api/             # routes / middleware / error-handling
└── bootstrap/
```

**判据**：如果一个模块的 domain 只有一个 interface、application 只有一个函数，就不要拆成四个目录。

### 6.4 12 条验收用例需要调整为前端可执行的断言

原文档 §10.1 的 TC01-TC12 方向对，但 TC03"上传试卷 → 文件完整保存"在**零文件存储**的当前架构下不成立——前端是 base64 直传模型，不落盘。

**建议改写为**：

| 编号 | 场景 | 验收断言 | 层级 |
|---|---|---|---|
| TC05 | 错因诊断 | 每个结论的 `evidence` 非空且 `confidence='待验证'` 时必须有 `verificationMethod` | 契约 |
| TC06 | 多知识点关联 | 失分分配后各知识点之和 == 题目总失分（±0.01） | 单元 |
| TC07 | 提分规划 | 给定固定输入，优先级排序结果完全可复现 | 单元 |
| TC08 | 时间约束 | `Σ task.estimatedMinutes ≤ effectiveDailyBudget` 且 `≥ 1` 个任务 | 单元 |
| TC09 | 任务状态机 | 非法状态迁移（如 未诊断→稳定掌握）被拒绝 | 单元 |
| TC11 | 掌握度更新 | 仅 `independent=true` 的作答可推进到"稳定掌握" | 单元 |
| TC12 | 异常恢复 | 服务重启后 RUNNING 任务被重新入队 | 集成 |
| **新增 TC13** | **前后端一致性** | 同一输入下，服务端计算结果 == 前端本地计算结果 | 契约 |
| **新增 TC14** | **AI 降级** | 模型超时/返回非法 JSON 时，返回结构化错误而非 500 崩溃 | 集成 |
| **新增 TC15** | **成本护栏** | 超过每日配额时拒绝新 AI 请求并返回 429 | 集成 |

**TC13 是新增的最有价值的一条**——它守住"共享引擎包"这个架构决策不腐化。

---

## 七、安全与合规（原文档标记 P4，但应提前）

原文档 §13 提到"如果要正式服务真实未成年学生，认证、权限隔离、数据备份、删除机制和安全审计不能省略"，这个判断正确，但把它排在 P4 太晚了。

结合前端看，**有三个现在就需要处理的问题**：

### 7.1 API 无鉴权

`server.ts` 的 5 个接口全部公开可调。任何人都能：
- 用你的 `GEMINI_API_KEY` 无限调用（真金白银）
- 提交任意图片让模型解析
- 拿到教学 prompt 的完整系统指令（可用于 prompt 注入）

**最小可行方案**（不需要引入第三方 auth 框架）：

```ts
// 自研 API Key 中间件（父、学生、老师三种角色）
// token → { studentId, role, dailyTokenQuota }
```

**关键**：token 必须绑定 `studentId`，因为后续所有数据都要按学生隔离。原文档 §8.2 列了"身份认证""角色与资源权限检查"，但需要从 P4 提到 P1。

### 7.2 试卷图片与学生个人信息的访问控制

原文档 §13 特别强调了"试卷图片和学生个人信息，应采用独立访问控制，不能直接暴露文件目录"。这个判断在当前**尚未成为问题**（因为文件不落盘），但一旦引入文件存储就会立刻成为问题。

**建议**：文件存储从第一天就设计成"存文件、按 ID 取、鉴权后返回"，不要提供静态目录服务。

### 7.3 未成年人数据

`Student` 包含 `name`、`targetSchool`、`targetExamDate`——这是未成年人个人信息。

**建议**：数据模型里给 `student` 聚合加 `dataRetentionUntil` 字段，并在 Job Engine 里加一个每日清理任务，落实删除机制。

---

## 八、落地路线图（修订版）

原文档 §11 的四阶段划分合理，但阶段内容需要按"**前后端协作**"重新组织，因为很多工作横跨前后端。

### P1 基础框架（前后端并行）

| 任务 | 归属 | 交付 |
|---|---|---|
| 抽取 `packages/shared/`：types + engines + contracts | 前端主导 | planner.ts 逻辑零行为迁移到 shared 包 |
| 为三个引擎补 `node:test` | 前端主导 | TC06/TC07/TC08/TC09/TC11 通过 |
| `packages/server/` 工程骨架 | 后端 | express + tsx + 结构化日志 + requestId |
| API Key 中间件 + 角色模型 | 后端 | 鉴权前置 |
| 错误响应统一结构 | 后端 | 错误码体系 |
| AI 调用层：超时/重试/schema校验/缓存 | 后端 | TC14 通过 |
| 提示词外置 + 版本化 | 后端 | prompt registry |

**P1 出口标准**：`node:test` 全绿，前后端共用同一份引擎代码，服务端能跑通 `/api/v1/health` 和鉴权。

### P2 核心业务（后端为主）

| 任务 | 归属 | 交付 |
|---|---|---|
| Repository + 原子写文件存储 | 后端 | 聚合落盘 |
| 学生/考试/试卷聚合 | 后端 | `POST /api/v1/exams`、`POST /api/v1/exams/:id/papers` |
| 诊断用例：调用 AI + 校验 + 落盘 | 后端 | `POST /api/v1/exams/:id/diagnosis` |
| 诊断结果人工确认流程 | 后端 + 前端 | `PATCH /api/v1/errors/:id/confirm` |
| 事件日志写入 | 后端 | 先落业务结果，再记事件 |
| Job Engine 骨架 | 后端 | 持久化 + 重试 + 启动恢复 |

**P2 出口标准**：上传试卷 → 诊断落库 → 断电重启 → 数据完好、任务可恢复。

### P3 学习引擎（前后端协作）

| 任务 | 归属 | 交付 |
|---|---|---|
| 掌握度聚合 + 服务端权威计算 | 后端 | `POST /api/v1/attempts` → 自动更新掌握度 |
| 计划服务端权威化 | 后端 + 前端 | `GET /api/v1/plans/weekly`，前端乐观渲染 + 服务端覆盖 |
| 一致性校验（TC13） | 前后端 | CI 中对比两端结果 |
| 教练会话持久化 | 后端 | 按学生+知识点切分 |

**P3 出口标准**：跨设备登录后数据一致；前端本地与服务端计算结果一致。

### P4 异步化与产品完善

| 任务 | 归属 | 交付 |
|---|---|---|
| 试卷解析转异步 + SSE | 后端 + 前端 | `GET /api/v1/jobs/:id/events` |
| 成本护栏与配额 | 后端 | TC15 |
| 报告生成 | 后端 | 周报 Job |
| 备份与恢复演练 | 后端 | 定期备份 + 恢复验证 |
| 权限矩阵与审计日志 | 后端 | 家长/学生/老师三角色 |
| 知识体系版本化 | 前后端 | `curriculumVersion` 贯穿诊断结果 |

---

## 九、给 CodeAgent 的执行 Spec（第一步该做什么）

原文档结尾说"下一步最有价值的交付物不是继续扩展架构文档，而是把以上设计转化为 CodeAgent 能直接执行的工程 Spec"。

结合前端现状，**第一步应该是"抽取"而不是"新建"**。因为现有 `planner.ts` 已经是可用的高质量实现，重写它是最浪费的行为。

### 任务 1：建立共享包并抽取引擎（最高优先级）

```
目标：
  把 src/engine/planner.ts 的三个引擎函数 + src/types.ts 的类型
  移动到 packages/shared/，前端改为 import 引用，行为完全不变。

约束：
  - 不改变任何计算逻辑，不改变任何阈值
  - 不引入 zod 等第三方依赖到 shared 包（保持纯 TS）
  - 补齐 node:test 覆盖：优先级可复现性、每日预算约束、状态机非法迁移拒绝

验收：
  - npm test 全绿
  - git diff 确认 planner.ts 的逻辑变更仅为"移动"，无逻辑修改
  - 前端行为零变化（同一份 appState 生成的计划完全一致）
```

### 任务 2：抽取 API 契约

```
目标：
  把 server.ts 5 个接口的请求/响应类型提取到 packages/shared/contracts/，
  并提供运行时解析函数。

约束：
  - 响应结构保持裸对象（不引入 ApiResponse 包裹，避免前端大规模改造）
  - 错误结构统一为 { error: { code, message, details? }, requestId }
  - 枚举统一为 { code, label } 双轨，中文 label 保持现有值不变

验收：
  - 前端不再需要 `as Record<string, unknown>` 强转
  - 非法响应时前端有明确降级路径，不白屏
```

### 任务 3：AI 调用层加固

```
目标：
  把 server.ts 中 5 处重复的 generateContent 调用收敛到统一的 generateJson()。

约束：
  - 行为兼容：现有 responseSchema 与 prompt 内容不变
  - 新增：超时、重试、schema 校验、提示词外置版本化、ontologyText 缓存
  - 降级：模型失败时返回结构化错误，不 500 崩溃

验收：
  - TC14 通过（模拟超时与非法 JSON）
  - 同一 prompt 重复调用不重复消耗模型（缓存命中）
```

**顺序很重要**：任务 1 先做，因为它零风险且立刻解锁测试；任务 2 次之，因为它建立前后端契约基线；任务 3 第三位，因为它是后端内部重构，不影响前端。

---

## 十、总结：五条最重要的优化

| # | 优化 | 现状 | 目标 | 优先级 |
|---|---|---|---|---|
| 1 | **引擎上移服务端，共享包消除逻辑副本** | 算法在 `planner.ts` 前端，localStorage 持久化 | 共享纯函数包 + 服务端权威 + 前端乐观渲染 | 🔴 最高 |
| 2 | **AI 调用层横切能力加固** | 5 处重复调用，无超时/重试/校验/成本控制 | 统一 `generateJson()` + schema 校验 + 提示词版本化 + 配额 | 🔴 最高 |
| 3 | **枚举与契约单一事实源** | 中文枚举直接做标识符，前端手写类型强转 | `{ code, label }` 双轨 + 共享 contracts + 运行时解析 | 🟠 高 |
| 4 | **放弃"零第三方运行时依赖"，保留"零外部基础设施"** | 自研胶水成本高 | 保留 express，引入 zod，架构解耦才是价值 | 🟠 高 |
| 5 | **鉴权与数据隔离前移到 P1** | API 全裸奔，token 额度无上限 | 自研 API Key 中间件 + 学生级数据隔离 + 配额 | 🟡 中高 |

**一句话总结**：原文档的**架构思想**（分层、纯函数引擎、Repository 抽象、版本化、证据链、事件日志）**全部保留**；需要替换的是**技术选型前提**（零依赖、无模型）和**逻辑位置假设**（全在服务端）。而最优先的落地动作不是建新架构，而是**把前端已有的好代码抽到共享包里**——让它既能被测试保护，又能在服务端复用。
