#!/usr/bin/env bash
# WorkBuddy Bridge · 无 systemd 环境的前台启动脚本。
#
# scripts/server/install.sh 用 systemd 托管服务（单元里写了 15 个环境变量）。
# 容器、chroot、没启用 systemd 的机器上没有 systemd，本脚本把同一份环境变量
# 收拢到这里，以前台方式拉起服务——环境与 systemd 单元完全等价，不会因为
# 「手抄清单漏了一行」而在升级后悄悄坏掉。
#
#   bash scripts/server/run-standalone.sh [选项]
#
# 选项（与 install.sh 同名同义）：
#   --data DIR    数据目录（默认 /var/lib/bridge；没有就退回 $PWD/bridge-data）
#   --port N      监听端口（默认 8787）
#   --host ADDR   监听地址（默认 127.0.0.1；对外请走隧道/反代，别裸暴露端口）
#   --user NAME   以该系统用户运行（root 下默认 bridge；非 root 下忽略、用当前用户）
#   --node PATH   node 可执行文件的绝对路径（默认自动解析当前 PATH 里的 node，
#                 并固定成绝对路径——防止服务因 PATH 差异落到旧版本）
#   --env-file F  追加读取的环境文件（默认存在 /etc/bridge/bridge.env 就读，
#                 KEY=VALUE 格式，等价 systemd 的 EnvironmentFile）
#
# 用法（前台跑，Ctrl-C 退出；配合 keepalive 循环常驻，见 README「无 systemd 环境」）：
#   sudo bash scripts/server/run-standalone.sh
#   nohup bash scripts/server/run-standalone.sh >> /var/log/bridge.log 2>&1 &
#
# 崩溃自动拉起（等价 systemd 的 Restart=always），外面套一层循环即可：
#   while true; do bash scripts/server/run-standalone.sh; sleep 3; done
set -euo pipefail

# 默认值与 scripts/server/install.sh（systemd 安装器）一致：PORT/HOST/DATA。
# 服务以当前用户前台跑，没有独立服务账号（SVC_USER），其余环境变量见文件末尾的 env 列表。
PORT=8787
HOST=127.0.0.1
DATA=""
SVC_USER=""
NODE_BIN=""
ENV_FILE="/etc/bridge/bridge.env"

while [ $# -gt 0 ]; do
  case "$1" in
    --data) DATA="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --host) HOST="$2"; shift 2 ;;
    --user) SVC_USER="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    -h|--help) sed -n '2,34p' "$0"; exit 0 ;;
    *) echo "不认识的选项：$1（--help 看用法）" >&2; exit 2 ;;
  esac
done

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
[ -f "$REPO/src/server.mjs" ] || { echo "[x] 找不到 $REPO/src/server.mjs——请在仓库里运行本脚本" >&2; exit 1; }

# node 固定成绝对路径：无 systemd 的环境里 PATH 往往靠 nvm/sdkman 之类拼出来，
# 换个 shell 就变——服务进程用的是启动那一刻解析好的绝对路径，不受影响。
if [ -z "$NODE_BIN" ]; then
  NODE_BIN="$(command -v node || true)"
  [ -n "$NODE_BIN" ] || { echo "[x] 找不到 node。请先装 Node 24+，或用 --node /路径/node 指定" >&2; exit 1; }
fi
case "$NODE_BIN" in /*) ;; *) NODE_BIN="$(command -v "$NODE_BIN")" ;; esac
[ "$( "$NODE_BIN" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0 )" -ge 24 ] \
  || { echo "[x] 需要 Node 24+（现在是 $("$NODE_BIN" -v 2>/dev/null || echo 未知)）。建议用 --node 指定 24+ 的绝对路径" >&2; exit 1; }

# 数据目录：非 root 用户不给 /var/lib/bridge 写权限时，退回仓库旁的 bridge-data
if [ -z "$DATA" ]; then
  if [ "$(id -u)" = 0 ] || [ -w /var/lib/bridge ] || [ -d /var/lib/bridge ]; then DATA=/var/lib/bridge
  else DATA="$REPO/bridge-data"; fi
fi
if [ "$(id -u)" != 0 ] && [ "$DATA" = /var/lib/bridge ] && [ ! -w /var/lib/bridge ]; then
  DATA="$REPO/bridge-data"
fi

# 以指定系统用户运行（root 才有这能力）：等价 systemd 的 User=
RUN=()
if [ "$(id -u)" = 0 ] && [ -n "$SVC_USER" ] && [ "$(id -un)" != "$SVC_USER" ]; then
  id -u "$SVC_USER" >/dev/null 2>&1 || { echo "[x] 系统用户 $SVC_USER 不存在（useradd 建一个，或去掉 --user）" >&2; exit 1; }
  RUN=(runuser -u "$SVC_USER" --)
  chown -R "$SVC_USER" "$DATA" 2>/dev/null || true
fi

# 数据目录树（与 install.sh 第 2 步一致：已有就原样保留，不动数据）
mkdir -p "$DATA" "$DATA/home" "$DATA/dimensio/sessions" "$DATA/dimensio/memory" \
  "$DATA/dimensio/knowledge" "$DATA/dimensio/workspace" "$DATA/dimensio/custom-providers"
[ "$(id -u)" = 0 ] && [ -n "$SVC_USER" ] && chown -R "$SVC_USER" "$DATA" 2>/dev/null || true

# 环境文件（等价 systemd 的 EnvironmentFile=-/etc/bridge/bridge.env）：存在才读
ENV_SOURCE=""
if [ -n "$ENV_FILE" ] && [ -f "$ENV_FILE" ]; then
  ENV_SOURCE="source '$ENV_FILE';"
fi

cat >&2 <<BANNER
WorkBuddy Bridge · standalone
  代码  $REPO
  数据  $DATA
  地址  http://$HOST:$PORT
  node  $NODE_BIN ($("$NODE_BIN" -v))
  前台进程：Ctrl-C 退出；常驻请套 keepalive 循环（README「无 systemd 环境」一节）
BANNER

# 前台拉起：bash -c 里 exec 成 node，本脚本以 node 的身份运行——Ctrl-C / kill 的信号直达，
# 退出码原样返回（keepalive 循环据此重启）。
"${RUN[@]}" env \
  NODE_ENV=production \
  BRIDGE_EDITION=server \
  BRIDGE_SUPERVISED=standalone \
  BRIDGE_DATA_ROOT="$DATA" \
  HOME="$DATA/home" \
  PORT="$PORT" \
  BRIDGE_HOST="$HOST" \
  SESSIONS_DIR="$DATA/dimensio/sessions" \
  MEMORY_DIR="$DATA/dimensio/memory" \
  KNOWLEDGE_DIR="$DATA/dimensio/knowledge" \
  DIMENSIO_CONFIG_FILE="$DATA/dimensio/runtime-config.json" \
  DIMENSIO_QUICK_FILE="$DATA/dimensio/quick.json" \
  PROJECTS_FILE="$DATA/dimensio/projects.json" \
  WORKSPACE_DIR="$DATA/dimensio/workspace" \
  HARNESS_ENV_FILE="$DATA/dimensio/.env" \
  DIMENSIO_CUSTOM_PROVIDERS_DIR="$DATA/dimensio/custom-providers" \
  bash -c "$ENV_SOURCE exec '$NODE_BIN' src/server.mjs"
