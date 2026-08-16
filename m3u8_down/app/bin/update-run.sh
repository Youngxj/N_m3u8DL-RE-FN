#!/bin/bash
# update-run.sh — 后台更新执行器（引擎更新 / 新版应用 fpk 下载）
#
# 由 index.cgi 以 setsid 启动，独立于请求进程运行（长下载不阻塞 CGI）。
# 进度与结果写入 <STATE_DIR>/update-job（key=value 格式）：
#   mode=engine|app
#   status=running|ok|failed
#   startedAt / finishedAt
#   message=结果说明
#   （engine 成功后）engineVersion / engineTag / updatedAt
#   （app 成功后）version / name / path / size
#
# 用法：
#   update-run.sh engine <STATE_DIR> <BIN_ARCH_DIR> <ENGINE_STATE_FILE>
#   update-run.sh app    <STATE_DIR> <SHARE_DIR>
#
# 安全设计：
#   - 下载到应用数据区临时目录，校验通过后才替换（先 cp 到目标目录再 mv，原子改名）
#   - 任何一步失败都不触碰现有二进制/文件，旧版本保持可用
#   - 引擎校验：解压后执行 --version（自包含二进制，无需 .NET），确认是有效引擎
exec 2>/dev/null

MODE="$1"; STATE_DIR="$2"
JOB="$STATE_DIR/update-job"

# ---------- 工具 ----------
reset_job() {
  : > "$JOB"
  echo "mode=$MODE" >> "$JOB"
  echo "status=running" >> "$JOB"
  echo "startedAt=$(date -Is 2>/dev/null)" >> "$JOB"
}

finish() { # $1=ok|failed $2=message
  echo "status=$1" >> "$JOB"
  echo "finishedAt=$(date -Is 2>/dev/null)" >> "$JOB"
  echo "message=$2" >> "$JOB"
  exit 0
}

github_get() {
  local url="$1"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --connect-timeout 6 --max-time 15 -A "m3u8_down-update/1.0" "$url" 2>/dev/null
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -qO- --timeout=15 -U "m3u8_down-update/1.0" "$url" 2>/dev/null
    return $?
  fi
  return 2
}

parse_json_field() {
  printf '%s' "$1" | grep -oE "\"$2\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" | head -n 1 | sed -E "s/^\"$2\"[[:space:]]*:[[:space:]]*\"([^\"]*)\"/\1/"
}

download_file() { # $1=url $2=dest
  if command -v curl >/dev/null 2>&1; then
    curl -fL --connect-timeout 10 --max-time 900 --retry 2 --retry-delay 3 -A "m3u8_down-update/1.0" -o "$2" "$1" 2>/dev/null
    return $?
  fi
  if command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" --timeout=900 --tries=3 "$1" 2>/dev/null
    return $?
  fi
  return 2
}

# ---------- 引擎更新 ----------
update_engine() {
  local bin_dir="$3" eng_state="$4" arch_suffix="" body="" tag="" asset_name="" asset_url=""
  local tmp_dir bin_file ver

  case "$(basename "$bin_dir")" in
    x64)   arch_suffix="linux-x64" ;;
    arm64) arch_suffix="linux-arm64" ;;
    *)     finish failed "未知引擎架构目录: $bin_dir" ;;
  esac

  reset_job

  # 1. 查询上游最新 Release
  body="$(github_get "https://api.github.com/repos/nilaoda/N_m3u8DL-RE/releases?per_page=1")"
  [ -n "$body" ] || finish failed "无法连接 GitHub，请检查网络"
  tag="$(parse_json_field "$body" tag_name)"
  asset_name="$(printf '%s' "$body" | grep -oE "\"[^\"]*${arch_suffix}_[^\"]*\.tar\.gz\"" | head -n 1 | tr -d '"')"
  [ -n "$asset_name" ] || finish failed "上游最新 Release 未找到 ${arch_suffix} 引擎包"
  asset_url="https://github.com/nilaoda/N_m3u8DL-RE/releases/download/${tag}/${asset_name}"
  echo "targetVersion=${tag#v}" >> "$JOB"

  # 2. 下载到应用数据区临时目录
  tmp_dir="$STATE_DIR/update-tmp"
  rm -rf "$tmp_dir"
  mkdir -p "$tmp_dir" || finish failed "无法创建临时目录"
  download_file "$asset_url" "$tmp_dir/asset.tar.gz" || { rm -rf "$tmp_dir"; finish failed "引擎包下载失败（网络或文件较大，请重试）"; }

  # 3. 解压并定位二进制
  ( cd "$tmp_dir" && tar -xzf asset.tar.gz 2>/dev/null ) || { rm -rf "$tmp_dir"; finish failed "引擎包解压失败"; }
  bin_file="$(find "$tmp_dir" -type f -name 'N_m3u8DL-RE' | head -n 1)"
  [ -n "$bin_file" ] || { rm -rf "$tmp_dir"; finish failed "引擎包中未找到 N_m3u8DL-RE 二进制"; }
  chmod 755 "$bin_file"

  # 4. 校验：执行 --version 确认是有效引擎
  ver="$( "$bin_file" --version 2>/dev/null | head -n 1 )"
  case "$ver" in
    *"$tag"*) : ;;
    *N_m3u8DL*|*n_m3u8dl*) : ;;   # 版本号格式差异时，只要确认为本引擎即通过
    *) rm -rf "$tmp_dir"; finish failed "引擎校验未通过（--version 输出: ${ver:-空}）" ;;
  esac
  echo "verifiedVersion=$(printf '%s' "$ver" | tr -d '\r')" >> "$JOB"

  # 5. 原子替换：先复制到目标目录再改名（同文件系统 mv 原子；跨设备时旧二进制不受中途失败影响）
  [ -d "$bin_dir" ] || finish failed "引擎目录不存在: $bin_dir"
  [ -w "$bin_dir" ] || finish failed "引擎目录不可写: $bin_dir（请通过应用更新获取新引擎）"
  cp -f "$bin_file" "$bin_dir/.N_m3u8DL-RE.new" || finish failed "写入引擎目录失败"
  mv -f "$bin_dir/.N_m3u8DL-RE.new" "$bin_dir/N_m3u8DL-RE" || finish failed "替换引擎失败"
  chmod 755 "$bin_dir/N_m3u8DL-RE"

  # 6. 记录引擎版本状态（应用数据区，升级应用时由 install/upgrade_callback 清理）
  {
    echo "engineVersion=${tag#v}"
    echo "engineTag=$tag"
    echo "updatedAt=$(date -Is 2>/dev/null)"
  } > "$eng_state"

  rm -rf "$tmp_dir"
  finish ok "核心引擎已更新到 ${tag#v}"
}

# ---------- 新版应用下载（fpk 到共享目录） ----------
update_app() {
  local share_dir="$3" body="" tag="" name="" url="" size=""
  reset_job

  body="$(github_get "https://api.github.com/repos/Youngxj/N_m3u8DL-RE-FN/releases?per_page=1")"
  [ -n "$body" ] || finish failed "无法连接 GitHub，请检查网络"
  tag="$(parse_json_field "$body" tag_name)"
  name="$(printf '%s' "$body" | grep -oE '"[^"]*_all\.fpk"' | head -n 1 | tr -d '"')"
  [ -n "$name" ] || finish failed "最新 Release 中没有 fpk 附件"
  echo "targetVersion=${tag#v}" >> "$JOB"
  echo "name=$name" >> "$JOB"

  [ -d "$share_dir" ] || finish failed "共享目录不存在: $share_dir"
  url="https://github.com/Youngxj/N_m3u8DL-RE-FN/releases/download/${tag}/${name}"
  download_file "$url" "$share_dir/$name" || { rm -f "$share_dir/$name"; finish failed "新版应用下载失败（网络或文件较大，请重试）"; }

  size="$(stat -c %s "$share_dir/$name" 2>/dev/null || stat -f %z "$share_dir/$name" 2>/dev/null || echo 0)"
  echo "path=$share_dir/$name" >> "$JOB"
  echo "size=$size" >> "$JOB"
  finish ok "新版应用已下载：$share_dir/$name"
}

case "$MODE" in
  engine) update_engine "$@" ;;
  app)    update_app "$@" ;;
  *)      finish failed "未知更新模式: $MODE" ;;
esac
