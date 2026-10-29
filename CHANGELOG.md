# 变更记录

> 只记**用户可感知**的变化与会影响部署/运维的改动。详细决策过程见 `docs/plan/`。

## 未发布（待发 v1.2.4）

**出口可逆（本次）**
- 「关闭壁纸」拆成两个动作：**暂停壁纸**（只隐藏背景，服务/看门狗/面板都保留，随时恢复）与
  **退出插件**（危险色按钮，确认框写明恢复方法）。标志文件分离为 `.paused` / `.stopped`。
- 暂停状态**持久化**：服务重启、页面重载、15s 自愈补注入都不会把壁纸拉回来；
  **点任意壁纸会自动解除暂停**（避免"点了没反应"）。
- 新增 `POST /api/pause {"paused":bool}`（需令牌）。

**注入可观测性**
- `Runtime.evaluate` 加 8s 超时——修掉"一次求值不返回 ⇒ 自愈轮询永久停摆"。
- 注入器写出 `<数据目录>/start-ui.log`（此前被看门狗 `stdio:'ignore'` 丢弃，日志全无）。
- `health.injection{ok,at,attempts,failures,lastError,pageUrl}` + `POST /api/inject`。
  面板「系统」页新增注入状态卡与「重新注入」；`pageUrl` 已剥掉 query（含令牌）。

**可读性**
- 面板「系统」页新增**文字蒙版**滑块（0–70%）与四档（关/轻/中/强），走已有 `/api/mask`。
- 资料库/知识库页给最外层加实底（`.97`）：修掉"卡片正中透出白色窗户、表格浮在壁纸上"。

**动态效果（P0，2026-10-29）**
- **昼夜循环**：主题 `theme.json` 可配 `frames`（多张关键帧 + 时间段），页面侧按本地时钟在
  相邻帧间做 opacity 跨淡化（含跨午夜环绕插值），分钟级平滑、运行时零网络零 AI 调用。
- **鼠标视差**：背景随鼠标做 `translate3d` 微位移（默认 ±8px 可配，只改 transform 不触发重排），
  鼠标离开 30s 后缓动回中。
- **动态效果开关**：面板「系统」页新增「动态效果」段落，昼夜循环/视差各一个开关，写
  `localStorage` 后即时生效；当前壁纸不支持（无多帧/未开视差）时开关自动置灰。
- 开关偏好键 `wdw.fx.daynight` / `wdw.fx.parallax`（'off' 关闭）。
- **性能护栏**：新增 7 条 verify 断言，把已踩的 GPU 坑固化（大面板禁 backdrop-filter、
  视差只走 translate3d、昼夜循环 60s 低频重算禁 rAF 全帧空转等）。
- **主题配方**：新增 `node scripts/recipe.js export <id>` / `import <file>`，导出「提示词 +
  参数 + 动画设置 + 素材哈希」的可复现配方 JSON（不内联像素，体积 KB 级）；导入落成新主题，
  本地已有同哈希素材自动复用。
- **场景属性可视化调节**（2026-10-29）：Wallpaper Engine 场景若在 `project.json` 里声明
  `general.properties`，面板「系统」页自动生成对应控件（bool 开关 / slider 滑块 / color 色块 /
  combo 下拉），改动即时提交（`POST /api/we-properties`）落盘 `weUserProperties` 并重注入，
  经 `__weSeedProps` / `applyProps` 写回 WebWallGL 渲染器。属性类型白名单，未知类型降级只读。

**适配**
- 面板 `top:34px`，不再盖住宿主窗口的最小化/最大化/关闭按钮；头部新增 ✕ 关闭。
- `上传`/`扫描`/`关闭壁纸` 不再被压成竖排两行；星标与色块点击目标 18→22px。
- 键盘 `:focus-visible` 可见焦点环；库计数随筛选变化；"当前壁纸"与"使用中"标记能正确显示。
- **报告卡片半透明化**（2026-10-29）：定时任务报告页 `automation-run-group__item` 自带不透明底
  `rgb(10,10,10)`/`rgb(22,22,25)`，848×400 两块把壁纸盖死；改 `rgba(13,15,20,.62)` 玻璃底 +
  细边框，壁纸透出、文字可读（双 token 选择器只命中卡片根）。
- **面板 z 997→1500**（2026-10-29）：压过宿主右缘「会话历史导航」(z=1100)，修掉"面板打开时
  导航栏按钮从面板上穿透、看着像错位"。纯样式改动，未 bump `WIRE_VER`。

**质量**
- `verify.js` 185 → **276**；适配矩阵 11 个入口 × 7 组视口/DPI 全绿。

## 1.2.3

**部署与运维**
- 端口可配且**两端同源**：`--port` > 环境变量 `WBWP_PORT` > 47851。
  修复「只改一边导致看门狗永远判服务没起来、每 5s 重复拉起 + 清 `.ui.pid`」。
- 新增**数据导出/导入**：`node scripts/export.js --out <zip>` / `--import <zip>`。
  只带用户资产，自动排除令牌、锁、下载暂存、渲染器与日志；导入是合并覆盖且先自动备份。

**可观测性**
- 新增**注入探针** `node scripts/probe-injection.js`：元素数 / 吉祥物 / 背景透明 / 场景 canvas，
  退出码即结论；`--soft` 供 CI（无 CDP 时跳过）。CI 已挂 Windows 软步骤。

**文档**
- 新增 `docs/ops/`（部署与运维手册、验收清单）、`docs/api/接口清单.md`（由 `routes.js` 生成，
  `verify.js` 比对防漂）、`docs/INDEX.md`。
- 6 份历史计划文档归档到 `docs/plan/`，根目录只留 README/SKILL/STORE/NOTICES。

**质量**
- `verify.js` 175 → **185**；`verify-apply-real.js` 54；线上守门 11。

## 1.2.2

- 把「换下载站」与「更新状态缓存修复」**带进发布包**（1.2.1 的包早于这两项，
  装完 `update.json` 仍指已删除的旧域名）。
- 下载站地址变更：`https://c2a975f3971d42169d9e1c859081cc47.app.workbuddy.host`，
  **每条路径需带 `?sharecode=`**（不带 403）。
- 修复：更新成功后 `/api/update` 仍报「有新版本」——缓存覆盖了实时 `currentVersion`。
- `minSupported = 1.2.1`：**1.2.0 及以下必须用安装包重装**。

## 1.2.1

- 更新链路加固：**Ed25519 签名验签**（`sha256` 改必填）、下载体积上限与跳转白名单/超时、
  本地接口 **Origin + 令牌**双校验（4 条更新接口 + `/api/shutdown`）。
- 进程判活不再只看 pid（防 pid 回收导致静默停机与误杀），跨平台（Linux 用 `/proc/<pid>/exe`）。
- 发版工具链：`release-feed.js` 六项门禁（minSupported 合法性 / ≤latest / notes 长度 /
  幂等 / 降级保护 / 产出后回读自检）。

## 1.2.0

- 新增自动更新机制：`core/update.js` + `/api/update*` 四条接口 + 面板「关于」页更新卡片。
- 触发时机：启动后 25s / 每 6h / 打开面板（读缓存）/ 手动。
