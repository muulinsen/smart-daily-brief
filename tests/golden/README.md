# 黄金样本集

用途：每次改规则或 Prompt 前跑回归；强制保留召回率下降即阻断发布（PRD 23.3 / 24.1）。

## 标注字段

| 字段 | 说明 |
|---|---|
| `id` | 稳定标识，`{source}:{item_key}` |
| `source` | 来源 id |
| `title` / `body` | 原始标题与正文（正文须是**全文**，不是 RSS 摘要） |
| `body_is_excerpt` | 正文是否为摘要。true 的样本不能用于校验 A–D 召回 |
| `expected.decision` | `retain` / `normal` / `filter` |
| `expected.mandatory_class` | `A`/`B`/`C`/`D`/`none` |
| `expected.section` | 四个分区之一 |
| `expected.filter_rule_id` | 若 decision=filter，必须给出 DF-xxx |
| `label_source` | `machine_proposed` / `human_confirmed` —— **只有后者计入回归** |
| `note` | 人工判定理由，尤其是边界案例 |

## 覆盖要求（PRD 23.3）

至少 200 条，且必须覆盖：
- 强制保留 A/B/C/D 各 ≥ 20 条正例 + ≥ 10 条反例（形似但不该保留）
- 重复 / 非重复各 ≥ 15 条
- 延迟补录 ≥ 10 条
- 重大新闻 ≥ 15 条
- Elsewhere 长文 ≥ 20 条
- 普通过滤（DF-010/011/020/030 各 ≥ 5 条）
- **「同关键词不等于重复」专项 ≥ 15 条**（PRD 7.4 / 23.1，最易错）

## 工作流

1. `node scripts/seed-golden.mjs` —— 从 fixtures 生成机器预标注草稿
2. 人工逐条改判，把 `label_source` 改为 `human_confirmed`
3. `node scripts/validate-golden.mjs` —— 检查覆盖度是否达标
