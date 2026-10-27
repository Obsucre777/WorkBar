<p align="center">
  <img src="build/app-icon.png" width="112" height="112" alt="WorkBar Logo" />
</p>

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/workbar-title-dark.svg" />
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/workbar-title-light.svg" />
    <img src="docs/assets/workbar-title-light.svg" width="480" height="88" alt="WorkBar · 简洁小巧，专注当下" />
  </picture>
</p>

<p align="center">
  一款 AI 原生的轻量桌面任务工具，让任务进展尽在掌握。
</p>

## 使用演示

https://github.com/user-attachments/assets/1e673ea5-3aaa-479c-bc71-75f23e90c5b1

## 能力速览

- **正计时**：无需预设时长，记录每项工作投入的时间。
- **倒计时**：设定预计时长，直观掌握剩余时间与超时状态。
- **通过 MCP 交给 AI 操作**：接入后，AI 可以创建、查看、修改、排序和删除任务，也可以开始、暂停、继续计时或标记完成。通过对话，就能管理 WorkBar 中的任务与计时。

## 快速开始

当前支持 Windows x64。

<p>
  <a href="https://github.com/Obsucre777/WorkBar/releases/latest/download/WorkBar-setup-win64.exe">
    <img src="docs/assets/download-windows.svg" alt="下载 Windows 版" width="252" height="56" />
  </a>
</p>

1. **安装并启动**：运行安装包，完成安装后打开 WorkBar。安装器会自动将 `workbar-mcp` 加入当前用户的 PATH。
2. **接入 MCP**：把下面的提示词发给你的 AI 客户端，让它替你完成接入。完成后，新建对话开始使用。

   ```text
   请帮我把本机已安装的 WorkBar 接入当前 AI 客户端的 MCP。

   WorkBar 的接入信息：

   - 服务名称：`workbar`
   - 传输方式：`stdio`
   - 启动命令：`workbar-mcp`，安装时已加入 PATH
   - 无需启动参数、API Key 或远程地址

   请先检查启动命令是否可用，再确认当前客户端支持的 MCP 接入方式，尽量直接完成配置。
   优先使用用户级配置，保留已有的其他 MCP 服务；
   如果 WorkBar 已接入，检查现有配置即可，避免重复添加。

   配置后，请验证连接和工具是否可用，验证时仅查询信息，不要改动我的任务。
   如果需要授权、重启客户端或新建会话，请明确告诉我下一步该做什么。
   若无法自动完成，请给出最少的手动操作步骤。
   ```

3. **安排第一项任务**：跟 AI 说：“帮我把写项目文档加入 WorkBar，预计 30 分钟。”任务会同步出现在桌面顶部。

需要手动接入时，可参考 [使用说明](scripts/portable/README-试用.txt) 中的配置示例。
