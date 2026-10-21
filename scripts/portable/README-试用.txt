Workbar 0.0.1 · 试用包
=====================

【方式一：绿色版（推荐先试）】
在资源管理器里打开本文件夹，双击：
    try-workbar.cmd
它会重置一份"以当前时间为中心"的示例计划，再启动 Workbar。

【方式二：装到系统里（不碰临时目录，装完自动启动）】
双击：
    install.cmd
它会：
  - 先结束正在运行的 Workbar（方便覆盖更新）
  - 复制 Workbar.exe / workbar-mcp.exe 到 %LOCALAPPDATA%\Programs\Workbar
  - 创建桌面 + 开始菜单快捷方式
  - 把安装目录加入【用户 PATH】（这样 MCP 客户端直接写 workbar-mcp 即可）
  - 直接启动 Workbar
卸载：双击 uninstall.cmd（会同时把该目录从 PATH 移除）

【展开态】
屏幕顶部（主显示器正中）一条暗色胶囊：
  圆环            当前任务计时，点一下暂停/继续
  ✓ 按钮          完成当前项（绿色粒子动画）
  右侧胶囊        接下来 2-3 项，点一下切换过去
  右上 2 / 6      今日进度
  右上 ⌃          收起（见下）
  Ctrl+Alt+W      隐藏 / 显示（隐藏后再按会展开显示）
  托盘图标        左键显示/隐藏；右键菜单（开机自启 / 打开数据目录 / 退出）

【收起态：屏幕顶端一条 4px 细线】
- 不显示任何文字，只有一条线。
- 这条线就是进度：随时间从两端向中间收；满格全宽，时间用尽收到中心一个光点。
- 颜色：进行中 靛蓝紫 / 暂停 变暗 / 超时 琥珀色闪 / 今日完成 绿色。
- 鼠标移到细线上会变亮；点一下 → 展开回胶囊。
- 也可以按 Ctrl+Alt+W 或点托盘图标把它叫回来。
- 收起时窗口高度就等于线高，所以没有黑边；只有屏幕最顶端那 4px 会命中细线。

【若安装包 Workbar-Setup-0.0.1.exe 报 "Error writing temporary file"】
那是 NSIS 安装器写 %TEMP% 被这台机器的环境拦了，不是程序坏了。
用上面的 install.cmd 即可，功能完全一样。

【接 AI（MCP）】
workbar-mcp.exe 是标准 MCP stdio server。安装器已经把安装目录写进用户 PATH，
所以只要【完全重启】一次 AI 客户端，直接用 workbar-mcp 这个命令即可：

  先验证（新开一个终端）：
    where workbar-mcp

  Claude Code：
    claude mcp add --scope user workbar -- workbar-mcp

  Cursor / 其它 JSON 客户端：
    {"mcpServers":{"workbar":{"command":"workbar-mcp"}}}

  Codex（~/.codex/config.toml）：
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
    C:\Users\<你>\AppData\Local\Programs\Workbar\workbar-mcp.exe

配好后直接跟 AI 说：
  "帮我排一下今天：上午写周报，10 点修登录 bug，下午写 README，晚上运动"
  "把修登录 bug 挪到下午两点，预估改成 45 分钟"
  "今天还剩什么没做完？"

【数据 / 排查 / 卸载】
计划数据：%APPDATA%\Workbar\plan.json（删掉即清空）
启动日志：%APPDATA%\Workbar\boot.log
崩溃日志：%APPDATA%\Workbar\crash.log（有异常时把这个发我）
绿色版：删掉本文件夹即卸载；安装版用 uninstall.cmd。
