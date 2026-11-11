#!/usr/bin/env node
// 生成后台凭证：node scripts/admin-setup.mjs '<你的口令>'
import { hashPassword, generateTotpSecret, totpUri, totpAt } from '../packages/web/src/auth.ts';
const pw = process.argv[2];
if (!pw) { console.error('用法: node scripts/admin-setup.mjs \'<口令>\''); process.exit(1); }
if (pw.length < 12) console.error('⚠️  口令短于 12 位，建议加长\n');
const secret = generateTotpSecret();
console.log('把以下两行写入 /etc/briefing/env（0640 root:brief）：\n');
console.log(`ADMIN_PASSWORD_HASH='${hashPassword(pw)}'`);
console.log(`ADMIN_TOTP_SECRET=${secret}`);
console.log('\n用验证器 App 扫描或手动添加：');
console.log(totpUri(secret, process.env.MAIL_TO ?? 'admin'));
console.log(`\n当前验证码（用于验证配置）：${totpAt(secret, Math.floor(Date.now()/1000/30))}`);
