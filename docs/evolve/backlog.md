# backlog

### EV-20261028-0958 自动采集候选（2026-10-28）

| 相关度 | 类型 | 标题 | 来源 |
|---|---|---|---|
| 30 | compat | Electron 45 | rss |
| 30 | other | Show HN: Wallps: set different live wallpapers for macOS desktop and l | hn |
| 26 | perf | Migrating from Tauri to Electron: Performance Comparison | hn |

- **[compat · 30] Electron 45**
  - https://electronjs.org/blog/electron-45-0
  - 摘要：Electron 45 has been released! It includes upgrades to Chromium 156.0.8078.48, V8 15.6, and Node v24.22.0.
  - 建议动作：宿主/运行时升级后必做三件事：① 7 组视口跑 `_tmp/audit-pages.js` ② `probe-injection.js` 确认注入在位 ③ `verify-apply-real.js`；重点核对 `color-mix()`、`:focus-visible`、`aspect-ratio` 与 `document.hidden` 时序是否仍成立
- **[other · 30] Show HN: Wallps: set different live wallpapers for macOS desktop and lock screen**
  - https://deepanshumishraa.github.io/wallps/
  - 摘要：Show HN: Wallps: set different live wallpapers for macOS desktop and lock screen macOS ties the lock screen to your desktop wallpaper, with no built-in option to set them separately. <p>What it does: 
  - 建议动作：人工判断相关性；不确定就只进 backlog，不排期
- **[perf · 26] Migrating from Tauri to Electron: Performance Comparison**
  - https://twitter.com/richiemcilroy/status/2087851482288640185
  - 摘要：Migrating from Tauri to Electron: Performance Comparison
  - 建议动作：先在 1080p + 场景壁纸下采样 GPU 进程 CPU（10s 均值）作为基线 → 应用后再采样一次；对照 `sceneFps` 档位看是否只是帧率问题
