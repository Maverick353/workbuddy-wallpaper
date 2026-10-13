# workbuddy-wallpaper

**独立壁纸引擎 skill** —— 零依赖本地服务 + 注入式玻璃拟态 UI，把壁纸画进 WorkBuddy 窗口。

> 与 WorkDaddy 主仓库**解耦**：本项目是独立 skill，不进 WorkDaddy 源码树。许可 AGPL-3.0-or-later。

## 它是什么

```
用户 / AI 说「启动壁纸 UI」「换壁纸」
        │
        ├─ scripts/start-ui.js
        │     ├─ 起本地服务（零依赖，:47851）
        │     └─ CDP 注入 UI 到 WorkBuddy 窗口
        │           ├─ 壁纸背景层（图片 / 视频 / 场景 iframe）
        │           └─ 拉绳吉祥物 + 4 页签面板（壁纸库 · 系统 · 扩展 · 关于）
        │
        └─ scripts/companion.js（看门狗）
              ├─ WorkBuddy 在 + 服务不在 → 自动起
              ├─ WorkBuddy 关 → 自动停
              └─ 单实例锁 + 日志 + 开机自启
```

## 快速开始

```bash
node scripts/start-ui.js                 # 起服务 + 注入 UI
node scripts/companion.js                # 常驻看门狗（随 WorkBuddy 启停）
node scripts/companion.js --install-autostart   # 开机自启
node scripts/verify.js                   # 自验证（21 项）
node scripts/install.js                  # 安装为 WorkBuddy skill
```

## 目录结构

| 路径 | 作用 |
|---|---|
| `scripts/` | 入口：`start-ui` / `stop-ui` / `companion` / `cdp` / `verify` / `install` |
| `core/` | 内核：`store`（数据）、`media`（媒体服务）、`we`（工坊扫描）、`theme-css`、`renderer` |
| `server/` | HTTP 路由与独立启动器（`routes.js` / `standalone.js`） |
| `ui/` | 注入页面的代码：`background.js`（背景层）、`dsh-ui/`（吉祥物 + 面板 + 立绘） |
| `renderer/` | vendored 场景渲染器（WebWallGL），见 `THIRD-PARTY-NOTICES.md` |
| `assets/wallpapers/` | 内置种子壁纸（首次启动铺进数据目录） |

## 数据目录

`%APPDATA%\workbuddy-wallpaper` —— 主题、自定义壁纸、工坊缓存、`.ui.pid`、`.companion.lock`、`companion.log`。

## 并发开发注意

- **改 UI 代码后必须重启服务**：服务不热加载模块，旧进程会继续注入旧版本。
- **进程生死以 `companion.log` 为准**，不要只看 `netstat`。
- 强杀服务后页面上会残留 UI，重注入前需先清（否则幂等标记会跳过）。

## 许可

AGPL-3.0-or-later。代码抽取自 [WorkDaddy](https://github.com/babygoton/WorkDaddy)，按同许可分发。
第三方组件许可见 `THIRD-PARTY-NOTICES.md`。
