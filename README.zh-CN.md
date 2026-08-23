# YouTube Digest + Codex

[English](README.md)

一个本地优先的 Chrome 扩展：把带字幕的 YouTube 视频变成可搜索字幕、双语学习视图、Codex 生成的概览与解释、时间戳笔记，以及可继续进入个人创作流程的 Learning Pack。

本项目基于
[zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest)
进行二次开发。它保留原项目的学习体验，并使用 YouTube 页面字幕与本机 Codex CLI，替代需要单独付费的字幕和大模型 API。

## 主要功能

- 读取当前 YouTube 播放器公开的字幕轨道。
- 查看原文、简体中文或中英双语对照字幕。
- 使用 Codex 生成章节、重点引用、解释、翻译与润色笔记。
- 保存时间戳笔记，并跳回视频对应位置。
- 在 Create 页面组合视频来源、概览、笔记与个人反思。
- 把严格限定内容的 Learning Pack 发送到可配置的本地 Creator Workspace。
- 跟随浏览器浅色或深色偏好，并使用 YouTube 风格的红色强调色。
- 不需要 Supadata、DeepSeek 或 OpenAI API Key。

本扩展不会转录音频；视频必须提供 YouTube 原生字幕或自动生成字幕。

## 工作原理

扩展直接读取当前 YouTube 页面字幕。需要 AI 的操作会发送给只监听
`127.0.0.1:43110` 的本机连接程序；连接程序调用已经通过 ChatGPT 登录的 Codex CLI。

本机连接程序会：

- 只监听本机回环地址；
- 每次请求都校验随机生成的安装凭据；
- 只接受本机 Chrome 扩展来源；
- 使用临时 Codex 会话、只读沙箱并禁用工具；
- 串行处理请求，并限制输入、输出与运行时间。

Codex 请求会计入当前 ChatGPT 套餐的使用额度。

## 环境要求

- Google Chrome 116 或更高版本
- Node.js 18 或更高版本
- 已安装并登录的 [Codex CLI](https://developers.openai.com/codex/cli)
- 一个提供字幕的 YouTube 视频

## 安装

```bash
git clone https://github.com/Alex-cloud0413/youtube-digest-codex.git
cd youtube-digest-codex
node bridge/generate-config.js
node bridge/server.js
```

保持最后一个命令运行，然后：

1. 打开 `chrome://extensions`。
2. 开启“开发者模式”。
3. 点击“加载已解压的扩展程序”。
4. 选择本仓库根目录，也就是包含 `manifest.json` 的目录。
5. 打开一个有字幕的普通 YouTube 视频页面，点击扩展图标。

如果需要开机自动启动，可以使用自己信任的本机进程管理工具运行
`node bridge/server.js`。不要把端口 `43110` 暴露到回环地址以外。

## Creator Workspace

运行 `node bridge/generate-config.js` 后会生成一个被 Git 忽略的本机文件：

```text
bridge/workspace-config.json
```

默认工作区是：

```text
~/Documents/youtube-digest-creator-workspace
```

可以在本机配置中修改 `workspaceRoot`。点击 **Send to Creator Workspace** 后，只会写入：

```text
<workspaceRoot>/inbox/youtube-digest/<video-id>/<handoff-id>/
├── learning-pack.json
└── learning-pack.md
```

目标目录只能由本机连接程序配置，浏览器请求不能传入路径。连接程序还会拒绝完整字幕字段，以及把 `articleIntent` 改成 true 的请求。

Learning Pack 可以包含：

- 标准化的 YouTube 来源与视频信息；
- 已生成的概览；
- 保存的时间戳笔记；
- 个人反思与可能的核心观点；
- 明确标记“不包含完整字幕”的来源信息。

交接状态固定为 `learning_complete`，不会自动创建文章项目或发布内容。
[`creator-workspace-template`](creator-workspace-template/README.md)
提供了一个不依赖具体平台的个人内容创作工作区范例。

## 使用方式

1. 打开有字幕的 YouTube 视频并点击扩展图标。
2. 阅读或翻译字幕。
3. 打开 **Overview** 查看章节与重点引用。
4. 选中字幕获取解释。
5. 从播放器或重点引用保存时间戳笔记。
6. 打开 **Create**，补充个人反思，再发送 Learning Pack。

## 隐私与安全

扩展不保存服务商 API Key。随机本机凭据与设备相关路径只存在于以下被忽略的文件中：

```text
bridge-config.js
bridge/bridge-config.json
bridge/workspace-config.json
```

不要提交或分享这些文件。完整边界见 [PRIVACY.md](PRIVACY.md) 与
[SECURITY.md](SECURITY.md)。

## 开发与检查

```bash
npm test
node bridge/generate-config.js
npm run check
```

## 来源与许可证

原项目和本项目均使用 MIT License。原始版权声明保留在
[LICENSE](LICENSE)，上游来源记录在 [NOTICE.md](NOTICE.md)。

YouTube 是 Google LLC 的商标，Codex 是 OpenAI 的产品。本社区项目与
Google、YouTube 或 OpenAI 没有隶属、背书或赞助关系。
