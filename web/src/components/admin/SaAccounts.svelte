<script>
  // Claude 账号切换（failover / 额度池 / 第三方端点）：整个 bridge 的 Claude Agent SDK 用哪个上游。
  // 两种类型：oauth（Claude 订阅令牌）/ custom（Anthropic 兼容端点：Kimi、DeepSeek、GLM…）。
  // 切换即时全局生效；所有账号共享 ~/.claude 会话，切号可无缝续同一条对话。
  import { api } from '../../lib/api.js';
  import { sa, loadAccounts, saToast, saConfirm, accLabel } from '../../lib/serverAdmin.svelte.js';
  import { t, tr } from '../../lib/i18n.js';

  $effect(() => { sa.tick; loadAccounts(); });

  let editModal = $state(null);   // { id?, label, type: 'oauth'|'custom', token, baseUrl, apiKey, model, isNew }
  let busy = $state(false);

  // 第三方端点快捷预设：baseUrl + 常用示例模型（模型可改可清空）
  const PRESETS = [
    { name: 'Kimi', baseUrl: 'https://api.moonshot.cn/anthropic', model: 'kimi-k3' },
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/anthropic', model: '' },
    { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/anthropic', model: 'glm-4.6' },
  ];
  function applyPreset(p) { if (editModal) { editModal.baseUrl = p.baseUrl; editModal.model = p.model; } }

  // 脚注整句一个键：键里用 **加粗**、`代码` 标出行内的 <b> / <code>，渲染时切段（中文 DOM 与原来一致）
  const rich = (s) => s.split(/(\*\*[^*]+\*\*|`[^`]+`)/).filter(Boolean);

  async function activate(a) {
    try { const r = await api.post('/api/admin/claude-account/active', { id: a.id }); if (r?.error) throw new Error(r.error); saToast(t('已切换到 {name}', { name: accLabel(a.label) })); loadAccounts(); }
    catch (e) { saToast(tr(e?.message) || t('切换失败'), true); }
  }
  function openAdd() { editModal = { label: '', type: 'oauth', token: '', baseUrl: '', apiKey: '', model: '', isNew: true }; }
  function openEdit(a) {
    editModal = { id: a.id, label: accLabel(a.label), type: a.type === 'custom' ? 'custom' : 'oauth', token: '', baseUrl: a.baseUrl || '', apiKey: '', model: a.model || '', isNew: false, hasToken: a.hasToken, tokenTail: a.tokenTail, hasKey: a.hasKey, keyTail: a.keyTail };
  }
  async function testConn() {
    const m = editModal; if (!m || busy) return;
    if (!m.baseUrl.trim() || !m.apiKey.trim()) { saToast(t('先填接口地址和 API Key 再测试'), true); return; }
    busy = true;
    try {
      const r = await api.post('/api/admin/claude-account/probe', { baseUrl: m.baseUrl.trim(), apiKey: m.apiKey.trim(), model: m.model.trim() });
      if (r?.ok) saToast(t('端点可用'));
      else saToast((r && r.message) || t('探活失败'), true);
    } catch (e) { saToast(tr(e?.message) || t('探活失败'), true); }
    busy = false;
  }
  async function saveModal() {
    if (busy) return;
    const m = editModal;
    if (m.type === 'custom') {
      if (!m.baseUrl.trim()) { saToast(t('接口地址不能为空'), true); return; }
      if (m.isNew && !m.apiKey.trim()) { saToast(t('API Key 不能为空'), true); return; }
    } else if (m.isNew && !m.token.trim()) { saToast(t('token 不能为空'), true); return; }
    busy = true;
    try {
      const body = m.type === 'custom'
        ? { label: m.label.trim(), type: 'custom', baseUrl: m.baseUrl.trim(), apiKey: m.apiKey.trim(), model: m.model.trim() }
        : { label: m.label.trim(), type: 'oauth', token: m.token.trim() };
      const r = m.isNew
        ? await api.post('/api/admin/claude-account/add', body)
        : await api.post('/api/admin/claude-account/update', { id: m.id, ...body });
      if (r?.error) throw new Error(r.error);
      editModal = null;
      if (r?.warning) saToast(r.warning, true);
      saToast(m.isNew ? t('已添加') : t('已保存'));
      loadAccounts();
    } catch (e) { saToast(tr(e?.message) || t('失败'), true); }
    busy = false;
  }
  async function del(a) {
    if (!(await saConfirm(t('删除账号 {name}？', { name: accLabel(a.label) }), t('只从切换列表移除；若删的是当前账号，会自动切到另一个。'), { yes: t('删除'), danger: true }))) return;
    try { const r = await api.post('/api/admin/claude-account/delete', { id: a.id }); if (r?.error) throw new Error(r.error); saToast(t('已删除')); loadAccounts(); }
    catch (e) { saToast(tr(e?.message) || t('失败'), true); }
  }
</script>

{#snippet richLine(s)}{#each rich(s) as seg}{#if seg.startsWith('**')}<b style="color:rgba(255,255,255,.7)">{seg.slice(2, -2)}</b>{:else if seg.startsWith('`')}<code class="sa-mono">{seg.slice(1, -1)}</code>{:else}{seg}{/if}{/each}{/snippet}

<div class="sa-card">
  <div class="sa-card-h">{t('Claude 账号')}
    <span class="sa-sp"></span>
    <button class="sa-btn sm pri" onclick={openAdd}>{t('＋ 添加账号')}</button>
  </div>
  {#if !sa.accounts.length}
    <div class="sa-empty">{t('还没有账号')}</div>
  {:else}
    <div class="sa-rows">
      {#each sa.accounts as a (a.id)}
        <div class="sa-row">
          <span style="width:74px;flex:none">
            {#if a.active}<span class="sa-badge green">{t('● 当前')}</span>{:else}<span class="sa-badge gray">{t('待用')}</span>{/if}
          </span>
          <span class="sa-row-tx">
            <span style="font-weight:650">{accLabel(a.label)}{#if a.type === 'custom'}<span class="sa-badge gray" style="margin-left:6px">{t('第三方')}</span>{/if}</span>
            <small class="sa-mono">
              {#if a.type === 'custom'}
                {a.baseUrl || '—'}{#if a.model}&nbsp;·&nbsp;{a.model}{:else}&nbsp;·&nbsp;{t('模型自动映射')}{/if}{#if a.hasKey}&nbsp;·&nbsp;…{a.keyTail}{/if}
              {:else}
                {a.hasToken ? '…' + (a.tokenTail || '') : t('用本机登录态（~/.claude）')}
              {/if}
            </small>
          </span>
          {#if !a.active}<button class="sa-btn sm pri" onclick={() => activate(a)}>{t('切到此号')}</button>{/if}
          <button class="sa-btn sm" onclick={() => openEdit(a)}>{t('编辑')}</button>
          {#if sa.accounts.length > 1}
            <button class="sa-btn sm dgr" onclick={() => del(a)}>{t('删除')}</button>
          {/if}
        </div>
      {/each}
    </div>
    <div style="height:8px"></div>
  {/if}
</div>
<div class="sa-foot" style="line-height:1.7">
  {@render richLine(t('切换**即时全局生效**：admin 对话、用户沙箱、定时路由的下一次生成都会用新账号的额度（正在跑的那一轮不受影响）。'))}<br />
  {@render richLine(t('所有账号**共享会话**（都落 ~/.claude）——一条对话可以在切号后无缝续聊：一号限流了切另一号接着聊。'))}<br />
  {@render richLine(t('添加订阅账号的 token：在**对应账号**登录状态下运行 `claude setup-token`，把返回的长期 token 粘进来；留空 token = 用本机 ~/.claude 已登录凭证。'))}<br />
  {@render richLine(t('**第三方兼容端点**：没有 Claude 订阅也能用 Claude 页——填 Kimi / DeepSeek / 智谱等提供的 Anthropic 兼容地址和 API Key。模型能力与工具调用支持以各家为准，额度按各家计费；激活后右上角的模型选择器会停用，以账号里配置的模型为准。'))}
</div>

{#if editModal}
  <button class="sa-mask" aria-label={t('关闭')} onclick={() => (editModal = null)}></button>
  <div class="sa-modal">
    <h3>{editModal.isNew ? t('添加 Claude 账号') : t('编辑账号')}</h3>
    <div class="sa-lab">{t('类型')}</div>
    <div class="seg" role="tablist">
      <button type="button" class:on={editModal.type === 'oauth'} onclick={() => (editModal.type = 'oauth')}>{t('Claude 订阅')}</button>
      <button type="button" class:on={editModal.type === 'custom'} onclick={() => (editModal.type = 'custom')}>{t('第三方兼容端点')}</button>
    </div>
    {#if editModal.isNew && editModal.type === 'custom'}
      <p>{@render richLine(t('没有 Claude 订阅也能用：填 Kimi / DeepSeek / 智谱等提供的 **Anthropic 兼容地址**和 API Key。点下面按钮可快速填入常用端点。'))}</p>
    {/if}
    <div class="sa-lab">{t('名称')}</div>
    <input class="sa-in" placeholder={editModal.type === 'custom' ? t('如：DeepSeek / Kimi / 备用') : t('如：主号 / 备用号')} bind:value={editModal.label} />
    {#if editModal.type === 'custom'}
      {#if editModal.isNew}
        <div class="presets">
          {#each PRESETS as p (p.name)}
            <button class="sa-btn sm" type="button" onclick={() => applyPreset(p)}>{p.name}</button>
          {/each}
        </div>
      {/if}
      <div class="sa-lab">{t('接口地址（Anthropic 兼容）')}</div>
      <input class="sa-in sa-mono" style="font-size:12.5px" placeholder="https://api.deepseek.com/anthropic" bind:value={editModal.baseUrl} />
      <div class="sa-lab">API Key</div>
      <input class="sa-in sa-mono" style="font-size:12.5px"
        placeholder={editModal.isNew ? 'sk-…' : (editModal.hasKey ? t('留空＝不改，当前 …{tail}', { tail: editModal.keyTail || '' }) : 'sk-…')}
        bind:value={editModal.apiKey} />
      <div class="sa-lab">{t('模型名（可留空）')}</div>
      <input class="sa-in sa-mono" style="font-size:12.5px" placeholder={t('如 deepseek-chat / kimi-k3 / glm-4.6')} bind:value={editModal.model} />
      <div style="margin-top:10px;display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <button class="sa-btn sm" type="button" onclick={testConn} disabled={busy}>{t('测试连接')}</button>
        <small style="opacity:.6">{t('会向该地址发一次最小请求（带上你填的 Key）')}</small>
      </div>
    {:else}
      <div class="sa-lab">Token</div>
      <input class="sa-in sa-mono" style="font-size:12.5px"
        placeholder={editModal.isNew ? 'sk-ant-oat…' : (editModal.hasToken ? t('留空＝不改，当前 …{tail}', { tail: editModal.tokenTail || '' }) : t('留空＝用本机登录态'))}
        bind:value={editModal.token} />
    {/if}
    <div class="acts">
      <button class="sa-btn" onclick={() => (editModal = null)}>{t('取消')}</button>
      <button class="sa-btn pri" onclick={saveModal} disabled={busy}>{editModal.isNew ? t('添加') : t('保存')}</button>
    </div>
  </div>
{/if}

<style>
  /* 类型二选（segmented control） */
  .seg { display: flex; gap: 0; margin: 4px 0 10px; border: 1px solid rgba(255,255,255,.14); border-radius: 9px; overflow: hidden; width: fit-content; }
  .seg button { background: transparent; color: rgba(255,255,255,.62); border: 0; padding: 7px 14px; font-size: 13px; cursor: pointer; }
  .seg button.on { background: rgba(255,255,255,.12); color: #fff; font-weight: 600; }
  /* 预设快捷填充行 */
  .presets { display: flex; gap: 6px; margin: 6px 0 2px; flex-wrap: wrap; }
  /* 英文「Switch to this account」按钮宽得多：窄屏上徽章 + 账号名占一行、按钮换到下一行（只在 :lang(en) 下，中文不变） */
  @media (max-width: 560px) {
    .sa-row:lang(en) { flex-wrap: wrap; row-gap: 8px; }
    .sa-row:lang(en) .sa-row-tx { flex-basis: calc(100% - 86px); }
  }
</style>
