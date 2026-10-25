<p align="center">
  <img src="build/app-icon.png" width="92" alt="Workbar 紫蓝青渐变三环图标" />
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
Workbar 的心智只有一条：屏幕最上面那条胶囊，把任务和各自的计时状态一直放在眼前。每项任务独立开始、暂停和完成，互不抢占。

- 你在**任何** AI 客户端里说一句话，计划就排好了；
- 它置顶、不抢焦点、不进任务栏、Alt+Tab 不可见；
- 展开最多显示 4 张固定宽度的任务卡片，更多任务可用左右箭头切换；小屏幕会减少同时显示的卡片数量，保持卡片尺寸；
- 每项任务的基础颜色固定，完成或删除其他任务、调整排序、翻页和重启都不会改变；
- `Ctrl+Alt+W` 一键收起 / 展开（收起同样是那条 4px 细线）；
- 点右上角 ⌃ 收起：只剩屏幕顶端一条 4px 细线，**进度就是这条线**——随时间从两端向中间收，
  满格是全宽、时间用尽收到中间一个光点；颜色随状态变（进行中靛蓝紫 / 暂停变暗 / 超时琥珀 / 完成绿）。
  收起时窗口高度就等于线高，没有多余黑边；点细线、`Ctrl+Alt+W` 或托盘图标都能展开。

它**不做**：分类、标签、优先级矩阵、看板、账号、云同步、番茄钟设置页。
信息越少，你越会看它。

## 用 AI 排计划（MCP）

Workbar 内置一个标准 **MCP (Model Context Protocol) server**（`workbar-mcp.exe`）。
**任何支持 MCP 的 AI 客户端**都能直接读写今天的计划——不需要 Workbar 开着，也不需要内置 AI Key。

| 工具 | 作用 |
|---|---|
| `workbar_get_today` | 读今天的计划（id、时间窗、预估、已用时、计时模式） |
| `workbar_start_work` | AI 开始干活：在浮条上开一条**立刻计时**的正计时任务（不用先暂停） |
| `workbar_finish_work` | AI 干活结束：停表并把这条任务标记完成 |
| `workbar_plan_day` | 整日重排（一句话生成一天） |
| `workbar_add_tasks` | 追加任务（可带 `timer: "up"` 或 `est_min` 指定正/倒计时） |
| `workbar_update_task` | 改标题 / 时间 / 预估 / 计时模式 / 完成状态 |
| `workbar_set_current` | 兼容旧客户端：只启动指定任务，其他任务不受影响 |
| `workbar_complete_task` | 标记完成 |
| `workbar_remove_task` | 删除一项 |
| `workbar_clear_day` | 清空重来 |

**AI 工作会话**：AI 接到一件活时，会先把这个活总结成 3–8 个字的标题，调
`workbar_start_work` 在浮条上开一条**正在跑的正计时**，干完调 `workbar_finish_work`
标记完成。让 AI 稳定地这么做有两条路：

1. **MCP 自身**：`instructions` + 工具描述 + 每次工具返回末尾的提醒；会注入 instructions
   的客户端（Claude Code、DSH）自动生效。
2. **全局上下文（推荐、最稳）**：把下面[「让 AI 自动记录工作（全局上下文）」](#让-ai-自动记录工作全局上下文推荐)
   那一节加到客户端的用户级 `AGENTS.md` / 全局记忆里，任何客户端都能触发——包括
   CodeBuddy 这种不注入 instructions、还把工具放在延迟队列里的客户端。

### 前置：安装器已经把 `workbar-mcp` 放进 PATH

安装器（安装包 / `install.cmd`）会复制程序到 `%LOCALAPPDATA%\Programs\Workbar`，
并把该目录追加到**用户 PATH**，所以下面所有配置都只写 `workbar-mcp`，不用管用户名和安装路径。

> ⚠️ PATH 只在进程启动时读取。装完（或刚更新过 PATH）后，**完全重启**终端和 AI 客户端。

验证：

```powershell
where workbar-mcp
# C:\Users\<you>\AppData\Local\Programs\Workbar\workbar-mcp.exe
```

### Claude Code

```bash
claude mcp add --scope user workbar -- workbar-mcp
claude mcp list
# workbar: workbar-mcp - ✓ Connected
```

### Codex CLI

编辑 `~/.codex/config.toml`：

```toml
[mcp_servers.workbar]
command = "workbar-mcp"
```

### DeepSeek Harness (DSH)

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在文件末尾追加（保持同级缩进）：

```yaml
- id: mcp-workbar
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: workbar
    transport: stdio
    command: workbar-mcp
```

DSH 通过 `@deepseek-ai/dsh-mcp-client` 桥接插件装载 MCP server，工具以
`mcp__workbar__<tool>` 的形式出现在模型工具列表里。
改完后**完全退出并重新打开 DSH**（DSH 进程的 PATH 需要能看到 `workbar-mcp`）。

### Cursor

编辑 `~/.cursor/mcp.json`（全局）或项目里的 `.cursor/mcp.json`：

```json
{
  "mcpServers": {
    "workbar": {
      "command": "workbar-mcp"
    }
  }
}
```

### CodeBuddy

编辑 `~/.codebuddy/mcp.json`：

```json
{
  "mcpServers": {
    "workbar": {
      "command": "workbar-mcp",
      "alwaysLoad": true
    }
  }
}
```

`alwaysLoad: true` 是 CodeBuddy 自己的选项：它默认把 MCP 工具放进「延迟工具」队列
（模型要先 ToolSearch 才能看到完整描述），并且**不注入** MCP `instructions`。
加上它可以让 Workbar 的工具直接加载给模型。即便这样，AI 主动开正计时仍可能需要你在
对话里说一句「先调 `workbar_start_work` 记一下」——这属于客户端行为差异，不是配置能完全解决的。

### 其它 JSON 配置的客户端

Windsurf、Cline、Continue 等同类客户端格式基本相同：

```json
{
  "mcpServers": {
    "workbar": {
      "command": "workbar-mcp"
    }
  }
}
```

### 兜底：PATH 不可用时

绿色版（没跑过 `install.cmd`）、或者客户端进程还带着旧 PATH 时，改用绝对路径：

```json
{
  "mcpServers": {
    "workbar": {
      "command": "C:\\Users\\<you>\\AppData\\Local\\Programs\\Workbar\\workbar-mcp.exe"
    }
  }
}
```

Claude Code 同理：

```bash
claude mcp add --scope user workbar -- "C:\Users\<you>\AppData\Local\Programs\Workbar\workbar-mcp.exe"
```

配好之后直接说人话：

> 帮我排一下今天：上午写周报，10 点修登录 bug，下午把 README 写完，晚上运动 30 分钟。
>
> 把「修登录 bug」挪到下午两点，预估改成 45 分钟。
>
> 我现在在做第一分钟补丁，完成后帮我标记。
>
> 今天还有什么没做完？

### 让 AI 自动记录工作（全局上下文，推荐）

MCP 的 `instructions` 只有部分客户端会注入（Claude Code、DSH 会；CodeBuddy 等不会），
所以「AI 接到任务就自动在 Workbar 上开一条正计时」这件事，**最可靠的做法是把它写进客户端的全局上下文 / 全局记忆**。
MCP 侧的 instructions 和工具描述照旧保留，两套不冲突。

不同客户端的叫法不同（`AGENTS.md`、全局 Memory、用户规则、`CODEBUDDY.md` 等）。
最简单的做法：**把下面这段直接发给你的 AI，让它加进自己的全局上下文**：

> 把 README 里「Workbar 任务记录」这一节加到你的全局上下文里（用户级 AGENTS.md / 全局记忆都行）。

如果你用的客户端支持 `AGENTS.md` 约定（DSH、很多 CLI agent 都支持），手动把下面这段写进用户目录的
`AGENTS.md`（例如 `~/.dsh/AGENTS.md`）即可：

````markdown
# Workbar 任务记录

Workbar 是用户查看"AI 正在做什么"的面板，用户交给你的每件具体工作都需要在里面有一条记录。

## 何时记录
用户交给你一件具体工作时就记录，不论大小：查资料、读文件、写代码、改 bug、写文档、总结、规划、运行命令，甚至查天气这类小查询。
不记录：寒暄、闲聊、感谢，以及你只是在向用户澄清需求。

## 怎么记录
1. 开始：在开展工作之前调用 `workbar_start_work`，可以与第一个其他工具调用同时发出。title 用用户的语言概括任务本身（不是第一步动作）：中文 3–8 个字，英文 3–5 个词；可附一行 `note`。
2. 结束：在给出最终答复之前调用 `workbar_finish_work`，使用开始时返回的任务 id。任务失败、被阻塞或中途放弃时同样要调用，并如实说明结果。

## 多轮与切换
- 任务没做完、跨多轮继续时（比如你中途向用户提问），不要重复 start。
- 已经 finish 的任务，用户又追问或返工同一件事：用相同标题重新 start。
- 用户换了新任务：新任务独立开始，不会自动结束上一条；上一项确实结束时，用它自己的 id 调用 finish。
- 不要用 `workbar_add_tasks` 记录你自己的工作。

## 异常处理
- 工具只显示名字、没有参数定义时，先加载再调用，这不算不可用。
- 工具确实未连接或调用报错：静默跳过，不要阻塞任务，不要改用其他工具或文件替代；同一对话里失败过一次就不再尝试。
- 不要在回复里提到 Workbar 或计时。
- 用户在当前对话中明确说不要使用 Workbar 时，停止记录。
````

### 为什么是 MCP + 文件，而不是内置 AI

- **MCP 是主通道**：结构化工具，模型自己会判断什么时候调用，跨客户端通用。
- **`plan.json` 是真相源**：人类可读、可进版本控制、任何程序都能改。
- **文件监听是实时层**：AI 写完 0.8 秒内浮条就变，不用重启、不用刷新。

MCP 解决「怎么让 AI 懂」，文件解决「怎么让任何东西都能接」。
少了任何一个，这个项目都会变成一个需要配 Key、绑账号、只服务一个客户端的重东西。

## 安装

1. 到 [Releases](../../releases) 下载 `Workbar-Setup-x.y.z.exe`，双击安装（当前用户安装，无需管理员）。
   也可以解压 portable zip 后双击 `install.cmd`（不写临时目录，适合 NSIS 被安全软件拦的机器）。
2. 安装器会：复制程序到 `%LOCALAPPDATA%\Programs\Workbar`、创建快捷方式、**把安装目录加入用户 PATH**。
3. 完全重启终端 / AI 客户端后，`workbar-mcp` 即可直接使用（见上面的 MCP 配置）。
4. 托盘菜单里可以勾选「开机自启」。
5. 卸载（`uninstall.cmd`）会把安装目录从 PATH 里移除。

不想安装？双击 `Workbar.exe` 即可（绿色版；MCP 用绝对路径，或手动把所在目录加入 PATH）。

### 常见问题

**安装包报 `Error writing temporary file. Make sure your temp folder is valid.`**
这是 NSIS 安装器写 `%TEMP%` 失败（部分机器的安全策略 / 安全软件会拦），不是程序问题。
下载 portable zip 解压后双击 `install.cmd`：复制到 `%LOCALAPPDATA%\Programs\Workbar` 并创建快捷方式，全程不写临时目录。

**AI 客户端报找不到 `workbar-mcp` / MCP 连接失败**
- PATH 是安装时写入的，已打开的终端和 AI 客户端要**完全重启**才会读到；
- 用 `where workbar-mcp` 验证，没有输出就重跑一次 `install.cmd`；
- 仍然不行就改用绝对路径兜底：`%LOCALAPPDATA%\Programs\Workbar\workbar-mcp.exe`。

**安装时提示 `workbar-mcp.exe 正被占用`**
AI 客户端（Claude Code / Cursor / CodeBuddy 等）会常驻一个 `workbar-mcp.exe` 子进程。
安装器会先自动结束它并重试；如果客户端立刻把它重新拉起，安装器会列出检测到的客户端，请完全退出对应程序后再运行一次 `install.cmd`。

**重复双击快捷方式 / 看不到浮条**
v0.0.1 包含单实例保护：已经有一个 Workbar 在跑时，再次启动只会把已有的浮条叫回来，不会崩溃。
如果浮条被隐藏了，再启动一次即可恢复。

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
- `running`：该项是否计时；`paused`：是否明确暂停。暂停状态会保留，重启或到点不会自动恢复它。
- 任务没有唯一的“当前任务”身份；旧计划中的 `current_id` 仅作兼容字段，不决定任何任务的运行、展示或亮度。
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
- [x] MCP server（10 个工具）
- [x] 多任务独立计时：单行任务单元，收起态分段细线；启动、暂停、完成一项不会改变其他任务
- [x] 正计时 / 倒计时（`timer: down/up`，无预估默认正计时；正计时圆环每小时一圈）
- [x] AI 工作会话（AI 干活时自动在浮条开一条正计时，干完标记完成）
- [ ] 任务来源链接（点击打开项目 / 文件 / 网页，方案待细化）
- [ ] `workbar_now` 工具（给 AI 当前时间与各任务状态）
- [ ] 内置对话面板（不依赖外部客户端也能排计划）
- [ ] 长期计划（周 / 月）与今日联动
- [ ] 多显示器选择 / 自定义位置
- [ ] 全屏应用时自动隐藏
- [ ] macOS 版本

详细设计（含颜色、规则、安全边界、不做什么）见 [docs/backlog.md](docs/backlog.md)。

## License

[MIT](LICENSE)
