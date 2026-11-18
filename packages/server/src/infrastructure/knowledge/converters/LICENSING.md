# 授权说明：cn-math-taxonomy 数据导入

## 结论（先读这一段）

**在取得作者的商业授权之前，本转换器产出的资产不得用于 daydayup 的任何商业场景
（付费课程、付费 App、机构收费服务等）。**

导入脚本生成的知识资产 **status = `DRAFT`**，不会自动生效，
必须经教师审核并手动改为 `ACTIVE` 才会被服务端加载。这是刻意设置的安全闸门。

## 源项目授权状态

| 项目 | 内容 |
|---|---|
| 上游仓库 | `https://github.com/xiaoyang111222/cn-math-taxonomy` |
| 许可证 | **CC BY-NC 4.0**（Attribution-NonCommercial 4.0 International） |
| 版权声明 | "个人学习、教学、研究可免费使用；**商业使用（付费课程、付费 App、机构收费服务等）需单独授权**" |
| 授权联系方式 | X: [@hassanyehiaa](https://x.com/hassanyehiaa) · 邮箱 `499749204@qq.com` · 或在仓库提 Issue |

daydayup 是面向中考学生的 AI 提分产品，具备明确的商业属性，
因此**直接落入 CC BY-NC 的 "NonCommercial" 排除范围**。

## 授权状态检查表

- [ ] 已通过上述任一联系方式联系作者，说明用途（商业教育产品）
- [ ] 已取得书面商业授权（含署名要求的具体形式）
- [ ] 已确认授权覆盖的**具体版本**（当前源数据 commit）
- [ ] 已在产品内按 CC BY 要求标注署名（作者名 + 仓库链接 + 许可证）

## 三条合法路径（按推荐度排序）

### 路径 A：取得商业授权（最直接）

联系作者 → 获得授权 → 导入资产 → 教师审核 → 上线。

署名要求（CC BY 的核心义务）应在产品内的"数据来源/致谢"页面标注：

```
知识体系与题库改编自 cn-math-taxonomy (xiaoyang111222)
原项目采用 CC BY-NC 4.0 许可，经作者授权用于商业用途。
```

### 路径 B：只用公开的一手资料自建（最干净）

不导入 cn-mt 的数据文件，只使用其**指向的公开权威来源**：

| 资料 | 来源 | 可用性 |
|---|---|---|
| 课程标准原文 | 教育部官网 PDF（`cn-curriculum-standards.json` 的 `source.url` 字段记录了原始 URL） | 公开文件，可自行抓取整理 |
| 教材目录 | 国家中小学智慧教育平台「电子课本」（basic.smartedu.cn） | 公开 |
| 先修关系 | 自行推导 + 教师审核 | 需自建 |

注意：`data/cn-curriculum-standards.json` 本身是 cn-mt 整理的产物（虽内容是教育部原文），
稳妥起见应从教育部原始 PDF 重新提取。

### 路径 C：只用公开的算法思路，自行实现（最保守）

**不复制 cn-mt 的数据文件**，但可以参考其算法设计——算法思想不受版权保护
（版权保护的是具体表达，不是抽象方法）。`diagnose/engine.js` 里的这些设计值得借鉴：

- 三态判定（掌握 / 不稳 / 薄弱）
- 连续答对 N 次才判掌握
- 仅在"确认题也错"时沿先修边回溯
- 种子化随机（mulberry32）保证可复现
- 难度分层的选题策略

自行实现即可，无需授权。

## 已实现的技术防护

转换器与导入脚本已内置以下防护，确保"未授权数据不可能误上线"：

| 防护 | 实现位置 | 行为 |
|---|---|---|
| 产物默认 DRAFT | `convertTaxonomy()` | `status` 默认 `'DRAFT'`，ACTIVE 需人工设置 |
| 拒绝覆盖 ACTIVE 资产 | `import-taxonomy.ts` | 目标文件已是 ACTIVE 时退出码 1，除非 `--force` |
| 数据缺口显式告警 | `report.warnings` | `commonTraps` 全空等缺口必须被看到 |
| 跳过内容不静默 | `report.skipped` | 每条跳过都有原因，按原因聚合输出 |
| 完整性校验 | `import-taxonomy.ts` | 悬空先修、先修环、题目外键 —— 任一失败即退出码 1 |
| 版本化溯源 | 资产 `version` 字段 | 版本号含 `taxonomy` 字样，便于审计 |

## 数据质量免责声明（与授权无关，仍需注意）

即使拿到授权，cn-mt 的 README 自己也声明了以下局限，
导入后**不能**当作教研结论直接使用：

> 「先修关系（哪些是 hard、哪些是 soft，甚至某条边该不该存在）**都需要一线教师审核**后才能用于教学、诊断或学习路径推荐。」

> 「**高中题和英语题没有做盲解**，`verify` 和答案来自同一条表达式。」
> （小学与初中数学有自动核验 / 盲解复核）

> 「课标句子仍是转述」「册次目录多数不是官方逐页核对」

因此 daydayup 的教师端（`TeacherDashboard`）应当承担**先修边审核**职责：
审核结果可回写进知识资产，形成 cn-mt 缺失的「教师校勘」闭环。

## 转换过程中的已知数据缺口

| 缺口 | cn-mt 是否有 | daydayup 的处理 |
|---|---|---|
| `commonTraps`（常见陷阱） | ❌ 无 | 留空 + 告警，**需教师补全**，不得由 AI 凭空生成 |
| `commonErrors`（题目常见错误） | ❌ 无 | 留空 |
| `examWeight`（考试权重） | ❌ 无 | 由 `type`/学段/课标置信度**确定性推导**（见 `deriveExamWeight`） |
| `learningCostHours`（学习成本） | ❌ 无 | 由 `type` + `mastery_criteria` 数量确定性推导 |
| `commonExamForms`（常见题型） | ❌ 无 | 由 `type` 推导 + 学段标签 |
| 课标 id | ✅ 有 | 保留在 `standards` 字段（daydayup 的 `KnowledgePoint` 暂无此字段，见下） |

### 建议的后续工作：扩展契约以承载课标溯源

cn-mt 的每个知识点都带 `standards: [{ id, confidence }]`，这是重要的可追溯性，
但 daydayup 的 `KnowledgePoint` 契约**没有对应字段**。建议扩展：

```ts
// packages/contracts/src/domain/index.ts
export interface KnowledgeStandard {
  id: string;              // 如 "cms-2022:4.NA.01"
  confidence: 'exact' | 'verbatim' | 'paraphrase' | string;
}

export interface KnowledgePoint {
  // ...现有字段
  standards?: KnowledgeStandard[];   // 课标溯源
  curriculumStage?: '小学' | '初中' | '高中';  // 学段（daydayup 目前只有初三）
}
```

本转换器**暂未**写入这两个字段 —— 因为契约未定义，写了会破坏类型约束。
待契约扩展后，只需在 `convertTopic()` 中补两行即可。
