# 智能日报系统

把你关注的 RSS、X（Twitter）账号和 Telegram 频道 / 群组汇总起来，用 AI 去重、筛选、归纳，每天生成一份日报，通过 RSS 或邮件发给你。

为个人自部署设计：一台小服务器即可运行，数据全部存在本机 SQLite，除你自己配置的 AI 模型外不依赖任何云服务。

> 项目仍在持续开发中，路线图见文末。

## 每天收到的日报

默认每天 08:00（台北 / 北京时间）出一期，覆盖前 24 小时。章节如下，没有内容的章节整章不显示：

| 章节 | 内容从哪来 | 怎么生成 |
|---|---|---|
| 一、官方动态 | 标为「官方」的来源（各公司的博客、更新日志），按厂商分组 | 同一厂商的同一件事合并为一条，AI 写标题和摘要；琐碎更新、72 小时内已推送过的事件不再出现 |
| 二、开源项目 | 所有条目里提到的 GitHub 仓库（非官方来源转载官方内容的除外） | 按提到它的来源数量排序，AI 写一句话介绍，72 小时内不重复，每期最多 12 个 |
| 技术干货 / 羊毛资讯 / 生活经验 | 社区论坛（内置 LINUX DO、V2EX 的规则，来源 ID 为 `linuxdo` / `v2ex`）；羊毛资讯还会从其他非官方来源与 Telegram 消息里收集优惠信息 | AI 判断是否值得收录并分类，相同优惠合并 |
| 时政速览 | 标为「时政」的来源 | 同一事件合并后，AI 写成 3–5 句的一段 |
| Telegram 群组要点 | 你加入的 Telegram 频道 / 群组 | 见下文「Telegram」 |

日报的结构、窗口时间、各章节规则都在 `config/rules.yaml`，可以改成每天多期，也可以切回旧版的分区格式（`brief.format: legacy`）。

## 工作流程

```
采集（每 20 分钟）→ 全文抓取（按需）→ 窗口内条目 → L1 结构化摘要 → 向量 → 聚类去重（灰区交 L2 确认）
→ 各章节 AI 判定与文案（L1 / L2 分层）→ 判定完整性检查 → 发布（RSS / 邮件）
```

**去重分三层**
1. 采集时：同一来源的同一条内容只存一次，正文变化才记新版本。
2. 规范化后网址完全相同的，只保留最早的一条。
3. 语义合并「同一件事」：L1 为每条写结构化摘要（主体、动作、对象、版本、数字、时间），转成向量算相似度；只在同一个池里合并（官方动态按厂商分池，时政一池，社区一池）。相似度 ≥ 0.90 且事实不冲突直接合并；0.80–0.90 之间，或者版本号不同、动作互斥（发布/下线、涨价/降价等）、数字不同，交给 L2 确认。阈值可在后台调整。没有配置向量模型时只按网址去重。

**AI 两层判定（L1 / L2）**
- L1 先判；以下情况送 L2：L1 调用失败、结果缺失或格式不合格、置信度低于 0.6、被模型以内容安全为由拒绝、去重灰区确认。
- L1、L2 都拒绝处理的条目按「排除」计并在后台列出。
- 两层都没给出有效结果的条目会**推迟本期发布**：每 15 分钟重试一次，超过计划时间 2 小时仍未解决则本期不发布，后台显示原因。
- 每期 AI 调用有上限（默认 600 次，L2 判定 80 条、灰区确认 60 次），超出时宁可多一条重复也不丢内容。
- 建议 L2 用比 L1 更强、或不同供应商的模型；两层用同一模型时，L2 只起到重试的作用。

## 功能

### 采集
- **RSS / Atom**，以及几种网页解析器：Telegram 公开频道网页版（`t.me/s/…`）、V2EX 热门 JSON、DeepSeek 更新日志页、OpenAI 产品更新页。
- **X 账号**：通过任意能把 X 账号转成 RSS 的服务接入（例如自建 RSSHub）。
- 每个来源可配多个备用地址，按优先级回退；条件请求（ETag / Last-Modified）；按主机分组限流（并发、最小间隔）；被限流或质询时持久熔断、自动冷却；按来源设置采集频率档位。
- **全文抓取**：对正文被截断的论坛帖子与文章页抓取原文，作为 AI 判断依据（内置 LINUX DO、V2EX、即刻、Elsewhere 的规则）。临时故障会自动重试，不会永久放弃。
- **出站安全**：所有抓取只允许 https，每一次重定向都重新校验目标地址，拒绝内网、环回、云元数据等地址；连接时只使用校验过的 IP（防 DNS 重绑定）；整次请求有截止时间与体积上限（按解压后计算）。需要 curl 的站点（Cloudflare 质询）走封闭的 curl 通道，规则相同。

### Telegram
- 用你自己的 Telegram 账号登录（Python / Telethon 采集器），收集公开频道和你已加入的群组的消息；登录验证码只经本机 Unix Socket 传给采集器，不落盘。
- 每个来源可选「普通总结」或「仅提取链接」（只保存消息里的网址）。
- 按设定的时刻为每个频道生成要点，再合并成一份标注来源的「跨频道要点」，附在日报末尾。
- **图片识别**（可选）：识别消息里的图片，把文字结果纳入总结；有每日额度，失败的图片保留 7 天自动重试，图片目录有容量上限。
- 消息与总结的保留天数可设置。Telegram 数据使用独立的数据库，原始消息不会进入日报候选。

### 模型
- 支持 OpenAI、Anthropic、Gemini、DeepSeek、通义千问，以及任何 OpenAI 兼容接口。
- 在后台添加「模型供应商」（API Key 加密保存），再给 6 个用途分配模型：L1、L2、L3（只有旧版日报格式使用）、Telegram 总结、图片识别（需支持图片输入）、向量模型（OpenAI 兼容 `/embeddings`，用于语义去重）；L2、L3、Telegram 用途可「跟随」L1。每个用途都能一键测试。
- 未启用全局模型供应商时，也可以按旧方式用环境变量或后台表单分别配置。

### 投递
- **RSS**：日报，以及 Telegram 的跨频道要点、全部频道、单个频道，各有独立订阅地址；地址带访问令牌，可随时重置或撤销。
- **邮件**（可选）：SMTP 或 Gmail API。`config/rules.yaml` 的 `brief.delivery` 设为 `rss_only` 时只发布 RSS。
- 已发出的日报不会被改写；可以在后台重新运行某一期或重新发送。

### 管理后台
| 页面 | 内容 |
|---|---|
| 今日 | 只显示需要处理的事项：日报漏运行 / 失败 / 推迟 / 未投递、来源连续失败、Telegram 掉线、图片识别暂停或积压、备份失败、磁盘将满、模型配置错误；每条都有「去处理」链接 |
| 订阅源 | RSS、Telegram、X 三个区域：状态、新增（先安全检查并试抓，通过才启用并进入观察期）、测试、改地址、分组、启停、删除；Telegram 频道的 RSS 令牌 |
| 日报 | 每一期的运行记录、候选内容与 AI 判定理由、人工调整、重新运行与重新发送；Telegram 跨频道要点 |
| 消息渠道 | 所有 RSS 订阅地址与令牌管理；邮件投递状态 |
| 系统运行 | 今天各时段的日报、定时任务状态、备份与磁盘、AI 调用量、图片识别队列 |
| 设置 | 模型供应商与分配；Telegram 登录、API 凭据、总结时段与提示词；其他 API Key；数据保留与备份开关 |

登录支持口令 + 可选的动态验证码（TOTP），所有写操作有 CSRF 保护并记审计日志；密钥用 AES-GCM 加密保存，页面只显示末四位。错误信息统一脱敏：日志与页面不会带出密钥、令牌、内网地址或上游返回的原文。

### 运维
- systemd 服务与定时器：采集每 20 分钟、全文抓取每 20 分钟（错开 10 分钟）、日报每天 08:00、Telegram 总结与图片识别每分钟检查一次、维护与本机备份每天 03:30。
- 本机每日备份两个数据库；可选通过 rclone 上传到 Google Drive（`deploy/scripts/briefing-gdrive-backup.sh`）。
- 数据库迁移只追加，升级可重复执行。

## 架构

```
apps/web          管理后台（Fastify，只监听本机，公网经反向代理）
apps/worker       定时任务：采集、全文、日报组装与发布、Telegram 总结与识别、维护
packages/
  connectors      抓取（出站安全）、解析器、限流
  ai              模型供应商、错误分类、事实核查
  digest          日报组装：去重聚类、L1/L2 分层、各章节
  telegram        Telegram 数据库、总结、要点、RSS、后台视图
  web / db / domain / templates   后台逻辑、数据库与迁移、规则与规范化、邮件与 RSS 模板
telegram-worker   Telegram 采集器（Python / Telethon）
config/           订阅源、规则、提示词
migrations/       数据库迁移
deploy/           systemd 单元、Nginx / Caddy 示例、备份脚本
```

后台与各个 worker 共用 SQLite（WAL 模式）；每一步都可以重跑，结果可追溯。

## 快速开始

**环境要求**：Node.js 22.18 及以上（直接运行 TypeScript）；curl（Cloudflare 质询站点的抓取通道）；openssl（运行测试时生成自签证书）。使用 Telegram 还需要 Python 3.11–3.14 与 [uv](https://docs.astral.sh/uv/)。

```bash
npm install
cp .env.example .env                                   # 按注释填写
node scripts/admin-setup.mjs '一个足够长的后台口令'      # 生成 ADMIN_PASSWORD_HASH，填进 .env
npm run migrate                                        # 建库
npm run sync                                           # 把 config/sources.yaml 同步进数据库
npm run web                                            # 启动后台，默认 http://127.0.0.1:3000
```

至少要设置：`ADMIN_PASSWORD_HASH`、`APP_ENCRYPTION_KEY`（主密钥：足够长的随机串，请另外妥善保存，丢失后已加密的密钥无法恢复）、`DATABASE_PATH`。未设置后台口令时为只读演示模式。

然后在后台：
1. **设置 → 模型**：添加模型供应商，给 L1、L2、Telegram 总结、图片识别、向量模型分配模型，逐个点「测试」，再启用。
2. **订阅源**：添加你的 RSS / X 来源（`config/sources.yaml` 里只有 4 个官方博客作示例）。
3. （可选）**设置 → Telegram**：填写 Telegram API ID / Hash / 手机号并登录，再到「订阅源 → Telegram」添加频道。

手动跑一次：

```bash
npm run harvest                    # 采集到期的来源
npm run run -- --no-send           # 生成日报但不投递
npm run status                     # 来源与运行状态
```

Telegram 采集器：

```bash
cd telegram-worker && uv sync && cd ..
npm run telegram:collector
npm run telegram:summarize
```

## 配置订阅源

后台新增的来源属于「社区」池：参与去重，并为「开源项目」「羊毛资讯」提供素材。想让来源进入「官方动态」或「时政速览」，在 `config/sources.yaml` 里配置后执行 `npm run sync`：

```yaml
sources:
  - id: openai_news                 # 唯一 ID，小写字母 / 数字 / 下划线
    name: OpenAI News
    display_name: OpenAI News       # 日报里显示的名字
    vendor: openai                  # 厂商：官方动态按它分组
    official: true                  # 官方来源 → 一、官方动态
    role: official                  # official 官方动态 / politics 时政速览 / context 其他
    category: ai
    harvest_tier: official_changelog   # 采集频率档位，见 harvest_tiers
    host_group: direct              # 限流分组，见 host_groups
    endpoints:                      # 多个地址按 priority 回退
      - { url: "https://openai.com/news/rss.xml", parser: rss, priority: 1 }
```

后台新增的来源不会被 `config/sources.yaml` 的同步覆盖。新增或修改端点后，可以用 `node scripts/probe-sources.mjs` 实测所有端点。

## 其他配置

| 文件 | 作用 |
|---|---|
| `config/rules.yaml` | 时区与日报时段、日报格式与章节、去重与 AI 分层参数、必须保留的内容类型、过滤规则、投递方式 |
| `config/prompts/` | 各环节的提示词 |
| `.env` | 端口、数据库与密钥保管库路径、主密钥、邮件通道等（见 `.env.example`） |

## 部署到服务器

`deploy/systemd/` 里是全部服务与定时器单元，`deploy/nginx/`、`deploy/Caddyfile` 是反向代理示例（后台只监听本机，公网经反向代理并启用 HTTPS）。建议：
- 用专门的系统用户（如 `brief`）运行，代码放在 `/opt/briefing-system`，数据放在 `/var/lib/briefing`，环境变量放在权限为 600 的 `/etc/briefing/env`。
- 升级时先停定时器、等运行中的任务结束，在线备份数据库后再执行 `npm run migrate`，最后恢复定时器。

## 测试

```bash
npm run typecheck
npm test            # 包含用本机 HTTPS 测试服务器与真实 curl 的出站安全测试
```

## 路线图

- [x] 第一期：后台导航与页面重组（今日只放待处理、订阅源分区、消息渠道）；抓取出站安全加固
- [ ] 第二期：订阅源改造——厂商标签、可订阅的来源目录、一键订阅、逐个来源的「是否公开」开关
- [ ] 第三期：Telegram Bot 投递渠道；采集停止等故障主动提醒
- [ ] 第四期：首次启动向导、Docker 部署

## 许可证

[MIT](LICENSE)
