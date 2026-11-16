# 前后端分离实施状态

> 本文档记录 `docs/frontend-backend-separation.md` 方案的实际落地情况。
> 方案文档讲「应该怎么做」，本文讲「做到了哪、验证结果如何、还有什么没做」。

---

## 总体进度

| 阶段 | 内容 | 状态 |
|---|---|---|
| Phase 1 | 解耦与契约对齐 | ✅ 完成 |
| Phase 2a | 鉴权层（认证 + 资源隔离 + 配额） | ✅ 完成 |
| Phase 2b | 知识体系 API 化 | ✅ 完成 |
| Phase 2c | 试卷/考试/错题聚合服务端化 | ✅ 完成 |
| Phase 2d | 计划任务状态服务端化 | ✅ 完成 |
| Phase 2e | 教练会话服务端化 | ✅ 完成 |
| Phase 3a | Job Engine + SSE 进度推送 | ✅ 完成 |
| Phase 3b | 试卷文件上传落盘 | ✅ 完成 |
| Phase 3c | 数据保留与删除机制 | ✅ 完成 |
| Phase 3d | 备份与恢复验证 | ✅ 完成 |
| Phase 4a | 文件按学生分目录（安全缺口） | ✅ 完成 |
| Phase 4b | 请求频率限制 | ✅ 完成 |
| Phase 4c | 操作审计补全 | ✅ 完成 |
| Phase 4d | 定时任务（每日备份 + 清理） | ✅ 完成 |
| Phase 4e | 教师角色界面 | ✅ 完成 |
| Phase 4f | 独立部署（Dockerfile / compose / CI） | ✅ 完成 |
| Phase 4g | 服务端免编译（Node 原生类型剥离） | ✅ 完成 |

---

## Phase 1 — 建立物理边界

### 已消除的反向依赖

```ts
// 分离前 server.ts:6 —— 后端 import 前端目录
import { SHANGHAI_CURRICULUM } from './src/data/shanghaiCurriculum.ts';

// 分离前 server.ts:566 —— 后端托管前端构建产物
app.use(vite.middlewares);
```

现在后端与契约包**完全不依赖** `web/`（仅一次性迁移脚本 `scripts/extract-*.mjs` 引用，
迁移完成后可删）。

### 业务逻辑下沉

| 原位置（前端） | 新位置（服务端） |
|---|---|
| `src/engine/planner.ts` → `buildSevenDayPlan` | `engines/planning-engine.ts` |
| `src/engine/planner.ts` → `evaluateMasteryTransition` | `engines/mastery-engine.ts` |
| `src/engine/planner.ts` → `computePriorityOpportunities` | `engines/planning-engine.ts` |
| `src/engine/planner.ts` → `getEffectiveDailyBudget` | 服务端计算 |
| `src/engine/planner.ts` → `getDelayedRetestStatus` | 服务端（依赖服务端时钟） |

逻辑**逐行等价**，仅两处必要改动：
- `Date.now()` → 显式入参 `now`（使引擎完全可测，且时钟基准由服务端控制）
- `KNOWLEDGE_MAP` → `getKnowledgeMap()`（从服务端知识体系资产构建）

所有数值常量（0.15 / 0.25 / 0.33 / 0.42 / 0.45 / 0.75 / 1.15 / 1.25 / 1.35）逐一核对未变。

### 契约包边界

`packages/contracts/` 只含**类型**与**纯校验函数**，不含业务逻辑。

原因：掌握度、提分优先级、每日时长约束是不可被学生篡改的数据。
放前端等于把评分逻辑交给学生自己改 JS。

前端保留 `web/src/engine/plan-fallback.ts` 仅作服务端不可用时的**展示降级**，
不参与任何评分、落库或状态迁移。

---

## Phase 2a — 鉴权层

### 三层防护

| 层 | 实现 | 防护目标 |
|---|---|---|
| 身份认证 | HMAC-SHA256 签名令牌 | 防止他人白嫖 `GEMINI_API_KEY` |
| 资源级隔离 | `AuthContext.studentIds` | 防止跨学生读取数据 |
| 成本护栏 | 按账号计数的 AI 配额 | 防止单账号刷量 |

### 关键实现细节

**令牌无状态**（不需 session 存储）：
```ts
payload = { sub, sids, role, iat, exp }
signature = HMAC-SHA256(payload, secret)
```
- 用 `timingSafeEqual` 比较签名，防时序攻击
- payload 带 `exp`，过期即失效
- `sids` 决定资源访问范围，服务端强制校验

**角色权限**：

| 角色 | 权限 |
|---|---|
| `student` | 读写自己的学习数据 |
| `parent` | **只读** —— 可看报告，不能替孩子提交作答 |
| `teacher` | 可访问全部学生 |

**开发/生产双模式**：

| 配置 | 行为 |
|---|---|
| 未配 `AUTH_SECRET` | 开发模式：不要求认证，仅保留配额；凭证为内存演示账号 |
| 配了 `AUTH_SECRET` | 强制认证；凭证读 `data/db/credentials.json` |

前端相应显示登录页，并在 401 时自动回到登录页。

---

## Phase 2b — 知识体系 API 化

### 变更

| | 分离前 | 分离后 |
|---|---|---|
| 前端 | 硬编码 589 行 `shanghaiCurriculum.ts` | `GET /knowledge-points` 拉取 |
| 题库 | 前端 `VERIFIED_QUESTION_BANK` | `GET /practice/questions` |
| 版本 | 无 | `shanghai-junior-2026.1` |

前端新增 `CurriculumProvider`（React Context）：
- 内存缓存（一次会话拉一次）
- localStorage 快照兜底（离线可浏览）
- 诊断结果记录 `curriculumVersion`，保证历史诊断可复现

### 验证

```
✓ 18 个知识点从服务端加载，下拉选项名称正确
✓ 前置知识引用完整性（无悬空引用）
✓ 589 行硬编码文件已删除
```

---

## Phase 2c/2d/2e — 业务实体服务端化

### 覆盖范围

| 实体 | 端点 | 说明 |
|---|---|---|
| 试卷 | `POST /exams/:id/papers` | 保存试卷 + 诊断条目落库为错题记录 |
| 考试 | `POST /exams` | 创建考试 |
| 元信息确认 | `PATCH /papers/:id/confirm-metadata` | AI 提取值与人工确认值**分离存储** |
| 错题记录 | `GET/PATCH /students/:id/error-records` | 订正状态独立生命周期 |
| 计划任务状态 | `PATCH /plans/:studentId/tasks/:taskId` | 完成/延后/步骤进度 |
| 教练会话 | `GET/PUT /students/:id/coaching/sessions/:kid` | 按知识点切分存储 |

### 事件日志

`data/events/{yyyy-MM-dd}.jsonl` 记录业务事件，**先落业务结果、再记事件**：

```json
{
  "event_id": "evt_...",
  "event_type": "DiagnosisCompleted",
  "aggregate_id": "stu-sh-zhangwei",
  "occurred_at": "2026-11-17T00:00:00.000Z",
  "payload": { "examId": "...", "errorCount": 2, "curriculumVersion": "..." }
}
```

### 水合（Hydration）

前端启动时 `useServerHydration` 从服务端拉取掌握度与错题记录，
覆盖本地缓存。localStorage 降级为**乐观缓存 + 离线兜底**。

---

## Phase 3 — 异步任务与生产加固

### Job Engine

| 能力 | 实现要点 |
|---|---|
| 持久化 | 任务写入 `data/db/jobs/`，重启后可恢复 |
| 幂等 | `idempotencyKey` 相同则返回同一任务 ID |
| 重试 | 失败按指数退避重试（默认 3 次） |
| 租约 | 进程崩溃后任务重新入队，启动时自动恢复 |
| 取消 | 长任务在检查点响应取消信号 |
| 并发 | 默认 2 个（`JOB_CONCURRENCY` 可调） |
| 优雅退出 | SIGTERM 等待进行中任务完成 |

### 异步诊断链路

```
上传试卷图片 → fileId
  → POST /exams/:id/diagnosis → jobId（幂等）
  → GET /jobs/:id/events → SSE 进度（stage + pct）
  → done 事件携带完整诊断结果
```

SSE 用 `node:http` 原生实现；前端用 `fetch` + `ReadableStream` 手动解析
SSE 帧（因为 `EventSource` 不支持自定义 header，无法携带 Bearer token）。
保留轮询作为降级路径。

### 文件存储

试卷图片不再 base64 直传模型，改为上传落盘 + 按 ID 鉴权访问。
**不提供静态目录服务**（原设计文档 §13 的明确要求）。

### 数据合规

| 能力 | 说明 |
|---|---|
| 自动清理 | 事件日志/作答流水/完成任务/上传文件按保留期清理 |
| 删除权 | `DELETE /admin/students/:id/data` 删除学生全部数据 |
| 审计 | 删除操作写入 `data/audit/`，保留可追溯 |
| 备份 | 逐文件拷贝 + SHA-256 校验和 |
| 恢复验证 | `--verify` 检查全部备份可恢复性 |

---

## Phase 4 — 生产加固与独立部署

### 文件按学生分目录（安全缺口修复）

Phase 3 的文件存储未按学生隔离——**知道 fileId 就能拿到任何人的试卷**。
现已修复：

| 层面 | 措施 |
|---|---|
| 存储路径 | `files/papers/{studentId}/{paperId}/{fileId}.jpg` |
| 元数据索引 | `db/files/{fileId}.json` 记录归属，鉴权不依赖文件名猜测 |
| 路径清洗 | `studentId`/`paperId` 中的分隔符被替换，防止注入 |
| 路径穿越 | `resolveSafe` 强制约束在 dataDir 内（且**错误必须抛出，不能被吞掉**） |
| 响应头 | `X-Content-Type-Options: nosniff` 防 MIME 嗅探 XSS |

### 限流

| 范围 | 默认 | 维度 |
|---|---|---|
| 全局 API | 120 次/分钟 | 认证用户按用户，匿名按 IP |
| AI 端点 | 10 次/分钟 | 同上 |

与「AI 配额」分工：限流防**瞬时刷量**，配额防**每日成本失控**。

### 审计

关键操作全量写入 `data/audit/{date}.jsonl`（只追加）：

档案更新、错题状态变更、元信息确认、掌握度迁移、计划重算、
教练会话保存、跨学生访问被拒、家长写操作被拒、备份创建、数据清理。

### 定时任务

`Scheduler`（node:timers，零第三方依赖）：

- `daily-backup` —— 每日自动备份
- `daily-cleanup` —— 每日自动清理
- **重启后不重复执行当日任务**（marker 文件持久化）

### 服务端免编译

Node 24 原生支持 TypeScript 类型剥离，服务端**无需编译步骤**：

```bash
node --experimental-strip-types packages/server/src/main.ts
```

前提：代码不得使用 strip-only 模式不支持的语法（如参数属性）。
已全部转换 12 处 `constructor(private readonly x: T)`。

### 部署

| 文件 | 说明 |
|---|---|
| `Dockerfile` | 多阶段构建；运行阶段零编译 |
| `docker-compose.yml` | 必需环境变量校验 + 数据卷 + 健康检查 |
| `.github/workflows/ci.yml` | typecheck → test → build → docker build |
| `docs/deployment.md` | 完整部署说明 + 环境变量 + 安全清单 |

---

## 验证结果

```
类型检查   contracts ✓ server ✓  web ✓
测试       93/93 通过（单元 18 + 鉴权 10 + Job 13 + 集成 15 + SSE 7 + 异步 4 + 保留/备份 9 + 安全/运维 17）
前端构建   ✓
浏览器     5 个页面渲染，零 page error / console error
教师工作台  ✓ 角色徽章 + 学生卡片 + 优先提分点
原生剥离启动 ✓ node --experimental-strip-types 直接运行 TS 源码
架构边界   后端不依赖 web/ ✓  前端不依赖后端实现 ✓
运维脚本   备份/恢复/清理 实测通过
```

### 测试发现并修复的真实缺陷

| # | 缺陷 | 影响 | 发现方式 |
|---|---|---|---|
| 1 | `FileDatabase.read()` 未兼容 `list()` 返回的带 `.json` 文件名 | **所有列表接口静默返回空数组**（200 但数据为空） | 集成测试 |
| 2 | `FileDatabase.remove()` 同样问题 | 保留期清理不生效，已完成任务永久堆积 | 保留测试 |
| 3 | `JobEngine.tick()` 并发检查有竞态 | **实际并发数 3 超过上限 2** | Job 测试 |
| 4 | `JobEngine` tick 无互斥 | `enqueue` 触发的 tick 与轮询 tick 重复领取任务 | Job 测试 |
| 5 | `FileStorage.listForStudent('')` 恒返回空 | **上传后的文件永远找不到**，异步诊断 400 | 异步链路测试 |
| 6 | `ApiException` 一律返回 400 | 401/403/429 全被压成 400 | API 集成测试 |
| 7 | 诊断接口用 `container.ai` 判断可用性 | Mock Provider 场景被误拒 | 异步链路测试 |

其中 #1、#5 最隐蔽——**接口都返回 200，只是结果不对**，
纯人工测试极易漏过。是集成测试（真实 HTTP + 真实文件存储）暴露的。

Phase 4 又发现 3 个：

| # | 缺陷 | 影响 |
|---|---|---|
| 8 | `storage.read()` 吞掉路径穿越异常 | **安全检查形同虚设**（异常被 catch 后返回 null） |
| 9 | `Scheduler` 每日任务绕过每日守卫 | **每日备份/清理会每 6 小时执行一次** |
| 10 | `FileStorage.listForStudent('')` 恒空 | 上传文件找不到（同 #5 同源） |

其中 #8、#9 都是**架构正确但实现有洞**的典型——
安全检查与调度语义都写在代码里，但被一行 catch 或一次调用绕过了。

---

## 全部阶段已完成

原设计的四个阶段均已落地。剩余为**规模化演进**（非当前必需）：

| 项 | 触发条件 | 方案 |
|---|---|---|
| 多实例部署 | 并发用户数上升 | 限流器 → Redis；Job → 独立 Worker；文件存储 → 数据库 |
| 数据库替换 | 复杂查询 / 跨实体事务 | Repository 抽象已就位，替换实现不改业务逻辑 |
| `node:sqlite` | 单机多学生并发写 | Node 24 内置，**保持零外部基础设施** |
| 外部 cron 调度备份 | 多实例部署后 | 避免多实例重复执行定时任务 |

### 建议的 Phase 3 顺序

1. **Job Engine 骨架** —— 任务持久化 + 重试 + 启动恢复（不改变前端接口）
2. **试卷解析转异步** —— 前端改为轮询/SSE（需前端配合改造）
3. **文件上传落盘** —— 试卷图片存储 + 鉴权访问（替代 base64 直传）
4. **数据删除与备份** —— 生产合规前置

---

## 保留的技术债

| 项 | 影响 | 何时处理 |
|---|---|---|
| 旧路径兼容层（`/api/diagnose-paper` 等） | 无 | 前端全量切换稳定一个发布周期后删除 |
| `scripts/extract-*.mjs` 迁移脚本 | 无 | 迁移确认无误后删除 |
| 前端 `shanghai_ai_score_os_v5` localStorage key | 仍存旧演示数据 | 首次访问时清理 |
| `plan-fallback.ts` 展示降级 | 服务端不可用时用本地估算 | 保留（离线兜底有价值），但确保不参与任何写操作 |
