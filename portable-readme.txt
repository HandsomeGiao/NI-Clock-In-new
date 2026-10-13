NI 考勤工作台 — 免安装版

双击 ni-clock-in.exe 启动。请将整个文件夹放到有写入权限的位置。
resources/sdk 中的 DLL 为设备通信组件，请保留完整目录结构。

人员配置、考勤和人工修正保存在 attendance.sqlite3 中；
导入前自动备份保存在本目录，界面缓存位于 webview 子目录。
导出的 Excel 报表、CSV 和完整 JSON 备份可自行选择保存位置。
迁移前请关闭程序，然后复制整个文件夹。

重复运行 build-portable.cmd 仅更新程序及 SDK，不会清除现有数据。
若要将程序发给其他人，请勿附带自己的数据库、备份和报表。

运行环境：Windows 11 x64，Microsoft Edge WebView2 Runtime。
如设备 SDK 提示缺少运行库，还需安装厂商要求的 VC++ 运行库。
