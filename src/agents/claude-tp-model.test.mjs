// resolveTpModel（agents/claude.mjs）：第三方/官方模型选择分流——
//   custom 激活 → 请求模型在账号列表里就用之，否则回落 models[0]（第三方 id 绝不过 to1M）；
//   oauth → 官方 id 照旧过 to1M（1M 兄弟档）。
// 纯函数直测：claude.mjs 顶层 import 有先例（bg-hold.test.mjs），无致命副作用。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTpModel } from './claude.mjs';
import { CLAUDE_MODELS } from '../config/capabilities.mjs';

const official = [...CLAUDE_MODELS].find((id) => !id.includes('['));
const oneM = [...CLAUDE_MODELS].find((id) => id.includes('['));

test('custom：合法第三方 id 原样返回；非法/空回落账号默认', () => {
  const tp = { custom: true, models: ['mimo-v2.6-pro', 'mimo-v2.6-flash'] };
  assert.equal(resolveTpModel(tp, 'mimo-v2.6-flash'), 'mimo-v2.6-flash');
  assert.equal(resolveTpModel(tp, 'claude-opus-5-5'), 'mimo-v2.6-pro', '官方 id 不在账号列表 → 回落默认');
  assert.equal(resolveTpModel(tp, ''), 'mimo-v2.6-pro');
  assert.equal(resolveTpModel(tp, undefined), 'mimo-v2.6-pro');
});

test('custom：models 缺失/为空 → 空串（调用方语义：以账号配置为准，env 五件套兜底）', () => {
  assert.equal(resolveTpModel({ custom: true, models: [] }, 'anything'), '');
  assert.equal(resolveTpModel({ custom: true }, 'anything'), '');
});

test('oauth：官方 id 过 to1M（1M 档加 [1m] 后缀）；普通 id 原样', () => {
  const tp = { custom: false, models: [] };
  assert.equal(resolveTpModel(tp, oneM), oneM, '1M 档 id 加后缀');
  assert.ok(resolveTpModel(tp, oneM).endsWith('[1m]'));
  assert.equal(resolveTpModel(tp, official), official);
  assert.equal(resolveTpModel(null, official), official, '无引擎信息 = oauth 语义');
});
