# onlion — AML 云端记忆服务

[English](README.md)

NMG AML Add/Search 边界背后云端记忆应用的 Git 管理源码。它导入规范根目录 `src/`——CLI/daemon 与本服务共用一份 NMG 实现，没有 vendored 第二棵树。设计依据与边界：[所属决策记录](../docs/decisions/implemented/2026-10-22-onlion-aml-cloud-service.zh-CN.md)。

## 目录布局

- `backend/worker.mjs` — HTTP 面、鉴权、R2 快照与回执事务接线。
- `backend/memory-service.ts` — daemon 核心之上的薄 AML 适配层：消息映射、固定搜索档案、投影。
- `backend/extractive-summaries.mjs` — 确定性、无 LLM 的检索索引摘要，经 store 的 provider 机制写入。
- `backend/storage.mjs`、`sqlite.mjs`、`page-delta.mjs` — R2 manifest 事务、SQLite WASM 请求上下文、快照页增量。
- `vendor/` — 仅 SQLite WASM 运行时胶水（官方 3.53.4 构建加构建时由可读覆盖集清单 `callbacks.manifest.json` 生成的回调模块；生成的 wasm 不跟踪）。search-query-parser 是普通 npm 依赖。
- `.runtime/` — 不跟踪的数据集、checkpoint、测试持久化与回执。

## 命令

```bash
npm install
npm run build    # 打包 dist/server，含 wrangler.json 与 prompts
npm run check    # 后端与根声明文件的 tsc --noEmit
npm run verify   # build、check、原生 temporal/media、backend、worker 套件
```

测试套件针对构建后的 Worker 在 Miniflare 与模拟 R2 中运行，不调用外部模型。

## 本地部署

```bash
npm run build
npm run start    # wrangler dev，127.0.0.1:8787，持久化到 .runtime/wrangler
```

为运行实例设置 `NMG_API_KEY`（生产用 Wrangler secret；本地用 `--var NMG_API_KEY:...`）。可选 embedding 变量（`NMG_EMBED_PROVIDER`/`NMG_EMBED_BASE_URL`/…）启用混合检索；不设置则词法检索。部署命名是显式的：`NMG_WORKER_NAME` 与 `NMG_R2_BUCKET` 覆盖构建产物命名，不再继承单一托管配置。

在目标账号开通 R2 后用 Wrangler 部署：

```bash
node node_modules/wrangler/bin/wrangler.js deploy --config dist/server/wrangler.json
```

`--dry-run` 加 `--outdir` 可只验证打包、不触碰远端资源。本地冒烟全流程（健康检查、Add、回执冲突、图文 Search、隔离）位于 `.runtime/verification/smoke-local.mjs`，针对 `wrangler dev` 运行。

## EdgeOne 部署

需要大陆评测流量直连时走这个目标（原托管平台对大陆出口返回 403）。设计与踩坑记录在 `onlion/edgeone-migration-plan.md`。

```bash
npm run build:edgeone   # dist/edgeone（单文件函数）+ dist/edgeone.zip
npm run test:cos        # 存储适配器打真实桶
npm run test:edgeone    # 用构建产物 + 真实桶跑完整 Add/Search/reset
npm run deploy:edgeone  # edgeone makers deploy ./dist/edgeone -n nmg-memory-api
```

存储从 R2 换成腾讯云 COS。桶必须与函数**同地域**，且**不能开启版本控制**：适配器用 `x-cos-forbid-overwrite` 模拟 manifest 的 CAS，而 COS 对已开启版本控制的桶会忽略该头。函数地域是**项目级**控制台设置、下次部署才生效；`edgeone.json` 不会给已存在的项目改地域，所以用 `x-nmg-region` 响应头确认实际落点。

配置全部来自平台环境变量，不读文件：`NMG_API_KEY`、`NMG_COS_BUCKET`/`NMG_COS_REGION`/`NMG_COS_SECRET_ID`/`NMG_COS_SECRET_KEY`，以及可选的 `NMG_EMBED_*`（含义与 Wrangler 目标一致）。`npm run smoke:edgeone` 验收已部署端点（`NMG_ENDPOINT=... NMG_API_KEY=...`）。

## 多模态行为

- Add 与 Search 接受有序 `text`/`image_url` parts；仅 Base64 data URL（JPEG/PNG/WebP/GIF），单图、单条内容与单请求均有上限。
- 检索使用随附描述文字加不透明的单图 SHA-256 引用。不要求、也不会调用任何图片描述模型；没有多模态向量。
- Search 在 `content` 返回原始有序 parts；`raw_content` 是原始证据 JSON。`content` 可能携带共享的条件式时间前缀（[展示策略](../src/integration/temporal-evidence-policy.json)）。
- 归因跟随消息角色；结构化内容标记携带格式、来源角色与内容哈希。

## 多子句检索

Search 接受两种形状：旧形态的单 `query`（可带 `options`，每条变成 `query + ' ' + option` 子句），或 `queries` 列表（1–8 条独立子句，每条为字符串或 `{text, name}`）。**服务端不发明检索维度**，由调用方给出。所有子句按同一规则融合——同一 memory id 取最高分、排序、按 `top_k` 截断——响应为每条子句附一行，含在返回页上统计的 `contributed` 与 `exclusive`。`queries[0]` 是呈现子句。`queries` 与 `query` 或 `options` 同时出现会被拒绝。子句可带 `appendOnly: true`：其结果跳过页面、单独以 `appended` 字段返回，与页面去重并按 `top_k` 封顶。见[多子句检索决策](../docs/decisions/implemented/2026-10-23-onlion-multi-clause-search.zh-CN.md)与[只进追加段决策](../docs/decisions/implemented/2026-10-23-onlion-append-only-clauses.zh-CN.md)。

## 非目标

本包不宣称任何官方 AML 评测、生产部署或完整 benchmark 分数。远端删除、异步 Add、HaluMem 物化操作计分与流式生命周期不在范围内；面向本服务的评测适配器见[集成边界](../evals/omnimemeval/README.zh-CN.md#集成边界)。
