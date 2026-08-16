#!/bin/bash
# task-run.sh — 后台任务运行器（由 index.cgi 通过 setsid 启动）
#
# 用法: task-run.sh <meta文件> <日志文件> <N_m3u8DL-RE二进制> <参数...>
# 职责:
#   1. 运行 N_m3u8DL-RE，输出重定向到日志文件（前端轮询读取 CLI 状态）
#   2. 结束后把退出码/结束时间写入 meta
#   3. 对比任务开始前的输出目录快照，识别并记录本任务产生的文件
#      （outputFiles=<逗号分隔>，供"已下载文件"列表使用，不扫描目录）
# 说明: 该脚本以 setsid 新会话方式运行，index.cgi 可用 kill -TERM -- -PID
#       对整个进程组（脚本 + N_m3u8DL-RE）发信号实现整组停止。

META="$1"
LOG="$2"
BIN="$3"
shift 3

echo "startedAt=$(date -Is)" >> "$META"

"$BIN" "$@" > "$LOG" 2>&1
RC=$?

echo "exitCode=$RC" >> "$META"
echo "finishedAt=$(date -Is)" >> "$META"

# 识别本任务产生的输出文件（与任务开始前的目录快照做差集）
OUT_DIR="$(sed -n 's/^outDir=//p' "$META" | head -n 1)"
SNAP="${META%.meta}.snapshot"
if [ -n "$OUT_DIR" ] && [ -d "$OUT_DIR" ] && [ -f "$SNAP" ]; then
  AFTER="$(mktemp 2>/dev/null || echo "/tmp/nre-after.$$")"
  (cd "$OUT_DIR" && ls -A1 2>/dev/null | sort) > "$AFTER"
  NEWFILES="$(comm -13 "$SNAP" "$AFTER" 2>/dev/null | tr '\n' ',' | sed 's/,$//')"
  [ -n "$NEWFILES" ] && echo "outputFiles=$NEWFILES" >> "$META"
  rm -f "$AFTER"
fi

exit 0
