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
| Phase 7a | 试卷存档库服务端化（TC-08） | ✅ 完成 |
| Phase 7b | 考试场次列表（TC-08 场次回填） | ✅ 完成 |
| Phase 7c | 产品验收用例测试 TC-01~TC-09 | ✅ 完成 |
| Phase 7d | 修复任务端点鉴权漏洞 | ✅ 完成 |
| Phase 8a | 修复水合被空列表提前中断 | ✅ 完成 |
| Phase 8b | 水合逻辑解耦（可独立测试） | ✅ 完成 |
| Phase 8c | 水合核心测试（7 例） | ✅ 完成 |
| Phase 8d | SSE 帧解析测试（21 例） | ✅ 完成 |
| Phase 8e | 登录态与知识体系缓存测试（25 例） | ✅ 完成 |
| Phase 8f | 降级计划学科硬编码修复（+21 例） | ✅ 完成 |
| Phase 8g | 中考倒计时时区修复（+17 例） | ✅ 完成 |
| Phase 8h | 凭证存储测试（15 例）+ 演示 PIN 后门修复 | ✅ 完成 |
| Phase 8i | AI 输出 schema 校验测试（22 例） | ✅ 完成 |
| Phase 8j | 知识体系资产完整性测试（26 例）+ 坏文件容错 | ✅ 完成 |
| Phase 8k | 提示词注册表测试（40 例） | ✅ 完成 |
| Phase 8l | 配置解析测试（18 例）+ NaN/缺密钥修复 | ✅ 完成 |
| Phase 8m | 日志保留字段保护（14 例） | ✅ 完成 |
| Phase 8n | 路径穿越修复 + 回归测试（12 例） | ✅ 完成 |
| Phase 8o | 限流按用户隔离修复（10 例） | ✅ 完成 |
| Phase 8p | AI 配额并发超发修复（8 例） | ✅ 完成 |
| Phase 8q | Job 幂等并发失效修复（4 例） | ✅ 完成 |
| Phase 8r | 跨学生数据丢失修复（2 例） | ✅ 完成 |
| Phase 8s | 并发作答丢失掌握度修复（6 例） | ✅ 完成 |
| Phase 8t | 试卷归属校验修复（4 例） | ✅ 完成 |
| Phase 8u | 上传文件归属校验修复（6 例） | ✅ 完成 |
| Phase 8v | AI 端点角色边界修复（5 例） | ✅ 完成 |
| Phase 8w | 前后端路由可达性测试（43 例） | ✅ 完成 |
| Phase 8x | 畸形知识体系快照白屏修复（6 例 + 2 E2E 断言） | ✅ 完成 |
| Phase 8y | 畸形登录会话白屏修复（5 例 + 2 E2E 断言） | ✅ 完成 |
| Phase 8z | 备份恢复路径穿越修复（3 例） | ✅ 完成 |
| Phase 9a | 上传文件魔数校验（17 例） | ✅ 完成 |
| Phase 6a | 自动化回归任务（定时 test/typecheck/build） | ✅ 完成 |
| Phase 6b | Job Engine 进度事件乱序修复 | ✅ 完成 |
| Phase 6c | 数据删除审计重复条目修复 | ✅ 完成 |
| Phase 6d | 前端测试基建（web 包接入测试） | ✅ 完成 |
| Phase 6e | E2E 重写为真实断言（19 条） | ✅ 完成 |
| Phase 6f | 教师工作台学生列表端点（补功能缺口） | ✅ 完成 |
| Phase 6g | API 客户端层测试（24 例） | ✅ 完成 |
| Phase 6h | 契约包运行时校验测试（41 例） | ✅ 完成 |
| Phase 10 | 设计与实现差距关闭（5 个 P0 + 7 个 P1） | ✅ 完成 |

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
| `web/tests/api-client.test.ts` | 24 例：令牌注入、错误码透出、重试策略、超时、401 事件 |

### 契约包测试

`packages/contracts` 的 `parseXxx` 是运行时校验器（解析失败 → null →
前端显示「服务返回格式异常」而非白屏）。这层的失效模式是**静默的**：
校验器一旦放宽，结构错误的服务端响应就会直接进入 UI。

`packages/contracts/tests/parsers.test.ts`（41 例）覆盖 12 个解析器 +
错误响应工具：

- 合法数据必须通过（防假阴性）、非法数据必须拒绝（防假阳性）
- 每个解析器跑统一的非法输入矩阵
- 错误码 → HTTP 状态映射的唯一性与语义正确性

### E2E 重写：从「只会打印」到「真能失败」

旧版 E2E 的问题：

1. **没有任何断言** —— 全是 `console.log`，永远不可能失败
2. 依赖人工预启动前后端 + 硬编码凭证
3. 跑完不退出（子进程句柄未释放）

新版（`tests/e2e/teacher-dashboard.mjs`，19 条断言）：

- 自举：临时数据目录 + 自动播种 + 自动启动前后端
- 覆盖：登录页 → 错误凭证被拒 → 教师登录 → 工作台渲染
  → localStorage 边界 → 遗留 key 清理 → 无运行时异常 → API 状态码
- 失败即非零退出码；显式 `process.exit` + 杀进程组

---

## 验证结果

> 下表是 **Phase 10 之后**的最新数据。Phase 10 之前的数字见
> [Git 历史](https://github.com/) 中对应 commit 的本文档版本。

```
类型检查   contracts ✓ server ✓  web ✓
测试       637/637 通过（contracts 41 + server 466 + web 130）
E2E        46/46 断言通过（自举前后端，退出码 0）
              原 24 条（登录/教师台/边界/容错）
              新 22 条（三条 P0 的浏览器级用户路径）
前端构建   ✓
浏览器     5 个页面渲染，零 page error / console error
localStorage 仅剩知识体系快照（原 19.7KB 业务数据）
教师工作台  ✓ 角色徽章 + 学生卡片 + 优先提分点
原生剥离启动 ✓ node --experimental-strip-types 直接运行 TS 源码
架构边界   后端不依赖 web/ ✓  前端不依赖后端实现 ✓
运维脚本   备份/恢复/清理 实测通过
```

> **注意**：Phase 10 之前的记录是「579/579 测试通过、24/24 E2E 断言通过」，
> 而当时 TC-01 / TC-02 / TC-06 在真实用户链路上**并不成立**
> （详见 Phase 10 与 `docs/DESIGN_IMPLEMENTATION_GAP_ANALYSIS.md`）。
> **测试全绿 ≠ 功能可用** —— 补上浏览器级用例后才是。

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
| 18 | **任务路由未挂认证中间件** | **任何人知道 jobId 即可读取学生诊断结论** |
| 19 | 水合漏了 `examPapers` / `exams` | **TC-08 存档库刷新后为空**（接口有了、前端没拉） |
| 20 | 水合中「错题为空」提前 return 整个流程 | **无错题学生丢失后 4 类数据**（含刚补好的存档库） |
| 21 | 降级计划学科硬编码「数学」（恒真三元残留） | **非数学学生看到一屏「数学」任务** |
| 22 | 中考倒计时目标日期按 UTC 零点解析 | **倒计时一直多一天**（明天显示成 2 天，UTC+8 受害） |
| 23 | 生产模式下演示 PIN `1234` 逐个 secret 回落 | **公开默认口令成为后门**（凭证文件存在也照样能登） |
| 24 | 知识体系资产损坏时 JSON.parse 直接抛 | **整个知识体系接口 500**（所有功能一起挂） |
| 25 | 数值配置非法 → `NaN` | **配额护栏静默失效**（`used >= NaN` 恒 false） |
| 26 | `AUTH_REQUIRED=true` 但无 `AUTH_SECRET` | **强制认证却用公开密钥签发令牌**（可伪造 teacher 身份） |
| 27 | 日志上下文覆盖 `ts`/`level`/`message` | **事件名与级别被冲掉**（按事件名聚合日志失效） |
| 28 | URL 参数直接拼进文件路径（未清洗） | **老师可覆盖 `credentials.json`**（凭证被改写） |
| 29 | 限流器挂在 `requireAuth` 前，`skipAuthenticated` 是死代码 | **同 IP 的不同用户互相挤掉额度** |
| 30 | AI 配额「读-判-写」非原子 | **并发下护栏完全失效**（限额 5 放行 20） |
| 31 | `enqueue` 幂等检查与记录之间有 await | **同一 key 并发产生 10 个任务**（重复 AI 诊断） |
| 32 | 删除学生时遍历 `listAll()` 删全部文件 | **删学生 A 连学生 B 的试卷一起删**（跨学生数据丢失） |
| 33 | 掌握度读-改-写非原子 | **并发作答丢记录**（5 个并发只剩 1 条） |
| 34 | 试卷归属用请求体的 studentId 校验 | **学生 A 可改学生 B 的试卷**（卷面元信息被篡改） |
| 35 | `storage.findById` 无归属校验且被诊断接口调用 | **学生 A 可把学生 B 的试卷图片挂进自己的诊断** |
| 36 | AI 端点只校验身份不校验角色 | **家长可替孩子提交作答**（越过只读边界 + 消耗孩子配额） |
| 37 | 知识体系快照不校验元素结构 | **畸形快照让整个应用白屏**（useState 初始化器抛错） |
| 38 | 会话只校验 token 不校验 studentIds | **畸形会话让整个应用白屏**（渲染函数体内抛错） |
| 39 | 备份恢复直接拼清单路径不校验 | **可把文件写到 dataDir 之外** |
| 40 | 上传只校验客户端自报的 mimeType | **任意内容可冒充图片落盘**（并被送给 AI 模型） |

其中 #8、#9 都是**架构正确但实现有洞**的典型——
安全检查与调度语义都写在代码里，但被一行 catch 或一次调用绕过了。

Phase 6 又发现 5 个：

| # | 缺陷 | 影响 |
|---|---|---|
| 13 | `reportProgress` 即发即忘，多个 await 竞争后 emit | **SSE 进度事件乱序**（进度条来回跳动，30% → 90% → 70%） |
| 14 | 数据删除写两条审计记录（retention + 路由各一条） | **审计追溯无法确定「谁删的」**（两条 schema 还不同） |
| 15 | 老师删除被记为 `via=owner` | 审计失真：管理需要 ≠ 数据主体本人 |
| 16 | **没有列出学生的端点**，老师令牌 `studentIds` 为空 | **教师工作台永远为空**（Phase 4e 标记「完成」但从未工作过） |
| 17 | `import.meta.env.VITE_API_BASE` 无可选链 | 非 Vite 环境（Node/SSR）整层 API 客户端崩溃 |

#13 最隐蔽——**写操作的锁保证了落盘顺序，却管不住 `await` 之后的 `emit` 顺序**。
写对了、存对了、发出去了，但顺序错了，人眼在浏览器里只看到「进度条乱跳」，
很难归因到并发。

#14 同属「**每一步都做对了，但做重了**」——
审计服务与 API 路由都认为自己该记一笔，结果一次删除留下两条互相矛盾的记录。

#16 是「**设计完成但功能没完成**」的典型：
Phase 4e 的教师工作台写完了，状态表也标了「✅ 完成」，
但没人验证过它能不能真的拿到数据 ——
因为老师令牌里**本来就没有**学生清单，服务端也**没有**对应的端点。
旧版 E2E 只有 `console.log` 没有断言，自然发现不了。

#17 属于「**测试能力缺失导致的隐性脆弱**」：
`import.meta.env` 只在 Vite 打包后存在，直接下标访问在 Node 里必崩。

#18 是「**边界之外没人管**」：
任务路由是唯一不挂在 `studentDataRouter` 上的路由
（为了 SSE 能在认证中间件前保持连接），
于是认证跟着一起被绕过了。

#19 与 #20 是同一件事的两个面：
#19 是「**服务端化了却忘了拉**」，
#20 是「**拉了却被提前 return 掐断**」——
两者叠加，导致 TC-08 补完端点后**依然看不到数据**。
这说明「补齐接口」不等于「功能可用」，
中间还隔着一段无人验证的前端数据流。

---

## Phase 7 — 产品验收闭环与鉴权补漏

### 对齐产品验收用例

`docs/PRODUCT_DESIGN_SPEC.md` §八 定义了 9 条 MVP 验收用例（TC-01~TC-09）。
逐条核对后发现 **TC-08（试卷存档库）与 TC-09（思维导图标记）在分离后是空壳**：

| 用例 | 分离前 | 分离后（补齐前） | 原因 |
|---|---|---|---|
| TC-08 | ✅ 内存里有 `examPapers` | ❌ 刷新后存档库为空 | `examPapers` 未纳入服务端水合 |
| TC-09 | ✅ 依赖 `errorRecords` | ⚠️ 依赖未水合的 `examPapers` | 思维导图按卷筛选时找不到卷 |

根因：**服务端化了数据，却漏了水合**——
接口有了、前端调了、但前端没拉。

补齐：

| 新增端点 | 用途 |
|---|---|
| `GET /students/:id/papers` | 试卷存档库列表（含五维错因分布、知识点、错题数） |
| `GET /students/:id/papers/:paperId` | 单份试卷详情（含关联错题明细） |
| `GET /students/:id/exams` | 考试场次列表（存档库场次回填、报告页筛选） |

前端水合从 5 类扩到 7 类数据。

### 验收用例测试（13 例）

`packages/server/tests/acceptance.test.ts` 逐条对齐产品文档：

| 用例 | 断言要点 |
|---|---|
| TC-01 | 诊断产出错题记录并关联知识点；每条结论带证据与验证方式 |
| TC-02 | 调整每日时长后每日排期严格 ≤ 新预算 |
| TC-03 | 教练返回结构完整（教学行为受控、阶段 0-4、快捷回复） |
| TC-04 | 变式通过 → 掌握；关联错题可闭环 |
| TC-05 | 连续两次错误 → 回退待学习（降阶保护）；计划带降阶标记 |
| TC-06 | 三层指标齐备：作答流水 / 掌握度+迁移轨迹 / 历次成绩 |
| TC-07 | 错因五维受控、订正状态受控、订正心得可记录 |
| TC-08 | 存档库留存元信息+错因分布+知识点；详情含错题明细 |
| TC-09 | 错题带 `examPaperId` → 思维导图可按卷筛选问题点 |

### 修复任务端点鉴权漏洞（安全）

写验收测试时发现：**任务路由完全没挂认证中间件**。

```ts
// 修复前
const jobRouter = express.Router();
jobRouter.use(createJobRoutes(container));   // ← 无 requireAuth
```

后果：任何未认证的调用方只要知道 `jobId`，就能读到任务输出——
而诊断任务的输出**包含学生的错题、失分与诊断结论**。

修复：

| 层面 | 措施 |
|---|---|
| 路由 | `jobRouter` 挂 `requireAuth`（生产模式强制） |
| 归属 | 任务的 `input.studentId` 决定归属，越权返回 403 |
| 角色 | 老师可访问全部任务 |
| 列表 | `GET /jobs` 只返回调用者可访问的任务 |
| SSE | 同样要求认证（前端用 fetch+ReadableStream 正是为了带 Authorization 头） |

回归测试 `tests/job-auth.test.ts`（7 例）覆盖：
无令牌 401、他人令牌 403 且**响应体不含任务输出**、本人可访问、
老师可访问、列表隔离、SSE 需认证、越权取消被拒。

---

## Phase 8 — 水合流程解耦与前端逻辑补测

### 修复：水合被空列表提前中断

Phase 7 把水合扩到 7 类数据后，试卷存档库（TC-08）**仍然显示为空**。

根因在 `web/src/store/hydrate.ts`：

```ts
const records = errors.records ?? [];
if (records.length === 0) return;   // ← 退出的是整个水合 IIFE
```

水合是**一个** async IIFE 里顺序执行的 7 段：

```
掌握度 → 掌握度历史 → 错题记录 → 作答流水 → 考试场次 → 试卷存档库 → 考试成绩
                              ↑ 这个 return
```

这个 `return` 退出整个函数，而非「跳过当前这段」。
于是**只要学生没有错题记录，后 4 类数据全都不会加载** ——
包括 Phase 7 刚补的试卷存档库。

| | 修复前 | 修复后 |
|---|---|---|
| 错题为空 | 存档库/成绩/场次/流水 **全部不加载** | 全部正常加载 |
| 语义 | 「空列表」被当成「跳过」 | 空列表是**有效状态**（"没有错题"），照常写回 |

### 水合逻辑解耦

抽出 `web/src/store/hydration-core.ts`（与 React 无关），
`hydrate.ts` 退化为只管生命周期与取消的薄壳。
核心逻辑从「嵌在 useEffect 里的一百多行」变成可独立测试的函数。

### 前端逻辑补测

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `web/tests/hydration.test.ts` | 7 | 7 类数据加载、**空列表不中断后续**、单类失败隔离、全部失败保留骨架、掌握度合并语义、取消处理 |
| `web/tests/sse-frame.test.ts` | 21 | 5 种事件类型、帧边界（心跳/多行 data/非法 JSON）、字段缺失兜底、缺回调不抛错 |
| `web/tests/api-client.test.ts` | 24 | 令牌注入、错误码透出、重试策略、超时、401 事件 |
| `web/tests/local-state.test.ts` | 13 | 遗留数据清理、骨架构造、UI 偏好 |

SSE 帧解析此前完全不可测（`handleFrame` 未导出）——
而出错时的症状是「进度条不动」或「诊断结果丢失」，
没有报错、没有日志，是全项目最难定位的代码之一。

### 顺带清理：一处不可达分支

```ts
if (line.startsWith(':')) continue;   // 注释/心跳
```

解析器只认以 `event:` / `data:` **开头**的行，而注释行以 `:` 开头 ——
该判断在当前实现下**永远不会为真**。留着它会让人误以为
「注释是被显式处理的」，实际并非如此。已移除，
并用行为测试（注释行不产生事件）锁住真实语义。

### 降级计划的学科硬编码

`plan-fallback.ts` 的提分机会构造里留着一段恒真三元：

```ts
subject: state.exams.length >= 0 ? ('数学' as Subject) : ('数学' as Subject),
knowledgeName: knowledgeId,
```

等价于硬编码 `subject: '数学'`。影响：降级路径下
**英语/物理/化学学生会看到一屏「数学」任务**，知识点名称还是 id。

知识体系资产客户端本来就有（`useCurriculum()` 的 knowledgeMap），
服务端也从同一来源取 `kp.subject` / `kp.name` ——
降级路径只是没接上。已接入；**优先级公式仍保持简化**
（服务端有前置依赖/紧急度/复测等修正因子，那是权威逻辑，不在降级侧复制）。

### 中考倒计时差一天（时区）

```ts
const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()); // 本地零点
const target = new Date(targetExamDate);                                // UTC 零点！
```

`new Date('2027-06-20')` 按 **UTC 零点**解析，「今天」按**本地零点**计算。
在上海（UTC+8）两者差 8 小时，`Math.ceil` 多算一天。

| 目标日期 | 正确 | 修复前 |
|---|---|---|
| 明天 | 1 | **2** |
| 后天 | 2 | **3** |
| 跨月（12-17） | 30 | **31** |
| 跨年（2027-06-20） | 215 | **216** |

学生每天在首页看到的「距离中考还有 N 天」**一直多一天**——
而本项目的主要使用地恰好是 UTC+8。

修复：目标日期按**本地日历日**解析（`YYYY-MM-DD` 用正则拆年月日），
非该格式时回退原行为。前后端两处重复实现同步修复。

### 生产模式的演示凭证回落（安全）

`resolveCredentialStore` 原先在生产模式下**逐个 secret 回落**：

```ts
const found = await fileStore.findBySecret(secret);
return found ?? (await fallback.findBySecret(secret));   // fallback 含 PIN 1234
```

于是**只要凭证文件存在且内容不同，内置演示 PIN `1234` 依然能登录** ——
在生产环境留了一个公开的默认口令。

注释的原意是「文件缺失时回落（便于首次部署）」，
但实现变成了「按 secret 回落」——**范围被放大了**。

修复为**整体回落**：

| 情形 | 演示 PIN `1234` |
|---|---|
| 凭证文件存在且非空 | ❌ 不可用 |
| 凭证文件缺失或为空 | ✅ 可用（首次部署引导） |

### 知识体系资产的容错与完整性

`readActiveCurriculumFile` 原先在循环里直接 `JSON.parse`，
知识体系目录里只要有**一个** JSON 损坏，整个知识体系接口就 500 ——
而知识体系是服务端唯一事实源，所有功能都依赖它。

修复：损坏的文件被**跳过**（并记日志），只有全部损坏才明确报错
（静默返回空会让前端展示空白却毫无线索）。
同时把「选哪个文件」的逻辑抽成纯函数 `selectCurriculumFile` 以便单测。

资产 JSON 一旦损坏，影响是全局且**隐式**的：

| 损坏形态 | 后果 |
|---|---|
| 悬空的前置引用 | 提分优先级算错（前置阻塞判定失效） |
| 重复 id | knowledgeMap 静默覆盖，知识点张冠李戴 |
| subject 不在列表内 | 前端按学科筛选漏掉该学科 |
| 题库指向不存在的知识点 | 取题永远落空 |

这些都不抛异常，只让数据悄悄变得不对 ——
所以 `curriculum-assets.test.ts`（26 例）把资产钉住。

### 提示词注册表测试

提示词版本化是**可追溯性**的基石：诊断结果记录 promptVersion，
使得「上周和本周诊断结果为何变化」能被回答。
版本号一旦错乱，历史结果就再也解释不清。

`prompt-registry.test.ts`（40 例）覆盖版本映射、知识本体摘要、
6 类提示词的构造（含 errorType 5 类与契约一致、苏格拉底 5 阶段、
微测最多 3 题、原错题必须变式不得照抄等）。

### 配置写错会静默失效

配置是全服务的开关来源，其中两项直接决定安全性。

**NaN 让护栏消失**：

```ts
dailyTokenQuota: Number(process.env.DAILY_TOKEN_QUOTA ?? 0)
```

`DAILY_TOKEN_QUOTA=abc` → `NaN`。而 `NaN <= 0` 为 false（不走「不限制」分支），
`used >= NaN` 恒为 false → **配额检查永远放行，成本护栏直接消失**。
`PORT=abc` 同理会让 `listen(NaN)` 行为不可预期。

**强制认证缺密钥**：

`AUTH_REQUIRED=true` 而 `AUTH_SECRET` 为空时，`authRequired` 仍为 true，
但 TokenService 回落到**源码里写死的开发密钥**（`container.ts`）。
结果是「要求登录」却用**公开的密钥**签发令牌 ——
任何人读一下源码就能伪造 `role: teacher` 的合法令牌。
强制认证反而比不登录更危险，因为它给人「已经受保护」的错觉。

修复：

| 项 | 修复前 | 修复后 |
|---|---|---|
| 数值配置 | 非法值 → `NaN` | 回落默认值 + 告警 |
| 布尔配置 | 仅 `'true'` 有效 | 接受 true/1/yes/on |
| 强制认证 | 可无密钥强制 | 无密钥时回退为不强制 + 错误日志 |

### 日志保留字段不被覆盖

```ts
const entry = { ts, level, message, ...(context ?? {}) };   // ← 上下文后展开
```

调用方传入的 `message` / `level` / `ts` 会覆盖日志自身字段。
`error-handler.ts` 就是活实例：

```ts
logger.error('api.unhandled', { requestId, message, path, stack });
```

`message`（错误正文）把事件名 `api.unhandled` 冲掉了 ——
按事件名聚合日志彻底失效，而「这个学生上周为什么这样诊断」正是靠日志回答的。
`level` 被覆盖还会影响 stderr/stdout 路由与告警规则。

修复：上下文字段先铺开、自身字段后铺开；
上下文中若含保留字段，改名为 `context_message` 等保留 —— 信息不丢。

### 路径穿越：老师可覆盖凭证文件

`FileDatabase.resolvePath` 只保证最终路径**不逃出 dataDir 根**，
但拦不住「逃出预期子目录」—— 而 dataDir 内部就放着
`db/credentials.json` 与其它学生的数据文件。

多处路由把 URL 参数直接拼进文件路径。实测（修复前）：

| 攻击 | 结果 |
|---|---|
| 老师 `PUT /students/../credentials/profile` | **200，`db/credentials.json` 被覆盖** |
| 学生 `PUT /coaching/sessions/../../evil` | **200，在 `db/` 根下创建了文件** |

老师角色尤其危险：`assertStudentAccess` 对 teacher 直接放行，
所以穿越串**不需要**在任何人的授权名单里就能生效 ——
「老师可访问全部学生」被当成了「老师可写任意路径」。

修复：在 `FileDatabase` 增加 `sanitizeSegment()`
（只保留 `[a-zA-Z0-9_-]`，其余替换为 `_`，限长 64），
应用到所有拼接用户输入的路径：

| 路由 | 清洗对象 |
|---|---|
| `coaching.routes.ts` | studentId + knowledgeId |
| `student.routes.ts` | studentId |
| `exam.routes.ts` | exams / papers 的 id |
| `plan.routes.ts` | mastery 的 studentId |

### 限流未按用户隔离

限流器的选项写着 `skipAuthenticated: true`（已认证用户按用户维度），
但限流中间件挂在 `requireAuth` **之前**（登录等公开端点不能要求认证），
此时 `req.auth` 恒为 undefined —— **那个分支从未执行过**。

实测（max=5）：

```
用户A: [200,200,200,200]
用户B: [200,429,429,429]     ← 被用户A挤掉
```

同一局域网 / NAT / 公司出口下的**不同用户互相影响** ——
学校机房、家长手机连同一个 WiFi 都会撞车。

修复：限流器自己解析令牌（`TokenService.resolvePrincipalId`，
做完整签名+过期校验），按主体 ID 分桶；令牌无效则回落到 IP 维度，
**伪造令牌拿不到独立桶**，无法借此绕过限流。

### AI 配额在并发下完全失效

`QuotaService.consume()` 是非原子的「读-判-写」：

```ts
const current = await this.getUsed();    // 读
if (current >= this.limit) return false; // 判
await this.db.write(..., { used: current + 1 }); // 写
```

三步之间有 `await`，并发请求全部读到同一个 `current`，
于是全部通过检查、全部写成 `current + 1`。

实测（限额 5，并发 20）：

```
allowed: 20 / 20      ← 全部放行
recorded used: 1      ← 用量还记错了
```

AI 配额是保护 GEMINI_API_KEY 成本的**最后一道护栏**，
而「并发发请求」正是刷量的典型手法。

修复：按账号串行化整个「读-判-写」
（与 `FileDatabase.withLock` 同款 promise 锁链模式）。
修复后：allowed 5/20，recorded used 5 —— 与限额完全一致。

顺带明确了另一条语义：**失败的 AI 调用也计入配额**。
模型确实被调用了、token 确实花了，退还反而会让「故意触发失败」绕过限制。

### 删除学生 A 会删掉学生 B 的试卷（跨学生数据丢失）

`RetentionService.deleteStudentData` 删除试卷文件时：

```ts
const allFiles = await this.storage.listAll();   // ← 全部学生的文件
for (const relativePath of allFiles) {
  await this.storage.remove(relativePath);        // ← 逐个删除
}
```

`listAll()` 返回 `files/papers/` 下的**所有**文件（所有学生），
于是「删除学生 A」把**学生 B 的试卷也删了**。

实测（两个学生各一份试卷）：

```
BEFORE: [papers/stu-A/p1/file_xxx.jpg, papers/stu-B/p2/file_yyy.jpg]
AFTER : []                                    ← 两个学生的文件都没了
```

跨越学生的数据丢失，**没有任何报错**，接口照样返回 200。
这是数据主体删除权（「删除我的数据」）的实现 —— 用户以为只删自己的，
实际把别人的数据也删了。

修复：按学生过滤（索引优先，路径前缀兜底），
并改用 `removeByFileId` —— 后者会同时清理元数据索引，
而 `remove(relativePath)` 只删文件、留下孤儿索引条目。

### 幂等性在并发下失效

`enqueue` 的「查已存在 → 建任务 → 记映射」三步之间有 `await persist()`，
并发调用同一 idempotencyKey 时**全部**通过存在性检查，各自建出任务。

实测（同一 key 并发 10 次）：

```
unique count: 10   （应为 1）
jobs on disk: 10
```

诊断接口用幂等键防止「客户端重试 → 多次 AI 诊断」，而 AI 诊断是真金白银。
已有的幂等测试是**顺序**调用的，永远发现不了 —— 必须真的并发发起。

修复：按幂等键串行化整个入队流程。

### 前后端路由可达性

分离后前端靠 URL 字符串调后端，两边**没有编译期保证**对得上 ——
契约包只覆盖**类型**，不覆盖「路径是否存在」。

后果：前端调了一个后端没注册的路径 →
- 404，错误信息是「接口不存在: POST /api/v1/xxx」，
  排查时很难立刻联想到「路径写错」还是「路由漏注册」
- 分离前是单体（前后端同进程），路径写错会直接抛错、立刻暴露；
  分离后变成**静默的 404** —— 这类退化恰恰是分离的代价

`route-reachability.test.ts`（43 例）用**真实 HTTP 服务**逐条验证
前端实际使用的 38 条路径确实存在，另含方法不匹配、旧路径已移除两组用例。

**一个关键区分**：404 有两种含义 ——
「**接口不存在**」（路由没注册，要防的）
与「**任务不存在**」（路由在，只是数据没有）。
两者错误消息不同，测试据此区分；否则「资源不存在」会被误判成「路由缺失」，
测试就得靠造数据才能通过，失去意义。

### 上传只校验自报的 mimeType

`FileStorage.save()` 只检查 mimeType 是否在白名单里，而 mimeType 是
**客户端自报的** —— 传 `image/jpeg` 加任意字节就能通过，
于是任意内容都以「图片」的名义落盘并被送给 AI 模型。

诊断接口的内联 base64 路径更糟：mimeType 缺省**一律**当 image/jpeg。

修复：

| 措施 | 说明 |
|---|---|
| `matchesMagicBytes(buffer, mimeType)` | 取文件头与类型签名比对；未登记签名的类型放行（避免误杀） |
| `sniffImageMimeType(buffer)` | 按内容嗅探类型 |
| `save()` | 内容不符直接拒绝，**不落盘** |
| 上传接口 | 声明类型不符 → 400 VALIDATION_FAILED |
| 诊断内联 base64 | **不信任自报类型**，改为嗅探，嗅不出就拒绝 |

> 顺带暴露了一个测试问题：既有测试用 `Buffer.from('任意文本')` 冒充图片，
> 新校验让它们失败 —— 这正是校验生效的证据。
> 新增 `tests/helpers/fake-images.ts` 提供合法的最小图片字节。
> 这些测试此前实际上没在测「文件能不能存」，而是在测「归属/隔离」。

### 备份恢复可把文件写到 dataDir 之外

`restore()` 直接把清单里的路径拼到 dataDir 上：

```ts
const target = path.join(this.dataDir, entry.path);
await fs.copyFile(source, target);   // ← target 可能逃出 dataDir
```

`entry.path` 来自**磁盘上的 manifest.json** ——
清单本身是数据目录里可被篡改的内容（数据损坏、外部同步、恶意替换）。

实测（清单写 `../evil-payload.txt`，且 source 真实存在）：

```
restore: {"restored":1,...}
escaped file exists? true
content: PWNED CONTENT      ← 写到了 dataDir/../ 下
```

修复：新增 `isSafeRelativePath()` —— 拒绝绝对路径、拒绝含 `..` 的路径段
（含 Windows 反斜杠）；`restore()` 跳过并告警，`verify()` 标记为非法。

> **测试要点**：穿越路径的 source 通常不存在，会被「缺失」分支提前跳过 ——
> 那样就**测不出**穿越。所以必须造出真实存在的 source，
> 这说明安全修复的测试要构造**能真正触发漏洞**的输入，
> 而不是碰巧被别的分支挡住的输入。

### 畸形登录会话导致应用白屏

`loadSession` 只校验 `session.token`，而 `App.tsx` 后续直接访问
`session.studentIds[0]`（水合目标计算）。

会话缺 `studentIds` 时抛
`Cannot read properties of undefined (reading '0')` ——
那行在**渲染函数体内** → **整个应用白屏**。

浏览器实测：

```
页面内容长度: 0 (白屏!)
page errors: 1 Cannot read properties of undefined (reading '0')
```

修复两层：`loadSession` 逐字段校验（缺任一项当「没登录」），
`App.tsx` 加可选链兜底。任一生效即可避免白屏。

> 注意：**空 `studentIds` 数组是合法值**（老师角色可访问全部学生），
> 不能当成非法数据拒绝。

### 畸形知识体系快照导致应用白屏

`loadSnapshot` 只校验「是数组且非空」，元素结构完全没校验：

```ts
if (!Array.isArray(parsed.knowledgePoints) || parsed.knowledgePoints.length === 0) {
  return null;
}
return parsed;      // ← 元素可能是 null
```

而 `buildCurriculumData` 里 `kp.id` 被直接访问：

```
TypeError: Cannot read properties of null (reading 'id')
```

**关键在于它发生在哪**：`buildCurriculumData` 是在 React 的
`useState` 初始化器里调用的 —— 初始化器抛错 = **整个应用白屏**，
连错误边界都救不了。

快照的现实来源：写入被中断（超出配额 / 进程被杀）、旧版本应用写的
不同结构、缓存被外部工具改过。

修复：逐条校验元素（必须有 string 类型的 `id` 与 `name`），
畸形元素被**过滤**而非整个丢弃；`buildCurriculumData` 同样兜底
（它在 useState 初始化器里，抛错代价太大）。

原则：**宁可当作没有快照回落到服务端，也不让一个坏缓存拖垮整个应用。**

E2E 补了浏览器级验证 —— 单元测试能证明「不抛错」，
但只有真实浏览器能证明「不白屏」：

```
✗ 畸形快照下应用仍正常渲染（不应白屏） — 页面内容长度 0
```

### AI 端点只校验身份不校验角色
文档「角色与权限」写着 `parent` 是**只读**角色 ——
"可看报告，**不能替孩子提交作答**"。

但 AI 端点的 `guard()` 只有 `requireAuth`（身份）+ `requireQuota`（配额），
**没有角色校验**。`requireAuth` 只回答「你是谁」，不回答「你能做什么」。

于是家长可以调用 `/practice/evaluate` 替孩子提交作答，
拿到判定结果与分步提示：

```
/api/v1/practice/evaluate  => 500 (通过角色检查)
/api/v1/practice/generate  => 500 (通过角色检查)
/api/v1/coach/chat         => 500 (通过角色检查)
```

（500 = 未配 API Key，说明请求已通过角色检查走到了 AI 调用）

双重问题：越过只读边界，且消耗**孩子**的 AI 配额（配额按 principalId 计）。

修复：`guard()` 增加角色限制（默认允许 student + teacher）。
5 个 AI 端点全是**学习动作**，没有一个是「只读看报告」，
家长对它们都无正当需求。

> 注：老师角色仍可写任意学生的数据（文档明确授予「可访问全部学生」）。
> 这与家长的边界不同，是刻意保留的 —— 但也意味着老师能替学生提交作答、
> 影响其掌握度记录，如需收紧应另行设计。

### 文件取用缺归属校验

试卷文件按 `files/papers/{studentId}/` 分目录存储，鉴权**依赖元数据索引**。
但「取文件路径」有两个入口，防护程度曾不一致：

| 入口 | 归属校验 |
|---|---|
| `GET /uploads/papers/:fileId`（下载） | ✅ `meta.studentId !== studentId` → 403 |
| `POST /exams/:id/diagnosis`（诊断引用 fileId） | ❌ **只按 ID 查路径** |

`storage.findById(fileId)` 只按 ID 查路径，**不做归属校验** ——
任何知道 fileId 的人都能拿到别人的试卷图片路径。
而 `storage.canAccess(fileId, studentId)` 一直存在，却**从未被调用**。

后果：学生 A 把学生 B 的 fileId 填进自己的诊断请求，
AI 就会去读 B 的卷子 —— **B 的卷面内容会进入 A 的诊断结果**。

修复：新增 `FileStorage.findByIdForStudent(fileId, studentId)`
（走索引时校验 `studentId`，回退路径匹配时校验目录前缀），
保留 `findById` 供内部管理逻辑使用 ——
关键是**两个方法名字明确**，不靠调用方记得传对参数。

### 归属校验用错了 studentId

`PATCH /papers/:id/confirm-metadata` 的授权用的是**请求体里的** studentId：

```ts
const studentId = String(body.studentId ?? '');
assertStudentWriteAccess(req, studentId);   // ← 调用方自述，随便填
const existing = await db.read(entityPath(PAPERS_DIR, req.params.id));
await db.write([...PAPERS_DIR, `${existing.id}.json`], updated);  // ← 归属从未校验
```

`assertStudentWriteAccess` 只回答「调用方能否写 studentId」，
与「这张卷属于谁」是两个问题。

攻击：学生 A 填自己的 studentId、却打到学生 B 的试卷上：

```
status: 200
confirmedMetadata: {"subject":"英语","examTitle":"被篡改",...}
```

可改掉他人试卷的学科、考试名、分数、日期 —— 影响诊断结论与提分分析。

**根因**：`ExamPaper` 契约里**没有 studentId 字段**，
新建试卷时根本没记录归属 —— 想校验也无从校验起。

修复：契约新增可选 `studentId` → 新建时持久化 →
修改时按**试卷的实际归属**校验（老数据回落到请求体的 studentId）。

### 并发作答丢失掌握度记录

掌握度作答的「读聚合 → 改记录 → 写回」三步之间有 `await`，
并发请求各自读到**同一个旧聚合**，各自写回自己的版本。

实测（5 个并发作答，5 个不同知识点）：

```
statuses: [200,200,200,200,200]      ← 全部「成功」
records in mastery: 1                 ← 只剩 kp-4
```

4 个知识点的学习记录被**静默丢弃**。
掌握度是提分优先级与学习计划的基础 ——
记录丢了，优先级排序就基于错误的证据做决策。

修复：`FileDatabase.withExclusive(key, fn)` 按**逻辑键**串行化整段临界区
（与文件锁不同：文件锁只保证单次写不交错，组合操作整体仍会互相覆盖）。

### 前端逻辑补测汇总

| 文件 | 例数 | 覆盖 |
|---|---|---|
| `web/tests/hydration.test.ts` | 7 | 7 类数据加载、**空列表不中断后续**、单类失败隔离、全部失败保留骨架、掌握度合并语义、取消处理 |
| `web/tests/sse-frame.test.ts` | 21 | 5 种事件类型、帧边界（心跳/多行 data/非法 JSON）、字段缺失兜底、缺回调不抛错 |
| `web/tests/auth-store.test.ts` | 12 | 会话读写、独立 token 键、过期判定（含边界）、过期即清除、存储异常容错 |
| `web/tests/curriculum-cache.test.ts` | 9 | 快照读写、空列表视为无快照、非法内容返回 null、knowledgeMap 索引构建 |
| `web/tests/plan-fallback.test.ts` | 21 | 有效时长预算（与服务端逐条对齐）、7 天日程、每日总时长 ≤ 预算、**展示字段取自知识体系**、步骤拆分 |
| `web/tests/countdown.test.ts` | 8 | 中考倒计时时区正确性 |
| `web/tests/api-client.test.ts` | 24 | 令牌注入、错误码透出、重试策略、超时、401 事件 |
| `web/tests/local-state.test.ts` | 13 | 遗留数据清理、骨架构造、UI 偏好 |

---

## Phase 10 — 设计与实现差距的关闭

> 触发来源：`docs/DESIGN_IMPLEMENTATION_GAP_ANALYSIS.md`
>
> 前面各 Phase 记录的是「**分离重构**」的落地情况。
> Phase 10 处理的是另一类问题：**架构分离做完了，但产品闭环有断链** ——
> 即「接口存在 / 组件存在」被当成了「功能可用」。

### 为什么要有这一 Phase

原文档把 60 个 Phase 全标为 ✅，并记录「579/579 测试通过、24/24 E2E 断言通过、
5 个页面渲染零错误」。逐条核对规格后发现：

| 类别 | 判断 |
|---|---|
| 架构重构类 Phase（1、4、5、8 的安全修复） | ✅ 属实，质量高 |
| 功能闭环类 Phase（7a~7c、4e、6f） | ⚠️ **接口齐备 ≠ 功能可用** |

核查发现的 5 个 P0 与 7 个 P1 **全部是在「测试全绿」的前提下存在的** ——
这本身说明测试有效性本身是缺口，而不只是实现缺口。

### 关闭的 P0

| # | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| P0-1 | 诊断失分不写服务端 `MasteryRecord` | 诊断→提分闭环在服务端断开；前端推导的掌握度刷新即丢；**违反契约「前端不得本地推导」** | 新增 `modules/mastery/mastery-service.ts` 统一读写；诊断落库时更新掌握度与迁移事件；前端改为乐观更新 + 服务端权威覆盖 |
| P0-2 | `ExamResult` 无实体持久化，`targetScore` 被抄成 `score` | 「距离目标分差值」恒为 0；成绩刷新即丢 | 新增 `db/exam-results` 存储 + `POST /students/:id/exam-results`；读时合并显式录入与试卷派生两条路径 |
| P0-3 | 示例卷从未进入上传链路 | TC-01 必然被服务端 `VALIDATION_FAILED` 拒绝 | 示例图读成 data URL 放进 `uploadedImages`，与用户上传同构；加载中/失败给明确提示 |
| P0-4 | 前端零调用 `PUT /profile` 与 `POST /plans` | TC-02「调整后立即缩减」不成立 | 落库档案 + 重新生成计划；滑块 400ms 防抖 |
| P0-5 | 30/35 分钟档位每日排期超支（实测 7/7 天） | 违反 §7.1「预算满足率 100%」 | 改为预算感知的整体分配（按比例 → 等比缩放 → 减任务） |

### 关闭的 P1

| # | 缺陷 | 修复 |
|---|---|---|
| P1-1 | 先修锁定漏判「未诊断」（`preRec &&` 短路） | 无 MasteryRecord 即视为未诊断，前置锁定不再在初始状态下失效 |
| P1-2 | 多模态（图片）诊断路径绕过 schema 校验 | 复用 `validateAgainstSchema` 并重试；schema 新增 enum 支持，五维错因/置信度/教学行为服务端强制 |
| P1-3 | `LearningAttempt` 运行时丢 4 个字段 | 写入并接收 `questionStem`/`userAnswer`/`aiFeedback`/`taskId` |
| P1-4 | `QuestionKnowledge` 是零使用方空壳 | 见「保留的技术债」 |
| P1-5 | 思维导图子技能归因靠关键词硬匹配 | 见「保留的技术债」 |
| P1-6 | 微测置信度硬编码「确定」 | 按证据强度分级：答错→待验证、有提示→较可能、独立→确定 |
| P1-7 | 错题「待复测」无写入路径 | 订正后进入待复测，复测通过才闭环；服务端补状态白名单 |

### 顺带修复

| 项 | 问题 |
|---|---|
| `curriculum.ts` 资产目录解析 | `DATA_DIR` 缺 `knowledge/` 时 `ENOENT`（临时数据目录下连 seed 都跑不起来）→ 回落到打包目录 |
| `curriculum-assets.test.ts` 版本断言 | 「只有一个资产文件」是多版本机制下的代理断言 → 改为「生效版本对应 ACTIVE 文件」 |

### 验收准则的修正（关键）

原验收测试 TC-01~TC-09 **全部直调服务端 API**，绕过前端接缝；
原 E2E **从未点击**诊断按钮、规划页滑块、成绩录入。
于是 P0-1~P0-4 一个都不会被捕获。

**新增强制准则**：

> 每个 TC 用例必须有一条**从 UI 操作出发**的浏览器级断言，
> 且断言「**用户可见的结果**」而非「API 返回值」。
> 服务端单元测试通过**不构成**该用例通过。

新增 `tests/e2e/gap-user-paths.mjs` 落实该准则：

| 用例 | 浏览器级判据 |
|---|---|
| TC-02 | 拖动时长滑块后，页面「实际排期 X 分钟」**立即缩减**；且服务端收到 `PUT /profile` 与 `POST /plans` |
| TC-01 | 点「载入数学图片示例卷」→ 点「启动 AI 试卷诊断」→ **不得**出现「请提供试卷图片」；且确有 `POST /uploads/papers` 成功 |
| P0-2 | 录入成绩后可读回，且 `targetScore` 独立于 `score` |

### Phase 10 验证结果

```
类型检查   contracts ✓ server ✓  web ✓
测试       466/466 通过（server，含 18 例差距回归）
           130/130 通过（web）
            41/41  通过（contracts）
E2E        46/46 断言通过（原 24 + 新增 22 条用户路径）
前端构建   ✓
```

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
| `QuestionKnowledge` 是零使用方空壳（规格 §四 13 实体之一） | 题目↔知识点多对多的 `weight` 丢失；`LostScore` 无按权重分摊机制。当前用 `Question.knowledgeIds: string[]` 近似 | 知识资产扩容后引入真实多对多关系 |
| 思维导图子技能归因靠关键词硬匹配（`SUBSKILL_ALIAS_MAP`） | TC-09 的**结构与四态达标**，但归因准确性靠模糊字符串启发式，可能误判/漏判 | 落库「失分题 ↔ 子技能」显式映射后改为证据绑定 |
| 旧路径兼容层（`/api/diagnose-paper` 等） | 无 | 前端全量切换稳定一个发布周期后删除 |
| `scripts/extract-*.mjs` 迁移脚本 | 无 | 迁移确认无误后删除 |
| 前端 `shanghai_ai_score_os_v5` localStorage key | 仍存旧演示数据 | 首次访问时清理 |
| `plan-fallback.ts` 展示降级 | 服务端不可用时用本地估算 | 保留（离线兜底有价值），但确保不参与任何写操作 |
