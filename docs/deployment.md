# 部署指南

前后端分离架构的部署说明。

---

## 架构形态

```
生产环境（推荐：双服务独立部署）
┌──────────────────┐        ┌──────────────────┐
│  前端静态托管      │        │  后端 Node 服务    │
│  nginx / CDN      │───────▶│  Express + 引擎   │
│  web/dist         │  /api  │  :3000            │
└──────────────────┘        └──────────────────┘
                                     │
                              ┌──────▼──────┐
                              │  数据卷       │
                              │  data/       │
                              │  backups/    │
                              └─────────────┘
```

单容器部署也支持（后端一并托管前端产物）：

```
┌────────────────────────────────────┐
│  单一容器                            │
│  Express:3000                      │
│    ├── /api/v1/*  → API            │
│    └── /*        → web/dist 静态文件 │
└────────────────────────────────────┘
```

---

## Docker 部署（推荐）

### 1. 准备环境变量

```bash
cat > .env <<'EOF'
# ---- 必需 ----
GEMINI_API_KEY=your-gemini-key
# 生产环境必须配置，否则任何人都能用默认凭证登录
AUTH_SECRET=$(openssl rand -hex 32)

# ---- 可选 ----
LOG_LEVEL=info
CORS_ORIGINS=https://your-frontend-domain.com
DAILY_TOKEN_QUOTA=100
RATE_LIMIT_PER_MINUTE=120
RATE_LIMIT_AI_PER_MINUTE=10
JOB_CONCURRENCY=2
EOF
```

> ⚠️ **`AUTH_SECRET` 必须配置**。未配置时服务进入开发模式，
> 使用内置演示凭证（学生 PIN `1234`），任何人都能登录。
>
> 配置 `AUTH_SECRET` 后进入生产模式，行为如下：
>
> | 情形 | 演示 PIN `1234` |
> |---|---|
> | `data/db/credentials.json` **存在且非空** | ❌ 不可用（只认文件里的凭证） |
> | `data/db/credentials.json` **缺失或为空** | ✅ 可用（仅作首次部署引导） |
>
> 也就是说：一旦你创建了真实凭证，演示 PIN 立即失效。
> 但在创建之前，公开的默认口令是有效的 —— **请务必在部署后立刻创建凭证**，
> 否则等于留了一个公开后门。

### 2. 启动

```bash
docker compose up -d
```

### 3. 初始化数据

```bash
# 播种演示数据（首次部署）
docker compose exec server node --experimental-strip-types packages/server/scripts/seed.ts

# 创建管理员凭证
docker compose exec server node --experimental-strip-types -e "
import fs from 'node:fs';
import { randomBytes } from 'node:crypto';
const file = 'packages/server/data/db/credentials.json';
const list = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file,'utf8')) : [];
list.push({
  principalId: 'teacher-001',
  secret: randomBytes(24).toString('hex'),
  role: 'teacher',
  studentIds: [],
  displayName: '管理员'
});
fs.writeFileSync(file, JSON.stringify(list, null, 2));
console.log('凭证已创建');
"
```

### 4. 验证

```bash
curl http://localhost:3000/api/v1/health
# {"ok":true,"aiEnabled":true,"authRequired":true,...}
```

---

## 无 Docker 部署

### 要求

- **Node.js 24+**（原生 TypeScript 类型剥离，服务端无需编译）
- npm 10+

### 步骤

```bash
# 1. 安装依赖
npm ci --legacy-peer-deps

# 2. 构建前端
npm run build --workspace=@daydayup/web

# 3. 播种数据（可选）
npm run seed --workspace=@daydayup/server

# 4. 启动
export GEMINI_API_KEY=...
export AUTH_SECRET=...
node --experimental-strip-types packages/server/src/main.ts
```

### 进程管理（systemd）

```ini
# /etc/systemd/system/daydayup.service
[Unit]
Description=Daydayup AI Score OS
After=network.target

[Service]
Type=simple
User=daydayup
WorkingDirectory=/opt/daydayup
EnvironmentFile=/etc/daydayup/env
ExecStart=/usr/bin/node --experimental-strip-types packages/server/src/main.ts
Restart=always
RestartSec=5

# 数据目录权限
ReadWritePaths=/opt/daydayup/packages/server/data /opt/daydayup/packages/server/backups

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now daydayup
```

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `GEMINI_API_KEY` | — | **必需**。AI 能力；缺失时非 AI 接口仍可用 |
| `AUTH_SECRET` | — | **生产必需**。令牌签名密钥；未配置则进入开发模式 |
| `AUTH_REQUIRED` | 自动 | 显式开关强制认证。**但没有 `AUTH_SECRET` 时不会真正强制**（见下） |
| `PORT` | 3000 | 监听端口。**非数字会被忽略并回落 3000**（不会变成 NaN） |
| `HOST` | 0.0.0.0 | 监听地址 |
| `DATA_DIR` | `packages/server/data` | 数据目录 |
| `BACKUP_DIR` | `packages/server/backups` | 备份目录 |

> ⚠️ **`AUTH_REQUIRED=true` 必须同时配置 `AUTH_SECRET`**。
> 没有密钥时服务会**回退为开发模式（不强制认证）**并记录错误日志 ——
> 因为强制认证时令牌必须用密钥签发，若无密钥只能用源码里写死的开发密钥，
> 那样任何人都能伪造合法令牌，「要求登录」反而比不登录更危险。
>
> 同理，`PORT` / `DAILY_TOKEN_QUOTA` 等数值项写错时会**回落默认值并告警**，
> 不会变成 `NaN`（`NaN` 会让配额护栏静默失效 —— 成本保护形同虚设）。
| `STATIC_DIR` | 空 | 设为 `web/dist` 时后端一并托管前端 |
| `LOG_LEVEL` | info | `debug` / `info` / `warn` / `error` |
| `CORS_ORIGINS` | `http://localhost:5173` | 允许的前端来源（逗号分隔） |
| `DAILY_TOKEN_QUOTA` | 0 | AI 每日调用上限（0 = 不限制） |
| `RATE_LIMIT_PER_MINUTE` | 120 | 全局限流（每分钟每用户） |
| `RATE_LIMIT_AI_PER_MINUTE` | 10 | AI 端点限流 |
| `JOB_CONCURRENCY` | 2 | 后台任务并发数 |
| `JOB_TIMEOUT_MS` | 600000 | 单任务超时 |
| `RETENTION_EVENT_LOG_DAYS` | 180 | 事件日志保留期 |
| `RETENTION_ATTEMPT_DAYS` | 365 | 作答流水保留期 |
| `RETENTION_JOB_DAYS` | 30 | 已完成任务保留期 |
| `RETENTION_UPLOAD_DAYS` | 180 | 上传文件保留期 |
| `RETENTION_AUDIT_DAYS` | 730 | 审计日志保留期 |

---

## 角色与凭证

凭证存放在 `data/db/credentials.json`：

```json
[
  {
    "principalId": "stu-001",
    "secret": "1234",
    "role": "student",
    "studentIds": ["stu-sh-zhangwei"],
    "displayName": "张伟"
  },
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

| 角色 | 权限 |
|---|---|
| `student` | 读写自己的学习数据 |
| `parent` | **只读** —— 可看报告，不能替孩子提交作答 |
| `teacher` | 可访问全部学生（`studentIds` 为空表示全部） |

---

## 运维操作

### 备份

```bash
# 创建备份（自动验证可恢复性）
npm run backup --workspace=@daydayup/server

# 列出备份
npm run backup --workspace=@daydayup/server -- --list

# 验证全部备份
npm run backup --workspace=@daydayup/server -- --verify
```

服务启动后也会**每日自动备份**（`daily-backup` 定时任务）。

### 恢复

```bash
# 试运行（只校验，不写入）
npm run restore --workspace=@daydayup/server -- --name <备份名> --dry-run

# 实际恢复
npm run restore --workspace=@daydayup/server -- --name <备份名>
```

### 数据清理

```bash
npm run cleanup --workspace=@daydayup/server
```

服务启动后也会**每日自动清理**（`daily-cleanup` 定时任务）。

### 删除某个学生的全部数据（数据主体删除权）

```bash
curl -X DELETE http://localhost:3000/api/v1/admin/students/stu-001/data \
  -H "Authorization: Bearer $TOKEN"
```

审计记录会保留（满足可追溯要求）。

---

## 监控要点

| 指标 | 位置 |
|---|---|
| 服务健康 | `GET /api/v1/health` |
| 后台任务 | `GET /api/v1/jobs` |
| 审计日志 | `GET /api/v1/admin/audit?date=YYYY-MM-DD` |
| 结构化日志 | stdout（JSON 格式），可直接接入日志采集 |
| AI 用量 | `data/db/quota/{principalId}.json` |

日志为结构化 JSON，便于 Loki / Elasticsearch 等采集：

```json
{"ts":"2026-11-17T00:00:00.000Z","level":"info","message":"mastery.transition","requestId":"req_...","studentId":"stu-001"}
```

---

## 安全清单

上线前逐项确认：

- [ ] `AUTH_SECRET` 已配置（随机 32 字节以上）
- [ ] `GEMINI_API_KEY` 已配置，且未提交到版本库
- [ ] `credentials.json` 中无默认/示例凭证
- [ ] `credentials.json` **已创建且非空** —— 否则演示 PIN `1234` 仍然可用（见上文回落规则）
- [ ] `CORS_ORIGINS` 只包含实际前端域名
- [ ] `DAILY_TOKEN_QUOTA` 已设置（防成本失控）
- [ ] `RATE_LIMIT_AI_PER_MINUTE` 已设置（防刷量）
- [ ] 数据卷已挂载持久化存储
- [ ] 备份已配置（定时任务或外部 cron）
- [ ] 备份已验证可恢复（`--verify`）
- [ ] HTTPS 已启用（令牌不应明文传输）
- [ ] `data/` 目录未暴露为静态目录

---

## 扩容路径

当前为**单实例**设计（进程内限流器、进程内 Job 调度、文件存储）。

需要多实例时：

| 组件 | 替换方案 |
|---|---|
| 文件存储 | → 数据库（`node:sqlite` 或 PostgreSQL） |
| 限流器 | → Redis 共享计数器 |
| Job Engine | → 独立 Worker 进程，或引入 MQ |
| 定时任务 | → 外部 cron（避免多实例重复执行） |
| 会话 | 令牌已无状态，无需处理 |

Repository 抽象已经就位，替换存储实现不需要改业务逻辑。
