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
2. **接入 MCP**：重新打开终端和 AI 客户端，运行下方对应的接入命令。
3. **安排第一项任务**：跟 AI 说：“帮我把写项目文档加入 WorkBar，预计 30 分钟。”任务会同步出现在桌面顶部。

| AI 客户端 | 接入命令 |
| --- | --- |
| Claude Code | `claude mcp add --transport stdio --scope user workbar -- workbar-mcp` |
| Codex | `codex mcp add workbar -- workbar-mcp` |

其它支持本地 MCP 的客户端，将服务启动命令设为 `workbar-mcp` 即可。更多配置示例见 [使用说明](scripts/portable/README-试用.txt)。
