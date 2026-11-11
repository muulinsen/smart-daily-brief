# 智能日报系统

把你关注的 RSS、X（Twitter）账号和 Telegram 频道 / 群组汇总起来，由 AI 分层筛选、去重、归纳，每天生成一份日报，通过 RSS 或邮件发给你。

适合自己部署在一台小服务器上，个人使用。数据都存在本机的 SQLite 里，不依赖任何云服务（AI 模型除外，用你自己的 API Key）。

> 项目仍在持续开发中，路线图见文末。

## 它能做什么

### 采集
- **RSS / Atom**：任意订阅地址；支持条件请求（ETag / Last-Modified）、按主机限流、失败自动熔断与恢复、多个备用地址。
- **X 账号**：通过任意能把 X 账号转成 RSS 的服务接入（例如自建的 RSSHub）。
- **Telegram 频道与群组**：用你自己的 Telegram 账号登录（Telethon），按时段收集消息；支持公开频道、已加入的私有群组；可选「仅提取链接」模式，只保存消息里的网址。
- **全文抓取**：对部分来源抓取文章正文，作为 AI 判断的依据。
- 后台添加来源时先做安全检查（只允许 https、拒绝内网地址）并试抓一次，测试通过才启用。

### AI 筛选与归纳
- **分层判定**：L1 初筛 → L2 复核 → L3 复核，便宜的模型先过滤，贵的模型只看拿不准的内容；每一层都可以单独选供应商和模型。
- **语义去重**：用向量模型把不同来源报道的同一件事合并成一条，避免日报里重复。
- **规则可配置**：时间窗口、分区、必须保留的内容类型（如安全公告、价格变动）、过滤规则都在 `config/rules.yaml`。
- **Telegram 总结**：每个时段为每个频道生成要点，再合并成一份「跨频道要点」，并标注来源。
- **图片识别**（可选）：识别 Telegram 消息里的图片，把文字结果纳入总结；有每日额度控制。
- **支持的模型**：OpenAI、Anthropic、Gemini、DeepSeek、通义千问，以及任何 OpenAI 兼容接口。在后台统一添加「模型供应商」，再给每个用途分配模型。

### 投递
- **RSS**：日报、Telegram 跨频道要点、每个频道的总结，各有独立的订阅地址（带访问令牌，可随时重置或撤销）。
- **邮件**：通过 SMTP 或 Gmail API 发送；也可以设置为只发 RSS。
- 已发出的日报不会被改写；可以在后台重新运行某一期或重新发送。

### 管理后台
| 页面 | 内容 |
|---|---|
| 今日 | 只显示需要处理的事项：日报漏发、来源连续失败、Telegram 掉线、备份失败、磁盘将满、模型配置错误等，每条都有「去处理」链接 |
| 订阅源 | RSS、Telegram、X 三个区域：查看状态、新增、测试、改地址、分组、启停、删除 |
| 日报 | 每一期的运行记录、候选内容与 AI 判定理由、人工调整、重跑与补发；Telegram 要点 |
| 消息渠道 | 所有 RSS 订阅地址与令牌管理；邮件投递状态 |
| 系统运行 | 今天各时段的日报、定时任务状态、备份与磁盘、AI 调用量、图片识别队列 |
| 设置 | 模型供应商与分配、Telegram 登录与总结设置、API Key、数据保留与备份 |

后台支持口令 + 可选的动态验证码（TOTP）登录，所有写操作有 CSRF 保护并记录审计日志。API Key 等密钥用 AES-GCM 加密保存，页面上只显示末四位。

### 运维
- 定时任务以 systemd 单元提供（采集、全文、日报、Telegram 总结与识别、维护与备份）。
- 每日本机备份，可选上传到 Google Drive。
- 错误信息统一脱敏：日志与页面不会带出密钥、令牌或上游返回的原文。

## 架构

```
apps/web        管理后台（Fastify）
apps/worker     定时任务：采集、全文、候选、AI 判定、组装日报、投递、维护
packages/*      连接器、AI 供应商、日报组装、Telegram、数据库、模板
telegram-worker Telegram 采集器（Python / Telethon）
config/         订阅源、规则、提示词
migrations/     数据库迁移（只追加）
deploy/         systemd 单元、反向代理示例
```

Web 后台与各个 Worker 共用 SQLite（WAL 模式）；Telegram 数据放在单独的数据库里。每一步都可以重跑，结果可追溯。

## 快速开始

需要 Node.js 22.18 及以上（直接运行 TypeScript），如需 Telegram 还要 Python 3.11+ 与 [uv](https://docs.astral.sh/uv/)。

```bash
npm install
cp .env.example .env               # 按注释填写
node scripts/admin-setup.mjs '一个足够长的后台口令'   # 生成 ADMIN_PASSWORD_HASH，填进 .env
npm run migrate                    # 建库
npm run sync                       # 把 config/sources.yaml 同步进数据库
npm run web                        # 启动后台，默认 http://127.0.0.1:3000
```

至少需要设置：`ADMIN_PASSWORD_HASH`、`APP_ENCRYPTION_KEY`（主密钥，请用足够长的随机串并妥善保存，丢失后已加密的密钥无法恢复）、`DATABASE_PATH`。未设置后台口令时为只读演示模式。

然后在后台：
1. **设置 → 模型**：添加模型供应商（填 API Key），给 L1 / L2 / L3、Telegram 总结、图片识别、向量模型分配模型，点「测试」确认可用，再启用。
2. **订阅源**：添加你的 RSS / X 来源（`config/sources.yaml` 里只有几个示例）。
3. （可选）**设置 → Telegram**：填写 Telegram API ID / Hash / 手机号，登录账号，再到「订阅源 → Telegram」添加频道。

手动跑一次：

```bash
npm run harvest                    # 采集
npm run run -- --no-send           # 生成日报但不投递
npm run status                     # 查看来源与运行状态
```

Telegram 采集器：

```bash
cd telegram-worker && uv sync && cd ..
npm run telegram:collector
npm run telegram:summarize
```

## 部署到服务器

`deploy/systemd/` 里是全部服务与定时器单元，`deploy/nginx/`、`deploy/Caddyfile` 是反向代理示例（后台只监听本机，公网经反向代理并启用 HTTPS）。建议：
- 用专门的系统用户（如 `brief`）运行，数据放在 `/var/lib/briefing`，环境变量放在权限为 600 的 `/etc/briefing/env`。
- 升级时先停定时器、等运行中的任务结束，备份数据库后再执行 `npm run migrate`。

## 配置

| 文件 | 作用 |
|---|---|
| `config/sources.yaml` | 订阅源、按主机的限流分组、采集频率分档 |
| `config/rules.yaml` | 时间窗口、分区、去重、必须保留的内容、过滤规则、投递方式 |
| `config/prompts/` | 各层 AI 判定与总结的提示词 |
| `.env` | 端口、数据库路径、主密钥、邮件通道等（见 `.env.example`） |

后台新增的来源不会被 `config/sources.yaml` 的同步覆盖。

## 测试

```bash
npm run typecheck
npm test
```

## 路线图

- [x] 第一期：后台导航与页面重组（今日只放待处理、订阅源分区、消息渠道）
- [ ] 第二期：订阅源改造——厂商标签、可订阅的来源目录、一键订阅、逐个来源的「是否公开」开关
- [ ] 第三期：Telegram Bot 投递渠道；采集停止等故障主动提醒
- [ ] 第四期：首次启动向导、Docker 部署

## 许可证

[MIT](LICENSE)
