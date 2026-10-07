# 在 GitHub 网页发布声轨

发布前，先把代码提交并 push 到 `main`，更新 `CHANGELOG.md`，确认本地测试通过。GitHub 只能发布已经推送的代码，无法读取电脑上尚未提交的改动。

## 发布前先验收 Windows

首次使用时，先将 `.github/workflows/windows-validation.yml` 合入并推送到默认分支 `main`，否则 GitHub 不会显示它的手动运行入口。

1. 打开 [Actions](https://github.com/LiuKay/musicdl-soundtrack/actions)，左侧选择 **Windows validation**。
2. 点击 **Run workflow**，分支选 `main`。下方 **Branch, tag or commit to validate** 留空即可测试所选分支；要测试其他已推送的代码，可填分支、Tag 或完整提交 SHA。
3. 点击绿色 **Run workflow**。等待音频工具构建、应用打包、Python / JavaScript 回归、实际安装包转换和重启/回收站验收全部通过；任一步失败，后续步骤不会上传测试包。
4. 打开该次运行，在 **Summary** 查看 **Tested commit**，确认与准备发布的提交一致。页面下方 **Artifacts** 中有 `Soundtrack-Windows-validation-提交SHA`，保留 7 天。
5. 下载并解压 Artifact，再解压其中的 `Soundtrack-Windows-validation.zip`，运行 `Soundtrack/Soundtrack.exe`。旁边的 `Soundtrack-audio-sources-Windows-validation.tar.gz` 是音频工具对应源码；测试包仅供验收，不自动成为正式版本。
6. 在 Windows 桌面补测收藏退出重启保留、下载/删除确认和 NVDA 朗读。自动化通过不代表交互和读屏都已通过。

这个工作流只有仓库读取权限，不创建或修改 Release。现有 **Windows release** 仍用于正式发布，不要用它代替发布前的验证。

## 发布一个新版本

1. 打开[项目 Releases 页面](https://github.com/LiuKay/musicdl-soundtrack/releases)，点击 **Draft a new release**（起草新版本）。
2. 点击 **Choose a tag**，输入一个未使用的版本号，例如 `v0.8.0`，再点击 **Create new tag**。Tag 是这次版本的固定标记；不要复用已经发布过的版本号。
3. **Target** 选择 `main`，确认它已包含要发布的代码。仅更新说明或重新运行构建不会让旧 Tag 自动变成最新代码。
4. **Release title** 填写版本标题，例如 `Soundtrack v0.8.0 · 更新说明`。在说明框中粘贴 Changelog 对应版本的内容；也可先点击 **Generate release notes**，再补充用户能理解的改动说明。
5. 在说明末尾保留音频工具对应源码的链接：把下方模板中的版本号全部替换为本次版本号。正式版不勾选 **This is a pre-release**；需要时勾选 **Set as latest release**。
6. 点击 **Publish release**。本项目会自动运行 `macOS release` 和 `Windows release`，编译、验收并上传安装包及音频工具源码。刚发布时附件可能尚未出现，需要等待构建完成。
7. 打开 [Actions](https://github.com/LiuKay/musicdl-soundtrack/actions)，确认这两个工作流对应本次版本的运行都显示绿色勾号。黄色表示仍在运行，红色表示失败。
8. 回到 Release 页面刷新，展开 **Assets**，确认有 macOS ZIP、Windows ZIP 和两个平台对应的 `Soundtrack-audio-sources-…tar.gz`，再对外分享。GitHub 自动提供的 **Source code (zip/tar.gz)** 是本项目代码，既不是可运行的安装包，也不能替代 FFmpeg/LAME 对应源码附件。

源码链接模板（以 `v0.8.0` 为例）：

```markdown
内置 FFmpeg / LAME 的许可证包含在应用中，对应源码和构建脚本：
- [macOS 音频工具源码](https://github.com/LiuKay/musicdl-soundtrack/releases/download/v0.8.0/Soundtrack-audio-sources-macOS-v0.8.0.tar.gz)
- [Windows 音频工具源码](https://github.com/LiuKay/musicdl-soundtrack/releases/download/v0.8.0/Soundtrack-audio-sources-Windows-v0.8.0.tar.gz)
```

若仓库开启了 **immutable releases**（不可变发布），请先保留 Release 草稿、准备并推送对应 Tag，再通过下面的手动工作流构建并上传附件；确认附件齐全后才发布。不可变版本公开后不能再补传或替换附件。

## 构建失败或需要补传附件

临时网络故障可以打开失败的 Actions 运行，点 **Re-run jobs** → **Re-run failed jobs**。如果是代码错误，需要先修复、提交、push，并发布新的版本号；重跑旧 Tag 不会包含修复。

要主动重新打包某个已有版本：

1. 打开 [Actions](https://github.com/LiuKay/musicdl-soundtrack/actions)，左侧选择 **macOS release** 或 **Windows release**。
2. 点击 **Run workflow**，分支选择 `main`。
3. 在 **Existing release tag** 输入完整版本号，例如 `v0.7.0`。对应 Tag 和 Release（可以是草稿）必须已经存在。
4. 点击绿色 **Run workflow**，等待结果。另一个平台要分别操作一次。

这里选择的 `main` 提供工作流定义；实际打包的代码由输入的 Tag 决定。成功后附件自动上传到对应 Release；同名附件会被替换。不要通过这一步把另一版本的文件冒充为旧版本。

官方说明：[创建与管理 Release](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository)、[手动运行 Actions](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow)。
