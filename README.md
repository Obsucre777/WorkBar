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

<p align="center">
  简体中文 · <a href="README.en.md">English</a>
</p>

## 使用演示

https://github.com/user-attachments/assets/1e673ea5-3aaa-479c-bc71-75f23e90c5b1

## 能力速览

- **正计时**：无需预设时长，记录每项工作投入的时间。
- **倒计时**：设定预计时长，直观掌握剩余时间与超时状态。
- **中英文界面**：默认跟随系统语言，也可从托盘菜单切换，立即生效并记住选择。
- **通过 MCP 交给 AI 操作**：接入后，AI 可以创建、查看、修改、排序和删除任务，也可以开始、暂停、继续计时或标记完成。通过对话，就能管理 WorkBar 中的任务与计时。

## 快速开始

支持 Windows x64 · **安装包约 2 MB · 安装后约 6.4 MB（含 MCP）**

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

3. **配置全局提示词**：把下面的提示词直接发给你的 AI 客户端，让它帮你保存到全局提示词或全局规则中。

   ```text
   请将以下 Workbar 任务记录规则保存到当前客户端的全局提示词或全局规则中，保留已有的其他规则。

   # Workbar 任务记录

   - 只记录有跟踪价值的执行任务，以及用户主动要求的待办。
     闲聊、澄清、简单问答或查询、进度询问和任务内部步骤不单独记录；不确定时不记录。
   - 执行任务前调用 `workbar_start_work`，标题用用户的语言概括任务目标。
     用户仅要求添加待办时，使用 `workbar_add_tasks`，不要擅自执行。
   - 同一任务跨轮沿用原记录，等待用户时不提前结束。
     完成、失败、无法继续或被取消时，调用 `workbar_finish_work`，如实说明结果，再给出最终答复。
   - 工具缺少参数定义时先加载；未连接或调用报错时静默跳过，不阻塞工作，
     不用其他工具或文件替代，同一对话不反复尝试。
   - 除非用户询问，不在回复中提及记录或计时；用户要求停用时，停止记录。
   ```

4. **安排第一项任务**：跟 AI 说：“帮我把写项目文档加入 WorkBar，预计 30 分钟。”任务会同步出现在桌面顶部。

## 常用操作

| 操作 | 方式 |
| --- | --- |
| 暂停 / 继续计时 | 点击任务圆环。 |
| 标记任务完成 | 点击任务旁的 ✓ 按钮。 |
| 浏览更多任务 | 点击左右箭头。 |
| 收起 / 展开 | 默认按 `Alt+W`，也可点击托盘图标；收起后点击顶部细线即可展开。 |
| 修改快捷键 | 右键托盘图标 →「设置快捷键」。 |
| 切换语言 | 右键托盘图标 →「语言 / Language」→「跟随系统 / 简体中文 / English」。中文系统默认中文，其他系统默认英文。 |
| 开机自启 | 右键托盘图标 →「开机自启」。 |
| 退出程序 | 右键托盘图标 →「退出 WorkBar」。 |

## 反馈与开源协议

遇到问题或有建议，欢迎提交 [Issue](https://github.com/Obsucre777/WorkBar/issues)。

本项目基于 [MIT License](LICENSE) 开源。

## 友情链接

[LINUX DO](https://linux.do/) · 新的理想型社区

## Star 趋势

<a href="https://www.star-history.com/?repos=Obsucre777%2FWorkBar&amp;type=date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=Obsucre777/WorkBar&amp;type=date&amp;theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=Obsucre777/WorkBar&amp;type=date" />
    <img alt="WorkBar Star 趋势" src="https://api.star-history.com/chart?repos=Obsucre777/WorkBar&amp;type=date" />
  </picture>
</a>
