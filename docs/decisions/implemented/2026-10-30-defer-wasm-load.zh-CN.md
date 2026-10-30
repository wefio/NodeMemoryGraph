# SQLite 只由需要它的请求加载

[English](2026-10-30-defer-wasm-load.md) · [Terms](2026-10-30-defer-wasm-load.terms.yaml)

**Status:** implemented
**Approved:** explicit

## 问题

改动前在线上实测：**连续 12 次 `/health` 各耗 3.6–6.5 秒**。每一次都是冷启动——本平台**每请求一个全新 isolate**（每行日志 `instance.seq = 1`，而容器 `uptime_s` 是几千秒）。所以这个开销是**按请求**付的，不是按容器付一次；而且付在了 `/health` 根本用不到的 SQLite 上：

1. `healthResponse` 在应答前调用 `sqliteReady()`，只为报告 `sqlite.version.libVersion`；
2. EdgeOne 构建把 wasm 以 base64 内联，并在**模块顶层**发出 `export default new WebAssembly.Module(Buffer.from(<base64>, "base64"))`——插件注释写着"lazy"，实际代码是急切的。于是 1.6 MiB 的 base64 解码加 wasm 编译在任何 handler 之前就跑完了。

评测预检恰好打的是 `/health`。它成了服务里最贵的一条路由。

## 决策

- 构建改为发出**工厂**：`encodedBytes` 保持字符串字面量（便宜），`compiledWasm()` 在首次调用时才解码与编译。
- `worker.mjs` 接受两种形态——工厂，或 wrangler 构建里 workerd 预编译好的模块——两条构建路径共用一份代码。
- `/health` 不再加载 SQLite，回答"deferred until a request needs it"，而不是一个它没读过的版本号。
- 常开请求行带 `sqlite_loaded`，让这个结论可被证伪：`false` 表示该请求全程没有解码或编译 wasm。

## 证据

| 改前                                                                                                                 | 改后                                                         |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 线上 `/health` ×12：3.617 / 3.839 / 3.772 / 6.482 / 4.301 / 4.729 / 5.861 / 6.039 / 5.143 / 3.745 / 4.249 / 3.604 秒 | 部署后实测；元数据路由 `sqlite_loaded: false` 已在套件中断言 |
| 套件里元数据路由记录 `sqlite_loaded: false`                                                                          | 同一断言，现在还能按请求在平台日志里核对                     |

## 这确立了什么、没有确立什么

- 它把 wasm 解码/编译从"不碰数据库的路由"上移除。它**没有**让数据库请求变便宜：`/add` 与 `/search` 仍加载 SQLite，在"每请求一个新 isolate"的平台上仍然每次都要付。那是下一个杠杆，而且属于另一种设计（能复用 isolate 的运行时，或者干脆不用 wasm）。
- 3.6–6.5 秒里包含容器启动与网络；部署后只有**差值**能归因于本次改动。
- 它不处理 53 ms / 54.48 MB 的快速失败：那些调用从未进入 handler。

## 考虑过的替代方案

- **保留急切模块，只从 `/health` 去掉 `sqliteReady()`**：只省一半——base64 解码与编译仍在模块顶层，路由照样慢。
- **把 wasm 作为独立文件、按需读取**：EdgeOne 构建刻意内联一切（"removes every filesystem-path assumption"）；函数是 `/var/user` 下的单个模块，那里的文件访问不是契约。字节留内联、解码推迟，能拿到同样的收益而不重新引入路径依赖。
- **跨请求缓存编译好的模块**：做不到——isolate 每请求一个，模块级缓存天然就是"每请求一份"。

## 后果

- `/health` 不再报告 `sqlite.version.libVersion`，改为报告"延迟加载"。解析该字段的客户端应改从 `/admin/status` 读版本——评测端只用状态码。
- `sqlite_loaded` 是请求行上一个布尔值，无额外分配、无内存采样。
- wrangler 构建行为不变：workerd 依旧编译模块，`worker.mjs` 直接使用该对象。
