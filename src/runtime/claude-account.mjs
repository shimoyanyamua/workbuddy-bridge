// Claude 账号切换（failover / 额度池 / 第三方端点）。
//
// 整个 bridge 的 Claude Agent SDK 用哪个上游，取决于注入子进程的环境变量。这里维护
// 一个「账号注册表 + 当前激活账号」，持久化到 config.json，并提供 claudeEngineEnv(ctx)——
// 每次跑 query() 时按【当前激活账号】现取凭据注进 env。切换是即时的、全局的
// （admin 对话 / 用户沙箱 / 定时路由都跟随）。
//
// 账号有两种类型：
//   oauth  —— Claude 订阅长期令牌（`claude setup-token` 生成），注入 CLAUDE_CODE_OAUTH_TOKEN；
//   custom —— Anthropic 兼容端点（Kimi / DeepSeek / GLM 等第三方），注入 ANTHROPIC_BASE_URL
//             + ANTHROPIC_AUTH_TOKEN（+ 模型五件套）。CLI 的认证优先级是
//             AUTH_TOKEN > API_KEY > OAUTH > 本机登录态，所以 AUTH_TOKEN 天然生效；
//             同时把 OAUTH/API_KEY 从 env 副本里删掉——本机凭据绝不发给第三方端点。
//
// 会话【共享】：所有账号仍用 ~/.claude（configDir 保持 null），切账号只换凭据——
// 一条对话可在切换后无缝续聊（A 号限流了切到 B 号接着聊同一个会话）。
//
// config.json 形状：
//   claudeAccounts: [{ id, label, type: 'oauth'|'custom', token, baseUrl, apiKey, model }]
//   claudeActiveAccount: <id>
// 向后兼容：旧条目无 type 视为 oauth。
// 迁移：若无 claudeAccounts 但有旧的 oauthToken，自动播种一个「默认账号」。

import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { CONFIG_PATH, OAUTH } from '../config/index.mjs';

let accounts = [];   // [{ id, label, type, token, baseUrl, apiKey, model }]
let activeId = '';

function loadRaw() {
  try { return JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch { return {}; }
}

// 只改这两个字段落盘，其余配置原样保留（别覆写 token/port 等）。
function persist() {
  const raw = loadRaw();
  raw.claudeAccounts = accounts;
  raw.claudeActiveAccount = activeId;
  try { writeFileSync(CONFIG_PATH, JSON.stringify(raw, null, 2)); } catch (e) { console.error('[claude-account] persist failed:', (e && e.message) || e); }
}

function newId() { return 'a-' + randomBytes(4).toString('hex'); }

// 规范化 baseUrl：去尾斜杠；剥掉用户常误填的尾部 /v1（CLI 自己拼 /v1/messages）。
function normalizeBase(u) {
  let b = String(u || '').trim().replace(/\/+$/, '');
  if (b.endsWith('/v1')) b = b.slice(0, -3);
  return b;
}

// 规范化一条账号：旧条目（无 type）视为 oauth；custom 字段全部保留（缺省空串）。
function normalizeAccount(a) {
  return {
    id: String(a.id || newId()),
    label: String(a.label || ''),
    type: a.type === 'custom' ? 'custom' : 'oauth',
    token: String(a.token || ''),
    baseUrl: normalizeBase(a.baseUrl),
    apiKey: String(a.apiKey || ''),
    model: String(a.model || '').trim(),
  };
}

function init() {
  const raw = loadRaw();
  if (Array.isArray(raw.claudeAccounts) && raw.claudeAccounts.length) {
    accounts = raw.claudeAccounts
      .filter((a) => a && typeof a === 'object')
      .map(normalizeAccount);
    activeId = (raw.claudeActiveAccount && accounts.some((a) => a.id === raw.claudeActiveAccount))
      ? raw.claudeActiveAccount : accounts[0].id;
  } else {
    // 从旧的 config.oauthToken 播种一个默认账号（token 可能为空——那就代表「用 ~/.claude
    // 里已登录的凭证」，不注入覆盖，行为与迁移前完全一致）。
    accounts = [normalizeAccount({ id: newId(), label: '默认账号', token: OAUTH || '' })];
    activeId = accounts[0].id;
    persist();
  }
}
init();

export function getActiveAccount() { return accounts.find((a) => a.id === activeId) || null; }

// 当前激活账号的 token（空串 = 不覆盖，沿用环境/登录态）。oauth 语义；status 等处仍在用。
export function activeToken() { const a = getActiveAccount(); return a ? a.token : ''; }

// 当前激活账号的认证视图；无效（custom 没 key）时返回 null。
export function activeAuth() {
  const a = getActiveAccount();
  if (!a) return null;
  if (a.type === 'custom') return a.apiKey ? { type: 'custom', baseUrl: a.baseUrl, apiKey: a.apiKey, model: a.model } : null;
  return { type: 'oauth', token: a.token };
}

// custom 激活且配了 model 时返回它——聊天 / 定时路由用它覆盖 UI 选的官方模型名。
export function activeModelOverride() {
  const a = getActiveAccount();
  return a && a.type === 'custom' && a.model ? a.model : '';
}

// 引擎身份签名：warm CLI 复用判定用。baseUrl/apiKey/model/token 任一变化都会换签名，
// 防止切换供应商后误用还停放在旧上游的 CLI 进程。
export function engineSig() {
  const a = getActiveAccount();
  if (!a) return '';
  return a.type === 'custom' ? ('c:' + a.baseUrl + '|' + a.apiKey + '|' + a.model) : ('o:' + a.token);
}

// /api/status 用：前端据此禁用模型选择器、显示当前第三方模型。
export function activeEngineInfo() {
  const a = getActiveAccount();
  if (!a || a.type !== 'custom' || !a.apiKey) return { custom: false, model: '' };
  return { custom: true, model: a.model };
}

// 给前端的安全视图：不外泄完整凭据，只给尾 6 位供辨认；custom 的 baseUrl/model 非敏感，明文回显。
export function listAccounts() {
  return accounts.map((a) => {
    const base = { id: a.id, label: a.label, active: a.id === activeId, type: a.type };
    if (a.type === 'custom') {
      return { ...base, baseUrl: a.baseUrl, model: a.model, hasKey: !!a.apiKey, keyTail: a.apiKey ? a.apiKey.slice(-6) : '' };
    }
    return { ...base, hasToken: !!a.token, tokenTail: a.token ? a.token.slice(-6) : '' };
  });
}

export function setActive(id) {
  if (!accounts.some((a) => a.id === id)) return { error: '无此账号' };
  activeId = id; persist();
  return { ok: true, active: activeId };
}

export function addAccount({ label, type, token, baseUrl, apiKey, model } = {}) {
  const l = String(label || '').trim() || ('账号 ' + (accounts.length + 1));
  if (type === 'custom') {
    const b = normalizeBase(baseUrl);
    if (!/^https?:\/\//.test(b)) return { error: '接口地址必须是 http(s):// 开头' };
    const k = String(apiKey || '').trim();
    if (!k) return { error: 'API Key 不能为空' };
    const m = String(model || '').trim();
    const id = newId();
    accounts.push({ id, label: l, type: 'custom', token: '', baseUrl: b, apiKey: k, model: m });
    persist();
    return { ok: true, id, ...(m ? {} : { warning: '模型名留空：若该端点不支持 claude-* 模型自动映射，请求会 404，建议填写' }) };
  }
  const t = String(token || '').trim();
  if (!t) return { error: 'token 不能为空（在该账号下跑 claude setup-token 获取）' };
  const id = newId();
  accounts.push({ id, label: l, type: 'oauth', token: t, baseUrl: '', apiKey: '', model: '' });
  persist();
  return { ok: true, id };
}

export function updateAccount(id, { label, type, token, baseUrl, apiKey, model } = {}) {
  const a = accounts.find((x) => x.id === id);
  if (!a) return { error: '无此账号' };
  if (typeof label === 'string' && label.trim()) a.label = label.trim();
  // 类型转换（前端表单允许切类型后保存）
  const wantType = type === 'custom' ? 'custom' : type === 'oauth' ? 'oauth' : a.type;
  if (wantType !== a.type) {
    if (wantType === 'custom') {
      const b = normalizeBase(typeof baseUrl === 'string' ? baseUrl : a.baseUrl);
      if (!/^https?:\/\//.test(b)) return { error: '接口地址必须是 http(s):// 开头' };
      if (!String(apiKey || '').trim() && !a.apiKey) return { error: 'API Key 不能为空' };
      a.type = 'custom'; a.baseUrl = b;
    } else {
      if (!String(token || '').trim() && !a.token) return { error: 'token 不能为空（在该账号下跑 claude setup-token 获取）' };
      a.type = 'oauth';
    }
  }
  if (a.type === 'custom') {
    if (typeof baseUrl === 'string' && baseUrl.trim()) {
      const b = normalizeBase(baseUrl);
      if (!/^https?:\/\//.test(b)) return { error: '接口地址必须是 http(s):// 开头' };
      a.baseUrl = b;
    }
    if (typeof apiKey === 'string' && apiKey.trim()) a.apiKey = apiKey.trim();   // 留空 = 不改
    if (typeof model === 'string') a.model = model.trim();                       // 可显式清空
  } else {
    if (typeof token === 'string' && token.trim()) a.token = token.trim();       // 留空 = 不改
  }
  persist();
  return { ok: true };
}

export function deleteAccount(id) {
  const i = accounts.findIndex((a) => a.id === id);
  if (i < 0) return { error: '无此账号' };
  if (accounts.length <= 1) return { error: '至少保留一个账号' };
  const wasActive = activeId === id;
  accounts.splice(i, 1);
  if (wasActive) activeId = accounts[0].id;
  persist();
  return { ok: true, active: activeId };
}

// 每次跑 Claude query() 时构造子进程 env：叠加当前激活账号的凭据 + 沙箱 configDir。
// custom 激活时注入 ANTHROPIC_BASE_URL / ANTHROPIC_AUTH_TOKEN / 模型五件套，并在副本上
// 删掉本机凭据（OAUTH / API_KEY）——它们绝不能跟着 env 发给第三方端点。
// 返回 null 表示无需覆盖——子进程直接继承 process.env（含 boot 时设的默认 token）。
export function claudeEngineEnv(ctx) {
  let touched = false;
  const env = { ...process.env };
  if (ctx && ctx.configDir) { env.CLAUDE_CONFIG_DIR = ctx.configDir; touched = true; }
  const a = getActiveAccount();
  if (a && a.type === 'custom' && a.apiKey) {
    env.ANTHROPIC_BASE_URL = a.baseUrl;
    env.ANTHROPIC_AUTH_TOKEN = a.apiKey;
    if (a.model) {
      // 模型五件套：主模型 + 按档位的默认映射（后台小任务/子 agent 否则会去请求 claude-haiku-*，第三方端点会 404）
      env.ANTHROPIC_MODEL = a.model;
      env.ANTHROPIC_DEFAULT_OPUS_MODEL = a.model;
      env.ANTHROPIC_DEFAULT_SONNET_MODEL = a.model;
      env.ANTHROPIC_DEFAULT_HAIKU_MODEL = a.model;
      env.CLAUDE_CODE_SUBAGENT_MODEL = a.model;
    }
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    delete env.ANTHROPIC_API_KEY;
    env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = '1';   // 第三方端点建议：别打非必要流量
    touched = true;
  } else if (a && a.token) {
    env.CLAUDE_CODE_OAUTH_TOKEN = a.token;
    touched = true;
  }
  return touched ? env : null;
}

// 第三方端点探活：发一次最小 messages 请求（max_tokens:1，成本可忽略）。
// 纯探测不落盘。失败只返回分类结果，由调用方决定是否仍允许保存。
export async function probeCustom({ baseUrl, apiKey, model } = {}) {
  const b = normalizeBase(baseUrl);
  const k = String(apiKey || '').trim();
  if (!/^https?:\/\//.test(b) || !k) return { ok: false, kind: 'input', message: '接口地址或 API Key 未填写' };
  try {
    const res = await fetch(b + '/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'anthropic-version': '2023-06-01',
        Authorization: 'Bearer ' + k,
      },
      body: JSON.stringify({ model: model || 'claude-sonnet-4-5', max_tokens: 1, messages: [{ role: 'user', content: 'hi' }] }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text().catch(() => '');
    if (res.ok) return { ok: true, kind: 'ok', message: '探活成功：端点可用' };
    if (res.status === 401 || res.status === 403) return { ok: false, kind: 'auth', message: `API Key 被拒绝（HTTP ${res.status}）` };
    if (res.status === 404) return { ok: false, kind: 'not_found', message: '端点返回 404：接口地址可能不对（确认带 /anthropic 之类的兼容后缀）' };
    if (res.status === 400 && /model/i.test(text)) return { ok: false, kind: 'model', message: '模型名不被端点接受：' + text.slice(0, 160) };
    return { ok: false, kind: 'http', message: `HTTP ${res.status}：` + text.slice(0, 160) };
  } catch (e) {
    return { ok: false, kind: 'network', message: '连不上端点：' + ((e && e.message) || e) };
  }
}
