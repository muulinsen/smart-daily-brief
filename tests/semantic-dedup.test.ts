import { resolveSemanticDuplicates, suspectDuplicatePairs } from '../packages/ai/src/semantic-dedup.ts';
import type { CompleteRequest, CompleteResult, Provider } from '../packages/ai/src/types.ts';

let fail = 0;
const ok = (name: string, value: boolean) => { if (!value) fail++; console.log(`  ${value ? '✅' : '❌'} ${name}`); };
const item = (id: string, title: string, eventKey: string) => ({ candidateId: id, title, body: title, eventKey, section: 'ai_tech', mandatoryClass: 'none' });
const provider = (same: boolean): Provider => ({
  name: 'mock', model: 'l1-test', strictness: 'strict',
  async complete(_req: CompleteRequest): Promise<CompleteResult> {
    return { data: { same_event: same, confidence: .95, reason: same ? '共同公告事实' : '仅主题相同' }, responseId: 'r1', model: 'l1-test', usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0, cacheWriteTokens: 0 } };
  },
});
const a = item('a', 'Codex Pro $200 subscriptions re-opening and usage changes', 'x-pro-subscription');
const b = item('b', 'Codex 重新开放 Pro $200 订阅并调整用量计算方式', 'tg-codex-quota');
ok('程序先筛出疑似重复对', suspectDuplicatePairs([a, b]).length === 1);
const yes = await resolveSemanticDuplicates([a, b], provider(true));
ok('L1 判定同一事件后统一事件键', yes.items[0]?.eventKey === yes.items[1]?.eventKey);
const no = await resolveSemanticDuplicates([a, b], provider(false));
ok('L1 判定不同事件时保持事件键分离', no.items[0]?.eventKey !== no.items[1]?.eventKey);
console.log(fail ? `❌ ${fail} 项失败` : '✅ 全部通过');
process.exit(fail ? 1 : 0);
