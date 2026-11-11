#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolveSecret } from '../../../packages/web/src/secrets.ts';
import { readyTelegramDb } from '../../../packages/telegram/src/db.ts';

/**
 * 看门狗（docs/telegram-collector-watchdog-design.md）：Python worker 通过 fd 3 管道报告进度，
 * 超过 STALL_MS 没有进度就强制结束它，supervisor 以退出码 1 结束，交给 systemd Restart=on-failure 重启。
 * 2026-11-07：断线后某个 Telethon 请求永不返回，进程存活但采集停摆 10.5 小时，原 supervisor 只在子进程退出时才有反应。
 * 只有 systemd 主动停止（本进程收到 SIGTERM/SIGINT）时以 0 退出；子进程任何其他方式的退出都以 1 结束，确保会被重启。
 */
const STALL_MS = Number(process.env.TELEGRAM_WATCHDOG_STALL_MS ?? 20 * 60_000);
const CHECK_MS = Number(process.env.TELEGRAM_WATCHDOG_CHECK_MS ?? 30_000);
const KILL_GRACE_MS = Number(process.env.TELEGRAM_WATCHDOG_KILL_GRACE_MS ?? 30_000);

const apiId=resolveSecret('TELEGRAM_API_ID'), apiHash=resolveSecret('TELEGRAM_API_HASH'), phone=resolveSecret('TELEGRAM_PHONE');
if(!apiId||!/^\d+$/.test(apiId)||!apiHash) throw new Error('Telegram 凭据未完整配置到共享密钥库');
const db=readyTelegramDb();db.close();
const python=process.env.TELEGRAM_PYTHON??'./telegram-worker/.venv/bin/python';
const child=spawn(python,['-m','briefing_telegram.worker'],{
  cwd:process.cwd(),stdio:['inherit','inherit','inherit','pipe'],env:{...process.env,TELEGRAM_API_ID:apiId,TELEGRAM_API_HASH:apiHash,TELEGRAM_PHONE:phone??'',
    TELEGRAM_DATABASE_PATH:process.env.TELEGRAM_DATABASE_PATH??'./data/telegram.sqlite3',TELEGRAM_SESSION_PATH:process.env.TELEGRAM_SESSION_PATH??'./data/telegram',
    TELEGRAM_LOGIN_SOCKET:process.env.TELEGRAM_LOGIN_SOCKET??'./data/telegram-login.sock',TELEGRAM_PROGRESS_FD:'3'},
});

// 单调时钟计时：不受系统时间调整影响，也不依赖 SQLite（数据库忙或损坏时看门狗照常工作）
let lastProgress = performance.now();
let stopRequested = false, watchdogFired = false;
let killTimer: NodeJS.Timeout | null = null;
const alive = () => child.exitCode === null && child.signalCode === null;
/** 看门狗与主动停止共用：先发信号，宽限期后仍未退出则 SIGKILL。 */
const terminate = (signal: NodeJS.Signals) => {
  if (!alive()) return;
  child.kill(signal);
  killTimer ??= setTimeout(() => { if (alive()) child.kill('SIGKILL'); }, KILL_GRACE_MS);
};
const progressPipe = child.stdio[3];
progressPipe?.on('data', () => { lastProgress = performance.now(); });
progressPipe?.on('error', () => { /* 子进程退出后管道关闭，忽略 */ });

const watchdog = setInterval(() => {
  if (stopRequested || watchdogFired || !alive()) return;
  const idle = performance.now() - lastProgress;
  if (idle < STALL_MS) return;
  watchdogFired = true;
  console.error(`Telegram 采集器 ${Math.round(idle / 60_000)} 分钟没有进度，判定为卡死，强制结束后由 systemd 重启`);
  terminate('SIGTERM');
}, CHECK_MS);

for (const signal of ['SIGINT', 'SIGTERM'] as NodeJS.Signals[]) process.on(signal, () => { stopRequested = true; terminate(signal); });
child.on('exit', (code, signal) => {
  clearInterval(watchdog);
  if (killTimer) clearTimeout(killTimer);
  // systemd 主动停止优先：即使看门狗已先触发，停止服务也应以 0 结束
  if (stopRequested) process.exit(0);
  console.error(`Telegram 采集器退出（${watchdogFired ? '看门狗终止' : signal ? `信号 ${signal}` : `退出码 ${code}`}），以失败状态结束以便 systemd 重启`);
  process.exit(1);
});
child.on('error', e => { clearInterval(watchdog); console.error(`无法启动 Telegram 采集器：${e.message}`); process.exit(1); });
