# AI中考提分系统：Node.js + TypeScript 后端设计方案

我建议重新调整技术方案：不引入外部基础设施、不引入第三方后端框架、不依赖外部业务服务，使用 Node.js + TypeScript + Node.js 原生能力实现完整后端。

这不仅是技术栈的简化，也是为了让 MVP 可以低成本启动、独立部署、方便 CodeAgent 理解和持续演进。

这里先明确一个边界：

- 不引入外部数据库、消息队列、缓存、工作流引擎、向量数据库。
- 不依赖 Express、NestJS、Prisma、TypeORM 等第三方框架或ORM。
- 尽可能只使用 Node.js 内置模块。
- AI模型接入采用可替换接口，初期使用规则引擎、Mock Provider 和本地能力实现，不把外部模型服务作为运行前提。
- 数据持久化采用本地存储适配层，避免业务逻辑与存储方式绑定。

如果连 npm 第三方开发依赖也不允许，那么需要使用支持 TypeScript 类型剥离的 Node.js 版本直接运行 `.ts` 文件；如果允许开发期依赖，则可以使用 TypeScript 编译器生成 JavaScript。

我的总体建议是：

模块化单体 + 内置任务调度 + 文件持久化适配器 + 规则驱动的AI能力接口。

# 一、总体技术架构

API 接入层

Node.js HTTP Server / REST API / SSE

应用服务层 Application Services

请求校验、用例编排、事务边界、权限校验

学生与档案

Student / Profile

考试与试卷

Exam / Paper

题目与知识

Question / Knowledge

诊断与提分

Diagnosis / Planning

学习计划

Plan / Task

AI教学

Teaching / Session

练习与评测

Practice / Assessment

报告与掌握度

Mastery / Report

领域能力引擎

知识规则 / 提分算法 / 教学策略 / 题目校验 / 评测算法

Repository

数据访问抽象

Job Engine

异步任务执行

File Storage

文件管理

AI Provider

模型能力抽象

Node.js 原生基础设施

node:http / node:fs / node:crypto / node:stream / node:worker_threads

这套架构有一个重要特点：

业务模块不直接依赖 Node.js 文件系统，也不直接依赖具体的 AI 模型。

例如，诊断服务只需要调用 `QuestionRepository`、`MasteryRepository` 和 `DiagnosisEngine`，不需要知道数据最终存在哪里。

这样后续即使引入 SQLite、PostgreSQL 或其他模型，也不需要重写业务领域。

# 二、技术选型：只使用 Node.js 原生能力

## 2.1 技术组件清单

| 能力     | 技术实现                    | 是否引入第三方    |
| ------ | ----------------------- | ---------- |
| HTTP服务 | node:http               | 否          |
| 路由     | 自研 Router               | 否          |
| 参数校验   | 自研 Schema Validator     | 否          |
| 类型系统   | TypeScript              | 编译期工具按约束选择 |
| 数据存储   | JSON文件 / 原生文件系统         | 否          |
| 文件上传   | node:stream + node:fs   | 否          |
| 唯一ID   | node:crypto UUID        | 否          |
| 日志     | node:console + 自研Logger | 否          |
| 定时任务   | node:timers             | 否          |
| 异步任务   | 自研 Job Queue            | 否          |
| SSE    | node:http               | 否          |
| 数据校验   | 自研规则引擎                  | 否          |
| 单元测试   | node:test               | 否          |
| 测试覆盖   | node:test 内置能力          | 否          |
| AI编排   | 自研有限状态工作流               | 否          |
| 数据迁移   | 自研 Migration Runner     | 否          |

注意：JSON文件存储适合单实例、低并发的MVP，不适合多进程共享写入。它是初期存储适配器，不是长期数据库方案。

## 2.2 Node.js版本建议

建议使用当前支持的LTS版本，并固定版本。

如果采用原生 TypeScript 类型剥离，需要确认目标 Node.js 版本支持所需语法。原生类型剥离不负责类型检查，因此仍需独立的静态检查流程。

这里有一个现实约束：

TypeScript 是开发语言，不等于 Node.js 可以自动进行完整的 TypeScript 类型检查。

建议将运行、类型检查、测试分开。

# 三、工程目录设计

建议采用领域驱动的模块化目录，而不是按照 Controller、Service、Utils 简单平铺。

推荐目录：

```
exam-score-system/
│
├── src/
│   ├── main.ts
│   ├── app.ts
│   │
│   ├── bootstrap/
│   │   ├── container.ts
│   │   ├── config.ts
│   │   ├── server.ts
│   │   └── shutdown.ts
│   │
│   ├── core/
│   │   ├── domain/
│   │   │   ├── entity.ts
│   │   │   ├── value-object.ts
│   │   │   └── domain-event.ts
│   │   ├── application/
│   │   │   ├── use-case.ts
│   │   │   └── result.ts
│   │   ├── errors/
│   │   ├── types/
│   │   ├── validation/
│   │   ├── events/
│   │   └── utils/
│   │
│   ├── modules/
│   │   ├── student/
│   │   │   ├── domain/
│   │   │   ├── application/
│   │   │   ├── infrastructure/
│   │   │   └── presentation/
│   │   │
│   │   ├── exam/
│   │   ├── question/
│   │   ├── knowledge/
│   │   ├── diagnosis/
│   │   ├── score-planning/
│   │   ├── learning-plan/
│   │   ├── teaching/
│   │   ├── practice/
│   │   ├── assessment/
│   │   ├── mastery/
│   │   └── report/
│   │
│   ├── engines/
│   │   ├── diagnosis-engine/
│   │   ├── score-engine/
│   │   ├── mastery-engine/
│   │   ├── teaching-engine/
│   │   ├── question-engine/
│   │   └── evaluation-engine/
│   │
│   ├── infrastructure/
│   │   ├── persistence/
│   │   │   ├── file-database.ts
│   │   │   ├── file-lock.ts
│   │   │   └── repositories/
│   │   ├── storage/
│   │   ├── jobs/
│   │   ├── ai/
│   │   ├── logging/
│   │   ├── scheduler/
│   │   └── security/
│   │
│   ├── api/
│   │   ├── router.ts
│   │   ├── middleware/
│   │   ├── controllers/
│   │   └── routes/
│   │
│   └── shared/
│       ├── constants/
│       └── contracts/
│
├── data/
│   ├── db/
│   │   ├── students/
│   │   ├── exams/
│   │   ├── questions/
│   │   ├── learning/
│   │   └── jobs/
│   ├── files/
│   │   ├── papers/
│   │   ├── answers/
│   │   └── attachments/
│   └── logs/
│
├── tests/
│   ├── unit/
│   ├── integration/
│   ├── contract/
│   └── e2e/
│
├── scripts/
│   ├── seed.ts
│   ├── migrate.ts
│   └── verify.ts
│
├── package.json
├── tsconfig.json
└── README.md
```

## 3.1 模块内部统一规范

每个业务模块采用四层结构：

| 层次             | 职责           | 示例                         |
| -------------- | ------------ | -------------------------- |
| Domain         | 领域对象、业务规则    | LearningTask、MasteryState  |
| Application    | 业务用例编排       | CreateLearningPlan         |
| Infrastructure | Repository实现 | FileLearningPlanRepository |
| Presentation   | API输入输出      | LearningPlanController     |

例如，诊断模块：

```
diagnosis/
├── domain/
│   ├── diagnosis.ts
│   ├── diagnosis-item.ts
│   ├── error-type.ts
│   └── diagnosis-policy.ts
│
├── application/
│   ├── diagnose-exam.ts
│   ├── confirm-diagnosis.ts
│   └── get-diagnosis.ts
│
├── infrastructure/
│   └── file-diagnosis-repository.ts
│
└── presentation/
    ├── diagnosis-controller.ts
    └── diagnosis-routes.ts
```

关键原则：

- Domain 不依赖任何 Infrastructure。
- Application 通过接口调用 Repository。
- Infrastructure 实现接口。
- Controller 不写业务逻辑。
- Engine 负责确定性算法，不直接操作HTTP和文件系统。

# 四、数据持久化设计

这是不引入外部依赖后，需要重点设计的部分。

我建议第一阶段使用文件型结构化存储，但不要简单地把所有数据塞进一个 `data.json`。

## 4.1 存储结构

```
data/db/
├── students/
│   ├── stu_001.json
│   └── stu_002.json
│
├── exams/
│   └── exam_001.json
│
├── questions/
│   ├── q_001.json
│   └── q_002.json
│
├── knowledge/
│   └── knowledge-tree.json
│
├── diagnoses/
│   └── diagnosis_001.json
│
├── plans/
│   └── plan_001.json
│
├── tasks/
│   └── task_001.json
│
├── attempts/
│   └── attempt_001.json
│
├── mastery/
│   └── stu_001.json
│
└── jobs/
    └── job_001.json
```

文件内容采用JSON结构化数据。

## 4.2 Repository接口

业务代码只依赖接口：

```
export interface Repository<T> {
  getById(id: string): Promise<T | null>;

  save(entity: T): Promise<void>;

  delete(id: string): Promise<void>;

  list(query?: QueryOptions): Promise<T[]>;
}
```

例如：

```
export interface LearningPlanRepository
  extends Repository<LearningPlan> {

  getCurrentPlan(
    studentId: string
  ): Promise<LearningPlan | null>;

  getByStudent(
    studentId: string
  ): Promise<LearningPlan[]>;
}
```

初期实现：

```
export class FileLearningPlanRepository
  implements LearningPlanRepository {
  // 使用 node:fs/promises 实现
}
```

以后可以替换成其他存储实现，而不用修改 LearningPlanService。

## 4.3 文件存储必须解决的四个问题

不能只使用 `writeFile()` 就认为持久化已经可靠。

必须实现：

1. 原子写入：先写临时文件，再通过 rename 替换正式文件，避免写入中断造成文件损坏。
2. 并发控制：同一数据文件的写操作串行化，防止并发覆盖。
3. 数据版本：记录数据版本号，支持乐观并发检查。
4. 备份恢复：定期备份数据目录，并验证备份可恢复。

特别需要注意：文件系统 rename 只能解决单文件替换的原子性，不能保证跨多个文件的事务一致性。

因此：

- 一个业务聚合的数据尽量放在一个文件中。
- 不要把一个业务事务拆成多个独立文件的无保护写入。
- 跨领域操作采用业务状态机、补偿机制和恢复任务。
- 单实例运行，暂不支持多个进程共享同一数据目录。

如果以后出现多学生并发写入、复杂查询和跨实体事务需求，应优先将持久化层升级为数据库，而不是继续给文件存储增加复杂度。

## 4.4 重要设计：业务事件日志

建议增加轻量级事件日志：

```
data/
└── events/
    ├── 2026-11-17.jsonl
    └── 2026-11-18.jsonl
```

记录：

```
{
  "event_id": "evt_001",
  "event_type": "LearningAttemptSubmitted",
  "aggregate_id": "stu_001",
  "occurred_at": "2026-11-17T10:00:00.000Z",
  "payload": {
    "task_id": "task_001",
    "question_id": "q_001",
    "is_correct": false
  }
}
```

这对后续分析非常有价值：

- 学生学习轨迹还原。
- 掌握度重新计算。
- 诊断结果更新。
- 学习计划重新规划。
- 业务问题追踪。

但事件日志不能替代可靠事务。MVP阶段应采用先持久化业务结果、再记录事件并支持恢复的方式，避免出现只记录了事件但业务状态未落库的情况。

# 五、异步任务引擎：不使用MQ

试卷解析、诊断、报告生成都可能是耗时任务。

没有消息队列也可以实现可靠的任务管理。

建议自研一个轻量级 Job Engine。

## 5.1 任务结构

```
export type JobStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED";

export interface Job<TInput = unknown> {
  id: string;
  type: string;
  status: JobStatus;

  input: TInput;
  output?: unknown;

  attempts: number;
  maxAttempts: number;

  createdAt: string;
  startedAt?: string;
  completedAt?: string;

  nextRetryAt?: string;
  error?: string;
}
```

## 5.2 Job Engine设计

创建任务并持久化

任务调度器扫描待执行任务

根据任务类型找到 Handler

执行任务

成功：保存结果

失败：重试或终止

核心接口：

```
export interface JobHandler<TInput, TOutput> {
  execute(
    input: TInput,
    context: JobContext
  ): Promise<TOutput>;
}

export interface JobEngine {
  register(
    type: string,
    handler: JobHandler<any, any>
  ): void;

  enqueue<T>(
    type: string,
    input: T
  ): Promise<string>;

  getJob(id: string): Promise<Job | null>;

  cancel(id: string): Promise<void>;
}
```

MVP实现时需要补充：

- 最大并发任务数。
- 任务超时。
- 失败重试与退避。
- 任务租约和异常恢复。
- 幂等键。
- 任务取消检查点。
- 优雅退出与启动恢复。

初期任务引擎可以运行在 API 进程内，但任务执行必须和 HTTP 请求隔离。对于耗时较长的AI任务，建议后续将 Worker 独立为另一个 Node.js 进程，仍然不需要引入外部服务。

# 六、核心业务引擎设计

我建议将系统的核心竞争力沉淀为六个纯 TypeScript 引擎。

这部分是未来最值得持续迭代的代码资产。

| 引擎               | 核心职责        | 是否依赖模型 |
| ---------------- | ----------- | ------ |
| DiagnosisEngine  | 错因识别、知识漏洞诊断 | 可选     |
| ScoreEngine      | 提分机会与优先级计算  | 否      |
| MasteryEngine    | 知识掌握状态计算    | 否      |
| PlanningEngine   | 学习任务与时间分配   | 否      |
| TeachingEngine   | 教学策略和教学状态管理 | 可选     |
| EvaluationEngine | 题目答案和学习效果评测 | 可选     |

## 6.1 DiagnosisEngine

输入：

```
interface DiagnosisInput {
  studentId: string;
  examId: string;
  answers: StudentAnswer[];
  questionKnowledge: QuestionKnowledge[];
}
```

输出：

```
interface DiagnosisResult {
  studentId: string;
  subject: string;
  lostScore: number;
  items: DiagnosisItem[];
}
```

错误类型统一定义：

```
type ErrorType =
  | "KNOWLEDGE_GAP"
  | "CONCEPT_MISUNDERSTANDING"
  | "METHOD_ERROR"
  | "CALCULATION_ERROR"
  | "READING_ERROR"
  | "EXPRESSION_ERROR"
  | "TIME_MANAGEMENT"
  | "CARELESSNESS"
  | "UNKNOWN";
```

第一阶段使用规则诊断，AI增强能力后续接入。

## 6.2 ScoreEngine

提分空间计算：

\\[ G_i=L_i \times R_i \times C_i \\]

其中：

- \\(L_i\\)：可恢复失分空间。
- \\(R_i\\)：预计训练恢复概率。
- \\(C_i\\)：诊断可信度。

再计算投入产出：

\\[ P_i=\frac{G_i \times E_i}{T_i} \\]

需要避免一个常见错误：同一道题涉及多个知识点，不能将失分分值完整计入每一个知识点，否则会重复计算提分空间。

建议通过题目知识点权重分配，保证：

\\[ \sum_j w\_{ij}=1 \\]

这样每道题的失分只会被分配一次。

## 6.3 MasteryEngine

不要简单采用做题正确率作为掌握度。

建议建立多维掌握模型：

```
interface MasteryEvidence {
  originalAccuracy: number;
  similarAccuracy: number;
  variantAccuracy: number;
  delayedAccuracy: number;
  independentRate: number;
  evidenceCount: number;
}
```

状态分级：

| 状态   | 判定条件示意      |
| ---- | ----------- |
| 未学习  | 没有有效学习证据    |
| 初步接触 | 看过讲解或完成引导练习 |
| 基本掌握 | 同类题独立作答稳定   |
| 熟练掌握 | 变式题也能独立完成   |
| 稳定掌握 | 延迟复测仍能保持    |

各项阈值应通过试点数据校准，而不是直接将某个正确率视为通用教育规律。

## 6.4 PlanningEngine

这是最适合用确定性程序实现的部分。

输入：

```
interface PlanningInput {
  studentId: string;
  availableMinutesPerDay: number;
  opportunities: ScoreOpportunity[];
  knowledgeDependencies: KnowledgeDependency[];
  completedTasks: LearningTask[];
}
```

输出：

```
interface WeeklyPlan {
  studentId: string;
  dailyTasks: DailyTask[];
  totalMinutes: number;
  expectedObjectives: string[];
}
```

推荐采用：

- 优先级排序。
- 先修知识依赖处理。
- 每日时间预算约束。
- 学科交替安排。
- 复测任务插入。
- 未完成任务重新规划。

对于每天只有1小时学习时间的学生，规划引擎必须硬性保证总任务时长不超过60分钟，而不是让AI自由生成任务列表。

# 七、AI能力设计：不依赖外部模型也能先开发

这里有一个必须明确的技术边界：

没有OCR引擎或视觉模型，Node.js原生能力无法可靠地将试卷照片转换成完整题目、手写答案和批改痕迹。

所以我不建议在没有模型的情况下假装实现了自动试卷识别。

应该先建立AI能力抽象，确保业务闭环可以开发和测试。

## 7.1 AI Provider接口

```
export interface AIProvider {
  generateText(
    request: GenerateRequest
  ): Promise<GenerateResponse>;

  analyzeImage?(
    request: ImageAnalyzeRequest
  ): Promise<ImageAnalyzeResponse>;
}
```

第一阶段实现三种Provider：

| Provider       | 实现           | 用途         |
| -------------- | ------------ | ---------- |
| MockProvider   | 固定测试数据       | 开发与测试      |
| RuleProvider   | TypeScript规则 | 诊断、教学策略、评分 |
| ManualProvider | 人工输入与确认      | 试卷识别、答案确认  |

未来增加真实模型时，再实现新的 Provider。

## 7.2 AI能力与确定性能力分离

我建议明确哪些事情必须使用确定性代码：

| 业务      | 实现方式             |
| ------- | ---------------- |
| 成绩计算    | TypeScript       |
| 提分空间计算  | TypeScript       |
| 学习时间分配  | TypeScript       |
| 任务状态机   | TypeScript       |
| 掌握度规则   | TypeScript       |
| 题目答案验证  | 规则或专用求解器         |
| 题目识别    | 未来接入视觉模型         |
| 手写答案识别  | 未来接入视觉模型         |
| 自然语言讲解  | AI Provider      |
| 错因语义分析  | AI Provider + 规则 |
| 个性化教学对话 | AI Provider      |
| 学习报告生成  | 规则数据 + 可选AI润色    |

不要让大模型负责学生成绩计算、任务状态迁移和提分时间预算。

## 7.3 教学工作流自主实现

不引入 LangGraph 等工作流框架，可以使用 TypeScript 状态机。

```
type TeachingState =
  | "INTRODUCING"
  | "EXPLAINING"
  | "GUIDING"
  | "PRACTICING"
  | "ASSESSING"
  | "COMPLETED";

interface TeachingContext {
  studentId: string;
  taskId: string;
  questionId: string;
  state: TeachingState;
  hintCount: number;
  attempts: number;
}
```

每次学生提交回答后：

```
接收回答
  ↓
答案验证
  ↓
判断是否正确
  ├── 正确
  │    ↓
  │  是否需要变式训练？
  │    ├── 是：PRACTICING
  │    └── 否：ASSESSING
  │
  └── 错误
       ↓
     分析错误类型
       ↓
     选择教学策略
       ├── 概念提示
       ├── 方法提示
       ├── 分步讲解
       └── 示例演示
```

这样，即使目前没有接入任何大模型，教学状态管理、训练任务和评测流程也可以正常运行。

# 八、REST API设计

采用原生 HTTP Server，自研轻量级 Router。

建议统一API版本：

`/api/v1`

## 8.1 API清单

| 领域   | API                             | 方法   | 作用       |
| ---- | ------------------------------- | ---- | -------- |
| 学生   | /students                       | POST | 创建学生     |
| 学生   | /students/:id                   | GET  | 查询学生     |
| 学生   | /students/:id/profile           | PUT  | 更新档案     |
| 考试   | /exams                          | POST | 创建考试     |
| 考试   | /exams/:id/results              | POST | 录入成绩     |
| 试卷   | /exams/:id/papers               | POST | 上传试卷     |
| 诊断   | /exams/:id/diagnosis            | POST | 发起诊断     |
| 诊断   | /exams/:id/diagnosis            | GET  | 查询诊断     |
| 知识   | /knowledge-points               | GET  | 查询知识体系   |
| 提分   | /students/:id/opportunities     | GET  | 查询提分机会   |
| 计划   | /students/:id/plans             | POST | 创建学习计划   |
| 计划   | /students/:id/plans/current     | GET  | 获取当前计划   |
| 任务   | /students/:id/tasks/today       | GET  | 获取今日任务   |
| 任务   | /tasks/:id/complete             | POST | 提交任务     |
| 教学   | /teaching/sessions              | POST | 创建教学会话   |
| 教学   | /teaching/sessions/:id/messages | POST | 提交回答     |
| 练习   | /practice/sessions              | POST | 创建练习     |
| 练习   | /practice/attempts              | POST | 提交答案     |
| 评测   | /assessments                    | POST | 创建独立评测   |
| 掌握度  | /students/:id/mastery           | GET  | 查询知识掌握情况 |
| 报告   | /students/:id/reports/weekly    | GET  | 查询周报     |
| 任务中心 | /jobs/:id                       | GET  | 查询后台任务   |

## 8.2 API统一返回结构

```
interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
  requestId: string;
  timestamp: string;
}
```

例如：

```
{
  "success": true,
  "data": {
    "studentId": "stu_001",
    "score": 76,
    "subject": "数学"
  },
  "requestId": "req_001",
  "timestamp": "2026-11-17T10:00:00.000Z"
}
```

建议实现以下原生中间件：

- Request ID。
- 统一异常处理。
- 请求体大小限制。
- 参数校验。
- 访问日志。
- 身份认证。
- 角色与资源权限检查。
- 请求频率限制。

# 九、完整的后端业务闭环

后端最终不是提供一堆CRUD接口，而是要实现完整的学习业务流程。

以学生上传期中考试数学试卷为例：

## 试卷诊断到提分验证

1. 考试数据录入

   创建考试、录入成绩、上传试卷。
2. 试卷结构化

   提取题目、答案、学生作答和得分；不能自动识别的部分进入人工确认。
3. 错因诊断

   将错题映射到知识点，分析失分原因，形成证据。
4. 提分机会分析

   计算各知识点的可恢复失分空间和学习投入产出。
5. 学习计划生成

   根据每天60分钟的约束，安排本周任务。
6. AI教学与练习

   逐步讲解、提示、训练和记录学生行为。
7. 独立能力评测

   使用未训练过的同类题、变式题验证掌握情况。
8. 更新知识掌握状态

   根据真实评测证据更新学生能力画像。
9. 动态重新规划

   根据学习效果和未完成任务调整下一周计划。

这个流程应该由多个应用用例组合完成，而不是由一个超大的 `StudentService` 承担全部逻辑。

# 十、测试与质量保证

完全不依赖第三方测试框架，可以使用 Node.js 内置的 `node:test`。

建议建立四级测试体系。

| 测试层级  | 测试对象          | 示例          |
| ----- | ------------- | ----------- |
| 单元测试  | 核心算法          | 提分优先级、掌握度计算 |
| 集成测试  | 模块和Repository | 考试诊断、计划保存   |
| 契约测试  | API及数据结构      | 请求校验、返回结构   |
| E2E测试 | 完整业务链路        | 上传考试到生成学习计划 |

## 10.1 最重要的业务验收用例

| 编号   | 场景     | 验收结果         |
| ---- | ------ | ------------ |
| TC01 | 创建学生   | 学生档案正确保存     |
| TC02 | 录入考试成绩 | 成绩与总分校验正确    |
| TC03 | 上传试卷   | 文件完整保存       |
| TC04 | 题目结构化  | 原始数据与识别数据可追溯 |
| TC05 | 错因诊断   | 每个结论包含证据     |
| TC06 | 多知识点关联 | 失分分配不重复      |
| TC07 | 提分规划   | 优先级计算可复现     |
| TC08 | 时间约束   | 每日总任务不超过预算   |
| TC09 | 学习任务   | 状态转换符合规则     |
| TC10 | 独立评测   | 训练提示不污染独立测试  |
| TC11 | 掌握度更新  | 只有有效证据才更新状态  |
| TC12 | 任务异常恢复 | 重启后未完成任务可以恢复 |

例如，PlanningEngine必须有一个确定性测试：

```
import { test } from "node:test";
import assert from "node:assert/strict";

test("daily learning time must not exceed 60 minutes", () => {
  const result = planningEngine.generate({
    studentId: "stu_001",
    availableMinutesPerDay: 60,
    opportunities: mockOpportunities,
    knowledgeDependencies: [],
    completedTasks: []
  });

  for (const day of result.dailyTasks) {
    const total = day.tasks.reduce(
      (sum, task) => sum + task.durationMinutes,
      0
    );

    assert.ok(total <= 60);
  }
});
```

# 十一、项目实施路线

我建议将后端拆成四个开发阶段。

| 阶段      | 开发内容                                     | 阶段交付      |
| ------- | ---------------------------------------- | --------- |
| P1 基础框架 | HTTP Server、Router、DI、Repository、文件存储、日志 | 可运行后端骨架   |
| P2 核心业务 | 学生、考试、题目、知识体系、诊断                         | 试卷诊断闭环    |
| P3 学习引擎 | 提分规划、学习任务、教学、练习、评测                       | 完整学习闭环    |
| P4 产品完善 | 报告、掌握度、权限、恢复、测试                          | 可试点使用的MVP |

## 11.1 推荐开发顺序

不要让 CodeAgent 一次性生成整个系统。

推荐按照以下依赖顺序实施：

```
基础工程
  ↓
核心领域模型
  ↓
文件持久化
  ↓
学生与考试
  ↓
题目与知识体系
  ↓
诊断引擎
  ↓
提分引擎
  ↓
学习计划引擎
  ↓
教学与练习
  ↓
评测与掌握度
  ↓
学习报告
```

每完成一个阶段，必须运行测试并检查实际数据，而不是只检查代码是否生成。

# 十二、我建议再增加一个重要设计：让后端本身具备可演进性

考虑到你希望后续通过 CodeAgent 持续开发，我建议增加三个工程机制。

1\. 业务规则版本化

例如：

```
interface RuleMetadata {
  ruleId: string;
  version: string;
  effectiveFrom: string;
  status: "DRAFT" | "ACTIVE" | "DEPRECATED";
}
```

提分算法、掌握度算法、错因诊断规则都应有版本。

这样才能解释为什么学生上周和本周的诊断结果发生变化。

2\. AI任务和业务结果可追溯

每个诊断结果都应该能够追溯：

- 使用了什么输入。
- 使用了哪个规则版本。
- 是否使用模型。
- 使用了什么提示词版本。
- 是否经过人工确认。
- 是否经过独立校验。

3\. 核心引擎可独立测试

ScoreEngine、PlanningEngine、MasteryEngine不应该依赖HTTP、文件系统或模型。

它们应当是纯 TypeScript 业务逻辑，可以用固定输入反复验证输出。

这会显著提高 CodeAgent 修改代码时的安全性。

# 十三、最终技术方案

# 推荐架构基线

MVP推荐

| 项目    | 选择                  |
| ----- | ------------------- |
| 运行环境  | Node.js             |
| 开发语言  | TypeScript          |
| 架构模式  | 模块化单体               |
| API   | 原生 HTTP + REST      |
| 数据持久化 | Repository + JSON文件 |
| 文件管理  | node:fs             |
| 异步任务  | 自研 Job Engine       |
| AI编排  | 自研状态机与Workflow      |
| 算法    | 纯 TypeScript        |
| 测试    | node:test           |
| 日志    | 自研结构化Logger         |
| 部署    | 单机 Node.js          |

核心原则

- 零第三方运行时依赖。
- 不依赖外部基础设施。
- 业务逻辑与基础设施解耦。
- 确定性算法优先于大模型。
- 所有AI输出必须经过校验。
- 所有学习结论必须有证据。
- 所有核心业务逻辑可自动化测试。

## 一个需要提前说明的生产边界

这套方案适合本地开发、原型验证和小规模单实例试点。但如果要正式服务真实未成年学生，文件存储不能长期承担核心业务数据库职责；认证、权限隔离、数据备份、删除机制和安全审计也不能因为不引入第三方依赖而省略。

尤其是试卷图片和学生个人信息，应采用独立访问控制，不能直接暴露文件目录。

我的最终建议：先把这套系统做成一个完全自主、零第三方运行时依赖的 TypeScript 后端。重点投资六个核心引擎：诊断、提分、规划、教学、评测、掌握度。

下一步最有价值的交付物不是继续扩展架构文档，而是把以上设计转化为 CodeAgent 能直接执行的工程 Spec：目录结构、TypeScript接口、完整数据Schema、API契约、状态机、开发任务和自动验收测试。