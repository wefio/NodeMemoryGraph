# NMG HTTP 服务（onlion）

[English](README.md)

NMG 记忆 HTTP 接口提供写入和检索。本地通过 `nmg http` 运行，云端通过 `onlion` 部署。两个入口共用请求解析、记忆写入和结果投影。[服务设计决策](../docs/decisions/implemented/2026-10-22-onlion-aml-cloud-service.zh-CN.md)

## 目录布局

- [`backend/worker.mjs`](backend/worker.mjs) 负责 HTTP 路由、鉴权、写入回执，以及待合并写入与检索的协调。
- [`backend/memory-service.ts`](backend/memory-service.ts) 把云端 SQLite 快照接到[共享记忆服务](../src/integration/memory-http-service.ts)。写入归因、多子句融合和待合并证据打分由共享模块处理。
- [`backend/append-log.mjs`](backend/append-log.mjs) 管理待合并写入。[`backend/storage.mjs`](backend/storage.mjs) 管理 manifest 与快照。[`backend/sqlite.mjs`](backend/sqlite.mjs) 使用 `sqlite-wasm/` 下的运行时，按请求打开 SQLite WASM 数据库。
- Cloudflare 直接绑定 R2。[`backend/edgeone-entry.mjs`](backend/edgeone-entry.mjs) 通过适配器把同一个 Worker 接到 COS。

## 命令

```bash
npm install
npm run build    # 打包 dist/server，含 wrangler.json 与 prompts
npm run check    # 后端与根声明文件的 tsc --noEmit
npm run verify   # build、check、原生 temporal/media、backend、worker 套件
```

CI 在 Miniflare 与模拟 R2 中运行构建后的 Worker，不调用外部模型。构建后可用 `npm run test:http-contract` 单独验证 HTTP 契约。它覆盖健康检查、鉴权、写完立即可查、乱序和重复写入、请求 ID 冲突、用户隔离及重置。回环代理会注入 429，并在上游 Add 成功后主动断开连接，验证用同一请求 ID 重试能恢复。

## 本地记忆 HTTP

在 `nmg-http.json` 中设置数据库和监听地址，然后运行 `nmg http --config ./nmg-http.json`。从源码运行时使用 `npm run cli -- http --config ./nmg-http.json`。

```json
{
  "databasePath": "./http-test.sqlite",
  "host": "127.0.0.1",
  "port": 8787,
  "defaultTopK": 20,
  "maxRequestBytes": 50331648
}
```

`databasePath` 是必填项，相对路径以配置文件所在目录为准。其他字段可省略，默认如上。需要鉴权时，用可选的 `apiKeyEnv` 指定存有密钥的环境变量名，写入和查询请求使用 `Authorization: Bearer <key>`。绑定非回环地址必须配置密钥。

```sh
curl http://127.0.0.1:8787/health
curl http://127.0.0.1:8787/add -H 'Content-Type: application/json' \
  -d '{"user_id":"demo","session_id":"s1","request_id":"r1","messages":[{"role":"user","content":"I prefer morning meetings."}]}'
curl http://127.0.0.1:8787/search -H 'Content-Type: application/json' \
  -d '{"user_id":"demo","query":"When should meetings be scheduled?","top_k":5}'
```

本地监听器按 `user_id` 隔离 SQLite 命名空间。每次 Add 最多原子写入 128 条消息，同一用户重复使用相同的请求 ID 会复用写入回执，更改内容会收到 `409`。Search 支持单 `query`（可带 `options`）或 `queries`，以及可选参考时钟 `now`（别名 `current_time`/`timestamp`，用于启用相对时间窗与当天到期提醒）；单子句查询同时返回按完整 `top_k` 投影的 `data` 与 NMG 渲染器生成的 `rendered` 文本。这个入口的 HTTP 数据与 daemon 会话使用独立的命名空间。

## 本地部署

此节用于在本机调试 Cloudflare Worker 与对象存储适配。

```bash
npm run build
npm run start    # wrangler dev，127.0.0.1:8787，持久化到 .runtime/wrangler
```

为运行实例设置 `NMG_API_KEY`（生产用 Wrangler secret；本地用 `--var NMG_API_KEY:...`）。可选 embedding 变量（`NMG_EMBED_PROVIDER`/`NMG_EMBED_BASE_URL`/…）启用混合检索；不设置则词法检索。部署命名是显式的：`NMG_WORKER_NAME` 与 `NMG_R2_BUCKET` 覆盖构建产物命名，不再继承单一托管配置。

在目标账号开通 R2 后用 Wrangler 部署：

```bash
node node_modules/wrangler/bin/wrangler.js deploy --config dist/server/wrangler.json
```

`--dry-run` 加 `--outdir` 可在本地验证打包。

## EdgeOne 部署

需要大陆评测流量直连时走这个目标（原托管平台对大陆出口返回 403）。设计与踩坑记录在 `onlion/edgeone-migration-plan.md`。

```bash
npm run build:edgeone   # dist/edgeone（单文件函数）+ dist/edgeone.zip
npm run test:cos        # 存储适配器打真实桶
npm run test:edgeone    # 用构建产物 + 真实桶跑完整 Add/Search/reset
npm run deploy:edgeone  # edgeone makers deploy ./dist/edgeone -n nmg-memory-api
```

存储从 R2 换成腾讯云 COS。桶必须与函数**同地域**，且**不能开启版本控制**：适配器用 `x-cos-forbid-overwrite` 模拟 manifest 的 CAS，而 COS 对已开启版本控制的桶会忽略该头。函数地域是**项目级**控制台设置、下次部署才生效；`edgeone.json` 不会给已存在的项目改地域，所以用 `x-nmg-region` 响应头确认实际落点。

平台环境变量包括 `NMG_API_KEY`、`NMG_COS_BUCKET`、`NMG_COS_REGION`、`NMG_COS_SECRET_ID`、`NMG_COS_SECRET_KEY`，以及与 Wrangler 目标含义相同的可选 `NMG_EMBED_*`。

设置 `NMG_ENDPOINT` 和 `NMG_API_KEY` 后运行 `npm run smoke:edgeone`，即可通过网络验证同一套 HTTP 契约。密钥需要有写入、检索、容量查询和重置权限。测试只创建和重置本次随机生成的测试用户。持续并发与延迟测量使用 [`soak-endpoint.mjs`](scripts/soak-endpoint.mjs)。

## 多模态行为

- Add 与 Search 接受有序 `text`/`image_url` parts（`type=text` 须非空；仅 Base64 data URL，支持 JPEG/PNG/WebP/GIF；共享协议单图解码至多 10 MiB、单次 Add 解码图片合计至多 30 MiB，云端 Worker 同时受 6 MiB 单请求体上限约束）。
- 检索使用随附描述文字加不透明的单图 SHA-256 引用。不要求、也不会调用任何图片描述模型；没有多模态向量。
- Search 在 `content` 返回原始有序 parts；`raw_content` 是原始证据 JSON。`content` 可能携带共享的条件式时间前缀（[展示策略](../src/integration/temporal-evidence-policy.json)）。
- 归因跟随消息角色；结构化内容标记携带格式、来源角色与内容哈希。

## 多子句检索

Search 接受两种形状：旧形态的单 `query`（可带 `options`，每条变成 `query + ' ' + option` 子句），或 `queries` 列表（1–8 条独立子句，每条为字符串或 `{text, name}`）。**服务端不发明检索维度**，由调用方给出。所有子句按同一规则融合——同一 memory id 取最高分、排序、按 `top_k` 截断——响应为每条子句附一行，含在返回页上统计的 `contributed` 与 `exclusive`。`queries[0]` 是呈现子句。`queries` 与 `query` 或 `options` 同时出现会被拒绝。子句可带 `appendOnly: true`：其结果跳过页面、单独以 `appended` 字段返回，与页面去重并按 `top_k` 封顶。见[多子句检索决策](../docs/decisions/implemented/2026-10-23-onlion-multi-clause-search.zh-CN.md)与[只进追加段决策](../docs/decisions/implemented/2026-10-23-onlion-append-only-clauses.zh-CN.md)。

## 非目标

本包验证服务接口和打包。远端删除、异步 Add、HaluMem 操作级评分和流式运行暂未支持。面向本服务的评测适配器见[集成边界](../evals/omnimemeval/README.zh-CN.md#集成边界)。
