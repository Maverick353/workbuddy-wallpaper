# 第三方许可与来源声明（THIRD-PARTY NOTICES）

壁纸 Skill（wallpaper-skill / 仓库 `workbuddy-wallpaper`）自身以 **AGPL-3.0-or-later** 分发（见 `LICENSE`）。其包含或派生的第三方组件如下，均按各自许可使用。

## 1. webwallgl — MIT

- 用途：场景（Scene）壁纸实时渲染器，随包分发于 `renderer/`（`web-shim.js`、`assets/renderer-*.js`、`default-wallpaper/`），版本 2.1.0（commit `4ba71c406fbc78f24c99b1bb1edd9d9cef9793c8`）。
- 来源：https://github.com/oneincase/webwallgl （MIT）
- 分发形式：官方构建产物（dist）原样 vendored，未修改。

```
MIT License

Copyright (c) 2026 oneincase <462534624@qq.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 2. WorkDaddy — AGPL-3.0-or-later

- 用途：本技能的内核逻辑（`core/*`、`server/*`）抽取并改造自 WorkDaddy 的壁纸插件（其 `scripts/plugins/wallpaper/`）。
- 来源：https://github.com/babygoton/WorkDaddy
- 义务：因派生自 AGPL 代码，本技能整体以 AGPL-3.0-or-later 同许可分发；再分发/修改须保留本声明与 `LICENSE`。

## 3. dsh-wallpaper-engine — MIT（架构参考，未分发其代码）

- 用途：交互桥协议（指针注入 / 暂停 / op 通道）与宿主-渲染分层设计借鉴其实现思路。
- 来源：https://github.com/elysia395/dsh-wallpaper-engine （MIT）
- 说明：本技能**未**包含该项目的代码，仅参考其协议语义与分层设计。

## 4. 随包官方壁纸（`assets/wallpapers/*.webp`）

- 来源：WorkDaddy 内置壁纸资产，随 WorkDaddy 以 AGPL-3.0-or-later 分发；本技能沿用同一许可。
