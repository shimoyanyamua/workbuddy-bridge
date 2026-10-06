// CSRF 信任 origin 的解析与匹配：反代 / 云网关（Cloudflare Tunnel、nginx、
// 平台发布通道等）转发时会把 Host 头改写成内部主机名，公网域名只留在浏览器
// 的 Origin 头里，「Origin === Host」判定因此失效，所有写请求被误拒（403）。
// 部署者用 BRIDGE_TRUSTED_ORIGINS（env，逗号分隔）+ config.json 的
// trustedOrigins（数组）显式列出浏览器侧域名，命中即放行。条目支持 `*.`
// 前缀通配：匹配裸域自身或任意层子域（`*.example.com` 放行 `example.com`、
// `a.example.com`、`a.b.example.com`）。
//
// 纯函数、无副作用——config/index.mjs 在启动时调 parseTrustedOrigins 固化
// 结果，server.mjs 用 originTrusted 做每请求判定。

// 单条目 → 规范 host（小写、去默认端口）；`*.` 前缀保留并规范化剩余部分。
export function normalizeTrustedOriginEntry(s) {
  const str = String(s || '').trim();
  if (!str) return '';
  if (str.startsWith('*.')) {
    const rest = normalizeTrustedOriginEntry(str.slice(2));
    return rest ? '*.' + rest : '';
  }
  try {
    return new URL(str.includes('://') ? str : 'https://' + str).host.toLowerCase();
  } catch {
    return '';
  }
}

// env（逗号分隔）∪ config 数组 → 去重后的 host 列表（保序，非法条目剔除）。
export function parseTrustedOrigins(envList, cfgList) {
  const raw = [...String(envList || '').split(','), ...(Array.isArray(cfgList) ? cfgList : [])];
  const out = [];
  for (const item of raw) {
    const h = normalizeTrustedOriginEntry(item);
    if (h && !out.includes(h)) out.push(h);
  }
  return out;
}

// 请求的 Origin host 是否命中信任列表（精确或 `*.` 通配）。
export function originTrusted(oh, trusted) {
  const host = String(oh || '').toLowerCase();
  if (!host) return false;
  return (trusted || []).some((h) =>
    h.startsWith('*.') ? (host === h.slice(2) || host.endsWith('.' + h.slice(2))) : host === h
  );
}
