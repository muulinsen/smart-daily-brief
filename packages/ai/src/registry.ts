import type { Provider, ProviderConfig, ProviderName } from './types.ts';
import { ProviderError } from './types.ts';
import { withTransientRetry } from './retry.ts';

/**
 * 按配置构建供应商。适配器全部动态 import —— 只有实际用到的那家
 * 才会被加载进内存（896 MB 机器上这点很重要）。
 *
 * 新增厂商只需在这里加一个分支 + 一个适配器文件，上层零改动。
 * 真实供应商统一套上瞬时故障退避重试（见 retry.ts）；mock 不套，测试里模拟的故障不应真的等待。
 * 后台页面里的交互式调用传 { retry: false }：用户在等页面返回，失败应立即显示而不是转圈一分多钟。
 */
export async function createProvider(cfg: ProviderConfig, opts: { retry?: boolean; onDispatch?: () => void } = {}): Promise<Provider> {
  let p = await createAdapter(cfg);
  // onDispatch 在每一次实际请求（含瞬时重试）之前调用，可抛错阻止派发（预算 / 截止时间）
  if (opts.onDispatch) p = countingProvider(p, opts.onDispatch);
  return cfg.provider === 'mock' || opts.retry === false ? p : withTransientRetry(p);
}

function countingProvider(inner: Provider, onDispatch: () => void): Provider {
  return {
    get name() { return inner.name; },
    get model() { return inner.model; },
    get strictness() { return inner.strictness; },
    complete(req) { onDispatch(); return inner.complete(req); },
  };
}

async function createAdapter(cfg: ProviderConfig): Promise<Provider> {
  switch (cfg.provider) {
    case 'mock': {
      const { MockProvider } = await import('./providers/mock.ts');
      return new MockProvider(cfg);
    }
    case 'openai':
    case 'openai_compatible':
    case 'deepseek':
    case 'qwen': {
      const { OpenAICompatProvider } = await import('./providers/openai-compat.ts');
      return new OpenAICompatProvider(cfg);
    }
    case 'anthropic': {
      const { AnthropicProvider } = await import('./providers/anthropic.ts');
      return new AnthropicProvider(cfg);
    }
    case 'gemini': {
      const { GeminiProvider } = await import('./providers/gemini.ts');
      return new GeminiProvider(cfg);
    }
    default:
      throw new ProviderError('bad_request', '未知供应商类型');
  }
}

const KEY_ENV: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  openai_compatible: 'OPENAI_COMPAT_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  qwen: 'DASHSCOPE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY',
  mock: '',
};

/**
 * 从环境变量解析某一层级（L1/L2/L3）的供应商配置。
 * 层级可以指向不同厂商 —— 例如 L1 用便宜模型批量判定、
 * L2/L3 用强模型复核，这正是 PRD 15.1 分级调用的意图。
 */
export function providerFromEnv(tier: 'L1' | 'L2' | 'L3', env: NodeJS.ProcessEnv = process.env): ProviderConfig {
  const value = (name: string): string | undefined => {
    const v = env[name]?.trim();
    return v || undefined;
  };
  const l1Provider = (value('AI_L1_PROVIDER') ?? value('AI_PROVIDER') ?? 'mock') as ProviderName;
  const l1Model = value('AI_L1_MODEL') ?? '';
  const l1BaseUrl = value('AI_L1_BASE_URL') ?? value('AI_BASE_URL');
  const l1Strictness = value('AI_L1_STRICTNESS') as ProviderConfig['strictness'];

  const explicitProvider = tier === 'L1' ? value('AI_L1_PROVIDER') : value(`AI_${tier}_PROVIDER`);
  const provider = (tier === 'L1' ? l1Provider : explicitProvider ?? l1Provider) as ProviderName;
  const sameAsL1 = provider === l1Provider;
  const model = tier === 'L1'
    ? l1Model
    : value(`AI_${tier}_MODEL`) ?? l1Model;
  // L2/L3 选择“同 L1”时，OpenAI Compatible 必须连 Base URL 一起继承；
  // 显式换成另一厂商且未填地址时，则交给适配器使用该厂商官方默认地址。
  const baseUrl = tier === 'L1'
    ? l1BaseUrl
    : value(`AI_${tier}_BASE_URL`) ?? (sameAsL1 ? l1BaseUrl : undefined);
  const strictness = (tier === 'L1'
    ? l1Strictness
    : value(`AI_${tier}_STRICTNESS`) as ProviderConfig['strictness'] ?? (sameAsL1 ? l1Strictness : undefined));
  const keyName = KEY_ENV[provider];
  return {
    provider,
    model,
    apiKey: keyName ? env[keyName] : undefined,
    baseUrl,
    strictness,
  };
}
