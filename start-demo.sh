#!/usr/bin/env bash
# WorkBuddy Bridge 演示启动脚本（供「发布为应用」的自启动机制调用）。
# 发布平台会注入 PORT 环境变量，node 进程继承后由 src/config 读取。
cd "$(dirname "$0")" || exit 1
export BRIDGE_DATA_ROOT=/tmp/wb-demo
# 公网网关转发会改写 Host 头 → 服务端 Origin 同源判定失效，写请求（登录等 POST）
# 全被 403。把发布域名列入可信 Origin 列表；域名变了改这一行即可。
export BRIDGE_TRUSTED_ORIGINS=https://a0d033971ea3d7bfb.app.workbuddy.host
exec node src/server.mjs
