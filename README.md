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
# 1. 安装依赖（npm workspaces）
npm install --legacy-peer-deps

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入 GEMINI_API_KEY（AI 功能必需，其余功能无需）

# 3. 播种演示数据（服务端存储）
npm run seed --workspace=@daydayup/server

# 4. 启动（两个独立进程）
npm run dev:server    # 后端 → http://localhost:3000
npm run dev:web       # 前端 → http://localhost:5173
```

前端开发服务器已配置 `/api` 代理，自动转发到后端 3000 端口。

---

## npm scripts

| 命令 | 说明 |
|---|---|
| `npm run dev:server` | 启动后端（tsx watch，热重载） |
| `npm run dev:web` | 启动前端（Vite dev server） |
| `npm run dev` | 等同 `dev:server` |
| `npm run build` | 构建前端产物到 `web/dist` |
| `npm run typecheck` | 全包类型检查 |
| `npm run lint` | 全包 lint |
| `npm test --workspace=@daydayup/server` | 领域引擎测试（node:test） |
| `npm run seed --workspace=@daydayup/server` | 播种演示数据 |

---

## 架构边界（硬约束）

| 规则 | 检查方式 |
|---|---|
| 后端**禁止** import `web/` | `grep -rn "web/" packages/server/src` |
| 前端**禁止** import `packages/server` | `grep -rn "packages/server" web/src` |
| 契约包**禁止**包含业务逻辑 | 仅 `domain/` + `api/` 类型与校验函数 |
| 业务算法**只在服务端** | `packages/server/src/engines/` |

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

两者均为**纯函数**（无 IO、时钟由参数显式传入），用 `node:test` 覆盖 18 个用例：

```
TC08 每日学习时长硬约束（≤60 分钟、≤3 任务）
TC07 提分优先级可复现
TC11 掌握度状态机（含 3 天延迟复测锁定）
TC06 多知识点失分不重复计算
```

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
| GET | `/health` | 健康检查 |
| GET | `/knowledge-points?subject=` | 知识体系（服务端资产，带版本号） |
| GET | `/students/:id` | 学生档案 |
| PUT | `/students/:id/profile` | 更新档案 |
| GET | `/students/:id/effective-budget` | **服务端权威**每日预算 |
| GET | `/students/:id/mastery` | 掌握度列表 |
| GET | `/students/:id/mastery/:kid/retest-status` | 延迟复测状态（服务端时钟） |
| POST | `/students/:id/mastery/:kid/attempt` | 提交作答 → 权威状态迁移 |
| GET | `/students/:id/opportunities` | 提分机会 |
| GET | `/students/:id/plans/current` | 当前 7 天计划 |
| POST | `/students/:id/plans` | 重新生成计划 |
| PATCH | `/plans/:studentId/tasks/:taskId` | 更新任务状态与进度 |
| POST | `/diagnose-paper` | 试卷诊断（多模态 + 结构化输出） |
| POST | `/coach/chat` | AI 教练对话 |
| POST | `/practice/generate` | 练习题生成 + **双轮独立验算** |
| POST | `/practice/evaluate` | 作答评测 |
| POST | `/diagnose-microquiz` | 诊断微测 |

旧路径（`/api/diagnose-paper` 等）保留一个发布周期作为兼容层，
前端全量切换后可删除。

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
└── db/
    ├── students/{id}.json
    ├── exams/{id}.json
    ├── papers/{id}.json
    ├── error-records/{studentId}/{id}.json
    ├── mastery/{studentId}.json             掌握度 + 迁移历史
    ├── plans/{studentId}/{planId}.json
    └── attempts/{studentId}/{yyyy-MM}.jsonl  作答流水（事件日志）
```

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
| `DAILY_TOKEN_QUOTA` | 0 | AI 每日配额（0 = 不限制） |
| `VITE_API_PROXY` | `http://localhost:3000` | 前端 dev proxy 目标 |
| `VITE_API_BASE` | 空 | 前端生产环境 API 基础路径 |
