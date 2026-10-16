# SkillHub 上架物料 · workbuddy-wallpaper

> 本文件是「workbuddy-wallpaper」提交到 SkillHub 商店所需的全部材料。
> 安装包：`dist/workbuddy-wallpaper.zip`（由官方 `package_skill.py` 校验并打包，校验结果 `Skill is valid!`）

## 商店信息

| 字段 | 值 |
|---|---|
| **展示名（商店里看到的）** | **workbuddy-wallpaper** |
| 标识（slug / SKILL.md `name`） | `workbuddy-wallpaper` |
| 版本 | `1.2.0` |
| 许可 | AGPL-3.0-or-later |
| 分类建议 | 效率工具 / 桌面美化 |
| 仓库/主页 | （可选，如有） |

## 简介

**中文（≤60 字）**
> 壁纸引擎与玻璃拟态注入式 UI：自定义/工坊壁纸、场景实时渲染、整站文字颜色与字体切换。

**English (≤120 chars)**
> Wallpaper engine with an injected glassmorphism UI: custom & Workshop wallpapers, live scenes, app-wide font control.

## 描述

**中文**
零依赖本地壁纸服务（纯 Node 标准库）＋ 注入式玻璃拟态界面，把壁纸画进 WorkBuddy 窗口，
并叠加「拉绳吉祥物 + 5 页签面板（壁纸库 / 字体 / 系统 / 扩展 / 关于）」。
支持自定义壁纸（图片 / 视频上传）、Wallpaper Engine（Steam 创意工坊）扫描与应用、
场景壁纸实时渲染（vendored WebWallGL）、收藏与标签过滤、
整站文字颜色（纯白 / 纯黑）与字体族切换；看门狗随 WorkBuddy 启停并支持开机自启。

**English**
A zero-dependency local wallpaper service (Node stdlib only) plus an injected glassmorphism UI
that paints wallpapers into the WorkBuddy window, with a rope mascot and a 5-tab panel
(Library / Font / System / Extensions / About). Supports custom image & video wallpapers,
Wallpaper Engine (Steam Workshop) scanning, live scene rendering, favorites/filtering,
and app-wide text color (pure white/black) and font-family switching.
A companion watchdog follows WorkBuddy's lifecycle and can auto-start at login.

## 示例提示词

**中文**
- 启动壁纸 UI，把拉绳吉祥物挂到窗口顶部
- 帮我换一张场景壁纸，并按收藏筛选
- 把界面文字改成纯黑，字体换成微软雅黑
- 扫描我本机的 Wallpaper Engine 工坊壁纸

**English**
- Start the wallpaper UI and hang the rope mascot on the window
- Switch to a scene wallpaper and filter my favorites
- Make all UI text pure black and set the font to Microsoft YaHei
- Scan my local Wallpaper Engine workshop wallpapers

## 发布步骤（需要你在 SkillHub 网页端操作）

**本机没有 SkillHub 的 CLI，也没有发布凭证 —— 我无法代替你提交。** 实际路径：

1. 打开 SkillHub 的开发者/上传入口（网页端），用你的账号登录。
2. 新建技能，**展示名填「workbuddy-wallpaper」**，标识填 `workbuddy-wallpaper`，版本 `1.2.0`。
3. 上传安装包 `dist/workbuddy-wallpaper.zip`（内部结构：`workbuddy-wallpaper/SKILL.md` + `scripts/` + `ui/` + `core/` + `server/` + `renderer/` + `assets/`）。
4. 粘贴上面的中/英简介与描述、示例提示词，选择分类。
5. 确认许可为 AGPL-3.0-or-later（因代码抽取自 WorkDaddy，**必须**同许可分发），提交审核。

## 上架前自检

- [x] `quick_validate.py` 通过（`Skill is valid!`）
- [x] SKILL.md frontmatter：`name` 为 hyphen-case（`workbuddy-wallpaper`）、含 `description` / `description_zh` / `description_en` / `license` / `version`
- [x] 包内不含 `.git` / `_tmp` / `dist` / `*.log`（由 `scripts/install.js` 的过滤器保证）
- [x] 自验证套件 21/21（`node scripts/verify.js`）
- [ ] 页面文案中「官方壁纸库」已在 2026-10-13 移除（当前库页来源 = 自定义 + WE 库）
- [ ] 上架前建议在一台干净机器上跑一遍 `node scripts/install.js` → `node scripts/start-ui.js`

## 重新打包

```bash
node scripts/install.js --no-autostart        # 同步到 ~/.workbuddy/skills/workbuddy-wallpaper
<skill-creator>/scripts/package_skill.py \
    "$USERPROFILE/.workbuddy/skills/workbuddy-wallpaper" ./dist
```
