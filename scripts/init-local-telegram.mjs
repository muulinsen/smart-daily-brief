#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';

const path=process.argv[2]??'./data/local-telegram.env';
if(existsSync(path)) throw new Error(`${path} 已存在，拒绝覆盖`);
mkdirSync('./data',{recursive:true,mode:0o700});
const content=[
  `APP_ENCRYPTION_KEY=${randomBytes(32).toString('base64url')}`,
  'SECRETS_PATH=./data/secrets.enc',
  'DATABASE_PATH=./data/brief.db',
  'TELEGRAM_DATABASE_PATH=./data/telegram.sqlite3',
  'TELEGRAM_SESSION_PATH=./data/telegram',
  'TELEGRAM_LOGIN_SOCKET=./data/telegram-login.sock',
  'TELEGRAM_PYTHON=./telegram-worker/.venv/bin/python',
].join('\n')+'\n';
writeFileSync(path,content,{mode:0o600,flag:'wx'});chmodSync(path,0o600);
console.log(`已创建 ${path}（0600）；内容未输出。`);
