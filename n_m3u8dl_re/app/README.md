# m3u8下载器（N_m3u8DL-RE for fnOS）

基于开源项目 [N_m3u8DL-RE](https://github.com/nilaoda/N_m3u8DL-RE)（MIT License）封装的
飞牛 fnOS 第三方应用：**DASH / HLS / MSS 流媒体下载工具**，带可视化 Web 界面。
二进制直接取自官方 GitHub Releases（linux-x64 / linux-arm64 自包含版本，无需 .NET 运行时）。

- 开发者：Youngxj · 项目主页：<https://github.com/Youngxj/N_m3u8DL-RE-FN>

## 功能

- **Web 管理界面**（飞牛原生 index.cgi）：打开应用卡片即可使用，实时查看下载进度。
- **全部参数可视化**：N_m3u8DL-RE 的完整命令行参数已接入界面，分为「基本配置 / 高级配置」
  两组中文表单（线程数、混流、字幕、限速、代理、请求头、分片范围、定时、解密、HLS 自定义、
  直播选项、日志等）。
- **实时进度**：进度条 + 速度 + 已下载/总量 + 分片 + 剩余时间 + 流类型（视频/音频/字幕），
  通过 PTY 实时落盘，多端进度一致。
- **文件管理**：仅列出程序自身下载产出的文件（任务前后目录快照对比），含完整路径与大小。
- **fnOS 文件选择器**：输出目录可用 fnOS 自带文件管理器浏览选择（需 fnOS 1.2.0401+，
  不支持时回退手动输入）。
- **双架构单包**：`platform=all`，同一 fpk 适配 x86_64 与 aarch64。
- **CLI 同时可用**：安装后 `N_m3u8DL-RE` 命令链接到 `/usr/local/bin`，SSH 可直接调用。

## 包结构

本目录（app/）即应用负载，打包时转为 `app.tgz`（解压后即 target/）：

```text
app/
├── bin/
│   ├── N_m3u8DL-RE       # 架构选择 wrapper（链接到 /usr/local/bin）
│   ├── task-run.sh       # 后台任务运行器（PTY 实时输出 + 退出码 + 产出文件记录）
│   ├── x64/N_m3u8DL-RE   # linux-x64 官方二进制
│   └── arm64/N_m3u8DL-RE # linux-arm64 官方二进制
├── ui/
│   ├── index.cgi         # CGI 入口：静态页面 + 任务/文件 API（纯 bash）
│   └── config            # 桌面入口配置
├── www/                  # 前端单页（index.html / app.js / style.css / vendor/trim-app.js）
├── LICENSE               # 上游 MIT License
├── README.md             # 本说明
└── USAGE.md              # N_m3u8DL-RE 命令行调用说明
```

fpk 顶层结构（由 build-fpk.mjs 生成）：

```text
n_m3u8dl_re_<版本>_all.fpk   # gzip 压缩的 tar 归档
├── app.tgz              # 上述 app/ 负载（checksum = 其 MD5）
├── manifest             # 应用元数据，含 checksum / fpk_version
├── config/privilege     # run-as=package 专用用户 n_m3u8dl_re
├── config/resource      # data-share + usr-local-linker + api-scope
├── cmd/                 # 生命周期脚本
├── ui/                  # 桌面入口配置（CGI 入口 + 图标）
├── wizard/              # 向导（无表单）
├── ICON.PNG             # 应用图标 64x64
└── ICON_256.PNG         # 应用图标 256x256
```

> 注意：fnOS 安装器依赖顶层 `app.tgz` + `manifest.checksum`（MD5），
> 只放 `app/` 目录会导致「解压 app.tgz 失败」。

## 构建

```bash
# 使用 GitHub 最新 Release；版本自动递增（0.6.0-beta.14 → .15 → ...）
node build-fpk.mjs
# 指定上游版本 / 手动构建号 / 附加说明
node build-fpk.mjs --version v0.6.0-beta --build 5 --note "说明"
```

也可用官方 `fnpack`（正式发布推荐，会做格式校验）：

```bash
fnpack build --directory n_m3u8dl_re
```

输出：`dist/n_m3u8dl_re_<版本>_all.fpk`

## 本地测试

```bash
# 需要 Git for Windows（git-bash）的 bash 环境
node test/run-cgi-tests.mjs
# 36 项断言：静态页面 / 任务创建(含&的URL) / 实时进度(真实输出格式解析) /
#            文件列表(仅程序记录) / 目录穿越防护 / 停止删除
```

## 使用说明

1. 飞牛 fnOS「应用中心 → 手动安装」选择生成的 `.fpk`。
2. 打开「m3u8下载器」卡片进入 Web 界面：
   - 粘贴 m3u8/mpd/mss 链接，按需配置「基本/高级」选项，点「开始下载」。
   - 任务卡片实时显示进度；「已下载文件」标签可下载/删除本应用产出的文件。
3. SSH 命令行同样可用（`N_m3u8DL-RE <url> [options]`，详见 USAGE.md）。

## 免责声明

引擎基于 MIT License 按"原样"提供。仅用于学习与技术研究，请只下载拥有合法权限的流媒体内容。
