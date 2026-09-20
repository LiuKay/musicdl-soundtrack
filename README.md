<div align="right">

[English](README.en.md) · **简体中文**

</div>

# 声轨 · Soundtrack

在一个界面里搜索音乐、安排播放顺序，再把选中的歌曲下载到本地。

声轨基于 [musicdl](https://github.com/CharlesPikachu/musicdl)，可在本机浏览器中运行，也可打包为 macOS / Windows 桌面应用。浅色界面提供独立播放队列、随机与循环播放、多选下载和同步歌词。

已接入咪咕、网易云、酷我、QQ、酷狗、5sing、Jamendo 和 Spotify。默认只开启咪咕，其余来源可在侧栏选择，手机端为顶部横向列表。不同来源的可用性取决于网络、接口和访问权限。

![声轨浅色主界面：来源状态、歌曲多选下载与底部播放控制](docs/interface-desktop.webp)

截图展示当前源码界面。发行包的功能请以对应 Release 说明为准。

## 运行

```bash
pip install -r requirements.txt
python app.py
# 浏览器打开 http://127.0.0.1:5000
```

可用 `PORT=8080 python app.py` 指定端口。下载的文件保存在 `downloads/<源>/` 下。

## 构建 macOS 应用

```bash
make app
open dist/Soundtrack.app
```

构建命令会把仅桌面版需要的打包工具安装到 `.venv`。应用默认把音乐保存在 `~/Downloads/Soundtrack/`，也可在下载面板中选择其他目录；“边听边存”缓存保存在 `~/Library/Caches/Soundtrack/audio/`。

## 构建 Windows 应用

在 Windows PowerShell 中运行：

```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
.\build-windows.ps1
```

程序生成在 `dist\Soundtrack\Soundtrack.exe`。也可以在 GitHub Actions 中运行 `Windows app` 工作流并下载构建产物。

> 需要能正常访问所选音乐平台的网络环境。本工具仅供学习研究，请尊重版权与各平台条款。

## 使用

- 顶部输入关键词搜索，结果逐条流式出现。
- 左侧切换音乐源（默认仅咪咕；手机端为顶部横向列表）。浅色界面采用灰白分层、莓红强调色和系统字体，不依赖在线字体。
- 搜索结果展示首个返回曲目的封面，桌面端可从封面旁直接播放；排列顺序不代表热度或推荐排名。
- 来源状态区分别显示搜索中、结果数、超时或请求失败；其他来源的结果不受影响。
- 勾选歌曲或全选当前结果，点击「下载所选」批量加入现有并发队列；搜索过程中后来出现的结果不会被自动选中。
- 「播放全部」用当前搜索结果建立独立播放队列。搜索其他歌曲不会清空正在使用的队列；行内「下一首播放」可插入或移动曲目。
- 播放条支持随机、顺序、列表循环和单曲循环；单曲循环只影响自然播完，手动切歌仍切到相邻曲目。
- 右下角队列按钮可查看、播放、移除待播曲目，或清空待播并保留当前歌曲。队列和播放模式目前仅在当前页面会话中保留，刷新后重置。
- 每行提供播放、下一首播放和下载按钮，双击歌曲行也可播放。
- 底部播放条：上一首 / 播放暂停 / 下一首、进度拖动、音量、实时频谱。
- “边听边存”可缓存播放过的歌曲，并按 512 MB–5 GB 的容量上限自动清理最旧缓存。
- 下载面板可把同时下载数量设置为 1–5 首，超出的任务按点击顺序等待。
- 「词」按钮打开同步歌词面板；「下载与资料库」可查看任务、播放或删除已下载歌曲。桌面应用还支持选择下载目录、在文件夹中显示歌曲。
- 新下载的歌曲会生成同名 `.lrc`，并为 MP3、FLAC、M4A、OGG 尽力嵌入歌名、歌手、专辑、歌词和封面；内部 `.soundtrack.json` 与 `.soundtrack.cover.jpg/.png/...` 仅供应用索引和兜底。
- 快捷键：空格播放/暂停，`Alt+←/→` 上一首/下一首。
- `Esc` 关闭面板；聚焦进度或音量条后，用方向键调节、`Home/End` 跳到两端。手机端保留播放进度条和缓存设置。

![独立播放队列：查看待播曲目、移除歌曲或清空待播](docs/interface-queue.webp)

队列与搜索结果分开管理，可以一边听当前列表，一边继续搜索。收藏、跨会话队列恢复和歌单链接导入尚未提供。

## 验证界面

```bash
node --test test_ui.cjs
python -m unittest -v test_app.py
```

前端回归测试不需要额外 Node.js 依赖，覆盖队列隔离、循环/随机、批量选择、重复下载防护、异步响应竞争、面板和键盘操作。真实音乐源仍需联网手动验证。

## 结构

```
app.py             Flask 后端：流式搜索(SSE) / 音频代理(Range) / 封面代理 / 下载进度(SSE)
static/index.html  界面结构
static/style.css   视觉样式（Apple Music 风格的浅色音乐工作台）
static/app.js      前端逻辑：流式搜索 / 独立队列 / Web Audio / 歌词 / 多选下载
docs/             Pages 展示页与界面截图，不包含在线搜索或下载服务
```

## 调整

`app.py` 顶部常量：

- `SUPPORTED_SOURCES`：增删音乐源、修改默认开关。
- `SEARCH_SIZE_PER_SOURCE`：每个源尝试解析的歌曲数，增加数量会延长搜索时间。
- `PER_SOURCE_TIMEOUT`：单源搜索等待超时秒数。

目前没有账号登录或 Cookie 配置界面。开发者可参照 musicdl 文档，在 `ClientManager._build()` 中配置自己有权使用的来源参数；这不保证特定曲目、会员音质或受保护格式可用，也不要将凭据提交到仓库。

Soundtrack 使用 musicdl 在搜索阶段解析出的直接音频 URL，通过自己的 HTTP 流程播放和下载，不调用来源专用的 musicdl `_download`。目前不实现专用媒体解密、HLS 分片合并或转码，也不提供下载任务的跨重启恢复和断点续传。Apple Music、Deezer、Joox、千千音乐、Qobuz、SoundCloud、StreetVoice、汽水音乐和 TIDAL 尚未接入；界面借鉴 Apple Music 的视觉风格，不代表接入了 Apple Music 服务。

## 致谢

基于 [CharlesPikachu/musicdl](https://github.com/CharlesPikachu/musicdl) 构建。所有搜索与音频解析逻辑均来自 musicdl；本项目在其之上提供了流式 Web 界面、播放器与下载体验。
