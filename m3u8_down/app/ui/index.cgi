#!/bin/bash
# 全局抑制 stderr，避免子命令错误输出污染 CGI 响应体
exec 2>/dev/null

# index.cgi — N_m3u8DL-RE Web 界面入口（飞牛 fnOS 原生 CGI）
#
# 职责：
#   1. 提供静态前端页面（app/www/）
#   2. 任务管理 API（?action=create|status|stop|remove）
#   3. 已下载文件管理（?action=files|download|delete_file）
#
# 设计：
#   - 纯 bash，零外部运行时依赖（不需要 Node/Python）
#   - 下载任务用 setsid 在后台独立会话运行（新进程组，便于整组停止），
#     状态/进度通过任务目录下的 meta + log 文件记录，前端轮询获取
#   - 不监听任何端口，无常驻进程（ctl_stop=false），完全贴合 fnOS 原生模型
#
# 调用示例：
#   /cgi/ThirdParty/m3u8_down/index.cgi/                 → 页面
#   /cgi/ThirdParty/m3u8_down/index.cgi/app.js           → 静态资源
#   POST action=create&url=...&name=...&auto=1             → 新建任务
#   GET  action=status                                     → 任务列表+进度
#   GET  action=stop&id=...                                → 停止任务
#   GET  action=remove&id=...                              → 删除任务记录
#   GET  action=files                                      → 已下载文件
#   GET  action=download&file=xxx.mp4                      → 下载文件
#   GET  action=delete_file&file=xxx.mp4                   → 删除文件
#   GET  action=update_check                               → 应用/引擎更新检查（GitHub 不可达时优雅降级）

# ---------- 路径解析 ----------
# CGI 环境通常没有 TRIM_* 变量，且 readlink -f 会把 /var/apps/{app}/target 符号链接
# 解析成真实路径 /vol{n}/@appcenter/{app}，导致应用根目录推导错误。
# 正确做法：用真实路径反推 appname，再拼回标准视图 /var/apps/{appname}。
if [ -n "$TRIM_APPDEST" ] && [ -d "$TRIM_APPDEST" ]; then
  TARGET="$TRIM_APPDEST"
  APP_NAME="$(basename "$(dirname "$TARGET")")"
else
  SELF_REAL="$(readlink -f "$0" 2>/dev/null || echo "$0")"
  D1="$(dirname "$SELF_REAL")"   # .../<appname>/ui（index.cgi 所在目录）
  D2="$(dirname "$D1")"          # .../<appname>
  APP_NAME="$(basename "$D2")"
  if [ -n "$APP_NAME" ] && [ -d "/var/apps/$APP_NAME" ]; then
    # 标准视图（符号链接形式，var/shares/tmp 均在此视图下）
    TARGET="/var/apps/$APP_NAME/target"
  else
    # 无 /var/apps 视图（本地测试等环境）：直接用推导出的应用目录
    TARGET="$D2"
  fi
fi
APP_ROOT="$(dirname "$TARGET")"
# fnOS 数据共享的真实存储位置：/vol{n}/@appshare/{appname}
REAL_SHARE="/vol1/@appshare/$APP_NAME"

WWW="$TARGET/www"
BIN="$TARGET/bin/N_m3u8DL-RE"
RUNNER="$TARGET/bin/task-run.sh"

# 选择第一个可写可创建的目录（CGI 运行用户可能无权写标准目录，逐级兜底）
pick_writable_dir() {
  local d
  for d in "$@"; do
    [ -n "$d" ] || continue
    if mkdir -p "$d" 2>/dev/null && [ -w "$d" ]; then
      printf '%s' "$d"
      return 0
    fi
  done
  return 1
}

TASKS_DIR="$(pick_writable_dir \
  "${TRIM_PKGVAR:+$TRIM_PKGVAR/tasks}" \
  "$APP_ROOT/var/tasks" \
  "$APP_ROOT/tmp/tasks" \
  "$APP_ROOT/home/tasks")"
[ -n "$TASKS_DIR" ] || TASKS_DIR="${TRIM_PKGVAR:-$APP_ROOT/var}/tasks"

SHARE_DIR="$(pick_writable_dir \
  "${TRIM_DATA_SHARE_PATHS%%:*}" \
  "$APP_ROOT/shares/downloads" \
  "$REAL_SHARE/downloads" \
  "$APP_ROOT/share/downloads" \
  "$APP_ROOT/var/downloads" \
  "$APP_ROOT/home/downloads")"
[ -n "$SHARE_DIR" ] || SHARE_DIR="${TRIM_DATA_SHARE_PATHS%%:*}"

MAX_RUNNING=3   # 同时运行的任务数上限

# ---------- 工具函数 ----------
urldecode() {
  # %XX → 字符，+ → 空格
  local s="${1//+/ }"
  printf '%b' "${s//%/\\x}"
}

# 从 stdin 读入文本，输出为 JSON 字符串（转义引号/反斜杠/控制符，多行转 \n）
json_escape() {
  awk '{
    line = $0
    gsub(/\\/, "\\\\", line)
    gsub(/"/, "\\\"", line)
    gsub(/\t/, "\\t", line)
    gsub(/[\001-\037]/, "", line)
    if (NR > 1) printf "\\n"
    printf "%s", line
  }'
}

# 解析 CGI 参数（GET query 与 POST body 均可；url 值可能含 &，需特殊处理）
ACTION=""; ID=""; URL=""; NAME=""; DIR_ARG=""
AUTO=""; SUBONLY=""; LIVE=""; MUX=""; THREADS=""; SAVE_PATTERN=""; CONCURRENT=""; SUB_FORMAT=""; MAX_SPEED=""
TMP_DIR=""; RETRY_COUNT=""; TIMEOUT=""; CUSTOM_PROXY=""; USE_SYSTEM_PROXY=""; HEADERS=""; CUSTOM_RANGE=""
TASK_START_AT=""; BASE_URL=""; SELECT_VIDEO=""; SELECT_AUDIO=""; SELECT_SUBTITLE=""; DROP_VIDEO=""
DROP_AUDIO=""; DROP_SUBTITLE=""; AD_KEYWORD=""; SKIP_MERGE=""; BINARY_MERGE=""; APPEND_URL_PARAMS=""
NO_DATE_INFO=""; DISABLE_UPDATE_CHECK=""; KEY=""; KEY_TEXT_FILE=""; DECRYPTION_ENGINE=""; DECRYPTION_BINARY_PATH=""
MP4_REAL_TIME_DECRYPTION=""; CUSTOM_HLS_METHOD=""; CUSTOM_HLS_KEY=""; CUSTOM_HLS_IV=""; LOG_LEVEL=""; NO_LOG=""
LIVE_REAL_TIME_MERGE=""; LIVE_RECORD_LIMIT=""; LIVE_WAIT_TIME=""; LIVE_KEEP_SEGMENTS=""; LIVE_PIPE_MUX=""
FILE=""; PATH_ARG=""; RAW_ALL=""
parse_params() {
  local raw="$1" pair key val
  local -a pairs
  [ -z "$raw" ] && return
  IFS='&' read -ra pairs <<< "$raw"
  for pair in "${pairs[@]}"; do
    [ -z "$pair" ] && continue
    key="${pair%%=*}"
    val="${pair#*=}"
    key="$(urldecode "$key")"
    if [ "$key" = "url" ]; then
      # url 值里的 & 已被编码，这里把拆分出的片段重新拼回并最后统一解码
      URL_RAW="$URL_RAW${URL_RAW:+&}$val"
      continue
    fi
    val="$(urldecode "$val")"
    case "$key" in
      action)     ACTION="$val" ;;
      id)         ID="$val" ;;
      name)       NAME="$val" ;;
      dir)        DIR_ARG="$val" ;;
      auto)       AUTO="$val" ;;
      subonly)    SUBONLY="$val" ;;
      live)       LIVE="$val" ;;
      mux)        MUX="$val" ;;
      threads)    THREADS="$val" ;;
      save_pattern) SAVE_PATTERN="$val" ;;
      concurrent) CONCURRENT="$val" ;;
      sub_format) SUB_FORMAT="$val" ;;
      max_speed)  MAX_SPEED="$val" ;;
      tmp_dir)    TMP_DIR="$val" ;;
      retry_count) RETRY_COUNT="$val" ;;
      timeout)    TIMEOUT="$val" ;;
      custom_proxy) CUSTOM_PROXY="$val" ;;
      use_system_proxy) USE_SYSTEM_PROXY="$val" ;;
      headers)    HEADERS="$val" ;;
      custom_range) CUSTOM_RANGE="$val" ;;
      task_start_at) TASK_START_AT="$val" ;;
      base_url)   BASE_URL="$val" ;;
      select_video) SELECT_VIDEO="$val" ;;
      select_audio) SELECT_AUDIO="$val" ;;
      select_subtitle) SELECT_SUBTITLE="$val" ;;
      drop_video) DROP_VIDEO="$val" ;;
      drop_audio) DROP_AUDIO="$val" ;;
      drop_subtitle) DROP_SUBTITLE="$val" ;;
      ad_keyword) AD_KEYWORD="$val" ;;
      skip_merge) SKIP_MERGE="$val" ;;
      binary_merge) BINARY_MERGE="$val" ;;
      append_url_params) APPEND_URL_PARAMS="$val" ;;
      no_date_info) NO_DATE_INFO="$val" ;;
      disable_update_check) DISABLE_UPDATE_CHECK="$val" ;;
      key)        KEY="$val" ;;
      key_text_file) KEY_TEXT_FILE="$val" ;;
      decryption_engine) DECRYPTION_ENGINE="$val" ;;
      decryption_binary_path) DECRYPTION_BINARY_PATH="$val" ;;
      mp4_real_time_decryption) MP4_REAL_TIME_DECRYPTION="$val" ;;
      custom_hls_method) CUSTOM_HLS_METHOD="$val" ;;
      custom_hls_key) CUSTOM_HLS_KEY="$val" ;;
      custom_hls_iv) CUSTOM_HLS_IV="$val" ;;
      log_level)  LOG_LEVEL="$val" ;;
      no_log)     NO_LOG="$val" ;;
      live_real_time_merge) LIVE_REAL_TIME_MERGE="$val" ;;
      live_record_limit) LIVE_RECORD_LIMIT="$val" ;;
      live_wait_time) LIVE_WAIT_TIME="$val" ;;
      live_keep_segments) LIVE_KEEP_SEGMENTS="$val" ;;
      live_pipe_mux) LIVE_PIPE_MUX="$val" ;;
      file)       FILE="$val" ;;
      path)       PATH_ARG="$val" ;;
    esac
  done
  if [ -n "$URL_RAW" ]; then
    URL="$(urldecode "$URL_RAW")"
  fi
}

json_header() {
  printf 'Content-Type: application/json; charset=utf-8\r\n\r\n'
}

read_meta() {
  # $1=meta 文件 $2=key → 输出值（值可含 =）
  sed -n "s/^$2=//p" "$1" | head -n 1
}

# ---------- 任务状态 ----------
# 输出单个任务的 JSON
task_json() {
  local meta="$1" log="$2" id="$3"
  local url name pid status createdAt exitCode outDir
  local opt_auto opt_subonly opt_live opt_mux opt_threads
  url="$(read_meta "$meta" url)"
  name="$(read_meta "$meta" name)"
  pid="$(read_meta "$meta" pid)"
  status="$(read_meta "$meta" status)"
  createdAt="$(read_meta "$meta" createdAt)"
  exitCode="$(read_meta "$meta" exitCode)"
  outDir="$(read_meta "$meta" outDir)"
  rawparams="$(read_meta "$meta" rawparams)"
  ofiles="$(read_meta "$meta" outputFiles)"
  # 真实路径（解析符号链接，fnOS 打开文件/目录需要 /vol1/... 真实路径）
  realOutDir="$(readlink -f "$outDir" 2>/dev/null || echo "$outDir")"
  opt_auto="$(read_meta "$meta" auto)"
  opt_subonly="$(read_meta "$meta" subonly)"
  opt_live="$(read_meta "$meta" live)"
  opt_mux="$(read_meta "$meta" mux)"
  opt_threads="$(read_meta "$meta" threads)"

  local alive=0
  if [ -n "$pid" ]; then
    kill -0 "$pid" 2>/dev/null && alive=1
  fi

  # 推导状态
  if [ "$status" = "stopping" ]; then
    [ "$alive" -eq 1 ] || status="stopped"
  elif [ "$alive" -eq 1 ]; then
    status="running"
  else
    if [ -n "$exitCode" ]; then
      if [ "$exitCode" = "0" ]; then status="success"; else status="failed"; fi
    else
      status="stopped"
    fi
  fi

  # 从日志提取进度/速度/分片/阶段/最新一行
  # 真实 N_m3u8DL-RE 进度帧形如：
  #   Vid Kbps ━━━━━ 296/870 34.02% 581.06MB/1.68GB10.85MBps00:00:46
  # 各字段独立提取（各自取最后一次匹配），保证至少有一项能正确显示
  local lograw percent speed segments downloaded total eta stream stage lastline
  lograw="$(tail -c 131072 "$log" 2>/dev/null | tr '\r' '\n' | sed 's/\x1b\[[0-9;?]*[A-Za-z]//g')"
  percent="$(printf '%s\n' "$lograw" | grep -oE '[0-9]{1,3}(\.[0-9]+)?%' | tail -n 1 | tr -d '%')"
  # 速度：支持 MBps/KBps/GBps 与 MB/s 等；取最后一次（避免匹配到流信息里的码率）
  speed="$(printf '%s\n' "$lograw" | grep -oE '[0-9.]+ ?[KMGT]?Bps' | tail -n 1)"
  # 已下载/总量成对匹配：581.06MB/1.68GB
  dltotal="$(printf '%s\n' "$lograw" | grep -oE '[0-9.]+ ?[KMGT]?B/[0-9.]+ ?[KMGT]?B' | tail -n 1)"
  downloaded="${dltotal%/*}"
  total="${dltotal#*/}"
  segments="$(printf '%s\n' "$lograw" | grep -oE '[0-9]+/[0-9]+' | tail -n 1)"
  eta="$(printf '%s\n' "$lograw" | grep -oE '[0-9]{2}:[0-9]{2}:[0-9]{2}' | tail -n 1)"
  stream="$(printf '%s\n' "$lograw" | grep -oE '\b(Vid|Aud|Sub)\b' | tail -n 1)"
  # 分片比例兜底：无百分比时用 分片done/total 计算进度
  if [ -z "$percent" ] && [ -n "$segments" ]; then
    local sd st
    sd="${segments%/*}"
    st="${segments#*/}"
    if [ "$st" -gt 0 ] 2>/dev/null; then
      percent=$((sd * 100 / st))
    fi
  fi
  # 最新一行（去掉空行与纯进度条碎片；注意字符类中 - 必须放最后，避免 Invalid range）
  lastline="$(printf '%s\n' "$lograw" | grep -vE '^[[:space:]]*$' | grep -vE '^\[[#. =-]*\]$' | tail -n 1)"
  # 截断超长明细（如停止任务残留的长进度帧），避免前端卡片被撑超宽
  lastline="${lastline:0:300}"

  stage="处理中"
  if [ "$status" = "success" ]; then
    stage="已完成"
  elif [ "$status" = "stopped" ]; then
    stage="已停止"
  elif printf '%s\n' "$lograw" | grep -qiE '混流|mux'; then
    stage="混流中"
  elif printf '%s\n' "$lograw" | grep -qiE '合并|merge'; then
    stage="合并中"
  elif printf '%s\n' "$lograw" | grep -qiE '下载|download'; then
    stage="下载中"
  elif printf '%s\n' "$lograw" | grep -qiE '解析|parse|探测|probe'; then
    stage="解析中"
  fi

  # options 对象（用于界面重试）
  local options_json='{"autoSelect":'
  if [ "$opt_auto" = "1" ]; then options_json="${options_json}true"; else options_json="${options_json}false"; fi
  options_json="${options_json},\"subOnly\":"
  if [ "$opt_subonly" = "1" ]; then options_json="${options_json}true"; else options_json="${options_json}false"; fi
  options_json="${options_json},\"live\":"
  if [ "$opt_live" = "1" ]; then options_json="${options_json}true"; else options_json="${options_json}false"; fi
  options_json="${options_json},\"muxFormat\":\"$(printf '%s' "$opt_mux" | json_escape)\""
  if [ -n "$opt_threads" ]; then
    options_json="${options_json},\"threadCount\":$opt_threads"
  else
    options_json="${options_json},\"threadCount\":null"
  fi
  if [ -n "$outDir" ] && [ "$outDir" != "$SHARE_DIR" ]; then
    options_json="${options_json},\"saveDir\":\"$(printf '%s' "$outDir" | json_escape)\""
  fi
  options_json="${options_json}}"

  # 速度显示归一化：10.85MBps → 10.85 MB/s
  if [ -n "$speed" ]; then
    speed="$(printf '%s' "$speed" | sed 's/^\([0-9.]*\) *\([KMGT]\)Bps$/\1 \2B\/s/; s/^\([0-9.]*\) *Bps$/\1 B\/s/')"
  fi

  # outputFiles 转 JSON 数组（供界面"打开文件"按钮使用）
  local ofiles_json='[]'
  if [ -n "$ofiles" ]; then
    local of first_of=1 ofarr
    ofiles_json='['
    IFS=',' read -ra ofarr <<< "$ofiles"
    for of in "${ofarr[@]}"; do
      [ -n "$of" ] || continue
      [ "$first_of" -eq 1 ] || ofiles_json="$ofiles_json,"
      first_of=0
      ofiles_json="$ofiles_json\"$(printf '%s' "$of" | json_escape)\""
    done
    ofiles_json="$ofiles_json]"
  fi

  printf '{"id":"%s","url":"%s","name":"%s","status":"%s","stage":"%s","progress":%s,"speed":"%s","segments":"%s","downloaded":"%s","total":"%s","eta":"%s","stream":"%s","exitCode":%s,"createdAt":"%s","outDir":"%s","realOutDir":"%s","outputFiles":%s,"options":%s,"rawparams":"%s","last":"%s"}' \
    "$id" \
    "$(printf '%s' "$url" | json_escape)" \
    "$(printf '%s' "$name" | json_escape)" \
    "$status" \
    "$(printf '%s' "$stage" | json_escape)" \
    "${percent:-0}" \
    "$(printf '%s' "$speed" | json_escape)" \
    "$(printf '%s' "$segments" | json_escape)" \
    "$(printf '%s' "$downloaded" | json_escape)" \
    "$(printf '%s' "$total" | json_escape)" \
    "$(printf '%s' "$eta" | json_escape)" \
    "$(printf '%s' "$stream" | json_escape)" \
    "${exitCode:-null}" \
    "$(printf '%s' "$createdAt" | json_escape)" \
    "$(printf '%s' "$outDir" | json_escape)" \
    "$(printf '%s' "$realOutDir" | json_escape)" \
    "$ofiles_json" \
    "$options_json" \
    "$(printf '%s' "$rawparams" | json_escape)" \
    "$(printf '%s' "$lastline" | json_escape)"
}

list_tasks() {
  local first=1 meta id
  printf '{"ok":true,"dir":"%s","tasks":[' "$(printf '%s' "$SHARE_DIR" | json_escape)"
  if [ -d "$TASKS_DIR" ]; then
    for meta in "$TASKS_DIR"/*.meta; do
      [ -e "$meta" ] || continue
      id="$(basename "$meta" .meta)"
      [ "$first" -eq 1 ] || printf ','
      first=0
      task_json "$meta" "$TASKS_DIR/$id.log" "$id"
    done
  fi
  printf ']}'
}

# ---------- 任务操作 ----------
create_task() {
  [ -n "$URL" ] || { echo '{"ok":false,"error":"下载链接不能为空"}'; return; }
  case "$URL" in
    http://*|https://*|/*) : ;;
    *)
      echo '{"ok":false,"error":"仅支持 http(s) 链接或本地文件路径"}'
      return
      ;;
  esac

  # 运行中任务数限制
  local running=0 meta pid
  if [ -d "$TASKS_DIR" ]; then
    for meta in "$TASKS_DIR"/*.meta; do
      [ -e "$meta" ] || continue
      pid="$(read_meta "$meta" pid)"
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        running=$((running + 1))
      fi
    done
  fi
  if [ "$running" -ge "$MAX_RUNNING" ]; then
    echo "{\"ok\":false,\"error\":\"已有 $MAX_RUNNING 个任务在运行，请稍后再试\"}"
    return
  fi

  # 确保任务/输出目录存在（若兜底仍失败，报出详细信息）
  if [ ! -d "$TASKS_DIR" ] || [ ! -d "$SHARE_DIR" ]; then
    mkdir -p "$TASKS_DIR" "$SHARE_DIR" 2>/dev/null
  fi
  if [ ! -d "$TASKS_DIR" ] || [ ! -w "$TASKS_DIR" ]; then
    echo "{\"ok\":false,\"error\":\"无法创建任务目录: $TASKS_DIR\",\"whoami\":\"$(id -un 2>/dev/null)\",\"app_root\":\"$APP_ROOT\",\"pkgvar\":\"${TRIM_PKGVAR:-未设置}\"}"
    return
  fi
  if [ ! -d "$SHARE_DIR" ] || [ ! -w "$SHARE_DIR" ]; then
    echo "{\"ok\":false,\"error\":\"无法创建输出目录: $SHARE_DIR\",\"whoami\":\"$(id -un 2>/dev/null)\",\"app_root\":\"$APP_ROOT\",\"share_paths\":\"${TRIM_DATA_SHARE_PATHS:-未设置}\"}"
    return
  fi

  # 生成任务 ID（uuid 优先，兜底时间戳）
  local id
  id="$(cat /proc/sys/kernel/random/uuid 2>/dev/null | cut -c1-8)"
  [ -n "$id" ] || id="$(date +%s)-$$"
  local meta="$TASKS_DIR/$id.meta"
  local log="$TASKS_DIR/$id.log"
  local outDir="${DIR_ARG:-$SHARE_DIR}"

  # 组装参数（使用数组避免空格问题；覆盖 N_m3u8DL-RE 全部可视化参数）
  local -a args=()
  # 基本
  [ -n "$NAME" ] && args+=(--save-name "$NAME")
  [ -n "$SAVE_PATTERN" ] && args+=(--save-pattern "$SAVE_PATTERN")
  if [ -n "$THREADS" ] && [ "$THREADS" -gt 0 ] 2>/dev/null; then
    args+=(--thread-count "$THREADS")
  fi
  [ "$AUTO" = "1" ] && args+=(--auto-select)
  [ "$CONCURRENT" = "1" ] && args+=(-mt)
  [ -n "$MUX" ] && args+=(-M "format=$MUX")
  [ "$SUBONLY" = "1" ] && args+=(--sub-only)
  [ -n "$SUB_FORMAT" ] && args+=(--sub-format "$SUB_FORMAT")
  [ "$LIVE" = "1" ] && args+=(--live-perform-as-vod)
  [ -n "$MAX_SPEED" ] && args+=(-R "$MAX_SPEED")
  # 高级
  [ -n "$TMP_DIR" ] && args+=(--tmp-dir "$TMP_DIR")
  [ -n "$RETRY_COUNT" ] && args+=(--download-retry-count "$RETRY_COUNT")
  [ -n "$TIMEOUT" ] && args+=(--http-request-timeout "$TIMEOUT")
  [ -n "$CUSTOM_PROXY" ] && args+=(--custom-proxy "$CUSTOM_PROXY")
  [ "$USE_SYSTEM_PROXY" = "0" ] && args+=(--use-system-proxy false)
  if [ -n "$HEADERS" ]; then
    while IFS= read -r h; do
      [ -n "$h" ] && args+=(-H "$h")
    done <<< "$HEADERS"
  fi
  [ -n "$CUSTOM_RANGE" ] && args+=(--custom-range "$CUSTOM_RANGE")
  [ -n "$TASK_START_AT" ] && args+=(--task-start-at "$TASK_START_AT")
  [ -n "$BASE_URL" ] && args+=(--base-url "$BASE_URL")
  [ -n "$SELECT_VIDEO" ] && args+=(-sv "$SELECT_VIDEO")
  [ -n "$SELECT_AUDIO" ] && args+=(-sa "$SELECT_AUDIO")
  [ -n "$SELECT_SUBTITLE" ] && args+=(-ss "$SELECT_SUBTITLE")
  [ -n "$DROP_VIDEO" ] && args+=(-dv "$DROP_VIDEO")
  [ -n "$DROP_AUDIO" ] && args+=(-da "$DROP_AUDIO")
  [ -n "$DROP_SUBTITLE" ] && args+=(-ds "$DROP_SUBTITLE")
  [ -n "$AD_KEYWORD" ] && args+=(--ad-keyword "$AD_KEYWORD")
  [ "$SKIP_MERGE" = "1" ] && args+=(--skip-merge)
  [ "$BINARY_MERGE" = "1" ] && args+=(--binary-merge)
  [ "$APPEND_URL_PARAMS" = "1" ] && args+=(--append-url-params)
  [ "$NO_DATE_INFO" = "1" ] && args+=(--no-date-info)
  [ "$DISABLE_UPDATE_CHECK" = "1" ] && args+=(--disable-update-check)
  [ -n "$KEY" ] && args+=(--key "$KEY")
  [ -n "$KEY_TEXT_FILE" ] && args+=(--key-text-file "$KEY_TEXT_FILE")
  [ -n "$DECRYPTION_ENGINE" ] && args+=(--decryption-engine "$DECRYPTION_ENGINE")
  [ -n "$DECRYPTION_BINARY_PATH" ] && args+=(--decryption-binary-path "$DECRYPTION_BINARY_PATH")
  [ "$MP4_REAL_TIME_DECRYPTION" = "1" ] && args+=(--mp4-real-time-decryption)
  [ -n "$CUSTOM_HLS_METHOD" ] && args+=(--custom-hls-method "$CUSTOM_HLS_METHOD")
  [ -n "$CUSTOM_HLS_KEY" ] && args+=(--custom-hls-key "$CUSTOM_HLS_KEY")
  [ -n "$CUSTOM_HLS_IV" ] && args+=(--custom-hls-iv "$CUSTOM_HLS_IV")
  [ -n "$LOG_LEVEL" ] && args+=(--log-level "$LOG_LEVEL")
  [ "$NO_LOG" = "1" ] && args+=(--no-log)
  [ "$LIVE_REAL_TIME_MERGE" = "1" ] && args+=(--live-real-time-merge)
  [ -n "$LIVE_RECORD_LIMIT" ] && args+=(--live-record-limit "$LIVE_RECORD_LIMIT")
  [ -n "$LIVE_WAIT_TIME" ] && args+=(--live-wait-time "$LIVE_WAIT_TIME")
  [ "$LIVE_KEEP_SEGMENTS" = "0" ] && args+=(--live-keep-segments false)
  [ "$LIVE_PIPE_MUX" = "1" ] && args+=(--live-pipe-mux)
  args+=(--no-ansi-color) # 便于进度解析
  [ -n "$DIR_ARG" ] && args+=(--save-dir "$DIR_ARG")

  {
    echo "id=$id"
    echo "url=$URL"
    echo "name=${NAME:-$id}"
    echo "createdAt=$(date -Is)"
    echo "status=queued"
    echo "outDir=$outDir"
    echo "auto=$AUTO"
    echo "subonly=$SUBONLY"
    echo "live=$LIVE"
    echo "mux=$MUX"
    echo "threads=$THREADS"
    # 保留原始创建参数（用于界面重试）
    echo "rawparams=$(printf '%s' "$RAW_ALL" | sed 's/&action=[^&]*//; s/^action=[^&]*&*//')"
  } > "$meta"

  # 记录任务开始前的输出目录快照（结束后由 task-run.sh 对比，识别本任务产生的文件）
  if [ -d "$outDir" ]; then
    (cd "$outDir" && ls -A1 2>/dev/null | sort) > "$TASKS_DIR/$id.snapshot" 2>/dev/null || true
  else
    : > "$TASKS_DIR/$id.snapshot"
  fi

  # 后台启动：优先 setsid 创建独立会话/进程组（便于整组停止）；
  # 无 setsid 的环境（如本地测试）退化为 nohup，停止时按 pid 处理。
  if [ -d "$outDir" ]; then
    cd "$outDir" || true
  fi
  if command -v setsid >/dev/null 2>&1; then
    setsid "$RUNNER" "$meta" "$log" "$BIN" "${args[@]}" "$URL" </dev/null >>/dev/null 2>&1 &
  else
    nohup "$RUNNER" "$meta" "$log" "$BIN" "${args[@]}" "$URL" </dev/null >>/dev/null 2>&1 &
  fi
  local pid=$!
  if [ -n "$pid" ]; then
    echo "pid=$pid" >> "$meta"
    echo "status=running" >> "$meta"
  fi

  echo "{\"ok\":true,\"id\":\"$id\"}"
}

stop_task() {
  [ -n "$ID" ] || { echo '{"ok":false,"error":"缺少任务 id"}'; return; }
  local meta="$TASKS_DIR/$ID.meta"
  [ -f "$meta" ] || { echo '{"ok":false,"error":"任务不存在"}'; return; }
  local pid
  pid="$(read_meta "$meta" pid)"
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    echo "status=stopping" >> "$meta"
    # 对进程组发送 TERM（setsid 启动，组号=pid），8 秒后补 KILL
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null
    ( sleep 8; kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null ) >/dev/null 2>&1 &
  fi
  echo '{"ok":true}'
}

remove_task() {
  [ -n "$ID" ] || { echo '{"ok":false,"error":"缺少任务 id"}'; return; }
  local meta="$TASKS_DIR/$ID.meta"
  [ -f "$meta" ] || { echo '{"ok":false,"error":"任务不存在"}'; return; }
  local pid
  pid="$(read_meta "$meta" pid)"
  [ -n "$pid" ] && { kill -KILL -- "-$pid" 2>/dev/null; kill -KILL "$pid" 2>/dev/null; }
  rm -f "$meta" "$TASKS_DIR/$ID.log" "$TASKS_DIR/$ID.snapshot"
  echo '{"ok":true}'
}

# ---------- 文件管理 ----------
# 已下载文件列表：仅汇总程序自身记录的任务输出文件（不扫描目录，
# 避免把用户目录中的无关文件都列出来）。路径校验仍基于允许根目录。
allowed_roots() {
  printf '%s\n' "$SHARE_DIR"
  [ -n "$REAL_SHARE" ] && printf '%s\n' "$REAL_SHARE"
  [ -n "$REAL_SHARE" ] && printf '%s\n' "$REAL_SHARE/downloads"
  if [ -d "$TASKS_DIR" ]; then
    local meta o
    for meta in "$TASKS_DIR"/*.meta; do
      [ -e "$meta" ] || continue
      o="$(read_meta "$meta" outDir)"
      [ -n "$o" ] && printf '%s\n' "$o"
    done
  fi
}

# 路径是否在允许的输出根目录内（拒绝穿越/越权）
path_allowed() {
  local p="$1" root
  [ -n "$p" ] || return 1
  case "$p" in
    /*) ;;
    *) return 1 ;;
  esac
  while read -r root; do
    [ -n "$root" ] || continue
    case "$p" in
      "$root"|"$root"/*) return 0 ;;
    esac
  done < <(allowed_roots | awk '!seen[$0]++')
  return 1
}

list_files() {
  local first=1 meta id outdir names name f size mtime realpath seen="|"
  printf '{"ok":true,"dir":"%s","files":[' "$(printf '%s' "$SHARE_DIR" | json_escape)"
  if [ -d "$TASKS_DIR" ]; then
    for meta in "$TASKS_DIR"/*.meta; do
      [ -e "$meta" ] || continue
      outdir="$(read_meta "$meta" outDir)"
      names="$(read_meta "$meta" outputFiles)"
      [ -n "$outdir" ] || continue
      [ -n "$names" ] || continue
      IFS=',' read -ra namearr <<< "$names"
      for name in "${namearr[@]}"; do
        [ -n "$name" ] || continue
        f="$outdir/$name"
        [ -f "$f" ] || continue
        case "$seen" in
          *"|$f|"*) continue ;;  # 去重
        esac
        seen="$seen$f|"
        [ "$first" -eq 1 ] || printf ','
        first=0
        size="$(stat -c %s "$f" 2>/dev/null || stat -f %z "$f" 2>/dev/null || echo 0)"
        mtime="$(stat -c %y "$f" 2>/dev/null | cut -d. -f1)"
        realpath="$(readlink -f "$f" 2>/dev/null || echo "$f")"
        printf '{"name":"%s","path":"%s","realPath":"%s","size":%s,"mtime":"%s"}' \
          "$(printf '%s' "$name" | json_escape)" \
          "$(printf '%s' "$f" | json_escape)" \
          "$(printf '%s' "$realpath" | json_escape)" \
          "$size" \
          "$(printf '%s' "$mtime" | json_escape)"
      done
    done
  fi
  printf ']}'
}

# 目标文件：优先 path（绝对路径，需校验），回退 file（共享目录下的文件名）
resolve_target() {
  if [ -n "$PATH_ARG" ]; then
    printf '%s' "$PATH_ARG"
  else
    valid_filename "$FILE" || return 1
    printf '%s/%s' "$SHARE_DIR" "$FILE"
  fi
}

# 文件名合法性：只允许扁平文件名，拒绝路径/穿越（兼容旧的 file 参数）
valid_filename() {
  case "$1" in
    ""|*/*|*\\*|*..*) return 1 ;;
    *) return 0 ;;
  esac
}

download_file() {
  local target
  target="$(resolve_target)" || { json_header; echo '{"ok":false,"error":"非法文件名"}'; return; }
  path_allowed "$target" || { json_header; echo '{"ok":false,"error":"路径不在允许范围内"}'; return; }
  [ -f "$target" ] || { json_header; echo '{"ok":false,"error":"文件不存在"}'; return; }
  printf 'Content-Type: application/octet-stream\r\n'
  printf 'Content-Disposition: attachment; filename="%s"\r\n\r\n' "$(basename "$target")"
  cat "$target"
}

delete_file() {
  local target
  target="$(resolve_target)" || { echo '{"ok":false,"error":"非法文件名"}'; return; }
  path_allowed "$target" || { echo '{"ok":false,"error":"路径不在允许范围内"}'; return; }
  [ -f "$target" ] || { echo '{"ok":false,"error":"文件不存在"}'; return; }
  rm -f "$target"
  echo '{"ok":true}'
}

# ---------- 静态文件 ----------
serve_static() {
  # $1=绝对路径
  local f="$1" ct
  if [ ! -f "$f" ]; then
    printf 'Status: 404 Not Found\r\nContent-Type: text/html; charset=utf-8\r\n\r\n'
    printf '<html><body style="font-family:sans-serif;padding:40px"><h2>404 Not Found</h2><p>%s</p><p>WWW 目录: %s</p><p>TRIM_APPDEST: %s</p></body></html>\r\n' \
      "$f" "$WWW" "${TRIM_APPDEST:-未设置}"
    return
  fi
  case "$f" in
    *.html) ct="text/html; charset=utf-8" ;;
    *.js)   ct="application/javascript; charset=utf-8" ;;
    *.css)  ct="text/css; charset=utf-8" ;;
    *)      ct="application/octet-stream" ;;
  esac
  printf 'Content-Type: %s\r\n\r\n' "$ct"
  if [ "$f" = "$WWW/index.html" ]; then
    # 注入 <base> 标签：无论带不带尾斜杠访问，相对资源（app.js/style.css）都能正确解析
    local base
    base="${REQUEST_URI%%\?*}"
    case "$base" in
      */) : ;;
      *) base="$base/" ;;
    esac
    sed "s|<head>|<head><base href=\"$base\">|" "$f"
  else
    cat "$f"
  fi
}

# ---------- 诊断 ----------
ping() {
  local bin_exists=0 www_exists=0
  [ -x "$BIN" ] && bin_exists=1
  [ -f "$WWW/index.html" ] && www_exists=1
  printf '{"ok":true,"app":"N_m3u8DL-RE","target":"%s","www_exists":%s,"bin_exists":%s,"tasks_dir":"%s","share_dir":"%s","whoami":"%s","uid":"%s","request_method":"%s","pkgvar":"%s","data_share_paths":"%s","bash":"%s"}' \
    "$(printf '%s' "$TARGET" | json_escape)" \
    "$www_exists" "$bin_exists" \
    "$(printf '%s' "$TASKS_DIR" | json_escape)" \
    "$(printf '%s' "$SHARE_DIR" | json_escape)" \
    "$(id -un 2>/dev/null)" "$(id -u 2>/dev/null)" \
    "${REQUEST_METHOD:-}" \
    "$(printf '%s' "${TRIM_PKGVAR:-未设置}" | json_escape)" \
    "$(printf '%s' "${TRIM_DATA_SHARE_PATHS:-未设置}" | json_escape)" \
    "$(bash --version 2>/dev/null | head -n1)"
}

# ---------- 更新检查 ----------
# 本地版本信息（app/www/version，构建时由 build-fpk.mjs 生成）：
#   appVersion=0.6.0-beta.24       应用（fpk）版本
#   engineVersion=0.6.0-beta       内置引擎版本（N_m3u8DL-RE 上游 tag 去掉 v）
# 远程检查：引擎走 nilaoda/N_m3u8DL-RE Releases，应用走本项目 Releases；
# 用 releases?per_page=1 取最新一条（含预发布，releases/latest 会跳过 prerelease）。
# 网络不可达（部分内网/无 GitHub 环境）时优雅降级：只返回本地版本并给出原因。

# 请求 GitHub API：curl 优先、wget 兜底；响应体输出到 stdout。
# 返回码：0=成功 1=网络/HTTP 错误 2=本机无 curl/wget
github_get() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 6 --max-time 15 -A "m3u8_down-update-check/1.0" "$url" 2>/dev/null
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=15 -U "m3u8_down-update-check/1.0" "$url" 2>/dev/null
    return $?
  fi
  return 2
}

# 从 JSON 中提取字段的字符串值（宽松匹配，取首次出现：
# Release 对象自身的 html_url 排在最前，贪心取末次会误中 author/uploader 的链接）
parse_json_field() {
  printf '%s' "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 | sed -E "s/^\"$2\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"/\1/"
}

# 版本比较：$1 > $2 → 返回 0（容忍 v 前缀；优先 sort -V 数字感知比较）
ver_gt() {
  local a="${1#v}" b="${2#v}"
  [ -n "$a" ] && [ -n "$b" ] || return 1
  [ "$a" = "$b" ] && return 1
  local hi
  if printf '%s\n%s\n' "$a" "$b" | sort -V >/dev/null 2>&1; then
    hi="$(printf '%s\n%s\n' "$a" "$b" | sort -V | tail -n 1)"
  else
    hi="$(printf '%s\n%s\n' "$a" "$b" | sort | tail -n 1)"
  fi
  [ "$hi" = "$a" ]
}

# 输出 JSON 字符串（空 → null）
json_str() {
  if [ -n "$1" ]; then printf '"%s"' "$(printf '%s' "$1" | json_escape)"; else printf 'null'; fi
}

# 1/0/空 → true/false/null
json_bool_null() {
  case "$1" in
    1) printf 'true' ;;
    0) printf 'false' ;;
    *) printf 'null' ;;
  esac
}

update_check() {
  local app_ver="" engine_ver=""
  if [ -f "$WWW/version" ]; then
    app_ver="$(sed -n 's/^appVersion=//p' "$WWW/version" | head -n 1)"
    engine_ver="$(sed -n 's/^engineVersion=//p' "$WWW/version" | head -n 1)"
  fi

  local net="ok" body="" rc
  local eng_latest="" eng_pub="" eng_url="" eng_err=""
  local app_latest="" app_pub="" app_url="" app_err="" asset_name="" asset_url=""

  if [ "${NRE_UPDATE_SKIP_NET:-0}" = "1" ]; then
    net="skipped"
  else
    # 引擎最新版本（上游 nilaoda/N_m3u8DL-RE）
    body="$(github_get "https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases?per_page=1")"
    rc=$?
    if [ $rc -eq 0 ] && [ -n "$body" ]; then
      eng_latest="$(parse_json_field "$body" tag_name)"
      eng_pub="$(parse_json_field "$body" published_at)"
      eng_url="$(parse_json_field "$body" html_url)"
      [ -z "$eng_latest" ] && eng_err="GitHub 返回异常（可能暂无发布或接口受限）"
    elif [ $rc -eq 2 ]; then
      eng_err="本机无 curl/wget，无法联网"
      net="unreachable"
    else
      eng_err="网络不可达（无法访问 GitHub）"
      net="unreachable"
    fi

    # 应用最新版本（本项目 Youngxj/N_m3u8DL-RE-FN，含预发布）
    body="$(github_get "https://api.github.com/repos/Youngxj/N_m3u8DL-RE-FN/releases?per_page=1")"
    rc=$?
    if [ $rc -eq 0 ] && [ -n "$body" ]; then
      app_latest="$(parse_json_field "$body" tag_name)"
      app_pub="$(parse_json_field "$body" published_at)"
      app_url="$(parse_json_field "$body" html_url)"
      # 提取 fpk 附件名与直链（browser_download_url）
      asset_name="$(printf '%s' "$body" | grep -oE '"[^"]*_all\.fpk"' | head -n 1 | tr -d '"')"
      asset_url="$(printf '%s' "$body" | grep -oE '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n 1 | sed -E 's/.*"([^"]*)"$/\1/')"
      [ -z "$app_latest" ] && app_err="GitHub 返回异常（可能暂无发布或接口受限）"
    elif [ $rc -eq 2 ]; then
      app_err="本机无 curl/wget，无法联网"
      net="unreachable"
    else
      app_err="网络不可达（无法访问 GitHub）"
      net="unreachable"
    fi
  fi

  # 版本比较：有"本地+最新"才判定；否则 unknown（null）
  local eng_up="" app_up=""
  if [ -n "$eng_latest" ] && [ -n "$engine_ver" ]; then
    if ver_gt "$eng_latest" "$engine_ver"; then eng_up=0; else eng_up=1; fi
  fi
  if [ -n "$app_latest" ] && [ -n "$app_ver" ]; then
    if ver_gt "$app_latest" "$app_ver"; then app_up=0; else app_up=1; fi
  fi

  local asset_json='null'
  if [ -n "$asset_name" ]; then
    asset_json="{\"name\":$(json_str "$asset_name"),\"url\":$(json_str "$asset_url")}"
  fi

  printf '{"ok":true,"network":"%s","appVersion":%s,"engineVersion":%s,"engine":{"latest":%s,"publishedAt":%s,"releaseUrl":%s,"upToDate":%s,"error":%s},"app":{"latest":%s,"publishedAt":%s,"releaseUrl":%s,"upToDate":%s,"asset":%s,"error":%s}}' \
    "$net" \
    "$(json_str "$app_ver")" \
    "$(json_str "$engine_ver")" \
    "$(json_str "$eng_latest")" \
    "$(json_str "$eng_pub")" \
    "$(json_str "$eng_url")" \
    "$(json_bool_null "$eng_up")" \
    "$(json_str "$eng_err")" \
    "$(json_str "$app_latest")" \
    "$(json_str "$app_pub")" \
    "$(json_str "$app_url")" \
    "$(json_bool_null "$app_up")" \
    "$asset_json" \
    "$(json_str "$app_err")"
}

# ---------- 请求分发 ----------
# 解析参数：GET query + POST body（保留原始参数用于任务重试）
QUERY="${QUERY_STRING:-}"
if [ "$REQUEST_METHOD" = "POST" ]; then
  BODY_RAW="$(cat 2>/dev/null)"
  parse_params "$BODY_RAW"
fi
parse_params "$QUERY"
RAW_ALL="${QUERY}${QUERY:+&}${BODY_RAW:-}"

# 解析静态资源相对路径（如 /cgi/ThirdParty/m3u8_down/index.cgi/app.js）
# 兼容不同 Web 服务器：优先 REQUEST_URI，其次 PATH_INFO，都没有则视为首页
normalize_rel() {
  local p="$1"
  case "$p" in
    *index.cgi*) p="${p#*index.cgi}" ;;
  esac
  [ -n "$p" ] || p="/"
  printf '%s' "$p"
}

REL_PATH="/"
if [ -n "$REQUEST_URI" ]; then
  REL_PATH="$(normalize_rel "${REQUEST_URI%%\?*}")"
elif [ -n "$PATH_INFO" ]; then
  REL_PATH="$(normalize_rel "$PATH_INFO")"
fi

# 统一入口：访问 /index.cgi（无尾斜杠）时 302 到 /index.cgi/
# （保证相对资源 app.js/style.css 解析正确，避免出现"裸 HTML"假象）
if [ -z "$ACTION" ] && [ -n "$REQUEST_URI" ]; then
  URI_NO_QUERY="${REQUEST_URI%%\?*}"
  case "$URI_NO_QUERY" in
    *index.cgi)
      local qs=""
      case "$REQUEST_URI" in
        *\?*) qs="?${REQUEST_URI#*\?}" ;;
      esac
      printf 'Status: 302 Found\r\nLocation: %s/%s\r\n\r\n' "$URI_NO_QUERY" "$qs"
      exit 0
      ;;
  esac
fi

case "$ACTION" in
  create)       json_header; create_task ;;
  status)       json_header; list_tasks ;;
  stop)         json_header; stop_task ;;
  remove)       json_header; remove_task ;;
  files)        json_header; list_files ;;
  download)     download_file ;;
  delete_file)  json_header; delete_file ;;
  update_check) json_header; update_check ;;
  ping)         json_header; ping ;;
  *)
    # 静态页面/资源
    case "$REL_PATH" in
      *..*|*\**) serve_static "$WWW/404.html" ;;
      /)         serve_static "$WWW/index.html" ;;
      *)         serve_static "$WWW$REL_PATH" ;;
    esac
    ;;
esac
