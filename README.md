<div align="center">

# workbuddy-wallpaper

**把壁纸画进 WorkBuddy 窗口** —— 零依赖本地服务 + 注入式玻璃拟态界面

[![CI](https://github.com/Maverick353/workbuddy-wallpaper/actions/workflows/ci.yml/badge.svg)](https://github.com/Maverick353/workbuddy-wallpaper/actions/workflows/ci.yml)
![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen)
![License](https://img.shields.io/badge/license-AGPL--3.0--or--later-blue)

</div>

---

## 这是什么

一个**独立的本地壁纸服务 + 注入式 UI**：纯 Node 标准库实现（**零 npm 依赖**），
在本机回环端口提供完整壁纸 HTTP API，同时通过 CDP 把界面注入 WorkBuddy 窗口：

- **壁纸层**：静态图片 / 视频 / **Wallpaper Engine 场景**（随包自带实时渲染器）
- **界面层**：玻璃拟态面板（5 页签）+ 可拖拽的「拉绳吉祥物」
- **文字层**：整站文字颜色（调色盘 / 常用色块）+ 字体（**本机全部字体，可搜索**）

壁纸与 UI 都是**注入**的，不修改 WorkBuddy 安装目录，一条命令即可完全撤除。

## 截图

| 壁纸 + 玻璃面板（整站透明、无黑线） | 字体页：调色盘 + 本机字体搜索 |
| --- | --- |
| ![壁纸](docs/screenshot-wallpaper.jpg) | ![字体](docs/screenshot-font.jpg) |

## 特性

| 能力 | 说明 |
| --- | --- |
| 壁纸来源 | 自定义（图片 / 视频上传）、**Wallpaper Engine 创意工坊**（Steam 工坊目录直读） |
| 场景壁纸 | vendored WebWallGL 实时渲染（`.pkg`），支持鼠标交互 / 帧率 / 暂停 |
| 面板 | 壁纸库 · 字体 · 系统 · 扩展 · 关于（玻璃拟态，可拖拽吉祥物唤出） |
| 文字颜色 | 调色盘（任意色）+ 16 个常用色块，**点一下即变**；覆盖文字 / 图标 / SVG |
| 字体 | **枚举本机已装字体**（实测 218 款）可搜索；含常见中文字体别名 |
| 界面让位 | 自动把宿主深色容器 / 黑线 / 深色内容块改为透明或浅玻璃，让壁纸透出 |
| 生命周期 | 看门狗随 WorkBuddy 启停；支持开机自启；崩溃自愈；日志轮转 |
| 韧性 | 进程级异常兜底（不静默死亡）、CDP 断线主动重连、服务假死自检 |

## 环境要求

- **Windows**（依赖 `tasklist` / `taskkill` / `netstat`）
- **Node.js ≥ 22**（零 npm 依赖，无需 `npm install`；18/20 上会出现「服务在跑但界面永远不上屏」这种最难查的状态）
- **WorkBuddy 必须带调试端口 `--remote-debugging-port=9222` 启动** ← **这是最容易卡住的一关**

  > 没有这个参数，**注入不了**，装了什么都不会有反应。
  > 检查：`node scripts/companion.js --status` → 看第 4 行是否 `CDP 9222: LISTENING`。
  > 开启：WorkBuddy 桌面快捷方式 → 右键属性 → **目标**末尾加一个空格 + `--remote-debugging-port=9222`
  > → 保存后**用这个快捷方式重启 WorkBuddy**。
  > （官方自动更新重启后可能丢掉这个参数，表现是壁纸突然消失 —— 用快捷方式重启即可恢复。）

- **Wallpaper Engine 是可选的** —— 只有要用创意工坊壁纸才需要；上传自定义图片/视频不需要

## 下载安装

> ⚠️ **下载下来不会自己跑。** 需要**双击一次**安装脚本（或跑 .exe 安装包），之后才是自动的。
>
> 🌐 **不想看 GitHub？** 有中文图文下载页：**https://c2a975f3971d42169d9e1c859081cc47.app.workbuddy.host/?sharecode=SK54F4ACNS**
>
> ✅ **不需要你预先装 Node** —— 脚本会先去找 WorkBuddy 自带的运行时
> （`CODEBUDDY_NODE_BIN` → 内置版本目录），找不到才回退到系统 PATH。需要的是 **Node ≥ 22**。

### 方式一：`.exe` 安装包（最省事，推荐给不写代码的人）

到 [**Releases**](https://github.com/Maverick353/workbuddy-wallpaper/releases/latest) 下载
**`workbuddy-wallpaper-setup-1.2.4.exe`** → 双击 → 下一步 → 完成。

装完会自动跑一次配置：找 Node → 装成技能 → 注册开机自启 → **并在后台把服务拉起来（隐藏窗口，不用等下次登录）** → **检查调试端口** →
没有就提出「帮你改快捷方式」。无需管理员权限（装进 `%LOCALAPPDATA%\Programs\`）。

> 未签名的包会触发 SmartScreen：点「**更多信息 → 仍要运行**」。这是没买代码签名证书的正常现象。

### 方式二：压缩包 + 双击 `.cmd`（不用装任何东西）

下载 `workbuddy-wallpaper.zip` → **解压** → 双击里面的：

| 想干什么 | 双击哪个 |
| --- | --- |
| 装成 WorkBuddy 技能（顺带注册开机自启） | **`install.cmd`** ／ 中文名 **`一键安装.cmd`** |
| 只想临时跑一下，不装进系统 | **`启动.cmd`**（绿色用法；首次会问一次"要不要开机自启"） |
| 卸载 | **`uninstall.cmd`** ／ **`一键卸载.cmd`** |

### 方式三：git（开发者）

```bash
git clone https://github.com/Maverick353/workbuddy-wallpaper.git
cd workbuddy-wallpaper
node scripts/install.js        # 装成技能 + 注册自启
# 或只在当前目录跑，不装：
node scripts/start-ui.js
```

## 快速开始

```bash
# ① 起服务 + 注入 UI（Ctrl+C 退出，会自动卸载页面 UI）
node scripts/start-ui.js

# ② 只起服务、不注入（给别的程序当纯 API 用）
node scripts/start-ui.js --no-inject

# ③ 卸载页面 UI 并停服务
node scripts/stop-ui.js
```

### 装成 WorkBuddy 技能（可选）

```bash
node scripts/install.js              # 复制到 ~/.workbuddy/skills/workbuddy-wallpaper（可加 --no-autostart）
node scripts/install.js --uninstall  # 停服务 + 撤销自启 + 删目录
```

### 看门狗（随 WorkBuddy 启停）

```bash
node scripts/companion.js            # 常驻看门（5s tick）
node scripts/companion.js --status   # 四行诊断：WorkBuddy / 服务 / 端口 / CDP
node scripts/companion.js --install-autostart    # 开机自启
node scripts/companion.js --stop-service         # 手动停服务
```

打开 WorkBuddy 时自动拉起服务，关掉 WorkBuddy 时自动停服务。

### 日常怎么用（装好之后）

| 想干什么 | 怎么做 |
| --- | --- |
| **打开面板** | 点窗口顶部那只**拉绳吉祥物**（挂在边上的猫），点一下面板就出来 |
| **换壁纸 / 调字体** | 面板里 5 个页签：壁纸库 · 字体 · 系统 · 扩展 · 关于 |
| **临时关掉壁纸** | 面板 → **关于** → 「关闭壁纸」；或 `node scripts/stop-ui.js` |
| **彻底卸载** | `node scripts/install.js --uninstall`（停服务 + 撤销自启 + 删目录） |
| **排查问题** | `node scripts/companion.js --status`（四行诊断：WorkBuddy / 服务 / 端口 / CDP） |

## 面板：5 个页签

| 页签 | 内容 |
| --- | --- |
| **壁纸库** | 来源分段（自定义 / WE 库）、收藏星标、标签过滤、关键词搜索、上传 |
| **字体** | 文字颜色（调色盘 + 常用色块 + 纯白/纯黑/默认）、本机字体搜索与预览 |
| **系统** | 吉祥物（拉绳 Buddy）说明 |
| **扩展** | 数据位置、与宿主的共存说明 |
| **关于** | 版本 / 更新（检查·一键更新·回滚）/ 许可 / 接口地址 / 关闭壁纸 |

## 更新（自动检查 + 一键更新）

**不需要你盯 Releases。** 检测到新版本会在面板「关于」页挂提示，点一下就能更新到最新。

### 什么时候检查

静态站只能轮询、没有真推送，所以用四条触发时机叠出「准推送」效果：

| 时机 | 说明 |
| --- | --- |
| **服务启动后 25 秒** | 先把服务、注入、壁纸都跑完再查，绝不抢启动路径 |
| **运行中每 6 小时** | 服务常驻期间自动重查 |
| **打开面板时** | 只读缓存（不发网络），缓存超 1 小时才后台补一次真检查 —— 所以打开面板永远不会卡 |
| **手动** | 「关于」页 → **检查更新** |

### 你会看到什么

- 「关于」页签上出现**小红点** + 更新卡片（当前版本 → 最新版本 + 更新说明）
- 日志里一行：`发现新版本 v1.x.x（当前 v1.y.y）→ 面板「关于」页可一键更新`

### 点「立即更新」之后

```
下载 → 校验 sha256 → 解压到暂存区 → 冒烟校验包内版本 → 整包备份当前版本 → 覆盖 → 服务重启
```

- **下载源自动兜底**：主源是自建静态站（国内可直连），失败自动换 GitHub Releases
- **sha256 / 大小不符直接拒绝**，且**不动任何已安装文件**（实测验证过）
- **包内版本 ≠ 目标版本也拒绝**（防止 feed 写错或包被换）
- 更新前会把当前版本**整包备份**到 `<数据目录>\versions\<旧版本>\`，默认保留最近 3 份
- 覆盖后如果版本校验失败，**自动回滚**
- 服务重启靠看门狗（约 5 秒）；如果你的服务是手动起的、没有看门狗，会先自己补一个再退出

### 出问题怎么办

| 情况 | 行为 |
| --- | --- |
| 更新源全部不可达 | **不报错、不阻塞**，保留上次结论；「关于」页显示上次成功时间 + 失败原因 |
| 更新失败 | 自动回滚到原版本，错误原因显示在面板上 |
| 更新后不合适 | 「关于」页 → **回滚到 vX.Y.Z**（用本地备份，不联网） |
| 当前版本低于 feed 的 `minSupported` | 面板红色提示「必须更新」（低于它接口契约不兼容），并**禁止回滚到更低版本** |
| 本地版本比 feed 新（自己改过代码） | 不提示更新，也不会「降级」 |

### 配置

优先级（低 → 高）：

1. `update.json`（随包分发，就是上面的默认值）
2. `<数据目录>\update.json`（**你的覆盖，升级不丢**）
3. 环境变量 `WBWP_UPDATE_FEED`（逗号分隔的 URL 列表）、`WBWP_UPDATE_OFF=1`（**整体关闭更新检查**）

```json
{
  "feeds": [
    "https://c2a975f3971d42169d9e1c859081cc47.app.workbuddy.host/version.json?sharecode=SK54F4ACNS",
    "https://raw.githubusercontent.com/Maverick353/workbuddy-wallpaper/main/landing/version.json"
  ],
  "channel": "stable",
  "startupDelaySeconds": 25,
  "checkIntervalHours": 6,
  "keepBackups": 3
}
```

feed 就是一个静态 JSON：`latest` / `minSupported` / `notes` / `assets.zip{url, mirrors, size, sha256}`。
发版时由 `node scripts/release-feed.js` 生成（默认从 GitHub Release 取那份正式 zip 来算 sha256，
并把**同一份字节**镜像进 `landing/` 供静态站托管 —— 两个下载源必须字节相同，sha256 才对两边都成立）。

## 数据目录

`%APPDATA%\workbuddy-wallpaper` —— 主题、自定义壁纸、工坊缓存、字体缓存、
`.ui.pid`、`.companion.lock`、`companion.log`（超 1MB 自动轮转）。

更新机制相关的：

| 路径 | 内容 |
| --- | --- |
| `update.json` | 你的更新配置覆盖（可选，升级不丢） |
| `update-cache.json` | 上次检查结论 + ETag + 失败原因 |
| `versions/<版本>/` | 更新前的整包备份（回滚用，默认留最近 3 份） |
| `update/download`、`update/staging` | 下载与解压暂存（可随时删） |

## 项目结构

```
scripts/     入口：start-ui / stop-ui / companion / cdp / verify / install / server / release-feed
core/        内核：store（数据）· media（媒体）· we（工坊扫描）· theme-css（背景 CSS）· fonts（字体枚举）· update（版本检测与更新）· renderer
server/      HTTP 路由与独立启动器
ui/          注入页面：background.js（背景层）· dsh-ui/（吉祥物 + 面板 + 立绘）
renderer/    vendored 场景渲染器（WebWallGL，MIT）
assets/      内置种子壁纸
landing/     静态下载页（同时托管 version.json 与更新包镜像）
```

## HTTP API（节选）

```
GET  /api/wallpaper/health      GET  /api/wallpapers        GET  /api/custom-wallpapers
POST /api/custom-wallpapers     DELETE /api/custom-wallpapers
GET  /api/we-wallpapers         POST /api/we-apply
POST /api/theme-bg              GET/POST /api/mask
GET  /api/fonts                 （本机字体列表，?refresh=1 强制重扫）
GET  /api/update                （读缓存的更新状态，不发网络）
POST /api/update/check          （真的去拉 feed；{force} 忽略节流）
POST /api/update/apply          （下载→校验→备份→覆盖→重启；{expectVersion} 防抢跑）
POST /api/update/rollback       （从本地备份回滚；{version} 不传则回最近一份）
静态  /wallpapers/* · /theme-media/* · /wallpaper-engine/scene-live/* · /wallpaper-engine/scene-files/*
```

## 兼容性与已知限制

本技能**注入宿主 UI**，因此与 WorkBuddy 的版本强耦合 —— 这几点请务必了解：

- **依赖宿主 DOM 类名**：界面透明化、去黑线等规则按 **WorkBuddy 5.8.2** 的类名编写（含 CSS-module 哈希名）。
  **宿主升级后可能失效**，需按新类名更新 `core/theme-css.js` 与 `ui/dsh-ui/index.js`。
- **需要 CDP**：WorkBuddy 必须带 `--remote-debugging-port=9222`。官方自动更新重启后可能丢失该参数
  （表现为壁纸突然消失），重启 WorkBuddy 即可恢复。
- **跨域限制**：WE 场景**自己渲染在 iframe 内**的文字 / 图形，父页 CSS 无法影响。
- **仅 Windows**：看门狗与安装脚本依赖 Windows 命令。
- **数据目录是全局的**：同一台机器上多个副本共享 `%APPDATA%\workbuddy-wallpaper`。

## 开发

```bash
node scripts/verify.js     # 自验证：起临时服务打真实请求（CI 也跑这套）
```

- 提交前请确保 `node scripts/verify.js` 全绿（CI 跑 ubuntu + windows × node 22/24）。
- **改 UI 代码后必须重启服务**：服务不热加载模块，旧进程会继续注入旧版本。
- 排查进程生死：以 `<数据目录>/companion.log` 为准，不要只看 `netstat`。

## 许可与第三方

- 本仓库：**AGPL-3.0-or-later**（见 [`LICENSE`](LICENSE)）
- 内置第三方组件与来源：见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)
  （webwallgl 场景渲染器 MIT；内核抽取自 [WorkDaddy](https://github.com/babygoton/WorkDaddy)）

## 免责声明

本项目通过注入方式增强本机应用界面，仅供**个人本地使用**。
请遵守你所用软件的服务条款；因使用本项目产生的任何后果由使用者自行承担。
