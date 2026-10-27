WorkBar 0.0.2 · Windows x64
=====================

【方式一：绿色版（推荐先试）】
在资源管理器里打开本文件夹，双击：
    try-workbar.cmd
首次运行时，它会通过 MCP 创建一份示例计划并保存到 SQLite，再启动 WorkBar。
如果已有任务，会保留现有计划。运行需要 Microsoft Edge WebView2 环境。

【方式二：装到系统里（不碰临时目录，装完自动启动）】
双击：
    install.cmd
它会：
  - 先结束正在运行的 WorkBar（方便覆盖更新）
  - 复制 WorkBar.exe / workbar-mcp.exe 到 %LOCALAPPDATA%\Programs\WorkBar
  - 创建桌面 + 开始菜单快捷方式
  - 把安装目录加入【用户 PATH】（这样 MCP 客户端直接写 workbar-mcp 即可）
  - 直接启动 WorkBar
卸载：双击 uninstall.cmd（会同时把该目录从 PATH 移除）

【展开态】
屏幕顶部（主显示器正中）一条暗色胶囊：
  圆环            每个任务独立计时，点一下暂停/继续
  ✓ 按钮          只完成对应任务（绿色粒子动画）
  左右箭头        浏览更多任务
  ⌃ 按钮          收起（见下）
  Ctrl+Alt+W      收起成细线 / 展开（再按一次来回切换）
  托盘图标        左键收起/展开；右键菜单可设置开机自启、修改快捷键、打开数据目录或退出

【收起态：屏幕顶端一条细线】
- 不显示任何文字，只有一条线。
- 倒计时随剩余时间收缩；正计时以呼吸效果表示运行。
- 多项已开始任务会显示为不同颜色的分段；暂停变暗，超时变为琥珀色。
- 鼠标移到细线上会变亮；点一下 → 展开回胶囊。
- 也可以按 Ctrl+Alt+W 或点托盘图标把它叫回来。
- 收起时窗口高度就等于线高。

【安装向导版】
也可以下载 WorkBar-setup-win64.exe，按向导安装。
安装包包含主程序和 workbar-mcp.exe，并会按需安装 WebView2。
安装器会自动把安装目录加入当前用户的 PATH，卸载时移除对应目录项。
安装完成后，请完全退出并重新打开终端和 AI 客户端，再使用 workbar-mcp 命令接入。

【接 AI（MCP）】
workbar-mcp.exe 是标准 MCP stdio server。
使用安装向导版或绿色包里的 install.cmd 安装，安装目录都会加入用户 PATH；
【完全重启】一次 AI 客户端后，可以直接使用 workbar-mcp 命令。
如果直接运行未安装的绿色版，请将下面的命令替换为 MCP 程序的绝对路径。

  先验证（新开一个终端）：
    where workbar-mcp

  Claude Code：
    claude mcp add --transport stdio --scope user workbar -- workbar-mcp

  Cursor / 其它 JSON 客户端：
    {"mcpServers":{"workbar":{"command":"workbar-mcp"}}}

  Codex（一行命令接入）：
    codex mcp add workbar -- workbar-mcp

  也可以手动配置 Codex（~/.codex/config.toml）：
    [mcp_servers.workbar]
    command = "workbar-mcp"

  DeepSeek Harness（~/.dsh/profiles/desktop/cordis.patch.yml 末尾追加，
                     然后完全退出并重启 DSH）：
    - id: mcp-workbar
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: workbar
        transport: stdio
        command: workbar-mcp

  兜底（PATH 没生效时）：把 workbar-mcp 换成
    C:\Users\<你>\AppData\Local\Programs\WorkBar\workbar-mcp.exe

配好后直接跟 AI 说：
  "帮我排一下今天：上午写周报，10 点修登录 bug，下午写 README，晚上运动"
  "把修登录 bug 挪到下午两点，预估改成 45 分钟"
  "今天还剩什么没做完？"

要显示 AI 自己正在执行的工作，可以告诉它：
  "开始工作前调用 workbar_start_work，完成后调用 workbar_finish_work。"
不同客户端加载工具与指令的方式有所不同，首次使用时可明确要求记录到 WorkBar。

【数据 / 排查 / 卸载】
任务数据：%APPDATA%\Workbar\workbar.db（SQLite，旧 plan.json 不再读取）
清空任务：通过 AI 调用 workbar_clear_day；不要在程序运行时删除数据库文件。
启动日志：%APPDATA%\Workbar\boot.log
崩溃日志：%APPDATA%\Workbar\crash.log（有异常时把这个发我）
绿色版：退出后删掉本文件夹即可移除程序，任务数据会保留。
使用 install.cmd 安装的版本：用 uninstall.cmd 卸载。
安装向导版：在 Windows 的“已安装的应用”中卸载 WorkBar。
