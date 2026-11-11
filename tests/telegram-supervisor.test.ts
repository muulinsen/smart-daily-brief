// Telegram supervisor 看门狗：无进度时强制结束子进程并以 1 退出；有进度不误杀；systemd 停止时以 0 退出；子进程意外退出以 1 退出
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const dir = mkdtempSync(join(tmpdir(), 'tg-supervisor-'));
// 伪装成 python 的脚本：忽略参数，按 MODE 行为
const fake = join(dir, 'fake-python');
writeFileSync(fake, `#!/bin/sh
case "$FAKE_MODE" in
  stall) sleep 30 ;;
  stubborn) trap '' TERM; while true; do printf . >&3; sleep 0.1; done ;;
  progress) while true; do printf . >&3; sleep 0.1; done ;;
  exit0) exit 0 ;;
esac
`);
chmodSync(fake, 0o755);

const run = (mode: string, o: { stopAfterMs?: number } = {}) => new Promise<{ code: number | null; ms: number; out: string }>(resolve => {
  const t0 = Date.now();
  const p = spawn(process.execPath, ['apps/worker/src/telegram-supervisor.ts'], {
    env: { ...process.env, FAKE_MODE: mode, TELEGRAM_PYTHON: fake, TELEGRAM_API_ID: '1', TELEGRAM_API_HASH: 'h', TELEGRAM_PHONE: '',
      TELEGRAM_DATABASE_PATH: join(dir, `tg-${mode}.sqlite3`), SECRETS_PATH: join(dir, 'secrets.enc'),
      TELEGRAM_WATCHDOG_STALL_MS: '2500', TELEGRAM_WATCHDOG_CHECK_MS: '200', TELEGRAM_WATCHDOG_KILL_GRACE_MS: '500' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = ''; p.stdout!.on('data', b => out += b); p.stderr!.on('data', b => out += b);
  if (o.stopAfterMs) setTimeout(() => p.kill('SIGTERM'), o.stopAfterMs);
  const guard = setTimeout(() => p.kill('SIGKILL'), 30_000);
  p.on('exit', code => { clearTimeout(guard); resolve({ code, ms: Date.now() - t0, out }); });
});

try {
  const stall = await run('stall');
  assert.equal(stall.code, 1, `无进度场景：${stall.out}`); assert.ok(stall.out.includes('没有进度'), stall.out); assert.ok(stall.ms < 20_000, `看门狗触发过慢 ${stall.ms}ms`);
  console.log('  ✅ 子进程无进度：看门狗强制结束，supervisor 以 1 退出（systemd 会重启）');
  const live = await run('progress', { stopAfterMs: 6_000 });
  assert.equal(live.code, 0, `持续进度场景：${live.out}`); assert.ok(!live.out.includes('没有进度'), `持续进度场景被误杀：${live.out}`);
  console.log('  ✅ 子进程持续报告进度：超过阈值也不误杀；systemd 停止时以 0 退出');
  const stubborn = await run('stubborn', { stopAfterMs: 1_000 });
  assert.equal(stubborn.code, 0, `不响应 SIGTERM 场景：${stubborn.out}`); assert.ok(stubborn.ms < 15_000, `停止超时 ${stubborn.ms}ms`);
  console.log('  ✅ 主动停止时子进程不响应 SIGTERM：宽限期后强制结束，supervisor 以 0 退出');
  const quit = await run('exit0');
  assert.equal(quit.code, 1, `意外退出场景：${quit.out}`);
  console.log('  ✅ 子进程意外退出（即使退出码 0）：supervisor 以 1 退出');
  console.log('\n✅ 全部通过');
} finally { rmSync(dir, { recursive: true, force: true }); }
