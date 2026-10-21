<p align="center">
  <img src="src-tauri/icons/128x128.png" width="92" alt="Workbar icon" />
</p>

<h1 align="center">Workbar</h1>

<p align="center">
  <b>一条永远置顶的悬浮条，只回答一个问题：现在该干什么。</b><br/>
  AI 原生 · MCP 驱动 · 安装包 1.2 MB · 不依赖 Electron / Node 运行时
</p>

---

## 为什么做这个

我们不是缺一个任务管理工具，是缺一个**在眼前**的东西。

Todo 应用的问题不是功能不够，而是你打开它的成本比「刷两下手机」还高。
Workbar 的心智只有一条：屏幕最上面那条胶囊，永远显示**当前这一项**、一个计时圆环、和接下来两三项。

- 你在**任何** AI 客户端里说一句话，计划就排好了；
- 它置顶、不抢焦点、不进任务栏、Alt+Tab 不可见；
- `Ctrl+Alt+W` 一键隐藏/显示；
- 点右上角 ⌃ 收起：只剩屏幕顶端一条 4px 细线，**进度就是这条线**——随时间从两端向中间收，
  满格是全宽、超时前收到中间一个光点；细线默认鼠标穿透，**不会挡住你点浏览器标签栏**，
  鼠标移上去才变实、点一下展开。

它**不做**：分类、标签、优先级矩阵、看板、账号、云同步、番茄钟设置页。
信息越少，你越会看它。

## 用 AI 排计划（MCP）

Workbar 内置一个标准 **MCP (Model Context Protocol) server**（`workbar-mcp.exe`）。
**任何支持 MCP 的 AI 客户端**都能直接读写今天的计划——不需要 Workbar 开着，也不需要内置 AI Key。

| 工具 | 作用 |
|---|---|
| `workbar_get_today` | 读今天的计划（id、时间窗、预估、已用时） |
| `workbar_plan_day` | 整日重排（一句话生成一天） |
| `workbar_add_tasks` | 追加任务 |
| `workbar_update_task` | 改标题 / 时间 / 预估 / 完成状态 |
| `workbar_set_current` | 让浮条指向某一项 |
| `workbar_complete_task` | 标记完成 |
| `workbar_remove_task` | 删除一项 |
| `workbar_clear_day` | 清空重来 |

### 配置示例

**Claude Code / Cursor / 其它 JSON 配置的客户端**（`.mcp.json`、`mcp.json` 等）：

```json
{
  "mcpServers": {
    "workbar": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Workbar\\workbar-mcp.exe"
    }
  }
}
```

**Codex**（`~/.codex/config.toml`）：

```toml
[mcp_servers.workbar]
command = "C:\\Users\\<you>\\AppData\\Local\\Programs\\Workbar\\workbar-mcp.exe"
```

**Claude Code CLI**：

```bash
claude mcp add workbar -- "C:\Users\<you>\AppData\Local\Programs\Workbar\workbar-mcp.exe"
```

配好之后直接说人话：

> 帮我排一下今天：上午写周报，10 点修登录 bug，下午把 README 写完，晚上运动 30 分钟。
>
> 把「修登录 bug」挪到下午两点，预估改成 45 分钟。
>
> 我现在在做第一分钟补丁，完成后帮我标记。
>
> 今天还有什么没做完？

### 为什么是 MCP + 文件，而不是内置 AI

- **MCP 是主通道**：结构化工具，模型自己会判断什么时候调用，跨客户端通用。
- **`plan.json` 是真相源**：人类可读、可进版本控制、任何程序都能改。
- **文件监听是实时层**：AI 写完 0.8 秒内浮条就变，不用重启、不用刷新。

MCP 解决「怎么让 AI 懂」，文件解决「怎么让任何东西都能接」。
少了任何一个，这个项目都会变成一个需要配 Key、绑账号、只服务一个客户端的重东西。

## 安装

1. 到 [Releases](../../releases) 下载 `Workbar-Setup-x.y.z.exe`，双击安装（当前用户安装，无需管理员）。
2. 托盘菜单里可以勾选「开机自启」。
3. 首次运行是空状态——用上面的 MCP 配置让 AI 排一天，或直接编辑计划文件。

不想安装？双击 `Workbar.exe` 即可（绿色版，`workbar-mcp.exe` 放在同一目录）。

### 常见问题

**安装包报 `Error writing temporary file. Make sure your temp folder is valid.`**
这是 NSIS 安装器写 `%TEMP%` 失败（部分机器的安全策略 / 安全软件会拦），不是程序问题。
下载 portable zip 解压后双击 `install.cmd`：复制到 `%LOCALAPPDATA%\Programs\Workbar` 并创建快捷方式，全程不写临时目录。

**重复双击快捷方式 / 看不到浮条**
v0.0.1 包含单实例保护：已经有一个 Workbar 在跑时，再次启动只会把已有的浮条叫回来，不会崩溃。
如果浮条被 `Ctrl+Alt+W` 或托盘隐藏了，再启动一次即可恢复。

**排查**
- 启动记录：`%APPDATA%\Workbar\boot.log`
- 崩溃记录（含 backtrace）：`%APPDATA%\Workbar\crash.log`

## 数据

一切状态就是一个人类可读的 JSON：

```
%APPDATA%\Workbar\plan.json
```

```json
{
  "date": "2026-10-21",
  "intro": "把 Sitta 的「第一分钟」补出来",
  "current_id": "t10a3",
  "tasks": [
    {
      "id": "t10a3",
      "title": "第一分钟补丁",
      "start": "14:40",
      "end": "16:30",
      "est_min": 110,
      "spent_sec": 754,
      "running": true,
      "done": false
    }
  ]
}
```

- `start` / `end`：本地 `HH:mm`；`est_min`：预估分钟；`spent_sec`：实际累计秒数。
- 写入是原子的（临时文件 + rename），并用短锁文件串行化，App 和 MCP server 可同时写。
- 完整示例见 [`plan.sample.json`](plan.sample.json)。
- 环境变量 `WORKBAR_DATA_DIR` 可覆盖数据目录（测试 / 便携用）。

## 实现

| 产物 | 大小 |
|---|---|
| `Workbar_0.0.1_x64-setup.exe`（安装包） | **1.16 MB** |
| `Workbar.exe`（主程序） | 3.3 MB |
| `workbar-mcp.exe`（MCP server） | 0.39 MB |

- **Rust + Tauri 2**，前端是纯 HTML/CSS/JS（**无框架、无打包器、无 node_modules 运行时**）。
- **静态 CRT**：`.exe` 不依赖 VC++ 运行库。
- **无后台服务**：MCP server 由 AI 客户端按需拉起，不用时零资源占用。
- 窗口：无边框、透明、`WS_EX_NOACTIVATE`（点击不抢焦点）、`WS_EX_TOOLWINDOW`（不进任务栏 / Alt-Tab）。
- 计时用「墙钟差值」而不是逐秒自增，窗口被挂起后回来也不会漂移。
- 渲染用系统自带的 WebView2，安装包省掉了一个浏览器引擎。

## 开发

需要 Rust stable（MSVC 工具链）+ Node 18+（只用于 Tauri CLI）。

```bash
npm install
npm run dev      # 开发模式
npm run build    # 生成安装包 → src-tauri/target/release/bundle/nsis/
```

只构建 MCP server：

```bash
cargo build --release -p workbar-mcp
```

MCP 冒烟测试（8 项检查，跑在临时数据目录，不碰你的真实计划）：

```bash
node scripts/smoke-mcp.js
```

## Roadmap

- [x] 置顶浮条 + 圆环计时 + 按时间自动切换 + 完成/暂停/跳转
- [x] 收起为细光条、全局快捷键、托盘、开机自启
- [x] MCP server（8 个工具）
- [ ] 内置对话面板（不依赖外部客户端也能排计划）
- [ ] 长期计划（周 / 月）与今日联动
- [ ] 多显示器选择 / 自定义位置
- [ ] 全屏应用时自动隐藏
- [ ] macOS 版本

## License

[MIT](LICENSE)
