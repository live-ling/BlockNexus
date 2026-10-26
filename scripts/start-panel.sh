#!/bin/sh
# BlockNexus 面板启动包装（systemd 用）。
#
# 为什么需要它：面板内更新会先退出自己，再由更新器换文件、重新拉起。
# 如果 systemd 配的是 Restart=always，它会在「面板刚退出、文件还没换完」时
# 立刻把面板拉起来——轻则更新器等到超时放弃，重则读到半新半旧的文件树。
#
# 做法：更新器在交接前写 data/update/in-progress，本脚本看到它就等；
# 更新器结束（成功或回滚）后删除它，systemd 再把新版面板拉起来。
# 锁带 10 分钟 TTL：更新器被杀时不会把启动永久卡住。
#
# 用法（systemd）：
#   ExecStart=/opt/blocknexus/scripts/start-panel.sh --host 127.0.0.1
# 注意：文件必须可执行（chmod +x scripts/start-panel.sh）。

set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
LOCK="$ROOT/data/update/in-progress"
MAX_WAIT=180
STALE_SEC=600

i=0
while [ -f "$LOCK" ] && [ "$i" -lt "$MAX_WAIT" ]; do
  now=$(date +%s)
  mtime=$(stat -c %Y "$LOCK" 2>/dev/null || stat -f %m "$LOCK" 2>/dev/null || echo "$now")
  if [ $((now - mtime)) -gt "$STALE_SEC" ]; then
    echo "BlockNexus: 更新锁超过 ${STALE_SEC}s，按陈旧锁忽略" >&2
    break
  fi
  i=$((i + 1))
  sleep 1
done

exec node "$ROOT/panel/server.js" "$@"
