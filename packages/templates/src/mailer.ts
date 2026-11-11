import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Mailer, SendResult } from './delivery.ts';

/**
 * 投递通道（PRD 17.1）。
 *
 * file   —— 把 multipart/alternative 原样落成 .eml，不发送。
 *           影子运行与预览用；也是没有 Gmail 凭证时验证全链路的方式。
 * smtp   —— Gmail SMTP + 应用专用密码。实测本机 587/465 开放、25 被 Azure 封。
 * gmail  —— Gmail API + OAuth2（PRD 17.1 推荐，refresh token 可撤销可审计）。
 *
 * 三者都实现同一个 Mailer 接口，投递幂等与重试逻辑不因通道而变。
 */

export type MailerKind = 'file' | 'smtp' | 'gmail';

const boundary = () => `----brief-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** 构造 multipart/alternative 原文（PRD 9.4）。 */
export function buildMime(o: {
  from: string; to: string; subject: string; text: string; html: string;
  headers?: Record<string, string>;
}): string {
  const b = boundary();
  // 中文主题必须 RFC 2047 编码，否则部分客户端会显示乱码
  const subj = /[^\x20-\x7e]/.test(o.subject)
    ? `=?UTF-8?B?${Buffer.from(o.subject, 'utf8').toString('base64')}?=`
    : o.subject;
  // 注意：额外头必须逐行展开进数组。若拼成一个可能为空的字符串再放进
  // 数组，join 时会插入一个空行 —— 而空行会提前终结邮件头区，
  // 导致后面的 Content-Type 被当成正文，全部客户端都渲染成乱码。
  const extra = Object.entries(o.headers ?? {}).map(([k, v]) => `${k}: ${v}`);
  return [
    `From: ${o.from}`,
    `To: ${o.to}`,
    `Subject: ${subj}`,
    `MIME-Version: 1.0`,
    `Date: ${new Date().toUTCString()}`,
    ...extra,
    `Content-Type: multipart/alternative; boundary="${b}"`,
    '',
    `--${b}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(o.text, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${b}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(o.html, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '',
    `--${b}--`,
    '',
  ].join('\r\n');
}

/** 落盘通道：产出真实 .eml，可直接用邮件客户端打开核对。 */
export function fileMailer(dir: string, from = 'brief@localhost'): Mailer {
  return async (msg) => {
    mkdirSync(dir, { recursive: true });
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${msg.to.replace(/[^\w.@-]/g, '_')}.eml`;
    const path = join(dir, name);
    writeFileSync(path, buildMime({ from, ...msg }), 'utf8');
    return { ok: true, providerId: `file:${name}` };
  };
}

/**
 * Gmail SMTP 通道。nodemailer 走动态 import（可选依赖），
 * 未安装时给出明确提示而不是在半路崩掉。
 */
export function smtpMailer(cfg: {
  host?: string; port?: number; user: string; pass: string; from?: string;
}): Mailer {
  let tx: any = null;
  return async (msg): Promise<SendResult> => {
    try {
      if (!tx) {
        let nodemailer: any;
        // 可选依赖：未安装时给出明确提示而不是崩在半路。
        // 用变量绕开静态解析，避免未安装时 tsc 报错。
        try { const mod = 'nodemailer'; nodemailer = (await import(mod)).default; }
        catch {
          return { ok: false, permanent: true,
            error: '未安装 nodemailer。执行 npm i nodemailer 后再用 smtp 通道。' };
        }
        tx = nodemailer.createTransport({
          host: cfg.host ?? 'smtp.gmail.com',
          port: cfg.port ?? 587,
          secure: (cfg.port ?? 587) === 465,
          // 应用专用密码在 Google 界面上是 4 组 4 位、带空格显示的，
          // 用户往往连空格一起复制 —— 去掉空格避免认证莫名失败
          auth: { user: cfg.user, pass: cfg.pass.replace(/\s+/g, '') },
        });
      }
      const info = await tx.sendMail({
        from: cfg.from ?? cfg.user, to: msg.to, subject: msg.subject,
        text: msg.text, html: msg.html, headers: msg.headers,
      });
      return { ok: true, providerId: String(info.messageId ?? '') };
    } catch (e: any) {
      // 认证失败与收件人无效是永久错误，不该反复重试（FR-053）
      const code = String(e?.responseCode ?? e?.code ?? '');
      const permanent = /^(535|550|553|554)$/.test(code) || /EAUTH|Invalid login/i.test(String(e?.message));
      return { ok: false, permanent, error: `${code} ${String(e?.message ?? e)}`.slice(0, 300) };
    }
  };
}

/**
 * Gmail API 通道（OAuth2）。直接调 REST，不引入 googleapis ——
 * 只用到一个 messages.send 端点，为它装整个 SDK 不值当。
 */
export function gmailApiMailer(cfg: {
  clientId: string; clientSecret: string; refreshToken: string; from: string;
}): Mailer {
  let token: { value: string; expiresAt: number } | null = null;

  const getToken = async (): Promise<string> => {
    if (token && Date.now() < token.expiresAt - 60_000) return token.value;
    // 不跟随重定向：307/308 会把带凭据的正文重发到别处（docs/ssrf-redirect-design.md §2）
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: cfg.clientId, client_secret: cfg.clientSecret,
        refresh_token: cfg.refreshToken, grant_type: 'refresh_token',
      }),
    });
    if (!r.ok) throw Object.assign(new Error(`刷新令牌失败 HTTP ${r.status}`), { permanent: r.status === 400 });
    const j: any = await r.json();
    token = { value: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return token.value;
  };

  return async (msg): Promise<SendResult> => {
    try {
      const at = await getToken();
      const raw = Buffer.from(buildMime({ from: cfg.from, ...msg }), 'utf8')
        .toString('base64url');
      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        redirect: 'error',
        method: 'POST',
        headers: { authorization: `Bearer ${at}`, 'content-type': 'application/json' },
        body: JSON.stringify({ raw }),
      });
      if (!r.ok) {
        const body = await r.text().catch(() => '');
        // 401/403 多为授权失效 —— 永久错误，应告警并暂停发送（PRD 18 章）
        return { ok: false, permanent: r.status === 401 || r.status === 403 || r.status === 400,
                 error: `HTTP ${r.status} ${body.slice(0, 200)}` };
      }
      const j: any = await r.json();
      return { ok: true, providerId: String(j.id ?? '') };
    } catch (e: any) {
      return { ok: false, permanent: !!e?.permanent, error: String(e?.message ?? e).slice(0, 300) };
    }
  };
}

/** 按环境变量判断实际生效的通道（不读取、不返回任何凭证值）；后台「消息渠道 → 邮件」与 worker 共用。 */
export function resolveMailTransport(env: NodeJS.ProcessEnv = process.env): { kind: MailerKind; note?: string } {
  const kind = (env.MAIL_TRANSPORT ?? '') as MailerKind;
  if (kind === 'gmail' || (!kind && env.GMAIL_REFRESH_TOKEN))
    return env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN && env.MAIL_FROM ? { kind: 'gmail' }
      : { kind: 'file', note: 'Gmail OAuth 凭证不完整（需 GMAIL_CLIENT_ID/SECRET/REFRESH_TOKEN 与 MAIL_FROM），已回落到落盘通道' };
  if (kind === 'smtp' || (!kind && env.SMTP_PASS))
    return env.SMTP_USER && env.SMTP_PASS ? { kind: 'smtp' }
      : { kind: 'file', note: 'SMTP 凭证不完整（需 SMTP_USER/SMTP_PASS），已回落到落盘通道' };
  return { kind: 'file', note: '未配置投递通道，邮件将落盘为 .eml 而不发送' };
}

/** 按环境变量装配通道。未配置凭证时回落到 file，并由调用方提示。 */
export function mailerFromEnv(outDir: string): { mailer: Mailer; kind: MailerKind; note?: string } {
  const r = resolveMailTransport();
  const from = process.env.MAIL_FROM ?? '';
  if (r.kind === 'gmail') {
    const { GMAIL_CLIENT_ID: id, GMAIL_CLIENT_SECRET: secret, GMAIL_REFRESH_TOKEN: rt } = process.env;
    return { mailer: gmailApiMailer({ clientId: id!, clientSecret: secret!, refreshToken: rt!, from }), kind: 'gmail' };
  }
  if (r.kind === 'smtp') {
    const { SMTP_USER: user, SMTP_PASS: pass, SMTP_HOST: host, SMTP_PORT: port } = process.env;
    return { mailer: smtpMailer({ user: user!, pass: pass!, host, port: port ? +port : undefined, from: from || user! }), kind: 'smtp' };
  }
  return { mailer: fileMailer(outDir, from || 'brief@localhost'), kind: 'file', note: r.note };
}
