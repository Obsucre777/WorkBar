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
  - 直接启动 Workbar
卸载：双击 uninstall.cmd

【看到什么算正常】
屏幕顶部（主显示器正中）出现一条暗色胶囊：
  圆环            当前任务计时
  右侧胶囊        接下来 2-3 项
  右上 2 / 6      今日进度
操作：
  - 点圆环        暂停 / 继续计时
  - ✓ 按钮        完成当前项（绿色粒子动画）
  - 点右侧胶囊    切换"现在就做这一项"
  - 右上 ⌃        收起成顶端一条呼吸细光（再点细光展开）
  - Ctrl+Alt+W    隐藏 / 显示
  - 托盘图标      左键显示/隐藏；右键菜单（开机自启 / 打开数据目录 / 退出）
退出：托盘右键 → 退出 Workbar，或双击 stop-workbar.cmd
注意：重复双击快捷方式不会崩（旧版会崩，已修复）；如果浮条被隐藏了，
      再双击一次快捷方式会把它叫回来。

【若安装包 Workbar-Setup-0.0.1.exe 报 "Error writing temporary file"】
那是 NSIS 安装器写 %TEMP% 被这台机器的环境拦了，不是程序坏了。
用上面的 install.cmd 即可，功能完全一样。

【接 AI（MCP）】
workbar-mcp.exe 是标准 MCP stdio server，在任意 MCP 客户端配置：

  {"mcpServers":{"workbar":{"command":"<本文件夹绝对路径>\\workbar-mcp.exe"}}}

配好后直接跟 AI 说：
  "帮我排一下今天：上午写周报，10 点修登录 bug，下午写 README，晚上运动"
  "把修登录 bug 挪到下午两点，预估改成 45 分钟"
  "今天还剩什么没做完？"

【数据 / 排查 / 卸载】
计划数据：%APPDATA%\Workbar\plan.json（删掉即清空）
启动日志：%APPDATA%\Workbar\boot.log
崩溃日志：%APPDATA%\Workbar\crash.log（有异常时把这个发我）
绿色版：删掉本文件夹即卸载；安装版用 uninstall.cmd。
