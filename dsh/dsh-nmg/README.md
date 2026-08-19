# @nmg/dsh-nmg — DeepSeek Harness / NMG 适配器

NMG（Node Memory Graph）在 DeepSeek Harness web 生态的宿主适配包。tsdown 构建为
宿主导包（`lib/index.js`，host 半区）+ 浏览器客户端（`lib/client.js`），经
`cordis.patch.yml` 的 `insert: [{ id: nmg, name: '@nmg/dsh-nmg' }]` 挂进 web
profile 的 host-composition。

## 开发回路（重要：Web HMR 已关闭）

**为什么热重载（HMR）是关闭的：**

官方 `@deepseek-ai/dsh-web-app` 的 `cordis.patch.yml` 里 **默认 `/id: hmr/ disabled:
true`**：

```yaml
# TODO: Re-enable shared HMR for Web after its reload lifecycle is tested.
- id: hmr
  disabled: true
```

即 DeepSeek Harness 官方自己都判定 **Web 生态的共享 HMR reload lifecycle 尚未测试、
不可靠**。若在 web profile 里强开（`hmr.disabled:false` + 监视 dsh-nmg 目录），
每次 `npm run build` 都会触发一条官方认为不可靠的重载路径，**build 后插件消失 /
重载失败**，需要重启 web 才恢复。这是已知且反复复现的问题。

同时 `web profile 手动重启` 也不够：如果 build 出的插件带致命问题，重启时 web
会报错无法启动——这正是用户要求热重载想防住的场景（坏插件别拖垮整个 web）。

### 替代回路：动态插件沙箱先行验证

动态 Cordis 插件（`cordis_define` / `cordis_run`，本会话工具）自带**插件级失败
隔离**：一个动态插件 apply/tools/事件出问题，只影响它自己的临时 fiber，web 其他
session 照常跑，不会崩。这就是热重载真正价值的等价实现。

> 注意：动态插件的 host ctx 是沙箱化的——只暴露 `ctx.tools.register` / `ctx.on` /
> `ctx.provide` / timer helpers，`ctx.registry` 等框架内部被拒绝（denyRead）。
> 因此动态插件不能直接枚举 registry / fiber，只适合验证业务逻辑与工具行为，不适合
> 做框架内省。

**推荐的改动流程：**

```text
1. 在动态插件沙箱里改/复制 dsh-nmg 的业务逻辑（apply / tools / 事件处理）
   → cordis_define 定义 → cordis_run 激活
   → 即时报错、单点隔离、web 不崩
2. 验证通过（工具可调、逻辑正确、无致命错误）后再落入源码
3. 改 src/plugin/index.ts → npm run build（tsdown → lib/）
4. 手动重启 web（此时版本已过沙箱验证，几乎不会撞上致命问题）
```

这套回路的心态是：**沙箱拦坏插件（等价热重载的价值），bundle 只收已验证的版本**。

## 常用命令（在 dsh-nmg 目录下）

```sh
npm run typecheck   # tsc --noEmit
npm run build       # tsdown → lib/index.js + lib/client.js
```

## 唤醒器（board wake）参考

唤醒器逻辑对应 pi 版 `.pi/extensions/nmg/index.ts` 的设计（`scanBoardWake` /
`isBoardWakeCandidate` / `maybeBroadcastToWorld`），DSH 侧用
`ctx.subagents.followup` 唤醒 continuable 子 agent。设计文档见
`docs/design/board-find-serial-a2a-compat-2026-08-13.md`。
