import type { CompleteRequest, CompleteResult, Provider } from './types.ts';
import { ProviderError } from './types.ts';

/**
 * 供应商调用的瞬时故障重试。
 *
 * 2026-10-09 早报：上游短暂断网，复核的每条调用都立即失败两次（两次之间没有任何等待），
 * 155 条全部落入待复核，完整性门禁阻断发送。这里在适配器外面统一加退避重试，
 * triage / review / compose / Telegram 总结都会受益，上层的「缩短输入重试」逻辑不变。
 *
 * 断网持续时不能让每条调用都把退避走完：并发 3 × 155 条 × 每条近一分钟会撞上
 * brief-run 的 30 分钟超时。所以连续 OUTAGE_THRESHOLD 条调用重试耗尽后判定为整体中断，
 * 之后的调用不再等待、直接失败，交给 systemd 的 5 分钟延迟重跑；任意一次成功即恢复。
 */

/** 只有这些错误值得原样重发；bad_request / auth / refusal 重发也不会变。truncated 由上层加大输出上限处理。 */
const TRANSIENT = new Set<ProviderError['kind']>(['network', 'timeout', 'server', 'rate_limited']);

export const DEFAULT_RETRY_DELAYS_MS = [5_000, 15_000, 45_000];
const OUTAGE_THRESHOLD = 3;
const MAX_RETRY_AFTER_MS = 120_000;

export type RetryOptions = {
  delaysMs?: number[];
  sleep?: (ms: number) => Promise<void>;
  log?: (line: string) => void;
};

export function isTransient(e: unknown): e is ProviderError {
  return e instanceof ProviderError && TRANSIENT.has(e.kind);
}

/**
 * 429 若带 Retry-After 秒数则按它等，否则按退避表；上限 2 分钟，避免单条调用卡死整轮。
 * 秒数由适配器在丢弃响应正文前解析进 retryAfterSec（响应头优先，头无效时取正文），这里不再读 message。
 */
function waitFor(e: ProviderError, fallback: number): number {
  if (e.kind === 'rate_limited' && e.retryAfterSec !== undefined) return Math.min(e.retryAfterSec * 1000, MAX_RETRY_AFTER_MS);
  return fallback;
}

/** 可被取消的等待：截止时间到达时立即结束，不再空等退避。 */
function abortableSleep(sleep: (ms: number) => Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) return sleep(ms);
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>(resolve => {
    const done = () => { signal.removeEventListener('abort', done); resolve(); };
    signal.addEventListener('abort', done, { once: true });
    sleep(ms).then(done);
  });
}

export function withTransientRetry(inner: Provider, opts: RetryOptions = {}): Provider {
  const delays = opts.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const log = opts.log ?? ((line: string) => console.warn(line));
  let exhaustedInARow = 0;

  return {
    get name() { return inner.name; },
    get model() { return inner.model; },
    get strictness() { return inner.strictness; },
    async complete(req: CompleteRequest): Promise<CompleteResult> {
      const budget = exhaustedInARow >= OUTAGE_THRESHOLD ? [] : delays;
      for (let i = 0; ; i++) {
        try {
          const res = await inner.complete(req);
          exhaustedInARow = 0;
          return res;
        } catch (e) {
          if (!isTransient(e) || e.budgetExhausted || req.signal?.aborted) throw e;
          if (i >= budget.length) {
            exhaustedInARow++;
            if (exhaustedInARow === OUTAGE_THRESHOLD)
              log(`AI 供应商连续 ${OUTAGE_THRESHOLD} 次调用重试后仍失败（${e.kind}），判定为上游中断，后续调用不再等待`);
            throw e;
          }
          const ms = waitFor(e, budget[i]!);
          // 只记录错误类型与状态码：上游响应正文可能回显请求内容或凭证
          log(`AI 调用瞬时失败（${e.kind}${e.status ? ` HTTP ${e.status}` : ''}），${Math.round(ms / 1000)} 秒后第 ${i + 1}/${budget.length} 次重试`);
          await abortableSleep(sleep, ms, req.signal);
          if (req.signal?.aborted) throw e;
        }
      }
    },
  };
}
