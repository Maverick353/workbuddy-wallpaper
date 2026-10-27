# 变更记录

> 只记**用户可感知**的变化与会影响部署/运维的改动。详细决策过程见 `docs/plan/`。

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
