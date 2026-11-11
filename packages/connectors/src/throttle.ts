/**
 * 主机分组令牌桶（实施方案 2.3）。
 * rsshub 组实测：单请求 0.87s 正常，连续请求退化至超时 → concurrency=1 + 8s 间隔。
 */
export type GroupCfg = {
  concurrency: number; min_interval_ms: number; timeout_ms: number; max_retries: number;
  jitter_ms?: number;
};

export class HostGroup {
  #active = 0;
  #lastStart = 0;
  #queue: Array<() => void> = [];
  name: string;
  cfg: GroupCfg;
  constructor(name: string, cfg: GroupCfg) { this.name = name; this.cfg = cfg; }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    await new Promise<void>(res => { this.#queue.push(res); this.#pump(); });
    const targetGap = this.cfg.min_interval_ms +
      (this.cfg.jitter_ms ? Math.floor(Math.random() * (this.cfg.jitter_ms + 1)) : 0);
    const gap = targetGap - (Date.now() - this.#lastStart);
    if (gap > 0) await new Promise(r => setTimeout(r, gap));
    this.#lastStart = Date.now();
    try { return await fn(); }
    finally { this.#active--; this.#pump(); }
  }
  /**
   * 只按最小间隔等待并更新最近一次请求时刻，不占并发名额（重定向的后续跳、通道回退用）。
   * 不会在持有本组许可时再排队等同组许可，因此不会死锁。
   */
  async pace(): Promise<void> {
    const targetGap = this.cfg.min_interval_ms +
      (this.cfg.jitter_ms ? Math.floor(Math.random() * (this.cfg.jitter_ms + 1)) : 0);
    const gap = targetGap - (Date.now() - this.#lastStart);
    this.#lastStart = Date.now() + Math.max(0, gap);
    if (gap > 0) await new Promise(r => setTimeout(r, gap));
  }
  #pump() {
    while (this.#queue.length && this.#active < this.cfg.concurrency) {
      this.#active++; this.#queue.shift()!();
    }
  }
}

export class Throttler {
  #groups = new Map<string, HostGroup>();
  #hostToGroup = new Map<string, string>();
  constructor(hostGroups: Record<string, GroupCfg & { hosts: string[] }>) {
    for (const [name, cfg] of Object.entries(hostGroups)) {
      this.#groups.set(name, new HostGroup(name, cfg));
      for (const h of cfg.hosts) this.#hostToGroup.set(h, name);
    }
  }
  groupFor(url: string, override?: string | null): HostGroup {
    if (override && this.#groups.has(override)) return this.#groups.get(override)!;
    let host = '';
    try { host = new URL(url).hostname; } catch { /* ignore */ }
    const name = this.#hostToGroup.get(host) ?? 'direct';
    return this.#groups.get(name) ?? this.#groups.values().next().value!;
  }
  run<T>(url: string, override: string | null | undefined, fn: () => Promise<T>) {
    return this.groupFor(url, override).run(fn);
  }
}
