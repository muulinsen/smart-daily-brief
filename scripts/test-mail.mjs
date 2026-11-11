#!/usr/bin/env node
// 发信凭证自测：node scripts/test-mail.mjs
// 从环境变量读配置，发一封最小测试信，不碰数据库、不影响简报。
import { mailerFromEnv } from '../packages/templates/src/mailer.ts';
import { checkEmail } from '../packages/templates/src/email.ts';

const to = process.env.MAIL_TO;
if (!to) { console.error('未设置 MAIL_TO'); process.exit(1); }

const { mailer, kind, note } = mailerFromEnv(process.env.MAIL_OUT_DIR ?? './data/outbox');
console.log(`通道 ${kind}${note ? ' —— ' + note : ''}`);
console.log(`发信人 ${process.env.MAIL_FROM ?? process.env.SMTP_USER ?? '(未设置)'} → 收件人 ${to}\n`);

const html = `<!doctype html><html><body style="margin:0;background:#f4f6f8">
<table width="100%"><tr><td align="center" style="padding:20px">
<table style="max-width:760px;background:#fff;border:1px solid #dfe4ea;border-radius:6px">
<tr><td style="padding:20px;font:15px/1.6 -apple-system,'PingFang SC',sans-serif;color:#1f2933">
<div style="font-size:18px;font-weight:700">十六源简报 · 发信通道自测</div>
<p>如果你能正常看到这段文字与下面的链接，说明 HTML 渲染、中文编码与投递通道都工作正常。</p>
<p><a href="https://linux.do" style="color:#1b5fa8">测试链接</a></p>
<p style="color:#5b6875;font-size:13px">发送时间 ${new Date().toISOString()}</p>
</td></tr></table></td></tr></table></body></html>`;
const text = `十六源简报 · 发信通道自测\n\n若纯文本部分正常显示，说明 multipart/alternative 结构正确。\n发送时间 ${new Date().toISOString()}\n`;

const errs = checkEmail(html, text);
if (errs.length) { console.error('邮件自检未通过：', errs.join('; ')); process.exit(1); }

const r = await mailer({ to, subject: '十六源简报｜发信通道自测', text, html,
                         headers: { 'X-Brief-Environment': 'test' } });
if (r.ok) {
  console.log(`✅ 发送成功  id=${r.providerId}`);
  if (kind === 'file') console.log('   （落盘通道：请到 MAIL_OUT_DIR 查看 .eml）');
  else console.log('   请检查收件箱，确认中文主题、HTML 排版与链接均正常。');
} else {
  console.error(`❌ 发送失败${r.permanent ? '（永久错误，不应重试）' : '（临时错误，可重试）'}`);
  console.error(`   ${r.error}`);
  if (/535|BadCredentials/.test(r.error ?? ''))
    console.error('\n   535 通常意味着：未开两步验证、密码复制不全、或用了账号登录密码而非应用专用密码。');
  process.exit(1);
}
