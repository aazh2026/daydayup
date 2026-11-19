# 易错（错因）资源集成方案

> 目标：把 `resources/` 下四处分散的易错内容，接进 daydayup 已经空着的
> `commonTraps` / `commonErrors` 两个字段，让它们变成产品能力而不是资料。
>
> 状态：建议稿（2026-11-18）。实施前先确认文末「授权与合规」一节。

---

## 1. 现状：字段已经在，值是空的

| 事实 | 位置 |
|---|---|
| 知识资产已导入 cn-mt：2760 知识点 / 11187 题 | [docs/taxonomy-import.md](taxonomy-import.md) |
| 转换器对 `commonTraps` 直接返回空数组，并写明「不得凭空捏造」 | `packages/server/src/infrastructure/knowledge/converters/taxonomy.ts:359` |
| 转换报告把「commonTraps 全空」列为告警 | `packages/server/src/infrastructure/knowledge/converters/taxonomy.ts:695` |
| 题目 `commonErrors` 同样留空 | `packages/server/src/infrastructure/knowledge/converters/taxonomy.ts:554` |
| 契约字段已定义 | `packages/contracts/src/domain/index.ts:124`（`commonTraps`）、`:142`（`commonErrors`） |
| 消费端已就绪 | `packages/server/src/engines/planning-engine.ts:527` 目标文案取 `commonTraps[0]` |
| 教练 / 练习 prompt 已留通道 | `packages/server/src/infrastructure/ai/prompts/registry.ts:154`、`:195` |
| 前端已展示「避坑点」 | `web/src/components/ErrorsPage.tsx:1136`、`web/src/components/knowledge/KnowledgePointCard.tsx:233`、`web/src/components/knowledge/KnowledgePointDetailModal.tsx:217` |
| `commonErrors` 只在类型里 | 服务端无逻辑消费，全仓 grep 只有类型与转换器 |

结论：**集成成本主要在「匹配与审核」，不在「写字段」**。字段、提示词通道、前端展示位都已就位。

---

## 2. 四处易错资源与可行性

| 资源 | 结构 | 与 daydayup 知识点 id 的关系 | 建议落到 |
|---|---|---|---|
| `junior-math-atlas/content/points/`（83 篇） | 每篇含 `sections.pitfalls`（`wrong`/`why`/`right`）与 `sections.cautions` | **无共同 id**，只有教材册次（人教版 2024 七上…）与主题名 | 初中数学 `commonTraps` |
| `china-skill-taxonomy/`（1273 主题 / 144 课例 / 104 题） | 课例 `courses/*/content.json` 有「最容易错的地方」页；`data/teaching-research.json` 每主题含 `pedagogy` 与 `assess.errors` | 自有 `mt_*` id，与 cn-mt 的 `cnm_*` **不同源但同名覆盖** | 全学科 `commonTraps`；104 题的 `refute` 可作新题 `commonErrors` |
| `cn-math-taxonomy`（已在库） | 4 个易错字知识点；355 道 `advanced` 题的 `explanation` 写明易错原因 | **已有 id**，可直接挂 | `commonTraps` / `commonErrors` |
| `workbuddy-research/上海中考英语完整知识地图.html` | 内嵌 `DATA`，338 条 `mistake` 字段 + 例题/答案 | 独立编码 `01.01.01.01`，需与 cn-mt 英语主题匹配 | 英语 `commonTraps` |
| `China-K12-knowledge-taxonomy`（8669 节点） | 知识点图谱，部分描述含易错字 | 粒度与 cn-mt 不同 | 低优先：只作先修边与覆盖度校验 |

---

## 3. 建议方案：新增独立的「错因资产」层

**不要**把易错内容直接塞进知识资产。四个来源授权不同、粒度不同、匹配置信度不同，
混在一个 JSON 里以后无法单独下架某个来源。

### 3.1 新资产类型 `TrapSet`

新目录 `packages/server/data/traps/`，与 `data/knowledge/`、`data/questions/` 并列：

```jsonc
{
  "version": "shanghai-traps-2026.11",
  "status": "DRAFT",              // 与知识资产同一套 DRAFT → ACTIVE 机制
  "subject": "数学",
  "source": {
    "repo": "junior-math-atlas",
    "path": "resources/junior-math-atlas/content/points",
    "license": "待确认"
  },
  "entries": [
    {
      "id": "trap-m1-00-05-001",
      "knowledgeId": "cnm_165",       // 匹配到的 daydayup 知识点（可空）
      "matchConfidence": "high",      // high | medium | low | unmatched
      "matchMethod": "manual-map",    // manual-map | exact-name | name-contains | none
      "wrong": "计算 -5+3 得 -8。",
      "why": "符号不同却按同号处理，把绝对值直接相加了。",
      "right": "两数异号，符号跟随绝对值较大的 -5 取负，结果是 -2。",
      "stage": "初中"
    }
  ]
}
```

要点：
- `wrong` / `why` / `right` 直接沿用 atlas 的三段式，**不重新改写**，避免失真。
- `knowledgeId` 可空；空的不进知识点，只进「待匹配池」。
- `matchConfidence` 决定能否进入 ACTIVE：`medium` 及以下必须人工确认。

### 3.2 匹配层 `trap-matcher.ts`

三级匹配，逐级降级，成功即停：

| 级别 | 方法 | 说明 |
|---|---|---|
| 1 | `manual-map` | 人工维护 `data/traps/id-map.json`：源 id → cn-mt id。可信度最高 |
| 2 | `exact-name` | 源主题名 == cn-mt 主题名（去空格、统一全半角），再校验学段 |
| 3 | `name-contains` | 一方包含另一方且长度差 < 4 字，记 `medium`，进入待审 |

学段/年级不一致直接判不匹配 —— 初中数学 atlas 的点不能挂到小学同名主题上。

匹配不上的不丢弃，进入 `unmatched` 队列，导出成教师可读的匹配表。

### 3.3 转换与发布

新增 CLI `packages/server/scripts/import-traps.ts`，与 `import-taxonomy.ts` 同构：

```bash
npm run import:traps --workspace=@daydayup/server -- --dry-run
npm run import:traps --workspace=@daydayup/server -- --source=junior-math-atlas
npm run import:traps --workspace=@daydayup/server -- --promote
```

沿用现有安全机制：默认 DRAFT、`--promote` 才发布、旧版本归档、
拒绝覆盖 ACTIVE（除非 `--force`）、悬空外键校验失败即退出码 1。

发布时同时写回：
- `KnowledgePoint.commonTraps` → 形如 `错在哪 → 错因 → 正确做法` 的一行式字符串（数组，每条陷阱一项）
- `Question.commonErrors` → 该题命中陷阱的 `wrong` 描述

### 3.4 审核闭环

最低成本版本（不新增前端页面）：
- `--promote` 前跑 `--report`，输出：匹配率、逐来源命中数、`low`/`unmatched` 明细
- 抽样人工核对：每个来源至少抽 10 条

进阶版本：新增教师端「错因审核」页，复用 `DiagnosisPage` 的
`reviewAction: pending/accepted/fixed/ignored` 人机协同模式，审核结果回写 `id-map.json`。

---

## 4. 分期路线

| 期 | 做什么 | 验收标准 |
|---|---|---|
| **P0** | 建 `TrapSet` 契约 + `import-traps.ts` + 匹配器，先只接 `cn-math-taxonomy` 自带的 4 个易错字主题与 355 道 advanced 题解析 | 4 个知识点 `commonTraps` 非空；转换报告零「全空」告警 |
| **P1** | 接 `junior-math-atlas` 83 篇 pitfalls + `china-skill-taxonomy` 144 课例易错页 | 初中数学知识点 `commonTraps` 覆盖率 ≥ 70%；未匹配项有明细表 |
| **P2** | 接英语知识地图 338 条 `mistake`；`commonErrors` 真正接进练习生成逻辑 | ✅ 错题页「避坑点」显示真实内容（338/338 逐字一致）；✅ 变式题提示词带上陷阱（服务端 `mergeTraps` 兜底） |
| **P3** | 错因结构化：`errorType` 与陷阱关联，统计「哪类陷阱反复错」 | 报告页新增按陷阱类型的错误分布 |

### P1 实测结果（2026-11-19，发布版）

**结论：P1 达标。** 初中数学 315 个知识点的 `commonTraps` 覆盖率有两个口径，都过 70% 线：

| 口径 | 含义 | 数值 | 是否达标 |
|---|---|---|---|
| **运行时 ACTIVE 口径** | `data/traps/` 下 `status=ACTIVE` 的资产实际被加载后，知识点 `commonTraps` 非空的比例 | **233/315 = 74.0%** | ✅ 达标 |
| 候选 DRAFT 口径 | atlas + cst 两个来源**全部**候选（含 `medium`）的去重覆盖率 | 298/315 = 94.6%（其中 high 232/315 = 73.7%） | ✅ 达标 |

运行时口径是**验收口径**（`curriculum.ts` 只加载 ACTIVE，DRAFT 不生效）；
候选口径用于人工审核排期。两者相差 65 个点，全部来自两处：
① `medium` 置信度条目默认不进 ACTIVE（红线：中等置信度必须人工确认）；②
② 早期版本的 ACTIVE 资产（`2026.11`）只覆盖少量点。

> 已用运行时加载路径实测复核：`getCurriculum()` → `applyTrapSets` 后，
> 315 个初中数学点中 **233 个** `commonTraps` 非空，共挂载 **3005** 条陷阱
> （`trap.overlay_applied` 日志：`knowledgeTraps=3005, affected=896`）。

#### 匹配架构的调整：从「条目中心」改成「资产中心」

原 `trap-matcher.ts` 是**条目中心**：每条易错内容自己去找最像的知识点。
实测这条路对 315 个初中数学点只能覆盖 **22 个（7%）** —— 因为 atlas 的
83 篇本身是按教材小节组织的，不是按 cn-mt 的细分知识点组织的。

改成**资产中心**（`trap-evidence.ts`）：每个知识点在「同册同章」的来源主题里
找**证据最强**的那一个，整篇继承该主题的易错条目。

| 证据 | 分数 | 含义 |
|---|---|---|
| `name==title` | 100 | 知识点名 == 来源标题 |
| `name==keyword` | 95 | 知识点名 == 来源关键词 |
| `name-in-title` | 90 | 知识点名短语 ⊂ 来源标题 |
| `name-in-body` | 88 | 知识点名短语出现在来源正文 |
| `term-in-title` | 85 | 知识点词 ⊂ 来源标题 |
| `term-in-body` | 82 | 知识点词出现在来源正文（不在 STOP 词表内） |
| `term==keyword` | 80 | 知识点词 == 来源关键词 |
| `keyword-overlap` | 60+ | 知识点词与关键词部分重叠 |
| `name-token-weak` | 40 | 只命中两字级碎词 |
| `soft-in-item` | 30 | 子技能/定义里的短语出现在某条易错内容里 |

置信度：≥ 80 → `high`（可直接进 ACTIVE），≥ 30 → `medium`（必须人工确认）。

硬门槛（`scopeHit`）：**册次一致 + 章号一致 + 节号前缀相交**
（知识点无节号、或来源侧缺该字段时放行），门槛不过直接不参与打分 ——
宁可漏挂，不挂到别的册次去。

册次冲突（`volumeConflict`）另作处理：来源主题明确属于**别的册次**时，
证据**降级为 `medium` 而不是丢弃**。降级后仍进待审池、可人工确认；
直接丢弃会让覆盖率从 76.5% 掉到 73.7% 以下，且丢掉本可人工确认的条目。

短语抽取（`namePhrases`）只取**完整并列段**（「一元二次方程的解法」保留，
「简便运算」「的计算」这类碎片剔除）；碎片仍走 `nameTerms` 参与
`term-in-title` / `term==keyword` 弱匹配，但不参与 `name-in-body` ——
否则「简便运算」会命中八上「整式的乘法与乘法公式」，制造噪声。

#### 实测数字（2026-11-19 发布版）

| 指标 | 数值 |
|---|---|
| 初中数学知识点总数 | 315 |
| **运行时 ACTIVE `high` 覆盖** | **233（74.0%）** ✅ |
| 候选 DRAFT 覆盖（含 `medium`） | 298（94.6%），其中 `high` 232（73.7%） |
| 运行时挂载的陷阱条目总数 | 3005 条（`knowledgeTraps=3005`，影响 896 个知识点） |
| atlas（ACTIVE） | 83 篇主题 → 采纳 265 个知识点（high 200 / medium 65），写出 1166 条 |
| cst（ACTIVE） | 1268 篇主题 → 采纳 1311 个知识点（high 733 / medium 578），写出 1672 条 |
| 证据分布（315 点，候选口径） | `name==keyword` 59 / `term-in-title` 50 / `term-in-body` 41 / `name-in-body` 40 / `keyword-overlap` 35 / `name==title` 29 / `name-token-weak` 20 / `name-in-title` 13 / `soft-in-item` 7 / `term==keyword` 4 |
| 基线（P0 之前，条目中心匹配） | 22/315 ≈ 7% |

#### 未覆盖项明细表

- **候选口径未覆盖 17 个**（来源资源本身的空白，多为应用型细分点与「综合与实践」栏目）：
  `cnm_015` 乘法运算律与多个因数相乘、`cnm_052` 点、线、面、体、
  `cnm_057` 度、分、秒及其换算、`cnm_061`/`101`/`109`/`119`/`141`/`267`
  综合与实践系列、`cnm_073` 平移作图、`cnm_154` 综合运用因式分解、
  `cnm_199` 用函数刻画实际变化规律、`cnm_227` 增长率与传播问题、
  `cnm_228` 面积与销售利润问题、`cnm_270` 相似多边形、
  `cnm_314` 对概率意义的常见误解辨析、
  `cnm_315` 综合与实践：用随机试验检验游戏的公平性。
- **运行时口径未覆盖 82 个**：= 上述 17 个 + 65 个仅 `medium` 证据的点
  （`medium` 不进 ACTIVE 是红线，需人工确认后用 `--allow-medium` 补发）。
  逐点明细见 `packages/server/data/staging/traps/coverage-active-2026.12.json`。

这些空白**硬凑只会错挂**，所以保留为未覆盖。

#### 复现命令与产物

```bash
# 试跑（不写盘）
npm run import:traps --workspace=@daydayup/server -- --source=atlas,cst --dry-run
# 产出 DRAFT + 待审清单 + 覆盖明细
npm run import:traps --workspace=@daydayup/server -- --source=atlas,cst --report
# 发布（atlas 需作者确认许可后带 --confirm-license）
npm run import:traps --workspace=@daydayup/server -- --source=atlas --promote \
  --confirm-license="<许可文本>" --version-suffix=2026.12 --published-at=2026-11-19T00:00:00.000Z
npm run import:traps --workspace=@daydayup/server -- --source=cst --promote \
  --version-suffix=2026.12 --published-at=2026-11-19T00:00:00.000Z
```

已发布（`packages/server/data/traps/`，`status=ACTIVE`，运行时生效）：

| 文件 | 内容 |
|---|---|
| `traps-junior-math-atlas-2026.12.json` | atlas ACTIVE，1166 条（作者已确认权利并授权） |
| `traps-china-skill-taxonomy-2026.12.json` | cst ACTIVE，1672 条 |
| `traps-china-skill-taxonomy-2026.11.json` | 早期 ACTIVE，259 条（保留版本历史，仍在生效） |
| `traps-cn-math-taxonomy-2026.11.json` | cn-mt ACTIVE，147 条（仍在生效） |

候选与审核产物（`packages/server/data/staging/traps/`）：

| 文件 | 内容 |
|---|---|
| `traps-junior-math-atlas-2026.12.json` | atlas DRAFT，1166 条 |
| `traps-china-skill-taxonomy-2026.12.json` | cst DRAFT，1672 条 |
| `unmatched-2026.12.json` | 1735 条未采纳条目（待审池） |
| `coverage-2026.12.json` | **候选口径明细表**：逐个知识点记录是否覆盖、置信度、来源主题、证据类型与分数 |
| `coverage-active-2026.12.json` | **运行时口径明细表**：ACTIVE 资产实际覆盖到哪 315 个点、各挂了多少条 |

单测：`packages/server/tests/trap-evidence.test.ts` + `trap-converter.test.ts`
（共 59 例，覆盖证据分级、硬门槛、册次冲突降级、短语碎片剔除、
分配规则、以及「不得凭空生成」红线）。

### P2 实测结果（2026-11-19，发布版）

**结论：P2 达标。** 两项验收标准都已落地：

| 验收标准 | 落地方式 | 实测 |
|---|---|---|
| 错题页「避坑点」显示真实内容 | 英语地图 338 条 `mistake` 进统一错因资产层（`data/traps/` ACTIVE） | **338/338 逐字一致**（与源 `mistake` 对比，diff 0）；运行时英语知识点 1259 个中 **468 个叠加层点 100% 有避坑点**、**主资产 791 个中 139 个有** |
| 变式题提示词带上陷阱 | 服务端 `mergeTraps()` 兜底，前端不传也能补出 | 前端传的排前、服务端补的排后、去重、上限 8 条；`/coach/chat` 与 `/practice/generate` 均已接入 |

#### 缺口 1：英语地图 338 条 `mistake` 进统一错因资产层

原来这 338 条只以 **overlay 的 `commonTraps` 字段**存在于
`data/overlays/workbuddy-english-2026.11.json`，运行时确实生效，
但**不在统一错因资产层**里 —— 无法单独下架、无法审计、无法追溯来源许可。

新增来源 `en-map`（repo `workbuddy-english-map`），覆盖三份工作簿：

| 源文件 | 工作表 | 条数 | 落点 |
|---|---|---|---|
| `上海中考英语完整知识地图.xlsx` | 知识地图 | 338 | `cne_wb_<code 下划线化>`（叠加层 id，与 overlay 一一对应） |
| `上海中考英语核心知识点详解表.xlsx` | 知识点总表 | 169 | `cne_wb_dNNN`，同名条目回退到地图 id |
| `上海中考英语提分实战手册.xlsx` | 抢分动作 | 19 | 无知识点 id → 待审池 |

**关键修复：`curriculum.ts` 里错因挂载必须排在 overlay 之后。**
原顺序是先 `applyTrapSets()` 再 `applyKnowledgeOverlays()`，
而英语错因的落点是 `cne_wb_*`（overlay 命名空间）——
挂的时候这些知识点还不存在，**338 条会全部落空**。
已把 `applyKnowledgeOverlays()` 提前（它不依赖 traps，重排安全）。

**详解表同名条目的处理**：详解表 169 条里有 38 条与地图同名，
overlay 生成时地图版优先，详解表那句更细的错因（如「名词所有格」的
「分别拥有与共同拥有混用。」）会被覆盖掉。现在详解表条目作为
**独立一条**挂在同一点上（`applyTrapSets` 是追加语义，两句都在）。

**主资产英语点的高置信挂载**：地图是语法/题型级，主资产是教材单元级
（「读懂水果喜好」「介绍家人」），两者几乎不重合。
实测名称匹配天花板 89/791，证据匹配 66/257 且软匹配误挂明显
（`cne_j003 姓名与称呼 ← 现在分词作定语`）。
所以只挂**高置信**的部分：名称 exact / prefix / suffix，
排除泛成分名（宾语/状语/主语/表语/定语/谓语等）与 < 3 字名，
**不做 infix 匹配**（纯成分名会大面积误挂）。

#### 缺口 2：题目级 `commonErrors` 接进出题

原来 `commonErrors` 只在题库数据里存在，**没有任何服务端消费点**：
`practice.routes.ts` 只有 `GET /practice/questions`；
`/practice/generate` 只吃前端传来的 `commonTraps`，服务端不兜底。

新增 `packages/server/src/infrastructure/knowledge/trap-context.ts`：

```
getKnowledgeTraps(knowledgeId)   → 知识点维度的避坑点（来自错因资产层）
getQuestionTraps(knowledgeId)     → 题目维度的历史错答（来自题库 commonErrors）
mergeTraps(前端传的, knowledgeId) → 前端在前、服务端补在后、去重、上限 8 条
```

接入点：
- `ai.routes.ts` `/coach/chat` —— 教练对话的「常见易错点」
- `ai.routes.ts` `/practice/generate` —— 变式题生成 prompt 的「重点易错点」
- `practice.routes.ts` `GET /practice/questions` —— 每题额外带 `knowledgeTraps`（知识点维度的通用避坑点）

#### 实测数字（2026-11-19 发布版）

| 指标 | 数值 |
|---|---|
| 英语地图 `mistake` → 运行时 `commonTraps` 逐字一致 | **338 / 338**（diff 0、missing 0） |
| 详解表 169 条逐字一致 | 135 一致 + 34 条原被地图覆盖（现已作为独立条目补挂） |
| en-map ACTIVE 条目数 | **582** 条（候选 600 → high 582 / medium 1 丢弃 / unmatched 17 进待审池） |
| 匹配方式分布 | source-topic 506 / exact-name-alias 74 / exact-name 2 / name-contains 1 |
| 主资产英语点高置信挂载 | **57 个**（小学 9 / 初中 28 / 高中 14 口径内的 exact/prefix/suffix） |
| 运行时英语知识点总数 | 1259 = 主资产 791 + overlay 468 |
| 运行时**叠加层 468 个点**有避坑点 | **468 / 468（100%）** |
| 运行时**主资产 791 个点**有避坑点 | **139 / 791**（en-map 新覆盖 57；另 82 个来自 cst 旧证据策略） |
| 运行时挂载陷阱条目总数 | 3106 条（`trap.overlay_applied knowledgeTraps=3106, affected=963`） |
| 题库题目级 `commonErrors` | 11246 题中 201 题有；英语 3223 题中 64 题有 |

> 主资产 791 个英语点仍有 652 个没有避坑点 —— 这是**来源侧的真实空白**，
> 不是匹配失败：英语地图是语法/题型级资产，主资产是教材单元级资产，
> 两者粒度不同。硬凑只能错挂（P1 已验证证据匹配会造噪声），
> 所以宁可留白，等 P3 做错因结构化后用「题型 → 教材单元」的映射补齐。

#### 复现命令与产物

```bash
# 试跑（不写盘）
npm run import:traps --workspace=@daydayup/server -- --source=en-map --dry-run
# 产出 DRAFT + 待审清单
npm run import:traps --workspace=@daydayup/server -- --source=en-map --report
# 发布（en-map 需作者确认许可后带 --confirm-license）
npm run import:traps --workspace=@daydayup/server -- --source=en-map --promote --force \
  --confirm-license="自有原创内容（作者确认拥有全部权利），授权 daydayup 项目内使用与发布" \
  --version-suffix=2026.12 --published-at=2026-11-19T00:00:00.000Z
```

已发布（`packages/server/data/traps/`，`status=ACTIVE`，运行时生效）新增：

| 文件 | 内容 |
|---|---|
| `traps-workbuddy-english-map-2026.12.json` | en-map ACTIVE，**582 条**，subject「英语」 |

单测新增：`packages/server/tests/trap-en-map.test.ts`（15 例）+ `trap-context.test.ts`（5 例），
连同 P1 的 59 例，**错因资产层共 79 例**，全量服务端 690 例（689 pass / 1 fail，
失败项是 `jobs.test.ts` 的取消竞态，与本次改动无关 —— 单独跑通过）。

### P2 之后的产品出口（按收益排序）

1. **AI 教练**：prompt 通道已有（`registry.ts:154`），只要资产里有值即刻生效 —— 改造成本最低。
2. **错题页 / 知识点卡「避坑点」**：前端已渲染，只差数据。
3. **针对易错点的变式题**：把 `commonErrors` 写进出题 prompt，让 AI 出的变式题专门打这个坑。
4. **掌握度归因**：错因标签 → 哪类错误反复出现 → 直接进入提分优先级排序。

---

## 5. 风险与红线

| 风险 | 处理 |
|---|---|
| **AI 凭空生成易错点** | 红线。`LICENSING.md:101` 明确要求教师补全，不得由模型生成填入 `commonTraps` |
| **同名不同义导致错挂** | 匹配必须带学段校验；`medium` 置信度必须人工确认才能进 ACTIVE |
| **把 atlas 直接并进知识资产** | 不做。来源与授权不同，独立资产层才能单独下架 |
| **资产体积膨胀** | 知识资产 2760 点已 1.47 MB（gzip 235 KB）。陷阱单列文件、按知识点 id 索引，前端按需取 |
| **ID 体系分裂** | cn-mt `cnm_*`、cst `mt_*`、atlas `m1-00-*`、英语地图 `01.01.01.01` 四套并存 —— 必须在 `TrapSet` 内统一收敛到 cn-mt id，不要让第四套 id 进主库 |

---

## 6. 授权与合规（实施前必须确认）

| 资源 | 许可 | 对本项目的影响 |
|---|---|---|
| `cn-math-taxonomy` | **CC BY-NC 4.0**（署名-非商业） | 已集成。**商业化（付费课程 / 付费 App / 机构收费）须先取得作者商业授权** —— 这是整个项目最硬的约束，新增的陷阱内容同样继承该限制 |
| `china-skill-taxonomy` | 数据库层 ODbL 1.0 + 原创文本 CC BY-SA 4.0 | 允许商业使用，需署名；衍生数据库须以相同许可保持开放 |
| `junior-math-atlas` | 仓库根目录无 LICENSE 文件，GitHub API `license` 字段为 null | **已由作者本人确认**：内容为自有原创（`content/site.json` 的 `source_note` 注明原理与解题思路按初中课标重写、例题自编逐题验算），授权 daydayup 项目内使用与发布。已带 `--confirm-license` promote 为 ACTIVE |
| `workbuddy-research` | 本仓库内部产出 | 视为自有资产，但仍需在页脚保留来源标注。英语错因资产（`en-map`）已带 `--confirm-license` promote 为 ACTIVE |

行动项：
1. ~~找 `junior-math-atlas` 作者确认许可~~ → 已完成（作者本人确认权利并授权）。
2. 若项目走向商业化，同步启动 `cn-math-taxonomy` 的商业授权谈判。
3. 页面侧统一署名：每条陷阱记录来源仓库、路径与许可，UI 可见。
4. 给 `junior-math-atlas` 仓库补一个 LICENSE 文件，把「口头确认」变成「仓库内可查的书面许可」，
   避免下一轮导入时再次卡在闸门。
5. 给 `workbuddy-research` 的英语错因来源也补一份书面授权说明（`en-map` 目前同样是
   `licenseConfirmed:false`，每次 promote 都必须显式带 `--confirm-license`）。

---

## 7. 涉及文件清单（实施时改动）

| 文件 | 改动 |
|---|---|
| `packages/contracts/src/domain/index.ts` | 新增 `TrapSet` / `TrapEntry` 类型；`KnowledgePoint.commonTraps` 保持 `string[]` 不变 |
| `packages/server/src/infrastructure/knowledge/converters/traps.ts` | 新增：源解析 → `TrapEntry[]` 的纯函数转换；`TrapCandidate` 加 `matchConfidenceHint` |
| `packages/server/src/infrastructure/knowledge/converters/traps-en-map.ts` | 新增：英语地图/详解表/抢分动作 → `TrapCandidate` 的纯函数转换 + 英语名称匹配（排除泛成分名） |
| `packages/server/src/infrastructure/knowledge/converters/traps-en-map-source.ts` | 新增：英语三份 xlsx 的读取（列索引固定，跳过标题行与列名行） |
| `packages/server/src/infrastructure/knowledge/trap-matcher.ts` | 新增：三级匹配 + 置信度判定；`matchConfidenceHint` 只在匹配到知识点时生效 |
| `packages/server/src/infrastructure/knowledge/trap-text.ts` | 新增：中文短语切分 / STOP 词表 / 教材册次-章-节解析（纯函数） |
| `packages/server/src/infrastructure/knowledge/trap-evidence.ts` | 新增：**资产中心**的证据打分与分配（纯函数，P1 覆盖率的主力） |
| `packages/server/src/infrastructure/knowledge/trap-context.ts` | 新增：出题/教练场景的错因兜底（`getKnowledgeTraps` / `getQuestionTraps` / `mergeTraps`） |
| `packages/server/scripts/import-traps.ts` | 新增：CLI 入口（IO、校验、写盘）；`--strategy=auto\|evidence\|candidate`；`en-map` 来源 |
| `packages/server/src/infrastructure/knowledge/curriculum.ts` | 加载 `data/traps/`；`commonTraps` 合并进知识点；**overlay 挂载排在错因挂载之前**（否则 `cne_wb_*` 落点的错因全落空） |
| `packages/server/src/infrastructure/knowledge/converters/taxonomy.ts` | `deriveCommonTraps` 改为读取外部陷阱资产，去掉空数组告警 |
| `packages/server/src/api/routes/practice.routes.ts` | 题目响应带 `knowledgeTraps`（知识点维度的通用避坑点） |
| `packages/server/src/api/routes/ai.routes.ts` | `/coach/chat` 与 `/practice/generate` 用 `mergeTraps()` 兜底补错因 |
| `packages/server/tests/trap-converter.test.ts` | 新增：转换与匹配单测 |
| `packages/server/tests/trap-evidence.test.ts` | 新增：证据分级、硬门槛、分配规则、红线单测（P1） |
| `packages/server/tests/trap-en-map.test.ts` | 新增：英语来源转换、名称匹配排除泛成分名、叠加层落点、DRAFT 不生效单测（P2） |
| `packages/server/tests/trap-context.test.ts` | 新增：服务端错因兜底与去重顺序单测（P2） |
| `web/src/components/knowledge/KnowledgePointCard.tsx` | 无需改（已渲染），仅验证数据来源 |
| `docs/taxonomy-import.md` | 增加「错因资产」一节，与知识资产导入流程对齐 |
