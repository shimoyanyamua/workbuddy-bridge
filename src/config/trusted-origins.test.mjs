// trusted-origins 纯函数单测：解析（env ∪ config）与通配匹配。
// 见 ./trusted-origins.mjs 顶部注释（反代改写 Host → CSRF 误拒 403 的背景）。

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalizeTrustedOriginEntry, parseTrustedOrigins, originTrusted } from './trusted-origins.mjs';

test('normalizeTrustedOriginEntry: 裸 host / 带协议 / 大小写 / 默认端口', () => {
  assert.equal(normalizeTrustedOriginEntry('a0d033971ea3d7bfb.app.workbuddy.host'), 'a0d033971ea3d7bfb.app.workbuddy.host');
  assert.equal(normalizeTrustedOriginEntry('https://a0d033971ea3d7bfb.app.workbuddy.host'), 'a0d033971ea3d7bfb.app.workbuddy.host');
  assert.equal(normalizeTrustedOriginEntry('https://Bridge.Example.COM:443'), 'bridge.example.com');
  assert.equal(normalizeTrustedOriginEntry(' http://bridge.local:8787 '), 'bridge.local:8787');
});

test('normalizeTrustedOriginEntry: 通配前缀规范化剩余部分', () => {
  assert.equal(normalizeTrustedOriginEntry('*.app.workbuddy.host'), '*.app.workbuddy.host');
  assert.equal(normalizeTrustedOriginEntry('*.App.WorkBuddy.Host'), '*.app.workbuddy.host');
  assert.equal(normalizeTrustedOriginEntry('*.EXAMPLE.com'), '*.example.com');
  // 通配后无有效剩余 → 整条无效
  assert.equal(normalizeTrustedOriginEntry('*.'), '');
  assert.equal(normalizeTrustedOriginEntry('*. '), '');
});

test('normalizeTrustedOriginEntry: 空值与非法输入', () => {
  assert.equal(normalizeTrustedOriginEntry(''), '');
  assert.equal(normalizeTrustedOriginEntry(null), '');
  assert.equal(normalizeTrustedOriginEntry('not a host!!'), '');
  assert.equal(normalizeTrustedOriginEntry('https://'), '');
});

test('parseTrustedOrigins: env 逗号分隔 ∪ config 数组，去重剔非法', () => {
  assert.deepEqual(
    parseTrustedOrigins('a.example.com, https://b.example.com ,, *.c.example.com', ['b.example.com', 'd.example.com']),
    ['a.example.com', 'b.example.com', '*.c.example.com', 'd.example.com']
  );
  assert.deepEqual(parseTrustedOrigins('', ['x.example.com']), ['x.example.com']);
  assert.deepEqual(parseTrustedOrigins('x.example.com', undefined), ['x.example.com']);
  assert.deepEqual(parseTrustedOrigins(undefined, undefined), []);
  // config 值不是数组 → 忽略
  assert.deepEqual(parseTrustedOrigins('x.example.com', 'y.example.com'), ['x.example.com']);
});

test('originTrusted: 精确匹配', () => {
  const t = ['a.example.com', '*.app.workbuddy.host'];
  assert.equal(originTrusted('a.example.com', t), true);
  assert.equal(originTrusted('b.example.com', t), false);
  assert.equal(originTrusted('', t), false);
  assert.equal(originTrusted(null, t), false);
  assert.equal(originTrusted('a.example.com', []), false);
});

test('originTrusted: 通配命中裸域与任意层子域', () => {
  const t = ['*.app.workbuddy.host'];
  assert.equal(originTrusted('app.workbuddy.host', t), true);
  assert.equal(originTrusted('a0d033971ea3d7bfb.app.workbuddy.host', t), true);
  assert.equal(originTrusted('a.b.app.workbuddy.host', t), true);
});

test('originTrusted: 通配不放过伪装域', () => {
  const t = ['*.app.workbuddy.host'];
  // 'evilapp' 无点分隔，不是 app.workbuddy.host 的子域
  assert.equal(originTrusted('evilapp.workbuddy.host', t), false);
  assert.equal(originTrusted('app.workbuddy.host.evil.com', t), false);
  assert.equal(originTrusted('app.workbuddy.host:8443', t), false);
});
