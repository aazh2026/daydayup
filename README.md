# daydayup · 上海中考 AI 提分系统

前后端分离的 Node.js + TypeScript 应用。

```
daydayup/
├── packages/
│   ├── contracts/     前后端共享契约（仅类型 + 纯校验，零业务逻辑）
│   └── server/        后端服务（Express + 领域引擎 + 文件持久化）
├── web/               前端 SPA（React + Vite）
├── docs/              设计文档
└── scripts/           一次性迁移脚本
```

---

## 快速开始

```bash
# 一条命令启动前后端
npm start
```

脚本会自动完成：

- 检查 Node 版本与依赖（缺失则自动安装）
- `.env` 不存在时从 `.env.example` 生成
- 首次启动自动播种演示数据
- 端口占用检测
- 统一彩色输出，Ctrl+C 同时停止两端

```
前端    http://localhost:5173
后端    http://localhost:3000/api/v1/health
```

### 启动选项

```bash
npm start                    # 前后端（开发模式，Vite HMR）
npm start -- --no-web        # 仅后端
npm start -- --no-srv        # 仅前端
npm start -- --seed          # 先播种演示数据
npm start -- --port 4000     # 指定后端端口
npm start -- --build         # 先构建前端产物
npm start -- --prod          # 生产模式：免编译 + 单端口托管前后端
```

### 手动启动（不想用脚本时）

```bash
npm install --legacy-peer-deps
cp .env.example .env        # 填入 GEMINI_API_KEY（AI 功能必需）
npm run seed --workspace=@daydayup/server

npm run dev:server    # 后端 → http://localhost:3000
npm run dev:web       # 前端 → http://localhost:5173
```

前端开发服务器已配置 `/api` 代理，自动转发到后端 3000 端口。

### AI 功能

未配置 `GEMINI_API_KEY` 时，脚本会提示 AI 功能不可用，**其余功能正常**
（计划生成、掌握度计算、报告、题库等均不依赖模型）。

配置后编辑 `.env`：

```bash
GEMINI_API_KEY="你的密钥"
```

---

## 生产部署

```bash
# Docker（推荐）
cp .env.example .env   # 填入 GEMINI_API_KEY 与 AUTH_SECRET
docker compose up -d

# 或无 Docker（需 Node 24+，服务端免编译）
npm ci --legacy-peer-deps
npm run build --workspace=@daydayup/web
node --experimental-strip-types packages/server/src/main.ts
```

完整部署说明见 [`docs/deployment.md`](docs/deployment.md)。

---

## npm scripts

| 命令 | 说明 |
|---|---|
| `npm start` | **一键启动前后端**（见上文） |
| `npm run dev:server` | 启动后端（tsx watch，热重载） |
| `npm run dev:web` | 启动前端（Vite dev server） |
| `npm run dev` | 等同 `npm start` |
| `npm run build` | 构建前端产物到 `web/dist` |
| `npm run typecheck` | 全包类型检查 |
| `npm run lint` | 全包 lint |
| `npm test --workspace=@daydayup/server` | 领域引擎测试（node:test） |
| `npm run seed --workspace=@daydayup/server` | 播种演示数据 |
| `npm run backup --workspace=@daydayup/server` | 创建备份（自动验证） |
| `npm run restore --workspace=@daydayup/server -- --name <名>` | 从备份恢复 |
| `npm run cleanup --workspace=@daydayup/server` | 清理过期数据 |
| `npm run test:e2e` | 教师工作台 E2E（需 `npx playwright install chromium`） |

---

## 架构边界（硬约束）

| 规则 | 检查方式 |
|---|---|
| 后端**禁止** import `web/` | `grep -rn "web/" packages/server/src` |
| 前端**禁止** import `packages/server` | `grep -rn "packages/server" web/src` |
| 契约包**禁止**包含业务逻辑 | 仅 `domain/` + `api/` 类型与校验函数 |
| 业务算法**只在服务端** | `packages/server/src/engines/` |

### 浏览器本地存储的边界

| 数据 | 保留 | 理由 |
|---|---|---|
| 访问令牌 | ✅ | 必须本地持有才能发请求 |
| UI 偏好 | ✅ | 纯客户端状态 |
| 知识体系只读快照 | ✅ | 减少请求，支持离线浏览 |
| 掌握度 / 错题 / 计划 / 会话 / 成绩 | ❌ | **服务端是唯一真相源**，一律水合填充 |

分离前前端把完整 AppState（约 20KB）写 localStorage，每次状态变化全量重写。

### 为什么契约包不放引擎

契约包只承载**类型**与**纯校验函数**。提分算法、计划生成、掌握度状态机
全部在服务端 `packages/server/src/engines/`。

原因：这是面向未成年学生的教育产品，掌握度、提分优先级、每日学习时长
约束都是**不能被学生篡改**的数据。放在前端等于把评分逻辑交给学生自己改 JS。

前端仅在服务端不可用时使用 `web/src/engine/plan-fallback.ts` 做**展示降级**，
该模块不参与任何评分、落库或状态迁移。

---

## 领域引擎（服务端权威）

| 引擎 | 文件 | 职责 |
|---|---|---|
| PlanningEngine | `packages/server/src/engines/planning-engine.ts` | 7 天计划、时间预算、提分优先级 |
| MasteryEngine | `packages/server/src/engines/mastery-engine.ts` | 掌握度状态机迁移 |

两者均为**纯函数**（无 IO、时钟由参数显式传入）。测试共 **43 个用例**：

```
单元测试（18）  TC08 每日学习时长硬约束 / TC07 优先级可复现
                TC11 掌握度状态机（含 3 天延迟复测锁定）/ TC06 失分不重复
鉴权测试（10）  Token 签发校验 / payload 篡改防护 / 过期失效
                配额上限 / 账号隔离 / 用量持久化
集成测试（15）  真实 HTTP + 真实文件存储：
                认证 / 资源级隔离（403）/ 知识体系前置引用完整性
                服务端权威计划与掌握度迁移 / 错题落库 / 事件日志
```

> 集成测试发现并修复了一个真实缺陷：`FileDatabase.read()` 未兼容
> `list()` 返回的带 `.json` 后缀文件名，导致**所有列表接口静默返回空**。

---

## 异步任务（Job Engine）

试卷诊断等耗时操作改为异步：提交 → 拿 jobId → 订阅 SSE 进度。

```
POST /api/v1/uploads/papers          上传试卷图片 → fileId
POST /api/v1/exams/:id/diagnosis     创建诊断任务 → jobId（幂等）
GET  /api/v1/jobs/:id/events         SSE 进度推送
GET  /api/v1/exams/:id/diagnosis/:jobId  轮询降级路径
```

| 能力 | 实现 |
|---|---|
| 持久化 | 任务写入 `data/db/jobs/`，重启后可恢复 |
| 幂等 | 相同 `idempotencyKey` 返回同一任务 ID |
| 重试 | 失败按指数退避重试（默认 3 次） |
| 租约 | 进程崩溃后任务不会永久卡在 RUNNING，启动时自动重新入队 |
| 取消 | 长任务在检查点响应取消信号 |
| 并发 | 默认 2 个任务并发（`JOB_CONCURRENCY` 可调） |
| 优雅退出 | SIGTERM 时等待进行中任务完成 |

SSE 用 `node:http` 原生实现，保持零第三方依赖。

---

## 数据合规与运维

### 数据保留与删除

| 命令 | 说明 |
|---|---|
| `npm run cleanup --workspace=@daydayup/server` | 清理过期数据 |
| `npm run test:e2e` | 教师工作台 E2E（需 `npx playwright install chromium`） |
| `DELETE /api/v1/admin/students/:id/data` | 删除某学生全部数据（数据主体删除权） |

保留期可通过环境变量配置（事件日志 180 天、作答流水 365 天、
完成任务 30 天、上传文件 180 天、审计日志 730 天）。

删除操作写入**审计日志**（`data/audit/`）并保留，满足可追溯要求。

### 备份与恢复

| 命令 | 说明 |
|---|---|
| `npm run backup --workspace=@daydayup/server` | 创建备份（自动验证可恢复性） |
| `npm run backup --workspace=@daydayup/server -- --list` | 列出备份 |
| `npm run backup --workspace=@daydayup/server -- --verify` | 验证全部备份 |
| `npm run restore --workspace=@daydayup/server -- --name <名> --dry-run` | 试运行恢复 |
| `npm run restore --workspace=@daydayup/server -- --name <名>` | 实际恢复 |

备份含每个文件的 SHA-256 校验和，恢复前可验证完整性。

---

## API

基础路径 `/api/v1`。成功返回裸对象；失败返回统一结构：

```json
{
  "error": { "code": "NOT_FOUND", "message": "学生不存在" },
  "requestId": "req_..."
}
```

错误码：`VALIDATION_FAILED` `UNAUTHORIZED` `FORBIDDEN` `NOT_FOUND` `CONFLICT`
`QUOTA_EXCEEDED` `AI_TIMEOUT` `AI_INVALID_OUTPUT` `INTERNAL_ERROR`

### 主要端点

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/login` | 凭证换令牌 |
| GET | `/auth/me` | 校验当前令牌 |
| GET | `/health` | 健康检查（含 `authRequired`） |
| GET | `/knowledge-points?subject=` | 知识体系（服务端资产，带版本号） |
| GET | `/knowledge-points/tree` | 知识树 |
| GET | `/students/:id` | 学生档案 |
| PUT | `/students/:id/profile` | 更新档案 |
| GET | `/students/:id/effective-budget` | **服务端权威**每日预算 |
| GET | `/students/:id/mastery` | 掌握度列表 |
| GET | `/students/:id/mastery/history` | 状态迁移历史 |
| GET | `/students/:id/mastery/:kid/retest-status` | 延迟复测状态（服务端时钟） |
| POST | `/students/:id/mastery/:kid/attempt` | 提交作答 → 权威状态迁移 |
| GET | `/students/:id/opportunities` | 提分机会 |
| GET | `/students/:id/plans/current` | 当前 7 天计划 |
| POST | `/students/:id/plans` | 重新生成计划 |
| PATCH | `/plans/:studentId/tasks/:taskId` | 更新任务状态与进度 |
| GET | `/students/:id/error-records` | 错题记录列表 |
| GET | `/students/:id/exams` | 考试场次列表 |
| GET | `/students/:id/papers` | 试卷存档库（含五维错因分布） |
| GET | `/students/:id/papers/:paperId` | 单份试卷详情（含错题明细） |
| GET | `/students/:id/attempts` | 作答流水 |
| PATCH | `/error-records/:studentId/:id` | 错题订正 / 闭环 |
| POST | `/exams` | 创建考试 |
| POST | `/exams/:id/papers` | 保存试卷 + 诊断结果落库 |
| PATCH | `/papers/:id/confirm-metadata` | 人工确认 AI 提取的元信息 |
| GET | `/practice/questions?knowledgeId=` | 题库取题（题库优先策略） |
| GET/PUT | `/students/:id/coaching/sessions/:kid` | 教练会话历史 |
| POST | `/diagnose-paper` | 试卷诊断（多模态 + 结构化输出） |
| POST | `/coach/chat` | AI 教练对话 |
| POST | `/practice/generate` | 练习题生成 + **双轮独立验算** |
| POST | `/practice/evaluate` | 作答评测 |
| POST | `/diagnose-microquiz` | 诊断微测 |

旧路径（`/api/diagnose-paper` 等）保留一个发布周期作为兼容层，
前端全量切换后可删除。

---

## 产品验收用例

`docs/PRODUCT_DESIGN_SPEC.md` §八 的 9 条 MVP 验收用例（TC-01~TC-09）
已全部实现并有自动化测试覆盖：

```bash
npm run test --workspace=@daydayup/server -- tests/acceptance.test.ts
```

| 用例 | 场景 | 断言要点 |
|---|---|---|
| TC-01 | 试卷拍照诊断闭环 | 产出错题记录并关联知识点；每条结论带证据 |
| TC-02 | 约束变化触发重排 | 调整时长后每日排期严格 ≤ 新预算 |
| TC-03 | 苏格拉底引导与逃生 | 教学行为受控、阶段 0-4、快捷回复 |
| TC-04 | 变式评测推进状态机 | 变式通过 → 掌握；错题可闭环 |
| TC-05 | 连续失误降阶保护 | 连续两次错误 → 回退待学习 |
| TC-06 | 三层效果报告 | 过程/能力/成绩三层数据齐备 |
| TC-07 | 多维错题整理 | 五维错因、订正状态、订正心得 |
| TC-08 | 自动元信息识别与试卷存档 | 存档库含元信息+错因分布+知识点 |
| TC-09 | 思维导图标记问题点 | 错题带试卷归属 → 按卷高亮 |

---

## 认证与授权

未配置 `AUTH_SECRET` 时进入**开发模式**（不要求认证，仅本地单学生使用）；
配置后强制认证。

```
POST /api/v1/auth/login  { "secret": "1234" }
→ { "token": "eyJ...", "studentIds": ["stu-sh-zhangwei"], "role": "student" }
```

| 角色 | 权限 |
|---|---|
| `student` | 读写自己的学习数据 |
| `parent` | **只读** —— 可看报告，不能替孩子提交作答 |
| `teacher` | 可访问全部学生 |

三层防护：

1. **身份认证** —— HMAC-SHA256 签名令牌，`timingSafeEqual` 防时序攻击，payload 带 `exp`
2. **资源级隔离** —— `AuthContext.studentIds` 决定可访问范围，越权返回 **403**
3. **成本护栏** —— AI 调用按账号计数，超额返回 **429**

演示凭证（开发模式）：学生 PIN `1234`。
生产环境把凭证写入 `data/db/credentials.json`：

```json
[
  {
    "principalId": "parent-001",
    "secret": "家长APIKey",
    "role": "parent",
    "studentIds": ["stu-sh-zhangwei"],
    "displayName": "张伟家长"
  },
  {
    "principalId": "teacher-001",
    "secret": "教师APIKey",
    "role": "teacher",
    "studentIds": [],
    "displayName": "王老师"
  }
]
```

> `teacher` 角色的 `studentIds` 为空表示可访问全部学生。
> 教师登录后顶部导航会出现「教师工作台」，可汇总各学生的掌握概况与优先提分点。

---

## AI 调用层

`packages/server/src/infrastructure/ai/` 收敛了原先散落在 5 处重复的
`generateContent` 调用，补齐：

- **超时控制**（AbortController，默认 120s）
- **指数退避重试**（默认 3 次）
- **响应 schema 二次校验**（Gemini 的 `responseSchema` 是软约束）
- **提示词版本化**（`diagnosis.v1` 等，结果记录 `promptVersion` 可追溯）
- **知识本体摘要缓存**（原本每次请求都重建 589 行字符串）

失败时返回结构化错误（`AI_TIMEOUT` / `AI_INVALID_OUTPUT`），而非笼统 500。

---

## 数据存储

服务端文件型持久化（`packages/server/data/`）：

```
data/
├── knowledge/shanghai-junior-2026.1.json   知识体系资产（版本化）
├── questions/bank.json                      题库
├── seed/demo-student.json                   演示数据
├── db/
│   ├── students/{id}.json
│   ├── exams/{id}.json
│   ├── papers/{id}.json
│   ├── error-records/{studentId}/{id}.json
│   ├── mastery/{studentId}.json             掌握度 + 迁移历史
│   ├── plans/{studentId}/{planId}.json      计划 + 任务状态
│   ├── coaching/{studentId}/{knowledgeId}.json
│   ├── attempts/{studentId}/{yyyy-MM}.jsonl  作答流水
│   ├── quota/{principalId}.json             AI 用量计数
│   └── credentials.json                     凭证（生产模式）
├── events/{yyyy-MM-dd}.jsonl                业务事件日志
└── audit/{yyyy-MM-dd}.jsonl                 审计日志（只追加）
```

上传文件按学生分目录（**存储路径即隔离边界**）：

```
files/papers/{studentId}/{paperId}/{fileId}.jpg
```

访问须经鉴权接口，**不暴露静态目录**；元数据索引（`db/files/`）
记录归属，鉴权不依赖文件名猜测。

写入特性（`FileDatabase`）：
- **原子写入**：临时文件 + rename
- **并发控制**：同文件写操作串行化
- **路径穿越防护**
- 事件日志：先落业务结果，再记事件

---

## 设计文档

| 文档 | 定位 |
|---|---|
| `docs/backend-design.md` | 原始理想设计 |
| `docs/backend-design-optimized.md` | 结合代码现状的优化分析（为什么这么改） |
| `docs/frontend-backend-separation.md` | 前后端分离架构方案（怎么落地） |

---

## 迁移脚本（一次性，迁移完成后可删）

```bash
npx tsx scripts/extract-knowledge.mjs   # 知识本体 + 题库 → JSON 资产
npx tsx scripts/extract-seed.mjs        # 演示数据 → seed JSON
```

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GEMINI_API_KEY` | — | AI 功能必需；缺失时其余接口正常可用 |
| `PORT` | 3000 | 后端端口 |
| `HOST` | 0.0.0.0 | 监听地址 |
| `DATA_DIR` | `packages/server/data` | 数据目录 |
| `LOG_LEVEL` | info | `debug`/`info`/`warn`/`error` |
| `CORS_ORIGINS` | `http://localhost:5173` | 允许的前端来源（逗号分隔） |
| `DAILY_TOKEN_QUOTA` | 0 | AI 每日配额（按调用次数，0 = 不限制） |
| `AUTH_SECRET` | — | 令牌签名密钥；**生产必配**，配了即强制认证 |
| `AUTH_REQUIRED` | 自动 | 显式开关强制认证 |
| `VITE_API_PROXY` | `http://localhost:3000` | 前端 dev proxy 目标 |
| `VITE_API_BASE` | 空 | 前端生产环境 API 基础路径 |
