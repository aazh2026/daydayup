# 前后端分离架构设计方案

> 本文是 `docs/backend-design.md` 的**架构形态修订**，与 `docs/backend-design-optimized.md` 互补：
> - `backend-design.md` —— 原始设计（理想起点）
> - `backend-design-optimized.md` —— 结合代码现状的优化（为什么这么改）
> - **本文** —— 前后端分离的具体形态（怎么落地）
>
> 前提：承接上文的结论——保留分层、纯函数引擎、Repository 抽象、版本化、证据链；
> 放弃"零第三方运行时依赖"，保留"零外部基础设施"。

---

## 零、分离的动机与现状分析

### 0.1 什么是"前后端分离"（在这个项目里）

不是"把 `server.ts` 拆成两个进程"这么简单。在这个项目里，**前后端分离的核心是数据所有权的转移**：

| | 当前状态（伪分离） | 分离后 |
|---|---|---|
| 进程 | 同一个 Node 进程，Vite 以 middleware 模式挂载 | 独立进程 / 独立部署 |
| 数据 | **浏览器 localStorage** | 服务端持久化，前端只读缓存 |
| 业务逻辑 | **前端** `planner.ts` | 服务端权威 |
| 知识体系 | 前端 `shanghaiCurriculum.ts` 硬编码 589 行 | 服务端资产，前端通过 API 拉取 |
| 认证 | 无 | 服务端签发 token，前端携带 |
| 部署 | `npm run dev` 一个命令 | 前后端分别构建、分别部署 |

当前状态准确说是 **"单体 + SPA"**：Express 只做模型代理，业务状态全在浏览器。这导致：

1. **数据不可跨端** —— 学生换浏览器/清缓存，学习轨迹全丢
2. **多人协作不可能** —— 家长看孩子报告、老师批改，无法实现
3. **密钥边界模糊** —— `GEMINI_API_KEY` 在服务端是对的，但用户数据在客户端，服务端完全不知道数据真实存在
4. **无法审计** —— 服务端无业务日志，无法回答"这个学生上周为什么这样诊断"

### 0.2 耦合点清点（实测）

审计 `src/` 全部 import，识别出 4 类耦合：

| # | 耦合 | 具体位置 | 性质 | 分离后归属 |
|---|---|---|---|---|
| C1 | **知识体系** | `CoachPage:14-15`, `DiagnosisPage:13`, `ReportPage:3`, `App.tsx:10` | 数据耦合 | 服务端，前端拉取并缓存 |
| C2 | **领域引擎** | `App.tsx:11`（`buildSevenDayPlan`, `evaluateMasteryTransition`）、`StudentProfileModal:4`、`CoachPage:18`、`ReportPage:4` | 逻辑耦合 | 服务端权威 + 共享包（可选） |
| C3 | **业务状态** | `App.tsx:58-69`（`useState` + `localStorage` 全量序列化） | 状态耦合 | 服务端持久化，前端缓存 |
| C4 | **题库** | `shanghaiCurriculum.ts:271` `VERIFIED_QUESTION_BANK` | 数据耦合 | 服务端题库，前端按需拉取 |

**额外发现——当前是"伪分离"的技术信号**：

```ts
// server.ts:6 —— 服务端反向依赖前端目录
import { SHANGHAI_CURRICULUM } from './src/data/shanghaiCurriculum.ts';

// server.ts:69-75 —— 服务端硬编码前端资源路径
const samplePath = path.resolve(process.cwd(), 'src/assets/images/sample_math_exam_paper_....jpg');

// server.ts:560-573 —— 服务端托管前端构建产物
const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
app.use(vite.middlewares);
```

`server.ts` 依赖 `src/` 目录，说明**前后端根本没有边界**。这正是要消除的。

---

## 一、目标架构

### 1.1 整体形态

```
┌─────────────────────────────────────────────────────────────┐
│  浏览器 / 移动端 (Web Client)                                │
│                                                             │
│  React SPA ─────────────────────────────────────────┐       │
│  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │       │
│  │ TodayPage    │  │ DiagnosisPage│  │ CoachPage │ │       │
│  └──────────────┘  └──────────────┘  └───────────┘ │       │
│         │                   │              │         │       │
│         └───────────────────┴──────────────┘         │       │
│                    │                                  │       │
│         ┌──────────▼──────────┐                       │       │
│         │  API Client 层      │  ← 统一封装 fetch      │       │
│         │  + TanStack Query   │  ← 服务端状态缓存      │       │
│         └──────────┬──────────┘                       │       │
└────────────────────┼─────────────────────────────────┘       │
                     │ HTTPS + Bearer Token                   │
┌────────────────────▼─────────────────────────────────┐       │
│  后端服务 (Node.js + TypeScript)                          │       │
│                                                             │
│  ┌───────────────────────────────────────────────────┐   │
│  │ API 层: /api/v1/*                                 │   │
│  │  中间件链: requestId → auth → rateLimit →         │   │
│  │           validate → handler → errorHandler       │   │
│  └───────────────────┬───────────────────────────────┘   │
│                      │                                    │
│  ┌───────────────────▼───────────────────────────────┐   │
│  │ 应用服务层 (Application Services / Use Cases)      │   │
│  │  DiagnoseExam · GeneratePlan · RecordAttempt ·    │   │
│  │  UpdateMastery · CoachChat · GeneratePractice     │   │
│  └───────────────────┬───────────────────────────────┘   │
│                      │                                    │
│  ┌───────────────────▼───────────────────────────────┐   │
│  │ 领域层: 实体 · 值对象 · 状态机 · 纯函数引擎        │   │
│  │  MasteryEngine · ScoreEngine · PlanningEngine     │   │
│  └────────┬──────────────────────────┬─────────────────┘   │
│           │                          │                    │
│  ┌────────▼─────────┐   ┌────────────▼───────────────┐   │
│  │ 基础设施层        │   │  领域能力引擎                │   │
│  │  Repository(文件) │   │  AI Provider (Gemini)       │   │
│  │  Job Engine       │   │  + 超时/重试/校验/配额       │   │
│  │  KnowledgeRepo    │   │  + 提示词版本化              │   │
│  └────────┬─────────┘   └────────────────────────────┘   │
│           │                                                │
│  ┌────────▼──────────────────────────────────────────┐    │
│  │ 数据层: data/  (JSON 文件 + 事件日志 + 附件)        │    │
│  │  students/ exams/ papers/ mastery/ plans/         │    │
│  │  questions/ coaching/ events/ jobs/ files/         │    │
│  └───────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 分离后的核心原则

| 原则 | 说明 |
|---|---|
| **服务端是唯一真相源** | 所有业务状态存服务端；前端是"服务端状态的缓存 + 视图" |
| **前端不存业务实体** | localStorage 只保留：token、UI 偏好、**只读缓存快照** |
| **契约先行** | OpenAPI 风格契约是前后端唯一接口，用代码生成/手写双方类型 |
| **知识体系是服务端资产** | 前端不硬编码任何知识点，前端通过 `/knowledge-points` 获取 |
| **引擎只在服务端跑** | 与上文的"共享包"方案不同：分离要求业务逻辑不依赖客户端信任 |
| **兼容期双轨** | 分离过程可回退，不做 Big Bang 切换 |

> **关于"共享包 vs 纯服务端"的取舍**
>
> 上文优化文档建议抽 `packages/shared/` 让前后端共用引擎。但在**严格分离**架构下，我建议**调整为纯服务端权威**：
>
> | 方案 | 优点 | 缺点 |
> |---|---|---|
> | A. 共享引擎包（前端也跑引擎） | 零延迟乐观渲染；离线可用 | 前端仍是半个后端；两套运行时可能版本漂移；**学生能改 JS 伪造掌握度** |
> | B. 纯服务端权威（推荐） | 单一实现；防篡改；契约清晰 | 每次操作有网络延迟，需要 loading 态 |
>
> **推荐 B**，理由：这是**面向未成年学生的教育产品**，掌握度、提分优先级、计划时长都是**不能被学生篡改**的数据。放在前端就等于把评分逻辑交给学生自己改。
>
> 折中：保留 `packages/shared/contracts`（**只有类型和纯校验函数，无业务逻辑**）用于前后端契约对齐，但**不放引擎实现**。前端需要"预估"时，走服务端 API 拿估算值。

---

## 二、目录结构

### 2.1 目标 monorepo 结构

```
daydayup/
├── packages/
│   ├── contracts/               # 【共享】仅类型 + 纯校验，无业务逻辑
│   │   ├── src/
│   │   │   ├── domain/          # 枚举、值对象类型
│   │   │   │   ├── enums.ts     # ErrorType / MasteryState / ConfidenceLevel ...
│   │   │   │   └── curriculum.ts
│   │   │   ├── api/             # 请求/响应 DTO
│   │   │   │   ├── student.ts
│   │   │   │   ├── exam.ts
│   │   │   │   ├── diagnosis.ts
│   │   │   │   ├── mastery.ts
│   │   │   │   ├── plan.ts
│   │   │   │   ├── practice.ts
│   │   │   │   ├── coaching.ts
│   │   │   │   └── job.ts
│   │   │   ├── errors.ts        # 错误码 + ApiError 结构
│   │   │   └── validate.ts      # 轻量运行时校验器（无依赖）
│   │   └── package.json
│   │
│   └── server/                  # 【后端】完整后端
│       ├── src/
│       │   ├── main.ts
│       │   ├── app.ts
│       │   ├── bootstrap/
│       │   │   ├── container.ts
│       │   │   ├── config.ts
│       │   │   └── shutdown.ts
│       │   │
│       │   ├── api/
│       │   │   ├── middleware/
│       │   │   │   ├── request-id.ts
│       │   │   │   ├── auth.ts
│       │   │   │   ├── rate-limit.ts
│       │   │   │   ├── validate.ts
│       │   │   │   └── error-handler.ts
│       │   │   ├── routes/
│       │   │   │   ├── index.ts
│       │   │   │   ├── student.routes.ts
│       │   │   │   ├── exam.routes.ts
│       │   │   │   ├── diagnosis.routes.ts
│       │   │   │   ├── mastery.routes.ts
│       │   │   │   ├── plan.routes.ts
│       │   │   │   ├── practice.routes.ts
│       │   │   │   ├── coaching.routes.ts
│       │   │   │   ├── knowledge.routes.ts
│       │   │   │   └── job.routes.ts
│       │   │   └── openapi.ts   # 契约文档生成
│       │   │
│       │   ├── modules/         # 业务模块（按复杂度分档）
│       │   │   ├── diagnosis/
│       │   │   │   ├── domain/
│       │   │   │   ├── application/
│       │   │   │   ├── infrastructure/
│       │   │   │   └── presentation/
│       │   │   ├── mastery/
│       │   │   ├── planning/
│       │   │   ├── practice/
│       │   │   └── ...
│       │   │
│       │   ├── engines/         # 纯函数领域引擎（仅服务端）
│       │   │   ├── score-engine.ts
│       │   │   ├── planning-engine.ts
│       │   │   ├── mastery-engine.ts
│       │   │   └── diagnosis-engine.ts
│       │   │
│       │   ├── infrastructure/
│       │   │   ├── persistence/
│       │   │   │   ├── file-database.ts
│       │   │   │   ├── file-lock.ts
│       │   │   │   └── repositories/
│       │   │   ├── ai/
│       │   │   │   ├── provider.ts
│       │   │   │   ├── gemini-provider.ts
│       │   │   │   ├── prompts/
│       │   │   │   └── quota.ts
│       │   │   ├── jobs/
│       │   │   ├── knowledge/     # 知识体系加载器
│       │   │   └── logging/
│       │   │
│       │   └── domain/           # 跨模块共享实体
│       │       ├── student.ts
│       │       ├── exam.ts
│       │       ├── paper.ts
│       │       ├── error-record.ts
│       │       ├── mastery.ts
│       │       ├── plan.ts
│       │       └── attempt.ts
│       │
│       ├── data/                # 运行时数据（gitignore）
│       │   ├── db/
│       │   ├── files/
│       │   └── logs/
│       │
│       └── package.json
│
├── web/                         # 【前端】React SPA
│   ├── src/
│   │   ├── main.tsx
│   │   ├── App.tsx
│   │   ├── api/                 # 【新增】API 客户端层
│   │   │   ├── client.ts        # fetch 封装 + 错误标准化 + token 注入
│   │   │   ├── hooks.ts         # TanStack Query hooks
│   │   │   └── endpoints.ts
│   │   ├── store/               # 【新增】轻量客户端状态
│   │   │   ├── auth.ts
│   │   │   └── ui-preferences.ts
│   │   ├── components/          # 现有页面组件（基本不改）
│   │   ├── features/            # 按业务域重组
│   │   └── types.ts             # 从 contracts 重导出
│   │
│   ├── index.html
│   ├── vite.config.ts
│   └── package.json
│
├── docs/
└── package.json                 # workspace root
```

### 2.2 前后端目录边界规则

| 规则 | 说明 |
|---|---|
| **后端禁止 import `web/`** | 消除 `server.ts:6` 的反向依赖 |
| **前端禁止 import `server/`** | 只能通过 `@daydayup/contracts` 拿类型 |
| **知识体系只在 `packages/server/src/infrastructure/knowledge/`** | 前端通过 API 获取 |
| **业务实体定义只在 `packages/contracts/src/domain/`** | 单一事实源 |

---

## 三、API 契约设计

### 3.1 基础约定

```
Base URL: /api/v1
认证:     Authorization: Bearer <token>
编码:     UTF-8
时间:     ISO 8601 UTC 字符串
分页:     ?limit=20&cursor=<opaque>
```

**成功响应**：保持**裸对象**（与现有前端兼容，降低改造量）

```ts
// GET /api/v1/students/stu_001
{
  "id": "stu_001",
  "name": "张小明",
  "grade": "初三",
  "region": "上海",
  "targetExamDate": "2027-06-20",
  "targetSchool": "上海市实验中学",
  "dailyBudgetMinutes": 60,
  "homeworkLoad": "适中",
  "fatigueLevel": "中"
}
```

**错误响应**：统一结构（现有前端 5 个接口都是 `{ error: string }`，需要升级）

```ts
// 400 / 401 / 403 / 404 / 409 / 422 / 429 / 500 / 503
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "每日学习时长必须为正整数",
    "details": { "field": "dailyBudgetMinutes", "received": -5 }
  },
  "requestId": "req_01HQ8..."
}
```

**错误码表**（放 `packages/contracts/src/errors.ts`）：

| code | HTTP | 含义 |
|---|---|---|
| `VALIDATION_FAILED` | 400 | 参数校验失败 |
| `UNAUTHORIZED` | 401 | 未登录/token 无效 |
| `FORBIDDEN` | 403 | 无权访问该学生数据 |
| `NOT_FOUND` | 404 | 资源不存在 |
| `CONFLICT` | 409 | 版本冲突（乐观锁） |
| `QUOTA_EXCEEDED` | 429 | 超出配额（AI 用量/频率） |
| `AI_TIMEOUT` | 503 | 模型超时（已重试） |
| `AI_INVALID_OUTPUT` | 502 | 模型返回非法结构（已重试） |
| `INTERNAL_ERROR` | 500 | 未预期错误 |

> **为什么错误结构统一如此重要**：现在前端 `CoachPage.tsx:328` 只能 `throw new Error(data.error || 'AI教练响应失败')`，无法区分"模型超时该重试"和"参数错了该改 UI"。统一错误码后，前端可以差异化处理。

### 3.2 资源划分与端点清单

#### 知识体系（只读，服务端资产）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/knowledge-points?subject=数学&version=` | 知识点列表（含 prerequisites、examWeight 等） |
| GET | `/knowledge-points/tree` | 知识树（供思维导图用） |
| GET | `/knowledge-points/curriculum-version` | 当前生效版本号 |

> 前端 `DiagnosisPage.tsx:229/245/584/641`、`CoachPage.tsx:524`、`ReportPage.tsx:115/174/181` 共 9 处使用 `SHANGHAI_CURRICULUM`，全部改为从 `/knowledge-points` 拉取 + 本地缓存。

#### 学生与档案

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/students` | 创建学生 |
| GET | `/students/:id` | 查询学生 |
| PUT | `/students/:id/profile` | 更新档案（含 budget、homeworkLoad、fatigueLevel） |
| GET | `/students/:id/effective-budget` | **新增**：服务端算每日预算 |

> `StudentProfileModal.tsx:4` 现在直接调 `getEffectiveDailyBudget()`。分离后预算因子（作业负担/疲劳度 → 分钟数）属于业务规则，**必须在服务端算**，否则学生改前端就能突破时间预算约束。

#### 考试与试卷

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/exams` | 创建考试 |
| GET | `/exams/:id` | 查询考试 |
| POST | `/exams/:id/results` | 录入成绩 |
| GET | `/students/:id/exams` | 学生考试列表 |
| POST | `/exams/:id/papers` | 上传试卷（multipart 或 base64） |
| GET | `/papers/:id` | 试卷详情 |
| POST | `/papers/:id/confirm-metadata` | **新增**：人工确认 AI 提取的元信息 |

#### 诊断（核心）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/exams/:id/diagnosis` | 发起诊断 → 返回 `jobId` 或同步结果 |
| GET | `/diagnosis/:id` | 查询诊断结果 |
| GET | `/students/:id/error-records` | 错题列表（分页） |
| PATCH | `/error-records/:id` | **新增**：人工订正/确认/闭环 |
| GET | `/students/:id/error-records/:id/confirmations` | 校验记录 |
| POST | `/diagnosis/micro-quiz` | 生成诊断微测 |

#### 掌握度

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/students/:id/mastery` | 掌握度列表 |
| GET | `/students/:id/mastery/history` | 状态迁移历史 |
| GET | `/students/:id/mastery/:knowledgeId/retest-status` | **新增**：延迟复测解锁状态 |
| GET | `/students/:id/knowledge-summary` | **新增**：报告页汇总 |

#### 提分与计划

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/students/:id/opportunities` | 提分机会（含优先级与理由） |
| GET | `/students/:id/plans/current` | 当前计划 |
| POST | `/students/:id/plans` | **重新生成**计划 |
| PATCH | `/plans/:id/tasks/:taskId` | 更新任务状态（完成/延后） |
| PATCH | `/plans/:id/tasks/:taskId/progress` | 更新步骤进度 |

#### 练习与评测

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/practice/questions` | 取题（题库优先，AI 兜底） |
| POST | `/practice/attempts` | 提交作答 → 服务端判定 + 更新掌握度 |
| GET | `/questions/:id` | 题目详情 |
| POST | `/questions/:id/verify` | **新增**：人工复核 AI 生成题 |

#### 教练对话

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/coaching/sessions` | 创建/获取会话 |
| POST | `/coaching/sessions/:id/messages` | 发送消息 |
| GET | `/coaching/sessions/:id/messages` | 拉取历史 |
| GET | `/students/:id/coaching/sessions` | 按知识点列会话 |

#### 任务中心

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/jobs/:id` | 查询任务状态 |
| GET | `/jobs/:id/events` | **SSE**：进度推送 |
| POST | `/jobs/:id/cancel` | 取消任务 |

### 3.3 关键契约详解

#### 诊断（当前 `/api/diagnose-paper` 的服务端化）

```ts
// POST /api/v1/exams/:examId/diagnosis
interface DiagnoseExamRequest {
  paperId: string;              // 已上传试卷
  subject?: Subject | '自动识别';
  inputFormat: 'image' | 'parsed_text' | 'mixed' | 'wrong_item';
  rawText?: string;
}

interface DiagnoseExamResponse {
  diagnosisId: string;
  status: 'completed';
  detectedMetadata: DetectedMetadata;   // AI 提取
  confirmedMetadata?: ConfirmedMetadata; // 人工确认后
  paperSummary: string;
  questionsDetectedCount: number;
  totalLostScore: number;
  diagnosedItems: DiagnosedItem[];
  // 可追溯性
  meta: {
    promptVersion: string;
    model: string;
    curriculumVersion: string;
    requestId: string;
    computedAt: string;
  };
}
```

**相比现在的变化**：
1. 请求体从"直接传 base64 图片"改为"传 paperId"——图片已在上传时落盘，诊断请求可重试、可缓存
2. 响应增加 `meta` 可追溯块
3. `diagnosedItems` 落库为 `error_records`，有独立生命周期（订正状态）

#### 提交作答（新增，服务端权威判定）

```ts
// POST /api/v1/practice/attempts
interface SubmitAttemptRequest {
  studentId: string;
  taskId?: string;
  questionId: string;
  knowledgeId: string;
  mode: PracticeMode;        // 诊断微测|基础练习|变式训练|迁移应用|延迟复测
  studentAnswer: string;
  hintsUsed: number;
  timeSpentSeconds: number;
  independent: boolean;
}

interface SubmitAttemptResponse {
  attemptId: string;
  isCorrect: boolean;
  errorType?: ErrorType;
  feedback: string;
  stepHint?: string;
  nextRecommendation?: string;
  // 服务端权威的掌握度变更
  mastery: {
    knowledgeId: string;
    previousState: MasteryState;
    newState: MasteryState;
    transitionEventId: string;
  };
  // 服务端权威的重算结果
  updatedOpportunity?: PriorityOpportunity;
}
```

**关键**：`evaluateMasteryTransition` 现在在 `planner.ts:364` 由前端调用。分离后必须移到服务端 `MasteryEngine`，前端只展示返回的 `previousState → newState`。

#### 计划生成（服务端权威）

```ts
// GET /api/v1/students/:id/plans/current
interface LearningPlanResponse {
  id: string;
  weekLabel: string;
  effectiveDailyBudget: number;
  generatedAt: string;
  engineVersion: string;        // 算法版本
  priorities: PriorityOpportunity[];
  days: DailySchedule[];
  taskStates: Record<string, TaskState>;
  meta: {
    computedAt: string;
    requestId: string;
  };
}
```

> **前端不再本地计算计划**。`App.tsx:71` 的 `useMemo(() => buildSevenDayPlan(appState), [appState])` 改为 `useQuery(['plan', studentId], fetchCurrentPlan)`。
>
> 好处不只是"权威"：现在每次 `appState` 变化（包括聊天记录）都会**全量重算 7 天计划**，分离后改为按需拉取 + 缓存，**性能也更好**。

---

## 四、认证与授权

### 4.1 现状与风险

`server.ts` 的 5 个接口**全部无鉴权**。分离后如果原样部署到公网：
- 任何人都能用你的 `GEMINI_API_KEY` 刷额度
- 提交任意图片让模型解析
- 读取/篡改任意学生的错题、掌握度数据

### 4.2 方案：自研轻量 Token（不引入第三方 auth 框架）

```ts
// packages/server/src/api/middleware/auth.ts
interface AuthContext {
  principalId: string;    // 用户 ID
  studentIds: string[];   // 可访问的学生 ID 列表
  role: 'student' | 'parent' | 'teacher';
  quota: { dailyTokens: number; usedTokens: number };
}

// Token: HMAC 签名，无状态
// payload: { sub, sids, role, exp, iat }
// signature: HMAC-SHA256(payload, AUTH_SECRET)
```

**接口分级**：

| 级别 | 端点 | 要求 |
|---|---|---|
| 公开 | `/api/v1/health`, `/api/v1/auth/*` | 无 |
| 需登录 | `/api/v1/students/:id/*`, `/api/v1/plans/*` ... | token 有效 + `studentIds` 含 `:id` |
| 需配额 | 所有 AI 相关端点 | 剩余 token > 0 |

**家长看孩子报告**：`studentIds: ['stu_001', 'stu_002']`，服务端按 `studentIds` 做资源级鉴权，不靠前端隐藏。

### 4.3 数据隔离

每个查询都必须带 `studentId` 过滤。Repository 层强制：

```ts
interface Repository<T> {
  getById(id: string, ctx: AuthContext): Promise<T | null>;  // ctx 用于过滤
  // ...
}
```

> 更严格的做法是 Repository 只接受已注入 `studentId` 的实例，避免漏过滤：
> ```ts
> const repo = container.get(ErrorRecordRepository).forStudent(studentId);
> ```

---

## 五、数据持久化（分离后）

### 5.1 服务端数据目录

```
packages/server/data/
├── db/
│   ├── students/{studentId}.json
│   ├── exams/{examId}.json
│   ├── papers/{paperId}.json
│   ├── error-records/{studentId}/{recordId}.json
│   ├── mastery/{studentId}.json
│   ├── plans/{studentId}/{planId}.json
│   ├── attempts/{studentId}/{yyyy-MM}.jsonl
│   ├── coaching/{studentId}/{knowledgeId}.json
│   ├── jobs/{jobId}.json
│   └── knowledge/
│       └── shanghai-junior-2026.1.json   # 知识体系资产
├── files/
│   ├── papers/{paperId}/{n}.jpg          # 试卷图片
│   └── attachments/
├── events/
│   └── {yyyy-MM-dd}.jsonl
└── logs/
    └── {yyyy-MM-dd}.log
```

### 5.2 前端本地存储的处置

分离后 `localStorage` 只保留三类数据：

| Key | 内容 | 理由 |
|---|---|---|
| `auth_token` | 访问令牌 | 必须本地持有 |
| `ui_prefs` | 主题、字号、当前选中页 | 纯 UI 偏好 |
| `snapshot:{resource}` | 只读缓存快照（如 curriculum） | 减少请求，支持离线浏览知识体系 |

**删除** `shanghai_ai_score_os_v5`（`App.tsx:29`）这个整体状态 key。

### 5.3 知识体系迁移

`src/data/shanghaiCurriculum.ts`（589 行）拆分为：

```
src/data/shanghaiCurriculum.ts
├── SHANGHAI_CURRICULUM  → data/knowledge/shanghai-junior-2026.1.json
├── KNOWLEDGE_MAP        → 运行时由服务端构建，不落前端
└── VERIFIED_QUESTION_BANK → data/questions/bank-{subject}.json（服务端题库）
```

**知识体系版本化**（承接优化文档 §5.3）：

```ts
interface CurriculumVersion {
  version: 'shanghai-junior-2026.1';
  publishedAt: string;
  status: 'ACTIVE';
  subjects: Subject[];
  knowledgePoints: KnowledgePoint[];
  questionBankVersion: string;
}
```

诊断结果记录 `curriculumVersion`，前端拉取时可指定版本，保证历史诊断可复现。

---

## 六、前端改造清单

### 6.1 新增：API 客户端层

```ts
// web/src/api/client.ts
export class ApiClient {
  constructor(private baseUrl: string, private tokenStore: TokenStore) {}

  async request<T>(
    path: string,
    init: RequestInit & { parse: (raw: unknown) => T | null },
    options?: { retries?: number; timeoutMs?: number }
  ): Promise<T> {
    // 1. 注入 Authorization
    // 2. 超时控制（AbortController）
    // 3. 网络错误重试（指数退避，仅幂等请求）
    // 4. 错误标准化：解析 ApiError → 抛 ApiRequestError(code, message)
    // 5. 响应解析：走 contracts 的 parse 函数，失败 → 抛 CONTRACT_MISMATCH
  }
}
```

**关键**：`ApiRequestError` 带 `code`，前端可以：
```ts
if (err.code === 'AI_TIMEOUT') showRetryBanner();
if (err.code === 'QUOTA_EXCEEDED') showQuotaBanner();
if (err.code === 'CONTRACT_MISMATCH') showGenericError();
```

### 6.2 新增：状态管理

引入 TanStack Query（业界标准、缓存/重试/失效内置），替换当前的 `useState` + 全量 localStorage：

```ts
// web/src/api/hooks.ts
export const useStudent = (id: string) =>
  useQuery({ queryKey: ['student', id], queryFn: () => api.student.get(id) });

export const useMastery = (id: string) =>
  useQuery({ queryKey: ['mastery', id], queryFn: () => api.mastery.list(id) });

export const usePlan = (id: string) =>
  useQuery({ queryKey: ['plan', id], queryFn: () => api.plan.current(id) });

export const useCurriculum = (subject?: Subject) =>
  useQuery({
    queryKey: ['curriculum', subject],
    queryFn: () => api.knowledge.list(subject),
    staleTime: 24 * 3600 * 1000,   // 知识体系几乎不变
  });
```

**提交作答的乐观更新**（保留即时反馈，但权威结果由服务端返回）：

```ts
const submitAttempt = useMutation({
  mutationFn: api.practice.submitAttempt,
  onSuccess: (data) => {
    // 服务端返回权威的掌握度变更和提分机会，直接更新缓存
    queryClient.setQueryData(['mastery', studentId], (old) => applyMasteryChange(old, data.mastery));
    queryClient.setQueryData(['plan', studentId], invalidatePlan);  // 计划可能变
  },
});
```

### 6.3 现有组件改造映射

| 组件 | 现状 | 改造后 |
|---|---|---|
| `App.tsx:58-71` | `useState<AppState>` + `useMemo(buildSevenDayPlan)` | 拆成多个 `useQuery`；计划走 API |
| `App.tsx:73-79` | `handleUpdateStudent` 改本地 | `useMutation` → `PUT /students/:id/profile` |
| `App.tsx:96-106` | `handleToggleCompleteTask` 本地数组 | `PATCH /plans/:id/tasks/:taskId` |
| `App.tsx:108-122` | `handleDeferTask` 本地数组 | `PATCH /plans/:id/tasks/:taskId { deferred: true }` |
| `App.tsx:124-132` | `handleUpdateCoachHistory` 本地 | 会话存服务端，前端只缓存 |
| `App.tsx:134-160` | `handleUpdateTaskProgress` 本地 | `PATCH /plans/:id/tasks/:taskId/progress` |
| `App.tsx:155+` | `evaluateMasteryTransition` 前端调用 | 删掉，改由 `POST /practice/attempts` 返回 |
| `StudentProfileModal:4` | `getEffectiveDailyBudget` | `GET /students/:id/effective-budget` |
| `DiagnosisPage:371` | `fetch('/api/diagnose-paper')` | `POST /exams/:id/diagnosis`（新 URL） |
| `DiagnosisPage:588` | `fetch('/api/diagnose-microquiz')` | `POST /diagnosis/micro-quiz` |
| `CoachPage:310` | `fetch('/api/coach/chat')` | `POST /coaching/sessions/:id/messages` |
| `CoachPage:381` | `fetch('/api/practice/generate')` | `POST /practice/questions` |
| `CoachPage:446` | `fetch('/api/practice/evaluate')` | `POST /practice/attempts` |
| `CoachPage:370` | `findBankQuestion` 前端查题库 | 移到服务端取题逻辑 |
| `DiagnosisPage:229+` | `SHANGHAI_CURRICULUM` 直读 | `useCurriculum()` |
| `CoachPage:524` | `SHANGHAI_CURRICULUM.map` | `useCurriculum()` |
| `ReportPage:115/174` | `SHANGHAI_CURRICULUM` 直读 | `useCurriculum()` |
| `ReportPage:4` | `MASTERY_ORDER` | 从 contracts 导入（常量，非逻辑） |
| `CoachPage:18` | `getDelayedRetestStatus` | `GET /mastery/:kid/retest-status` |
| 全部组件 | `localStorage` 兜底 | 删除，仅保留 `auth_token` / `ui_prefs` |

> **`MASTERY_ORDER` 属于常量不是业务逻辑**——它是状态枚举的显示顺序，可以安全放在 `packages/contracts`。但 `getDelayedRetestStatus` 涉及时间解锁判定，**属于服务端逻辑**（且依赖服务端时钟，避免客户端改时间作弊）。

### 6.4 组件层保留什么

**保留在前端**：纯展示逻辑、交互状态、表单校验（仅 UX 层面）、路由、图表渲染。
**移到服务端**：所有业务判定、时间预算、状态迁移、评分、排序。

---

## 七、迁移路径（可回退，不 Big Bang）

分离最大的风险是**一次性重写导致功能丢失**。采用四阶段渐进迁移，每阶段可独立验证。

### 阶段 1：解耦与契约对齐（不改变行为）

```
目标：
  1. 建 packages/contracts，把 src/types.ts 搬过去，前端改为 import
  2. 建 packages/server，把 server.ts 搬进去，去掉对 src/ 的反向依赖
  3. 知识体系 JSON 化，但仍由前端 import（暂不 API 化）

变更：
  - server.ts:6 的 `import { SHANGHAI_CURRICULUM } from './src/data/...'` 
    → 改为 `import curriculum from '../data/knowledge/shanghai-junior-2026.1.json'`
  - vite 移除 middleware 模式挂载，前后端独立 dev server
  - 前端 API 调用改为走 vite proxy（开发）/ VITE_API_BASE（生产）

验证：
  - 5 个接口功能完全不变
  - 前端页面渲染不变
  - npm run dev:server 与 npm run dev:web 可独立启动
```

**这一阶段是纯搬移，零逻辑变更，是最重要的一步** —— 它建立了物理边界，后续都在边界内演进。

### 阶段 2：知识体系 API 化

```
目标：
  GET /api/v1/knowledge-points 服务化
  前端 useCurriculum() 取代 9 处直读 SHANGHAI_CURRICULUM

变更：
  - 前端删除 KNOWLEDGE_MAP（服务端构建）
  - KnowledgePoint 类型进 contracts
  - 加 curriculumVersion 到诊断响应

验证：
  - 所有页面知识点数据渲染一致
  - 知识体系版本号出现在诊断 meta 中
```

### 阶段 3：业务状态服务端化（核心）

```
目标：
  1. Repository + 文件存储落地
  2. 掌握度、计划、错题、作答、教练会话全部服务端持久化
  3. 前端 localStorage 只留 token

变更顺序（按依赖）：
  a. 教练会话 → POST /coaching/sessions/:id/messages（最独立，风险最低）
  b. 错题记录 → PATCH /error-records/:id
  c. 作答与掌握度 → POST /practice/attempts 返回权威状态变更
  d. 计划 → GET /plans/current + PATCH tasks（最后做，因为它依赖 a/b/c）
  e. 学生档案 → PUT /students/:id/profile

验证：
  - 换浏览器登录，数据完整
  - 掌握度状态迁移全部由服务端产生
  - 前端无业务引擎代码残留
```

### 阶段 4：鉴权、配额与部署分离

```
目标：
  1. Token 认证 + 学生级数据隔离
  2. AI 配额
  3. 前后端独立部署

变更：
  - auth 中间件
  - 前端登录页
  - 后端 Dockerfile / 独立静态部署
  - CORS 配置

验证：
  - 无 token 访问受保护端点 → 401
  - 越权访问他人学生 → 403
  - 超配额 → 429
```

### 迁移期兼容策略

阶段 1-3 期间，前后端可能不同步部署。用**版本化 API 路径**兜底：

```
/api/v1/...    分离后 API
（保留）        /api/diagnose-paper 等旧路径，代理到新实现
```

旧路径保留一个发布周期，前端全量切换后删除。这样任何时刻前后端版本组合都能工作。

---

## 八、分离后的关键设计决策（可能引发争议的部分）

### 8.1 前端是否还需要 TanStack Query 等库？

**需要。** 分离后前端承担了"服务端状态缓存 + 同步 + 重试 + 失效"的职责。没有这类库要手写一套，等于把后端的复杂度搬到前端。TanStack Query 是纯前端运行时依赖，不违反"零外部基础设施"。

### 8.2 是否需要在服务端保留 `packages/contracts`？

**需要。** 前后端编译期共享类型是分离架构的安全网。代价是契约变更需要两边同步发布——这正是我们想要的（显式契约 > 隐式约定）。

### 8.3 为什么不直接上数据库？

分离后**更应该**尽早数据库化——多学生并发写入、复杂查询、跨实体事务都是分离架构的必然需求。但原文档的"零外部基础设施"约束仍在，且当前是单实例试点。

**建议**：保持 Repository 抽象，**存储实现可换**。文件存储作为 `FileRepository` 实现保留，同时预留 `SqliteRepository`（Node 22+ 内置 `node:sqlite`，无外部依赖！）。这比引入 PostgreSQL 更符合项目约束，又解决了并发问题。

> `node:sqlite` 在 Node 22.5+ 实验性、Node 24 稳定。这是一个**既保持零外部基础设施、又解决并发写**的路径，值得在阶段 3 评估。

### 8.4 知识体系要不要完全服务端化？

**要。** 理由：
1. 前端打包体积（589 行 + 题库）
2. 知识体系会随考纲更新，服务端更新无需重新发布前端
3. 前端硬编码 = 前端可篡改诊断映射
4. 版本化追溯的前提

**妥协**：前端缓存 + `staleTime: 24h`，减少请求；离线时用缓存兜底。

### 8.5 SSE 还是轮询？

诊断可能 >2min。用 **SSE**（`node:http` 原生支持，零依赖）优于轮询：
- 单向推送场景 SSE 是最优解
- 自动重连
- 比 WebSocket 简单，无需额外库

保留轮询作为降级路径（代理不支持 SSE 时）。

---

## 九、分离后的风险与对策

| 风险 | 影响 | 对策 |
|---|---|---|
| **网络延迟** | 每次操作有等待 | 乐观更新 + 骨架屏；不乐观的场景显示明确 loading |
| **离线不可用** | 断网无法学习 | 缓存最近计划 + 知识体系只读浏览；作答队列离线暂存 |
| **契约漂移** | 前后端版本不匹配 | `packages/contracts` 单一事实源 + CI 校验 |
| **迁移期双写** | 数据不一致 | **避免双写**——阶段 3 一次性切到服务端，前端停止写 localStorage |
| **鉴权加晚了** | 数据泄露 | 阶段 4 才加鉴权有窗口期 → **建议把鉴权提前到阶段 1**（至少保护 AI 端点） |
| **前端篡改** | 学生改掌握度 | 服务端权威（§1.2 方案 B）+ 服务端时钟 |
| **成本失控** | token 花费 | 配额 + 缓存（承接优化文档） |

> **强烈建议**：把"鉴权 + AI 配额"从阶段 4 **提前到阶段 1**。理由：分离过程中后端会暴露在网络上，而 `GEMINI_API_KEY` 是直接成本。阶段 1 至少要给 AI 端点加一个简单 token 校验。

---

## 十、与前两份文档的关系

| 文档 | 定位 | 回答的问题 |
|---|---|---|
| `backend-design.md` | 原始理想设计 | 系统**应该**长什么样 |
| `backend-design-optimized.md` | 结合现状的优化 | 为什么**要这样调整** |
| **本文** | 前后端分离形态 | **怎么落地** |

三份文档的核心主张是一致的：

1. **分层与解耦是真价值** —— Repository 抽象、Provider 抽象、纯函数引擎
2. **"零第三方运行时依赖"不是价值** —— 用库实现解耦更便宜
3. **确定性算法优先于大模型** —— 成绩、预算、状态迁移、优先级都该是确定性代码
4. **所有结论必须有证据，所有 AI 输出必须可追溯**
5. **服务端是唯一真相源**（本文新增的落地约束）

---

## 附录 A：分离后的请求示例

```bash
# 1. 登录
curl -X POST http://localhost:3000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"studentCode":"S001","pin":"1234"}'
# → { "token":"eyJ...", "studentIds":["stu_001"], "role":"student" }

# 2. 拉取学生档案
curl http://localhost:3000/api/v1/students/stu_001 \
  -H 'Authorization: Bearer eyJ...'

# 3. 上传试卷
curl -X POST http://localhost:3000/api/v1/exams/exam_001/papers \
  -H 'Authorization: Bearer eyJ...' \
  -F 'file=@paper.jpg' \
  -F 'subject=数学'
# → { "paperId":"paper_001", "status":"uploaded" }

# 4. 发起诊断（异步）
curl -X POST http://localhost:3000/api/v1/exams/exam_001/diagnosis \
  -H 'Authorization: Bearer eyJ...' \
  -H 'Content-Type: application/json' \
  -d '{"paperId":"paper_001","inputFormat":"image"}'
# → { "jobId":"job_001", "status":"pending", "streamUrl":"/api/v1/jobs/job_001/events" }

# 5. 订阅进度（SSE）
curl -N http://localhost:3000/api/v1/jobs/job_001/events \
  -H 'Authorization: Bearer eyJ...'
# event: progress
# data: {"stage":"识别试卷结构","pct":40}
# event: done
# data: {"diagnosisId":"diag_001", ...}

# 6. 提交作答 → 权威掌握度变更
curl -X POST http://localhost:3000/api/v1/practice/attempts \
  -H 'Authorization: Bearer eyJ...' \
  -H 'Content-Type: application/json' \
  -d '{"questionId":"q_001","knowledgeId":"math-alg-rational","mode":"变式训练","studentAnswer":"x=2","hintsUsed":1,"timeSpentSeconds":180,"independent":true}'
# → {"isCorrect":false,"errorType":"审题问题",
#    "mastery":{"previousState":"学习中","newState":"学习中",...}}

# 7. 拉取当前计划
curl http://localhost:3000/api/v1/students/stu_001/plans/current \
  -H 'Authorization: Bearer eyJ...'
```

## 附录 B：阶段 1 的文件迁移映射

| 现在 | 迁移到 |
|---|---|
| `src/types.ts` | `packages/contracts/src/domain/` |
| `src/data/shanghaiCurriculum.ts`（本体部分） | `packages/server/data/knowledge/shanghai-junior-2026.1.json` |
| `src/data/shanghaiCurriculum.ts`（题库部分） | `packages/server/data/questions/bank.json` |
| `src/engine/planner.ts` | `packages/server/src/engines/`（**服务端独占**） |
| `src/data/initialStore.ts` | `packages/server/src/bootstrap/seed.ts`（种子数据） |
| `server.ts` | `packages/server/src/`（拆分 app/bootstrap/api/modules） |
| `src/components/*` | `web/src/features/*`（可选重组） |
| `src/api/` | `web/src/api/`（新增） |
| `index.html`, `vite.config.ts` | `web/` |
