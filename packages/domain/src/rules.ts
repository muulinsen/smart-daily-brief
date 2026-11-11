import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { createHash } from 'node:crypto';

export type Rules = any;
export type Sources = any;

let _rules: Rules | null = null;
let _rulesRaw = '';
export function loadRules(path = './config/rules.yaml'): Rules {
  if (!_rules) { _rulesRaw = readFileSync(path, 'utf8'); _rules = parse(_rulesRaw); }
  return _rules;
}
export const rulesRaw = () => _rulesRaw;
export const rulesHash = () => createHash('sha256').update(_rulesRaw).digest('hex');

let _sources: Sources | null = null;
export function loadSources(path = './config/sources.yaml'): Sources {
  if (!_sources) _sources = parse(readFileSync(path, 'utf8'));
  return _sources;
}

/** 把 YAML 里的 {regex, flags} 编译成 RegExp，flags 缺省为空。 */
export const re = (d: { regex: string; flags?: string }, extra = '') =>
  new RegExp(d.regex, (d.flags ?? '') + extra);
