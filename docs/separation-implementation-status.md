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
| Phase 5a | 运维接口角色校验（安全修复） | ✅ 完成 |
| Phase 5b | 移除旧路径兼容层 | ✅ 完成 |
| Phase 5c | localStorage 边界收紧（只留 token/偏好/快照） | ✅ 完成 |
| Phase 5d | 补全服务端水合（历史/流水/成绩） | ✅ 完成 |
| Phase 5e | 清理一次性迁移脚本 | ✅ 完成 |
| Phase 6a | 自动化回归任务（定时 test/typecheck/build） | ✅ 完成 |
| Phase 6b | Job Engine 进度事件乱序修复 | ✅ 完成 |
| Phase 6c | 数据删除审计重复条目修复 | ✅ 完成 |
| Phase 6d | 前端测试基建（web 包接入测试） | ✅ 完成 |

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

## Phase 5 — 收尾清理与安全补漏

### 运维接口角色校验（安全修复）

审计中发现：**家长（只读角色）可以触发运维接口**。

| 接口 | 修复前 | 修复后 |
|---|---|---|
| `POST /admin/backup` | 任何登录用户 | 仅 teacher |
| `POST /admin/cleanup` | 任何登录用户 | 仅 teacher |
| `GET /admin/backups` | 任何登录用户 | 仅 teacher |
| `GET /admin/audit` | 任何登录用户 | 仅 teacher |
| `DELETE /admin/students/:id/data` | 拒绝家长 | **允许家长代为行使孩子的删除权**（数据主体权利） |

`admin/cleanup` 尤其危险——它会删除**所有学生**的过期数据。

### localStorage 边界收紧

分离前前端把完整 AppState（约 20KB，含全部聊天记录与试卷）写 localStorage，
每次状态变化全量重写。这让「服务端是唯一真相源」名存实亡。

现在 localStorage 只保留：

| 数据 | 保留 | 说明 |
|---|---|---|
| 访问令牌 | ✅ | 必须本地持有 |
| UI 偏好 | ✅ | 纯客户端状态 |
| 知识体系只读快照 | ✅ | 减少请求，支持离线浏览 |
| 掌握度/错题/计划/会话/成绩 | ❌ | **一律从服务端水合** |

旧 key（`shanghai_ai_score_os_v5`）在首次访问时自动清理。

### 补全服务端水合

原先只水合掌握度与错题记录，导致报告页缺失：
- 掌握度迁移历史 → `GET /mastery/history`
- 作答流水 → `GET /attempts`（新增）
- 考试成绩 → `GET /exam-results`（新增）

### 移除旧路径兼容层

前端已全量切换到 `/api/v1`，删除 `/api/*` 兼容层。
前后端版本不再需要错配保护。

### 清理一次性脚本

`extract-knowledge.mjs` / `extract-seed.mjs` 的产物已是正式资产（JSON），
脚本删除。

### 修复 seed 非幂等

`seed` 用 append 写作答流水，重复执行会产生重复记录（导致 React key 冲突）。
现改为先清空再写，读接口另加按 ID 去重防御。

---

## Phase 6 — 回归测试与并发缺陷修复

### 自动化回归任务

已配置定时任务（`schedule-ee11af60-fb15-44ff-b621-4eaa9c2a5d48`），
周期性执行 `npm test` + `npm run typecheck` + `npm run build`，
失败时定位根因、补测试、修复实现，直至全绿。

### Job Engine 进度事件乱序（并发缺陷）

**现象**：`JobEngine` 进度订阅者收到的进度事件顺序与上报顺序不一致。

```
上报顺序：第一步(30) → 第二步(70) → 第三步(90)
实际收到：第一步 → 第三步 → 第二步
```

**根因**：`reportProgress` 内部先 `await persist()`（磁盘写）再 `emit`，
而 `JobContext.reportProgress` 是**即发即忘**（`void` 调用）。
连续上报时多个 `await` 并发挂起，谁先完成就谁先 `emit` ——
**写操作的锁保证了落盘顺序，却管不住 await 之后的 emit 顺序**。

实测：8 次连续上报，10 次运行中 **7 次乱序**；
20 次上报时顺序错乱更明显（如 `s0,s2,s3,s1,s5,s6,s7,s4`）。

**影响**：SSE 推送的进度条会来回跳动（30% → 90% → 70%），
用户看到「进度倒退」。

**修复**：

| 措施 | 说明 |
|---|---|
| 每任务进度链 | `progressChains: Map<jobId, Promise>` 把同任务的进度上报串成 FIFO |
| `drainProgress()` | 任务结束前等待排队的进度事件推送完毕 |
| `done` 事件时序 | 保证 `done` 永远排在最后一条 `progress` 之后 |
| 失败隔离 | 单次进度上报失败只告警，不影响任务本身 |

### 数据删除审计重复条目（合规缺陷）

**现象**：一次删除学生数据，审计日志里出现**两条** `StudentDataDeleted`。

| 来源 | 字段 |
|---|---|
| `retention-service.ts` | `payload: { scope, reason }`，**无 actor** |
| `admin.routes.ts` | `actor / actor_role / via`，**无 scope** |

两条记录 schema 不同，审计追溯时无法确定「谁删的」。

**修复**：审计落盘统一收敛到 `retention.deleteStudentData()`，
调用方通过 `options.actor` / `options.via` 传入身份上下文，只写一条完整记录。

顺带修正：

| 问题 | 修复前 | 修复后 |
|---|---|---|
| 老师删除的身份标记 | `via=owner`（误标为数据主体本人） | `via=teacher` |
| `event_id` 生成 | `Date.now()`（同毫秒内会重复） | `randomUUID()` |

### 前端测试基建

`web` 包此前无测试能力，「localStorage 只保留 token / 偏好 / 快照」
这一关键边界约束完全依赖人工保证。

| 文件 | 说明 |
|---|---|
| `web/tests/helpers/local-storage.ts` | localStorage 替身，支持「写入必然失败」模式覆盖配额超限分支 |
| `web/tests/local-state.test.ts` | 13 例：遗留数据清理、骨架构造、UI 偏好读写 |

根 `package.json` 的 `test` 改为 `--workspaces`，前后端测试统一入口。

---

## 验证结果

```
类型检查   contracts ✓ server ✓  web ✓
测试       134/134 通过（服务端 121 + 前端 13）
                单元 18 + 鉴权 10 + Job 17 + 集成 15 + SSE 7 + 异步 4
                + 保留/备份 9 + 安全/运维 17 + 角色权限 24
前端构建   ✓
浏览器     5 个页面渲染，零 page error / console error
localStorage 仅剩 7.3KB 知识体系快照（原 19.7KB 业务数据）
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
| 11 | 运维接口无角色校验 | **家长可触发全量数据清理** |
| 12 | `seed` 用 append 写流水 | 重复播种产生重复记录（React key 冲突） |

其中 #8、#9 都是**架构正确但实现有洞**的典型——
安全检查与调度语义都写在代码里，但被一行 catch 或一次调用绕过了。

Phase 6 又发现 3 个：

| # | 缺陷 | 影响 |
|---|---|---|
| 13 | `reportProgress` 即发即忘，多个 await 竞争后 emit | **SSE 进度事件乱序**（进度条来回跳动，30% → 90% → 70%） |
| 14 | 数据删除写两条审计记录（retention + 路由各一条） | **审计追溯无法确定「谁删的」**（两条 schema 还不同） |
| 15 | 老师删除被记为 `via=owner` | 审计失真：管理需要 ≠ 数据主体本人 |

#13 最隐蔽——**写操作的锁保证了落盘顺序，却管不住 `await` 之后的 `emit` 顺序**。
写对了、存对了、发出去了，但顺序错了，人眼在浏览器里只看到「进度条乱跳」，
很难归因到并发。

#14 同属「**每一步都做对了，但做重了**」——
审计服务与 API 路由都认为自己该记一笔，结果一次删除留下两条互相矛盾的记录。

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
