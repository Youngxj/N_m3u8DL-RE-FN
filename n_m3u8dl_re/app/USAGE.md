# N_m3u8DL-RE 使用说明

> 本文档整理自 [N_m3u8DL-RE 官方 README](https://github.com/nilaoda/N_m3u8DL-RE)。
> 完整参数以 `N_m3u8DL-RE --help` 与 `N_m3u8DL-RE --morehelp <选项>` 为准。

## 基本用法

```text
N_m3u8DL-RE <input> [options]
```

- `<input>`：m3u8 / mpd / mss 链接，或本地文件路径。
- 支持点播与直播（DASH / HLS / MSS）。

## 常用参数

| 参数 | 说明 |
| --- | --- |
| `--tmp-dir <dir>` | 临时文件目录 |
| `--save-dir <dir>` | 输出目录（默认当前目录） |
| `--save-name <name>` | 保存文件名 |
| `--save-pattern <pattern>` | 文件名模板，支持 `<SaveName> <Id> <Codecs> <Language> <Resolution> <Bandwidth> <MediaType> <Channels> <FrameRate> <VideoRange> <GroupId> <Ext>` 变量 |
| `--thread-count <n>` | 下载线程数（默认本机 CPU 线程数） |
| `--download-retry-count <n>` | 分片失败重试次数（默认 3） |
| `--http-request-timeout <s>` | HTTP 请求超时秒数（默认 100） |
| `--auto-select` | 自动选择所有类型的最佳轨道 |
| `-sv / -sa / -ss` | 按正则选择视频 / 音频 / 字幕流 |
| `-dv / -da / -ds` | 按正则剔除视频 / 音频 / 字幕流 |
| `--sub-only` | 只下载字幕 |
| `--sub-format <SRT\|VTT>` | 字幕输出格式（默认 SRT） |
| `-mt, --concurrent-download` | 并发下载已选择的音视频与字幕 |
| `-H, --header <header>` | 自定义请求头，如 `-H "Cookie: xxx"` |
| `-R, --max-speed <SPEED>` | 限速，如 `15M`、`100K` |
| `-M, --mux-after-done <OPTIONS>` | 完成后混流，如 `-M format=mp4`、`-M format=mkv:muxer=mkvmerge` |
| `--binary-merge` | 使用二进制合并（不依赖 ffmpeg） |
| `--skip-merge` | 跳过合并，只保留分片 |
| `--key <KEY>` | 指定解密密钥（`--key KID1:KEY1`），配合 mp4decrypt / shaka-packager / ffmpeg |
| `--decryption-engine <FFMPEG\|MP4DECRYPT\|SHAKA_PACKAGER>` | 解密引擎（默认 MP4DECRYPT） |
| `--custom-hls-method <METHOD>` | 指定 HLS 加密方式（AES_128 / CENC / NONE 等） |
| `--custom-hls-key <FILE\|HEX\|BASE64>` | 指定 HLS 解密 KEY |
| `--custom-hls-iv <FILE\|HEX\|BASE64>` | 指定 HLS 解密 IV |
| `--use-system-proxy` / `--custom-proxy <URL>` | 代理设置（默认使用系统代理） |
| `--custom-range <RANGE>` | 只下载部分分片，如 `0-10`、`10-`、`-99`、`05:00-20:00` |
| `--task-start-at <yyyyMMddHHmmss>` | 定时开始任务 |
| `--live-perform-as-vod` | 以点播方式下载直播流 |
| `--live-real-time-merge` | 直播实时合并 |
| `--live-record-limit <HH:mm:ss>` | 直播录制时长限制 |
| `--log-file-path <path>` | 日志文件路径 |
| `--log-level <DEBUG\|ERROR\|INFO\|OFF\|WARN>` | 日志级别（默认 INFO） |
| `--ui-language <en-US\|zh-CN\|zh-TW>` | 界面语言 |
| `--no-log` | 关闭日志文件输出 |
| `--disable-update-check` | 禁用版本更新检测 |
| `--version` / `-h` | 版本 / 帮助 |

## 选择器示例

```bash
# 选择最佳视频（默认）
N_m3u8DL-RE <url> -sv best

# 选择 4K + HEVC 视频
N_m3u8DL-RE <url> -sv res="3840*":codecs=hvc1:for=best

# 选择所有音频 / 最佳英语音轨
N_m3u8DL-RE <url> -sa all
N_m3u8DL-RE <url> -sa lang=en:for=best

# 选择所有中文字幕
N_m3u8DL-RE <url> -ss name="中文":for=all

# 选择长度 > 1 小时 20 分 30 秒的视频
N_m3u8DL-RE <url> -sv plistDurMin="1h20m30s":for=best
```

## 混流示例

```bash
# 混流为 mp4 容器（默认 ffmpeg）
N_m3u8DL-RE <url> --auto-select -M format=mp4

# 使用 mkvmerge 混流为 mkv
N_m3u8DL-RE <url> --auto-select -M format=mkv:muxer=mkvmerge

# 引入外部字幕/音轨
N_m3u8DL-RE <url> --mux-import path=zh-Hans.srt:lang=chi:name="中文 (简体)"
```

## 分片范围示例

```bash
# 下载第 0-10 个分片（共 11 个）
N_m3u8DL-RE <url> --custom-range 0-10

# 从第 10 个分片开始
N_m3u8DL-RE <url> --custom-range 10-

# 下载第 5 分钟到第 20 分钟的内容
N_m3u8DL-RE <url> --custom-range 05:00-20:00
```

## 命名模板示例

```bash
# 文件名包含分辨率：video_1920x1080.mp4
N_m3u8DL-RE <url> --save-name video --save-pattern "<SaveName>_<Resolution>"

# 多音轨包含语言与声道：audio_en_2ch.m4a
N_m3u8DL-RE <url> --save-pattern "<SaveName>_<Language>_<Channels>ch"
```

## 直播录制

```bash
# 以点播方式下载直播流
N_m3u8DL-RE <url> --live-perform-as-vod

# 实时合并 + 录制时长限制 1 小时
N_m3u8DL-RE <url> --live-real-time-merge --live-record-limit 01:00:00
```

> 网络不稳定时不要开启 `live-pipe-mux`；可用环境变量 `RE_LIVE_PIPE_OPTIONS` 调整其 ffmpeg 选项。

## 免责声明

本软件基于 MIT License 开源，按"原样"提供。仅用于学习和技术研究目的，请只下载拥有合法权限的流媒体内容，使用者需自行承担全部法律责任。
