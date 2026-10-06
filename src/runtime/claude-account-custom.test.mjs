// claude-account.mjs 的 custom（第三方 Anthropic 兼容端点）支持测试。
//
// 注意：config/index.mjs 是单例，首次 import 即固化 CONFIG_PATH——所以「磁盘初始状态」
// 类用例（init 兼容/规范化/播种）必须用独立子进程验证（spawnCheck）；其余行为类用例
// 共享一个主实例，用模块 API（setActive/updateAccount/addAccount）驱动状态。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const DIRS = [];

function scrubEnv() {
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
}

// 独立子进程：写 config → import 模块 → 执行 body → 回传 JSON（body 里 console.log(JSON.stringify(...))）
function spawnCheck(cfg, body) {
  const d = mkdtempSync(join(tmpdir(), 'wb-ca-'));
  DIRS.push(d);
  writeFileSync(join(d, 'config.json'), JSON.stringify({ token: 'x'.repeat(32), ...cfg }, null, 2));
  const script = `
    const m = await import(${JSON.stringify(pathToFileURL(join(REPO, 'src/runtime/claude-account.mjs')).href)});
    ${body}
  `;
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, BRIDGE_DATA_ROOT: d, CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_API_KEY: '' },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim().split('\n').pop());
}

const CUSTOM = { id: 'a-custom', label: 'DeepSeek', type: 'custom', token: '', baseUrl: 'https://api.deepseek.com/anthropic/', apiKey: 'sk-ds-abcdef123456', model: 'deepseek-chat' };
const OAUTH = { id: 'a-oauth', label: '默认账号', token: 'sk-ant-oat-example' };

// ---------- 磁盘初始状态类（子进程隔离） ----------

test('init 保留 custom 字段（旧版 map 丢字段的回归锁）；尾斜杠去掉', () => {
  const r = spawnCheck({ claudeAccounts: [CUSTOM, OAUTH], claudeActiveAccount: 'a-custom' }, `
    const v = m.listAccounts().find((a) => a.id === 'a-custom');
    const live = m.getActiveAccount();
    console.log(JSON.stringify({ type: v.type, baseUrl: v.baseUrl, model: v.model, hasKey: v.hasKey, keyTail: v.keyTail, leaked: 'apiKey' in v, liveKey: live.apiKey, liveUrl: live.baseUrl }));
  `);
  assert.equal(r.type, 'custom');
  assert.equal(r.baseUrl, 'https://api.deepseek.com/anthropic');
  assert.equal(r.model, 'deepseek-chat');
  assert.equal(r.hasKey, true);
  assert.equal(r.keyTail, '123456');
  assert.equal(r.leaked, false, 'apiKey 不得明文外泄');
  assert.equal(r.liveKey, 'sk-ds-abcdef123456');
  assert.equal(r.liveUrl, 'https://api.deepseek.com/anthropic');
});

test('旧条目（无 type）视为 oauth；baseUrl 剥掉误填的 /v1；model 缺省空串', () => {
  const r = spawnCheck({ claudeAccounts: [{ id: 'a-old', label: '旧', token: 'sk-ant-oat-old' }, { id: 'a-c2', label: 'C', type: 'custom', baseUrl: 'https://x.example.com/v1/', apiKey: 'sk-x-123456' }], claudeActiveAccount: 'a-c2' }, `
    const old = m.listAccounts().find((a) => a.id === 'a-old');
    const c = m.listAccounts().find((a) => a.id === 'a-c2');
    console.log(JSON.stringify({ oldType: old.type, oldHasToken: old.hasToken, oldTail: old.tokenTail, baseUrl: c.baseUrl, model: c.model }));
  `);
  assert.equal(r.oldType, 'oauth');
  assert.equal(r.oldHasToken, true);
  assert.equal(r.oldTail, 'at-old');
  assert.equal(r.baseUrl, 'https://x.example.com');
  assert.equal(r.model, '');
});

test('无 claudeAccounts → 播种默认账号（OAUTH 空）→ claudeEngineEnv 走 null 继承路径', () => {
  const r = spawnCheck({}, `
    console.log(JSON.stringify({ env: m.claudeEngineEnv(null), accounts: m.listAccounts().length }));
  `);
  assert.equal(r.env, null);
  assert.equal(r.accounts, 1);
});

// ---------- 行为类（共享主实例，API 驱动状态） ----------

const m = await load();
function load() {
  const d = mkdtempSync(join(tmpdir(), 'wb-ca-'));
  DIRS.push(d);
  scrubEnv();
  process.env.BRIDGE_DATA_ROOT = d;
  writeFileSync(join(d, 'config.json'), JSON.stringify({ token: 'x'.repeat(32), claudeAccounts: [CUSTOM, OAUTH], claudeActiveAccount: 'a-custom' }, null, 2));
  return import('../runtime/claude-account.mjs');
}

test('claudeEngineEnv：custom 注入 BASE_URL/AUTH_TOKEN/模型五件套并删除本机凭据；process.env 不被污染', () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-secret';
  process.env.ANTHROPIC_API_KEY = 'sk-ant-api-secret';
  try {
    const env = m.claudeEngineEnv({ configDir: '/tmp/cfg' });
    assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.deepseek.com/anthropic');
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-ds-abcdef123456');
    for (const k of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL']) {
      assert.equal(env[k], 'deepseek-chat', k);
    }
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined, 'OAUTH 不得发给第三方端点');
    assert.equal(env.ANTHROPIC_API_KEY, undefined, 'API_KEY 不得发给第三方端点');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/tmp/cfg');
    assert.equal(process.env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-secret', '副本上删，真身不动');
    assert.equal(process.env.ANTHROPIC_API_KEY, 'sk-ant-api-secret');
  } finally { scrubEnv(); }
});

test('claudeEngineEnv：model 留空（update 清空）时不设模型变量，仍删本机凭据', () => {
  assert.equal(m.updateAccount('a-custom', { model: '' }).ok, true);
  scrubEnv();
  process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat-secret';
  try {
    const env = m.claudeEngineEnv(null);
    assert.equal(env.ANTHROPIC_MODEL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-ds-abcdef123456');
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  } finally { scrubEnv(); }
  assert.equal(m.updateAccount('a-custom', { model: 'deepseek-chat' }).ok, true);
});

test('claudeEngineEnv：oauth 激活时行为与旧版一致（注入 OAUTH）', () => {
  m.setActive('a-oauth');
  const env = m.claudeEngineEnv(null);
  assert.notEqual(env, null);
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, 'sk-ant-oat-example');
  assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  m.setActive('a-custom');
});

test('engineSig：custom/oauth 互异；model 变则签名变（warm CLI 防误复用）', () => {
  const sigCustom = m.engineSig();
  assert.ok(sigCustom.startsWith('c:'));
  m.setActive('a-oauth');
  assert.ok(m.engineSig().startsWith('o:'));
  assert.notEqual(m.engineSig(), sigCustom);
  m.setActive('a-custom');
  assert.equal(m.engineSig(), sigCustom);
  m.updateAccount('a-custom', { model: 'deepseek-reasoner' });
  assert.notEqual(m.engineSig(), sigCustom);
  m.updateAccount('a-custom', { model: 'deepseek-chat' });
});

test('activeModelOverride / activeEngineInfo / activeAuth / activeToken', () => {
  assert.equal(m.activeModelOverride(), 'deepseek-chat');
  assert.deepEqual(m.activeEngineInfo(), { custom: true, model: 'deepseek-chat', models: ['deepseek-chat'] });
  assert.equal(m.activeAuth().type, 'custom');
  m.setActive('a-oauth');
  assert.equal(m.activeModelOverride(), '');
  assert.deepEqual(m.activeEngineInfo(), { custom: false, model: '', models: [] });
  assert.equal(m.activeAuth().type, 'oauth');
  assert.equal(m.activeToken(), 'sk-ant-oat-example');
  m.setActive('a-custom');
});

test('addAccount：custom 校验必填、无 model 给 warning；oauth 校验 token', () => {
  assert.ok(m.addAccount({ label: 'x', type: 'custom', baseUrl: 'ftp://bad', apiKey: 'k' }).error);
  assert.ok(m.addAccount({ label: 'x', type: 'custom', baseUrl: 'https://ok.example.com', apiKey: '' }).error);
  const noModel = m.addAccount({ label: 'K', type: 'custom', baseUrl: 'https://api.moonshot.cn/anthropic', apiKey: 'sk-kimi-x' });
  assert.equal(noModel.ok, true);
  assert.ok(noModel.warning, 'model 留空应有 warning');
  assert.ok(m.addAccount({ label: 'O', type: 'oauth', token: '' }).error);
  const ok = m.addAccount({ label: 'G', type: 'custom', baseUrl: 'https://open.bigmodel.cn/api/anthropic', apiKey: 'sk-glm-x', model: 'glm-4.6' });
  assert.equal(ok.ok, true);
  assert.ok(!ok.warning);
});

test('updateAccount：apiKey 留空 = 不改；类型互转需过校验', () => {
  assert.equal(m.updateAccount('a-custom', { apiKey: '' }).ok, true);
  assert.equal(m.getActiveAccount().apiKey, 'sk-ds-abcdef123456', '空 apiKey 不得清掉');
  assert.ok(m.updateAccount('a-custom', { type: 'oauth' }).error, '无 token 转 oauth 应报错');
  assert.equal(m.getActiveAccount().type, 'custom');
  assert.ok(m.updateAccount('a-custom', { type: 'custom', baseUrl: 'bad' }).error, '非法 baseUrl 应报错');
});

test('probeCustom：输入缺失走 input 分支（不联网）', async () => {
  const bad = await m.probeCustom({ baseUrl: '', apiKey: '' });
  assert.equal(bad.kind, 'input');
  assert.equal(bad.ok, false);
});

// ---------- v0.1.2：模型列表（models 数组）+ 拉取 + 聊天校验分流 ----------

test('init：旧 custom 条目只有 model 单值 → 读时自动升级为单元素 models', () => {
  const r = spawnCheck({ claudeAccounts: [{ id: 'a-c', label: 'M', type: 'custom', baseUrl: 'https://m.example.com/anthropic', apiKey: 'sk-m-999999', model: 'mimo-v2.6-pro' }], claudeActiveAccount: 'a-c' }, `
    const v = m.listAccounts().find((a) => a.id === 'a-c');
    console.log(JSON.stringify({ models: v.models, model: v.model, engine: m.activeEngineInfo() }));
  `);
  assert.deepEqual(r.models, ['mimo-v2.6-pro']);
  assert.equal(r.model, 'mimo-v2.6-pro');
  assert.deepEqual(r.engine, { custom: true, model: 'mimo-v2.6-pro', models: ['mimo-v2.6-pro'] });
});

test('addAccount：models 数组清洗（trim/去空/去重/封顶 20），model 派生为首位', () => {
  const r = m.addAccount({ label: '列表', type: 'custom', baseUrl: 'https://lst.example.com/anthropic', apiKey: 'sk-ls-1', models: [' a ', 'a', '', 'b', null, 3] });
  assert.equal(r.ok, true);
  const a = m.listAccounts().find((x) => x.label === '列表');
  assert.deepEqual(a.models, ['a', 'b']);
  assert.equal(a.model, 'a');
  m.addAccount({ label: '封顶', type: 'custom', baseUrl: 'https://cap.example.com/anthropic', apiKey: 'sk-cp-1', models: Array.from({ length: 30 }, (_, i) => 'm' + i) });
  const cap = m.listAccounts().find((x) => x.label === '封顶');
  assert.equal(cap.models.length, 20);
});

test('updateAccount：models 整表替换；只传 model 按旧语义视为单元素；models/model 都不传则不动', () => {
  const id = m.listAccounts().find((x) => x.label === '列表').id;
  const cur = () => m.listAccounts().find((x) => x.id === id);
  m.updateAccount(id, { models: ['x1', 'x2'] });
  assert.deepEqual(cur().models, ['x1', 'x2']);
  m.updateAccount(id, { model: 'solo' });
  assert.deepEqual(cur().models, ['solo']);
  m.updateAccount(id, { label: '列表改名' });
  assert.deepEqual(cur().models, ['solo'], '不带 models/model 的更新不得动列表');
  m.updateAccount(id, { models: [] });
  assert.deepEqual(cur().models, []);
});

test('resolveChatModel：custom 激活按账号列表校验；oauth 走官方白名单；非法一律空串', async () => {
  // 当前主实例激活 a-custom（models 被 update 清空过 → 先补上）
  m.updateAccount('a-custom', { models: ['deepseek-chat', 'deepseek-reasoner'] });
  assert.equal(m.resolveChatModel('deepseek-reasoner'), 'deepseek-reasoner');
  assert.equal(m.resolveChatModel(' claude-opus-5-5 '), '', 'custom 时官方 id 不在账号列表 → 空');
  assert.equal(m.resolveChatModel('不存在的模型'), '');
  assert.equal(m.resolveChatModel(undefined), '');
  // 切到 oauth：官方白名单恢复生效
  const official = [...(await import('../config/capabilities.mjs')).CLAUDE_MODELS][0];
  m.setActive('a-oauth');
  assert.equal(m.resolveChatModel(official), official);
  assert.equal(m.resolveChatModel('mimo-v2.6-pro'), '', 'oauth 时第三方 id 非法 → 空');
  m.setActive('a-custom');
  m.updateAccount('a-custom', { models: ['deepseek-chat'] });
});

test('fetchCustomModels：data[].id 解析 / 非 200 / 网络错误（mock fetch，不联网）', async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ data: [{ id: 'mimo-v2.6-pro' }, { id: 'mimo-v2.6-flash' }, { name: 'glm-5' }, '裸字符串', {}] }) });
    const ok = await m.fetchCustomModels({ baseUrl: 'https://x.example.com/anthropic', apiKey: 'sk-1' });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.models, ['mimo-v2.6-pro', 'mimo-v2.6-flash', 'glm-5', '裸字符串'], '去重 + 容忍多种元素形状');
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}) });
    const nf = await m.fetchCustomModels({ baseUrl: 'https://x.example.com/anthropic', apiKey: 'sk-1' });
    assert.equal(nf.ok, false);
    assert.equal(nf.kind, 'http');
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    const net = await m.fetchCustomModels({ baseUrl: 'https://x.example.com/anthropic', apiKey: 'sk-1' });
    assert.equal(net.ok, false);
    assert.equal(net.kind, 'network');
    const bad = await m.fetchCustomModels({ baseUrl: '', apiKey: '' });
    assert.equal(bad.kind, 'input');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('cleanup', () => { for (const d of DIRS) { try { rmSync(d, { recursive: true, force: true }); } catch {} } assert.ok(true); });
