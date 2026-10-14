---
name: workbuddy-wallpaper
description: 壁纸引擎与注入式 UI 技能（workbuddy-wallpaper）—— 零依赖本地服务（纯 Node 标准库，监听 127.0.0.1:47851）+ CDP 注入的玻璃拟态界面，把壁纸画进 WorkBuddy 窗口并叠加「拉绳吉祥物 + 5 页签面板（壁纸库/字体/系统/扩展/关于）」。能力：自定义（图片·视频上传）/Wallpaper Engine（Steam 创意工坊）壁纸、场景壁纸实时渲染（vendored WebWallGL）、收藏与标签过滤、整站文字颜色（纯白/纯黑）与字体族切换、随 WorkBuddy 启停的看门狗与开机自启。触发词：壁纸、换壁纸、壁纸面板、启动壁纸、壁纸服务、场景壁纸、动态壁纸、Wallpaper Engine、工坊壁纸、拉绳吉祥物、玻璃拟态面板、改字体、文字变黑、workbuddy-wallpaper、apply wallpaper、wallpaper engine。
description_zh: 壁纸引擎与注入式 UI（玻璃拟态面板 + 拉绳吉祥物；自定义/工坊壁纸、场景实时渲染、文字颜色与字体切换）
description_en: Wallpaper engine with an injected glassmorphism UI for WorkBuddy — custom and Steam Workshop wallpapers, live scene rendering, and app-wide text color/font control.
license: AGPL-3.0-or-later
version: 1.1.1
agent_created: true
---

# workbuddy-wallpaper · 壁纸引擎与注入式 UI

把壁纸能力做成本机**独立服务 + 注入式界面**：纯 Node 标准库实现（**零 npm 依赖**），
监听回环端口暴露完整 HTTP API，并通过 CDP 把玻璃拟态 UI（拉绳吉祥物 + 面板）注入 WorkBuddy 窗口。

## 何时使用

- 用户说「换壁纸 / 启动壁纸 / 壁纸面板 / 动态壁纸 / 场景壁纸」
- 需要列出、上传、收藏、应用壁纸；或扫描本机 Wallpaper Engine 创意工坊
- 需要把壁纸与 UI 画进 WorkBuddy 窗口（玻璃拟态面板 + 可拖拽的拉绳吉祥物）
- 为其它程序/面板提供壁纸能力（纯 HTTP API，可脱离任何宿主独立运行）

## 首次使用（装好技能后先做这一步）

**装上技能 ≠ 立刻能用。** 首次必须先过两关，缺任一个都是「装了没反应」：

### 第 1 关：WorkBuddy 必须带调试端口启动（CDP 注入的唯一前提）

```bash
node scripts/companion.js --status
```

- 第 4 行输出 `CDP 9222: LISTENING（可注入 UI）` → 过关
- 第 4 行输出 `未监听` → **注入不了，后面做什么都没用**。让 WorkBuddy 以调试端口启动：
  桌面快捷方式 → 右键**属性** → **目标**末尾加一个空格再加 `--remote-debugging-port=9222`
  （形如 `"D:\...\WorkBuddy.exe" --remote-debugging-port=9222`）→ 保存后用**这个快捷方式重启 WorkBuddy**。

### 第 2 关：服务要有人启动（技能不会自己跑）

```bash
node scripts/companion.js --install-autostart   # 注册开机自启（只写启动项，**不会立刻拉起**）
node scripts/companion.js --start-detached      # 真正在后台跑起来（隐藏窗口，关掉终端不影响）
# 或只想试一次（前台跑，Ctrl+C 退出）：
node scripts/start-ui.js
```

> ⚠️ **`--install-autostart` 单独跑等于什么都没发生。** 它只往「启动」文件夹写一个 vbs，
> 而启动文件夹里的东西**只在用户登录时执行**。所以只跑它会得到「装好了、重启 WorkBuddy 还是没反应」，
> 得等到下次登录才生效 —— 这就是「装了没反应」最常见的成因。
> 要立刻生效，必须在注册后再跑一次 `--start-detached`。
> `install.cmd` / 「一键安装.cmd」/ .exe 安装包都已经按这个顺序做了，不用手动敲。

过完这两关：**打开 WorkBuddy 壁纸自己出现，关掉自动停**。之后日常只需点窗口顶部的拉绳吉祥物开面板。

### 依赖清单（其余都不用管）

| 需要 | 说明 |
|---|---|
| Windows | 看门狗/安装脚本依赖 Windows 命令 |
| Node ≥ 22 | **零 npm 依赖**，无需 `npm install`；WorkBuddy 自带运行时即可。**低于 22 会出现「服务在跑但界面永远不上屏」**（`cdp.js` 依赖 Node 22 才有的全局 `WebSocket`），入口会直接报错退出 |
| Wallpaper Engine | **可选**。只有要用创意工坊壁纸才需要；上传自定义图片/视频**不需要** |

## 快速开始

```bash
# 一键启动：起服务 + 注入 UI（Ctrl+C 退出）
node scripts/start-ui.js

# 只起服务、不注入 UI
node scripts/start-ui.js --no-inject

# 卸载页面 UI 并停服务
node scripts/stop-ui.js

# 看门狗（随 WorkBuddy 启停本服务）
node scripts/companion.js            # 常驻看门
node scripts/companion.js --status   # 四行诊断（WorkBuddy / 服务 / 端口 / CDP）
node scripts/companion.js --start-detached       # 后台隐藏拉起（装完立刻生效，不用等登录）
node scripts/companion.js --install-autostart    # 开机自启（登录时动态解析路径；不会立刻拉起）
node scripts/companion.js --uninstall-autostart  # 取消自启
node scripts/companion.js --stop-service         # 手动停服务
node scripts/companion.js --stop-watchdog        # 停掉常驻看门狗

# 自验证（21 项：服务面 + 前端注入契约）
node scripts/verify.js
```

**一键安装为 WorkBuddy 技能**（复制到 `~/.workbuddy/skills/` 并可选注册开机自启）：

```bash
node scripts/install.js              # 安装
node scripts/install.js --uninstall  # 卸载（停服务 + 撤销自启 + 删目录）
```

## 关键事实（排查问题先看这里）

| 项 | 值 |
|---|---|
| 服务端口 | `127.0.0.1:47851` |
| 宿主 CDP 端口 | `9222`（WorkBuddy 渲染进程） |
| 数据目录 | `%APPDATA%\workbuddy-wallpaper`（含 `current-theme.json`、`themes/`、`mask.json`、`.ui.pid`、`.companion.lock`、`companion.log`） |
| 服务进程纪律 | 进程生死**以 `companion.log` 为准**，不要只看 netstat |
| 代码不热加载 | 改完 UI 代码**必须重启服务**才生效（旧进程内存里是旧模块） |
| 注入幂等 | `data-wdw-ver` 指纹自判重建；强杀后残留 UI 需先清（否则幂等标记会跳过注入） |

## 能力面（HTTP API 摘要）

- `GET /health` · `GET /wallpapers` · `GET /custom-wallpapers`
- `POST /api/custom-wallpapers`（dataUrl 上传）· `DELETE` 删除
- `POST /api/mask`（背景蒙版）· `GET /api/we-cache` / `POST /api/we-scan`（工坊扫描）
- `POST /api/apply`（应用壁纸，含场景/视频）· `POST /api/theme-bg`
- 静态：`/wallpapers/*`、`/theme-media/*`、`/wallpaper-engine/scene-files/<id>/<file>`（含 ETag/304）

## 依赖与许可

- **零 npm 依赖**（仅 Node 标准库）；`renderer/` 为 vendored 第三方（见 `THIRD-PARTY-NOTICES.md`）
- 许可：**AGPL-3.0-or-later**（代码抽取自 WorkDaddy，须同许可分发）
