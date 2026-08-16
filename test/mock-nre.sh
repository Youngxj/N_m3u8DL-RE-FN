#!/bin/bash
# Mock N_m3u8DL-RE（仅本地测试用，不进 fpk）
# 模拟真实工具的输出：解析 → 下载（分片/百分比/速度）→ 合并 → 完成。
# 同时解析 --save-dir / --save-name 并写入模拟输出文件。
set -u

SAVE_DIR="."
SAVE_NAME="mock_output"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --save-dir)  SAVE_DIR="$2";  shift 2 ;;
    --save-name) SAVE_NAME="$2"; shift 2 ;;
    *) shift ;;
  esac
done

echo "N_m3u8DL-RE (Mock) 20260816"
echo "正在解析媒体信息..."
sleep 0.8
echo "检测到 HLS 流，共 120 个分片"
# 模拟真实进度帧：Vid Kbps ━━━ 分片 百分比 已下载/总量速度ETA（部分无空格拼接）
for i in $(seq 1 120); do
  sleep 0.12
  pct=$((i * 100 / 120))
  speed=$((3 + i % 7))
  downloaded=$((i * 5))
  printf 'Vid Kbps %s %s/120 %s.%s%% %s.0MB/600.0MB%s.0MBps00:00:%02d\n' \
    "$(printf '━%.0s' $(seq 1 20))" "$i" "$((pct / 10))" "$((pct % 10))" "$downloaded" "$speed" "$((46 - i / 20))"
done
echo "Vid Kbps ━━━━━━━━━━━━━━━━━━━━ 120/120 100.0% 600.0MB/600.0MB8.0MBps00:00:00"
echo "正在合并分片..."
sleep 0.7
echo "混流中..."
sleep 0.7
mkdir -p "$SAVE_DIR"
head -c 1048576 /dev/zero > "$SAVE_DIR/$SAVE_NAME.mp4"
echo "完成: $SAVE_DIR/$SAVE_NAME.mp4"
exit 0
