---
name: wallpaper-skill
description: 壁纸引擎与注入式 UI 技能（壁纸 Skill）—— 零依赖本地服务（纯 Node 标准库，监听 127.0.0.1:47851）+ CDP 注入的玻璃拟态界面，把壁纸画进 WorkBuddy 窗口并叠加「拉绳吉祥物 + 5 页签面板（壁纸库/字体/系统/扩展/关于）」。能力：自定义（图片·视频上传）/Wallpaper Engine（Steam 创意工坊）壁纸、场景壁纸实时渲染（vendored WebWallGL）、收藏与标签过滤、整站文字颜色（纯白/纯黑）与字体族切换、随 WorkBuddy 启停的看门狗与开机自启。触发词：壁纸、换壁纸、壁纸面板、启动壁纸、壁纸服务、场景壁纸、动态壁纸、Wallpaper Engine、工坊壁纸、拉绳吉祥物、玻璃拟态面板、改字体、文字变黑、壁纸 Skill、apply wallpaper、wallpaper engine。
description_zh: 壁纸引擎与注入式 UI（玻璃拟态面板 + 拉绳吉祥物；自定义/工坊壁纸、场景实时渲染、文字颜色与字体切换）
description_en: Wallpaper engine with an injected glassmorphism UI for WorkBuddy — custom and Steam Workshop wallpapers, live scene rendering, and app-wide text color/font control.
license: AGPL-3.0-or-later
version: 1.0.0
agent_created: true
---

# 壁纸 Skill · 壁纸引擎与注入式 UI（wallpaper-skill）

把壁纸能力做成本机**独立服务 + 注入式界面**：纯 Node 标准库实现（**零 npm 依赖**），
监听回环端口暴露完整 HTTP API，并通过 CDP 把玻璃拟态 UI（拉绳吉祥物 + 面板）注入 WorkBuddy 窗口。

## 何时使用

- 用户说「换壁纸 / 启动壁纸 / 壁纸面板 / 动态壁纸 / 场景壁纸」
- 需要列出、上传、收藏、应用壁纸；或扫描本机 Wallpaper Engine 创意工坊
- 需要把壁纸与 UI 画进 WorkBuddy 窗口（玻璃拟态面板 + 可拖拽的拉绳吉祥物）
- 为其它程序/面板提供壁纸能力（纯 HTTP API，可脱离任何宿主独立运行）

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
node scripts/companion.js --status   # 三行诊断
node scripts/companion.js --install-autostart    # 开机自启
node scripts/companion.js --uninstall-autostart  # 取消自启
node scripts/companion.js --stop-service         # 手动停服务

# 自验证（21 项 + 前端注入契约）
node scripts/verify.js
node scripts/verify-contract.js
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
