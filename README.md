# NI 考勤工作台

NI Clock In 是一款本地考勤管理桌面应用，用于整理考勤机打卡记录、维护人员与班次、计算出勤并生成 Excel 报表。界面使用 React + TypeScript + Vite，桌面后端使用 Tauri 2 + Rust，数据保存在本机 SQLite 数据库中，无需部署服务器。

## 主要功能

- **人员与部门**：维护人员档案、设备用户 ID、部门和人员班次，支持批量导入名单。
- **班次与规则**：按星期配置上午/下午班次，设置有效打卡窗口以及迟到、早退阈值。
- **打卡记录**：通过局域网从中控考勤机下载记录（Windows x64），或导入 CSV；支持筛选、去重和 CSV 导出。设备读取不会清空设备记录。
- **考勤统计**：按日期和部门计算应到、实到、缺勤、迟到、早退及工时，查看每日明细，人工补卡、免考勤和添加备注。
- **报表与迁移**：导出 Excel 统计及明细，将周报合并为月报，导入旧版数据，导出和恢复完整 JSON 备份。

## 系统要求

本项目仅支持 **Windows 11 x64**。考勤机通信使用随附的 64 位中控 COM SDK，构建与打包统一使用 x64 MSVC 工具链。

## 编译前准备

首次构建需要联网下载 npm、Cargo 依赖及打包工具。脚本自动安装项目依赖、编译前端和后端并打包；系统开发工具需要先安装一次。

请在 Windows 11 x64 上准备以下工具：

1. [Node.js](https://nodejs.org/) **22.12 或更新版本**（包含 npm；这是构建脚本采用的最低版本）。
2. 通过 [rustup](https://rustup.rs/) 安装 Rust 稳定版及 Cargo。清单声明 Rust 最低为 1.85，但锁定依赖可能要求更高版本，建议使用最新稳定版。

系统开发依赖以 [Tauri 官方环境准备说明](https://v2.tauri.app/start/prerequisites/) 为准。

- 安装 Visual Studio Build Tools，选择 **“使用 C++ 的桌面开发”**，包含 MSVC x64/x86 工具及 Windows SDK。
- 安装 Microsoft Edge WebView2 Runtime；应用运行也需要它。
- 使用 `x86_64-pc-windows-msvc` Rust 工具链。可在项目目录设置：

  ```powershell
  rustup toolchain install stable-x86_64-pc-windows-msvc
  rustup override set stable-x86_64-pc-windows-msvc
  ```

随附设备 DLL 位于 `src-tauri/resources/sdk/`，构建时会一起打包，通常无需手动注册 COM。若运行时提示 SDK 加载失败，检查 DLL 是否完整以及厂商 SDK 所需的 VC++ 运行库是否已安装。

## 一键编译

安装好上述编译环境后，**在文件资源管理器中双击项目根目录的 `build.cmd` 即可开始编译**，无需输入命令。它会自动调用 `build.ps1`，完成依赖安装、编译和打包。成功或失败后窗口都会保留，按任意键关闭。

也可以在项目目录的终端中运行：

```powershell
.\build.cmd
```

默认输出：

- 安装程序：`src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/*-setup.exe`
- 主程序：`src-tauri/target/x86_64-pc-windows-msvc/release/ni-clock-in.exe`

建议使用安装程序安装和分发，它会包含设备 SDK 等资源；仅复制主程序不足以保证设备通信可用。

脚本使用 `npm ci --include=dev` 按 `package-lock.json` 安装依赖，并向 Cargo 传入 `--locked`，保留 `Cargo.lock` 中的依赖版本。脚本会检查 Windows 11 系统版本及 x64 MSVC 工具链。若设置了 `CARGO_TARGET_DIR`，以构建日志中的实际输出路径为准。

## 开发与手动构建

```powershell
# 首次安装项目依赖
npm ci --include=dev

# 启动完整桌面应用（前端热更新）
npm run desktop

# 编译前端并打包桌面应用
npm run bundle -- -- --locked
```

手动构建默认使用当前 Rust 工具链，请确保为 x64 MSVC；项目会拒绝其他编译目标。未指定 `--target` 时，通常输出到 `src-tauri/target/release/bundle/`。`npm run bundle` 会自动执行前端构建，无需预先运行 `npm run build`。

| 命令               | 用途                                           |
| ------------------ | ---------------------------------------------- |
| `npm run dev`      | 仅启动 Vite 界面预览                           |
| `npm run build`    | TypeScript 检查及前端编译，输出到 `dist/`      |
| `npm run desktop`  | 启动 Tauri 桌面开发模式                        |
| `npm run check`    | TypeScript 检查与 Rust Clippy 检查             |
| `npm test`         | Rust 单元测试和旧版兼容性测试                  |
| `npm run test:e2e` | Windows 真实桌面流程测试，需按下述步骤预先构建 |

浏览器预览无法访问 SQLite、文件对话框及考勤机；完整功能请使用桌面应用。`npm run check` 需要 Clippy，可通过 `rustup component add clippy` 安装。

现有端到端测试依赖 Windows WebView2。先关闭已运行的应用（避免单实例机制干扰），然后执行：

```powershell
npm run tauri -- build --debug --no-bundle
npm run test:e2e
```

测试默认启动 `src-tauri/target/debug/ni-clock-in.exe`，使用独立的 `.local-data/e2e-*` 数据目录。若改变了构建输出位置，可通过 `NI_CLOCK_EXECUTABLE` 指定测试程序路径。Windows 下部分 Rust 测试会加载随附 SDK，但不会连接实际考勤机。

## 使用与数据位置

1. 在“人员与部门”和班次页面设置人员、设备用户 ID、部门及班次。
2. 在设置中配置设备 IP、端口、机器号和通讯密码后连接考勤机；也可在原始记录页面导入 CSV。
3. 选择日期范围下载或导入记录，计算统计，按需修正异常并导出 Excel。
4. 在“设置 → 数据与备份”中导出完整备份，或导入旧版项目/data 文件夹。

数据库文件名为 `attendance.sqlite3`，默认位于 Tauri 的应用数据目录，Windows 通常是 `%APPDATA%\com.ni.clockin\`；以设置页面显示的“当前数据目录”为准。恢复备份或导入旧版数据前，会在数据目录保存 `before-import-*.json` 自动备份。

开发时可指定独立数据目录，避免使用日常数据：

```powershell
# Windows PowerShell
$env:NI_CLOCK_DATA_DIR = Join-Path $PWD '.local-data/dev'
npm run desktop
```

## 项目结构

```text
src/                          React 界面、页面及 Tauri 调用
src-tauri/src/                Rust 业务逻辑、SQLite、设备通信与报表
src-tauri/resources/sdk/      Windows x64 中控设备 SDK
src-tauri/tauri.conf.json     Windows 打包配置
src-tauri/tests/              旧版兼容性测试
tests/                       Windows 桌面端到端测试
build.ps1                    Windows 11 x64 一键构建
build.cmd                    双击编译入口（调用 build.ps1）
```
