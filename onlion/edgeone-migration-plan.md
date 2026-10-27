# onlion → EdgeOne Pages (Makers) 迁移计划

> 状态：方案已按官方文档与代码核实修订（第二版）。旧版有两处判断被证伪，见「0. 修订摘要」。

## 0. 修订摘要（旧版哪里错了）

| 旧版判断 | 核实结果 | 影响 |
|---|---|---|
| COS PUT 支持 `If-Match` / `If-None-Match`，直接映射 R2 的 etag CAS | **错**。COS `PUT Object` 只支持 `x-cos-forbid-overwrite: true`（存在即 409 `FileAlreadyExists`，且**版本控制开启时该头失效**）。没有 If-Match / If-None-Match。 | 致命：`commitManifest` 是唯一的并发控制点，必须换实现方案（§4） |
| `sqlite-wasm/` 预编译模块「只是普通 JS+wasm，Node 里照样跑，一行不改」 | **错**。`sqlite-wasm/worker-loader.mjs:1` 是 `import callbacksModule from './callbacks.wasm'`（wasm ESM 导入），Node 20 不支持无标志的 wasm 模块导入。 | 致命：构建需把两个 wasm 内联成 base64（§3） |
| 「EdgeOne Cloud Functions 是 `main(params, context)` 形态，写薄适配层解析 HTTP」 | **不必**。Handler 模式直接拿标准 `Request`/`Response`：`export function onRequest(context)`，`context.request` 就是 Web `Request`。worker 的 `fetch(request, env, execution)` 可以直通。 | 适配层从 ~60 行降到 ~15 行 |
| 「6MB 请求体上限、120s 超时」 | 正确。另确认：**响应体也是 6MB**；超时默认 30s，`edgeone.json` 可配到 120s；运行时 **Node 20.x**；代码包（含依赖）128MB。 | 见风险 |
| env 清单只说 API_KEY + embed timeout | 实际有 10 个 `env.*`（§6），embedding 走 `NMG_EMBED_API_KEY/...`。另：**环境变量值上限 1000 字节**。 | 部署时别漏变量 |

用户关心的问题：「代码不符影响吗？」——上面两处致命项必须改方案才能部署成功；其余是补漏，不影响架构。

## 1. 背景与目标

现有后端部署在境外托管（openai sites），地域封锁导致国内评测出口 Smoke 拿 403。目标：迁到腾讯 **EdgeOne Makers**，国内评测流量直连可达。材料截止 **10/31 23:59 (UTC+8)**，评测截止 **11/4 23:59**。

运行时确定为目标：**EdgeOne Cloud Functions (Node.js 20.x)**，不是 Edge Functions（后者无 SQLite、请求体 1MB、代码包 5MB，直接排除）。

## 2. 已核实的现状（代码 + 平台）

后端在 `onlion/backend/`，构建产物 `dist/server/index.js`（esbuild，**已经是 `platform: node` 的 ESM 单文件**，不是 workerd 专用产物）。

- **入口**：`backend/worker.mjs`（1238 行），`export default { fetch(request, env, execution) }`（worker.mjs:1165）。trace id 优先取 `cf-ray` 头，缺失时 `crypto.randomUUID()`（Node 19+ 有全局 crypto，20 满足）。
- **存储层**：bucket 的依赖面共 **5 类操作**，集中在 storage.mjs + monitoring.mjs + reclamation.mjs 三处：
  - `bucket.get(key)` → 需要 `.size` / `.etag` / `.json()` / `.arrayBuffer()`；不存在时返回 `null`
  - `bucket.head(key)` → 需要 `.size`（仅 legacy `users/<key>.sqlite` 用）
  - `bucket.put(key, body, opts)` → `opts.httpMetadata.contentType`、`opts.customMetadata`、`opts.onlyIf.{etagMatches|etagDoesNotMatch:'*'}`；**条件写失败必须返回 falsy**（`commitManifest` 用 `if (saved)` 判定，storage.mjs:92；monitoring.mjs:46 同）
  - `bucket.delete(key | keys[])`（含 1000 条/批的循环，storage.mjs:145）
  - `bucket.list({prefix, limit, cursor})` → `{objects:[{key,size}], truncated, cursor}`（**仅在 `reclaimAll` 里用**，reclamation.mjs:61；普通请求不列举桶）
  - 对象布局：`users/<key>/manifest.json` + `users/<key>/parts/<uuid>.sqlite`（≤16MiB 分片）+ legacy `users/<key>.sqlite`
- **CAS 只有两个调用点**：`commitManifest`（storage.mjs:92，generation barrier / 并发写 / reset 屏障）与 `monitoring.mjs:46`（错误日志追加）。两者共用同一套 `onlyIf` 语义，适配器一处解决即可。
- **SQLite**：`backend/sqlite.mjs` 用 sqlite-wasm 内存库（`oo1.DB(':memory:')` + `sqlite3_deserialize` + `sqlite3_js_db_export`）。`/tmp/nmg/*.sqlite` 只是 Map key，不落盘。wasm 的实例化在 `worker.mjs:118-131`：`init({instantiateWasm(imports, receive) { const instance = new WebAssembly.Instance(compiledSqlite, imports); ... }})`，其中 `compiledSqlite` 来自 `import compiledSqlite from "../sqlite-wasm/sqlite3.wasm"`（workerd 的 CompiledWasm）。
- **后台任务**：只有 `monitoring.mjs:59-60` 用 `context.execution?.waitUntil`，且已做可选保护 → 适配层不提供 `waitUntil` 时自动降级为同步 `await`，无功能损失。
- `env.*` 全量清单（10 个）见 §6。

## 3. 构建：单文件 Node 20 ESM + 内联 wasm

新增 `onlion/scripts/build-edgeone.mjs`（不修改现有 `build-backend.mjs`，旧 wrangler 部署保留以便回滚）：

1. 复用现有前置步骤：`scripts/generate-prompts.ts`（workspace 根）、`scripts/generate-callbacks.mjs`（生成 `sqlite-wasm/callbacks.wasm`，注意该文件在 `.gitignore` 里，必须构建时生成）。
2. esbuild 打包 `backend/worker.mjs`：`platform: node`、`format: esm`、`target: node20`、`bundle: true`。
3. **wasm 内联插件**：把 `.wasm` 导入解析成 `new WebAssembly.Module(Buffer.from("<base64>", "base64"))`。涉及 `../sqlite-wasm/sqlite3.wasm`（869KB）与 loader 内部的 `./callbacks.wasm`（19KB）→ 产物约 +1.2MB（base64），远低于 128MB 限制。
   - 不用 `includeFiles` + `readFileSync`：函数产物里的相对路径布局不由我们控制，内联是唯一确定性方案。
4. 产物写 `onlion/dist/edgeone/cloud-functions/api/[[default]].js`，同目录附 `edgeone.json`、最小 `package.json`（依赖已 bundle，无需安装）。

`sourceRevision`（`__NMG_SOURCE_REVISION__` define）保持现有 `generate-callbacks` 输出 + git dirty 后缀逻辑，便于材料里做版本绑定。

## 4. 存储适配器：R2 → COS（含 CAS 替代方案）

新写 `onlion/backend/cos-bucket.mjs`，导出 `createCosBucket(config)`，实现 §2 的 4 类操作。HTTP 层用 `fetch` 手写 COS **签名 V5**（HMAC-SHA1），不引入 `cos-nodejs-sdk-v5`：本项目只需要 5 个操作，手写可控、可单测、零依赖、能自由控制 `x-cos-forbid-overwrite` 头。

| R2 操作 | COS 实现 | 说明 |
|---|---|---|
| `get(key)` | `GET /<key>` | 404 → `null`；返回 `{size, etag, json(), arrayBuffer()}` |
| `head(key)` | `HEAD /<key>` | 404 → `null`；`size` ← `Content-Length` |
| `put(key, body, opts)` 无条件 | `PUT /<key>` | `Content-Type` ← `httpMetadata.contentType`；`customMetadata` → `x-cos-meta-*` |
| `put(..., {etagDoesNotMatch:'*'})` | `PUT` + `x-cos-forbid-overwrite: true` | 409 → 返回 `null`（首次创建屏障，语义等价） |
| `put(..., {etagMatches: E})` | **claim 协议，见下** | COS 无 If-Match |
| `delete` | `DELETE /<key>`；批量用 `POST /?delete`（≤1000/次，内部自动分批） | 批量删除在 CAM 里仍然只需要 `cos:DeleteObject` |
| `list({prefix,limit,cursor})` | `GET /?list-type=2&prefix=&max-keys=&continuation-token=` | `limit`→`max-keys`；`truncated`←`isTruncated`；`cursor`←`next-continuation-token`；XML 需最小解析（含实体解码） |

**ETag 归一化**：COS 返回带引号的 `ETag`，适配器统一去掉引号后对外暴露，内部比较自洽即可。

### 4.1 CAS 方案：按「期望 etag」抢占 claim 对象

COS 唯一原子原语是 `x-cos-forbid-overwrite`（创建即独占、已存在即 409）。用它构造「同一期望状态只能有一个写者」的 claim：

```
put(key, body, {onlyIf:{etagMatches: E}}):
  1. claimKey = `users/<k>/claims/<sha256(E)>`        // 同一期望 etag → 同一 claim key
  2. PUT claimKey  (body: ownerId + 时间戳), x-cos-forbid-overwrite: true
       ├─ 409 → 已有写者持有该状态 → 返回 null（调用方按既有逻辑重读 manifest 重试）
       └─ 200 → 本次写入获得独占权
  3. HEAD key → 当前 etag E'
       ├─ E' !== E → DELETE claimKey → 返回 null（并发已推进，语义等同 412）
       └─ E' === E → 继续
  4. PUT key (无条件，写新 manifest)
  5. 尽力 DELETE claimKey；失败忽略
  6. 返回 { etag: 新 etag }
```

正确性来自两点：claim key 由「期望状态」唯一决定（不同期望状态互不阻塞，同期望状态只有一个赢家）；写入后的新 etag 使旧的 claim key 永久作废——**claim 泄漏不会阻塞后续写者**，只会留下垃圾对象。

`etagMatches` 之外的一个自愈点：若第 4 步失败（网络/超时）导致客户端重试，而重试读到的 etag 仍是 `E`，claim 已存在 → 需按 `Last-Modified` 老化（> 10s）后接管。接管用「删除 + 重新 forbid-overwrite 抢占」，存在极窄的双接管窗口（两个接管者同时判定过期）；记录为已知残余风险，不做更重的分布式锁。

这些约束落在 `commitManifest` 之外，`storage.mjs` / `worker.mjs` **零改动**。

### 4.2 明确不做

- 不改 `storage.mjs` 的对象布局（不做「generation 分键 + list 查最新」，那是更大重构）。
- 不静默降级为无条件写。

## 5. 入口适配器（~15 行）

`onlion/dist/edgeone/cloud-functions/api/[[default]].js`（构建产物，catch-all 路由）：

```js
import worker from './_worker.js';            // §3 的 bundle
import { createCosBucket } from './_cos.js';  // 或合并进同一 bundle

const bucket = createCosBucket(process.env);  // 冷启动建一次，复用

export default function onRequest(context) {
  return worker.fetch(context.request, {
    ...context.env,          // Makers 环境变量（NMG_*）
    MEMORY: bucket,
  });
}
```

- 路由：`/cloud-functions/api/[[default]].js` 匹配 `/api/**` 全部路径（含 `/add/status/<id>`、`/admin/*`），仍受 `normalize` 处理 `/api` 前缀，与现有 Worker 路径一致。
- 不传第三个参数（execution）→ `monitoring.mjs` 自动走同步 `await`。
- 冷启动预热只实例化 COS 客户端；wasm 仍按需 `sqliteReady()` 惰性加载。

## 6. 环境变量（Makers 项目设置里逐个填）

值的上限 1000 字节（DashScope key、COS SecretKey 都远小于此）。

| 变量 | 必需 | 用途 |
|---|---|---|
| `NMG_API_KEY` | 是 | Bearer / x-api-key 鉴权（worker.mjs:134） |
| `NMG_COS_SECRET_ID` | 是 | COS 子账号 SecretId |
| `NMG_COS_SECRET_KEY` | 是 | COS 子账号 SecretKey |
| `NMG_COS_BUCKET` | 是 | `name-appid`，如 `nmg-1300000000` |
| `NMG_COS_REGION` | 是 | 与函数同地域，如 `ap-guangzhou` |
| `NMG_EMBED_PROVIDER` | 是（评测） | `openai`（DashScope compatible-mode） |
| `NMG_EMBED_BASE_URL` | 是（评测） | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| `NMG_EMBED_API_KEY` | 是（评测） | DashScope key |
| `NMG_EMBED_MODEL` | 是（评测） | `text-embedding-v4` |
| `NMG_EMBED_DIMENSIONS` | 可选 | 显式固定维度，避免默认值漂移 |
| `NMG_EMBED_TIMEOUT_MS` | 可选 | 默认 90000（worker.mjs:231） |
| `NMG_SEARCH_DELTAS` | 可选 | 设 `0` 关闭分页 delta（默认开） |
| `NMG_OWNER_EMAIL` | 可选 | 管理接口归属校验 |
| `NMG_SELFTEST_TOKEN` / `NMG_SELFTEST_EXPIRES_AT` | 可选 | 自检端点 |

COS 子账号最小权限（**5 个 action，缺一不可**，见 §6.1）：`cos:PutObject` / `cos:GetObject` / `cos:HeadObject` / `cos:DeleteObject` / `cos:GetBucket`，资源限定到 `bucket/*`。

### 6.1 子账号 CAM 策略（可直接粘贴）

`ListObjects` 不是 COS 的 action 名——列举走 `cos:GetBucket`；`DELETE Multiple Objects` 官方也归到 `cos:DeleteObject`。少 `GetBucket` 只会让 `/reclaim/all` 403（服务自检照常），但这是合法运维路径，必须给。

```json
{
  "version": "2.0",
  "statement": [{
    "effect": "allow",
    "action": [
      "name/cos:PutObject",
      "name/cos:GetObject",
      "name/cos:HeadObject",
      "name/cos:DeleteObject",
      "name/cos:GetBucket"
    ],
    "resource": [
      "qcs::cos:ap-guangzhou:uid/1250000000:nmg-1250000000/*"
    ]
  }]
}
```

`uid/1250000000` 换成实际 APPID，桶名换成实际桶名。前缀若不用 `/*` 而想收窄，必须同时覆盖三处：`users/*`、`generations/*`、`maintenance/*`（控制记录是 `maintenance/memory-reclamation.json`）。

可选第 6 个 action：`cos:HeadBucket`（仅当在冷启动自检里 `HEAD /` 探活时用；不加则该自检不打）。

## 7. 部署方式

**主线（赶截止）：CLI 本地产物上传。**

1. 本地 `npm ci` + `npm run build:edgeone`（需要 workspace 根，跨仓库引 `../../src`，本机构建最稳）。
2. 控制台建项目 → 加速区域选**含中国大陆**（否则没有大陆 Cloud Functions 地域）→ 函数地域 `ap-guangzhou`。
3. `edgeone makers deploy ./onlion/dist/edgeone -n nmg-memory-api`（直接上传类型项目）。
4. 环境变量用控制台或 `edgeone makers env set`；注意改动只对新部署生效。

**备选：Git 仓库联动**（root 目录设 `onlion`，build 命令 `npm run build:edgeone`）。风险是构建时能否访问 `../src`（跨根目录路径）与 `cloud-functions/` 的收集时机；不作为首个可用版本。

**本地调试**：`edgeone makers dev` 也需要鉴权（实测 CLI 1.6.46 直接拒绝：未登录且非交互环境时要求 `-t <token>` 或 `EDGEONE_PAGES_API_TOKEN`），所以要么先在本机跑一次 `edgeone login`，要么提供 API Token。dev 从**项目目录**的 `.env` 读环境变量，而 `deploy` 是整目录上传，因此 `build:edgeone` 已在末尾删除产物目录里的任何 `.env*`，避免把 COS 密钥传上去。

**鉴权三条路（浏览器登录不是必需）**：

1. **Token（推荐）**：控制台 ─ Makers 项目设置生成 API Token 后 `edgeone login -t <token>`，或直接 `EDGEONE_PAGES_API_TOKEN`；`makers dev` / `makers env set` / `makers deploy` 全部可用。
2. **Git 联动（完全不用 CLI）**：控制台关联仓库 → 根目录 `onlion`、构建命令 `npm run build:edgeone`、输出目录 `dist/edgeone`。前提是平台能访问该仓库，且构建时能读到 `../src`（跨根目录引用）。
3. `deploy --anonymous`：无需登录生成临时项目。**本项目用不了**：它没有地方注入 `NMG_COS_*` / `NMG_API_KEY` 这些环境变量，而把密钥烤进产物不可接受。

产物目录结构：

```
onlion/dist/edgeone/
├── edgeone.json                      # cloudFunctions: mainlandRegions ap-guangzhou, maxDuration 120
├── package.json                      # 空依赖（全部 bundle），type: module
└── cloud-functions/
    ├── [[default]].js                # 全部路径：/add /search /health /admin/* /api/*
    └── index.js                      # 同一份 bundle，只为了覆盖 `/`（[[default]] 不匹配根路径）
```

**catch-all 必须在 `cloud-functions/` 根下**，不能放 `cloud-functions/api/`：Makers 按文件路径路由，放在 `api/` 下就只匹配 `/api/*`，评测方打 `/add` 会直接 404。两份文件是刻意重复（2.4 MiB ×2，远低于 128 MB 包大小限制），避免依赖构建器对 re-export 是否算入口的未文档化行为。

手传：`onlion/dist/edgeone.zip`（`scripts/zip-writer.mjs` 生成，单个顶层目录 `nmg-memory-api/`，与官方模板同形），或直接传文件夹。

**别用 shell 打包**：git-bash 的是 GNU tar，会无视 `tar -a` 写出一个改名成 .zip 的 tar（控制台会报「不是有效的 ZIP 格式」）；PowerShell 的 `Compress-Archive` 把 `[[default]].js` 里的方括号当通配符。所以 zip 字节由脚本自己写（deflate + 标准中央目录，无 data descriptor、无 Zip64），写完用 python `zipfile.testzip()` 与解压 diff 双重校验。

## 8. 实施顺序

1. `cos-bucket.mjs` + 签名 + 4 类操作（含 claim CAS）
2. **本地 Node harness（不起 wrangler、不上云）**：直接 import 适配器跑 `scripts/test-backend.mjs` 等价用例；先接 `InMemoryBucket` 之外的 COS 真实桶，重点打：
   - 并发条件写：两个 `etagMatches=E` 同时提交，只有一个成功，另一个返回 falsy
   - `etagDoesNotMatch:'*'` 首次创建 / 已存在返回 falsy
   - 16MiB 分片读写、批量 delete（>1000 键）
3. `build-edgeone.mjs`：wasm 内联 + 产物落盘；本地 `node dist/edgeone/cloud-functions/api/[[default]].js` 用一个最小 `Request` 打 `/health`、`/add`、`/search`
4. 部署 + 端到端（§9）
5. Evaluation Key 重新绑定新端点 → 重跑 Smoke（Smoke 不占 Full 额度，可 checkpoint 续跑）
6. Smoke 绿 → 才动 Full（每赛道 2 次、间隔 30 天）

## 9. 验收标准（逐条可测）

- [ ] `npm run verify` 在改动后全绿（旧 wrangler 路径不回归）
- [ ] CAS：并发条件写只有一个成功；失败方收到 falsy → `commitManifest` 返回 false → worker 返回 503 `write_conflict`（不是覆盖成功）
- [ ] 协议回归（复用 nmg-memory-api 用例集）：Add 幂等（同 request_id/task_id）、fail-fast 400、交错批次 Search 命中
- [ ] 大陆可达：不挂代理（手机流量即可）`curl https://<new-endpoint>/health` 返回 200/401，无 403
- [ ] `/health` 的 `retrieval` 报 `hybrid`（证明 embeddings 生效）
- [ ] Smoke 通过（重跑，非复用旧结果）
- [ ] 版本绑定：新端点 + commit hash + suite ID 一致记录进材料

## 10. 风险与已知约束

- **响应体 6MB**（不只是请求体）：Search 大页 + 分页 delta 场景需实测；超限会拿 413，`NMG_SEARCH_DELTAS=0` 是应急开关。
- **120s wall clock 上限**：大批次重嵌（DashScope 慢）可能超时；靠有界批次 + receipt 幂等重试兜底。
- **claim CAS 的残余窗口**：第 4 步失败后 claim 老化接管存在极窄双接管窗口；不做重锁，写入日志里留 ownerId/时间戳以便排查。
- **COS 桶不能开版本控制**：`x-cos-forbid-overwrite` 在版本控制开启时失效（官方文档明确），这会让首次创建屏障与 claim 全部失效。上线前用 `HEAD bucket?versioning` 核验。
- **COS 强一致性**：对象 PUT/DELETE 后立即可读（官方承诺），claim → HEAD → PUT 的顺序成立。
- **冷启动**：wasm 解 base64 + 编译约几十 ms 级，Smoke 阶段实测；不达标再谈预热。
- **Node 20 运行时 vs 构建 Node**：构建可用 24（`engines: >=24`），但产物必须 `target: node20`、不得用 24 独有 API。
- 不做 Edge Functions 路线（已排除）；不换 COS 之外的存储（如需托管 DB，另立项）。

## 11. 需要用户/控制台侧动作（非代码）

1. 腾讯云 COS：建桶（`ap-guangzhou`，**不开版本控制**）、**新建专用子账号** + 最小权限密钥（步骤见 §11.1）。
2. EdgeOne Makers：开通服务、建项目（加速区域含中国大陆）、填 §6 环境变量。
3. DashScope：可用的 `text-embedding-v4` key。
4. 材料截止前：把新端点写进提交材料，并更新 Evaluation Key 的 endpoint 配置。

### 11.1 子账号怎么建（推荐：新建专用子用户）

**不要**复用已有子用户，也**不要**用主账号密钥。理由：这个密钥要填进第三方平台（EdgeOne）的环境变量、在别人机器上跑，泄露面必须限定到「只能动这一个桶」；已有子用户往往带着别的权限，一旦泄露爆炸半径不可控，而且不好单独禁用/轮换。

步骤（CAM 控制台）：

1. 先建策略：访问管理 → 策略 → 新建自定义策略 → **按策略语法** → 粘贴 §6.1 的 JSON（把 `uid/<APPID>` 和桶名换成实际值；APPID 在「账号信息」页）→ 保存。
2. 访问管理 → 用户 → 用户列表 → 新建用户 → **自定义创建**。
3. 访问方式：**只勾「编程访问」**（API 密钥），不勾控制台登录——不给网页登录能力就少一个爆破面。
4. 权限：**不加入任何用户组**，直接关联第 1 步的自定义策略。
5. 创建完成页会显示 SecretId / SecretKey，**SecretKey 只显示这一次**：当场下载 CSV 或抄进密码管理器，然后立刻填到 EdgeOne 环境变量（§6）。
6. 命名建议：`nmg-onlion-cos` / 策略 `nmg-onlion-cos-rw`，备注写清「EdgeOne Makers 运行时专用」。

如果坚持复用已有子用户（例如团队已有统一运维账号）：

1. 同第 1 步建策略 → 用户详情 → 权限 → 关联策略。
2. 用户详情 → API 密钥 → 新建密钥（每个子用户最多 2 个密钥）。
3. 注意：轮换时先建新密钥 → 更新 EdgeOne 环境变量并重新部署 → 确认新端点正常 → 再禁用旧密钥。环境变量改动只对新部署生效，不重新部署不生效。

验证（拿到密钥后，代码写完就能跑）：一次 `PUT` 到 `users/_probe/manifest.json`、一次 `HEAD`、一次 `GET`、一次 `DELETE`、一次 `GET /?list-type=2&max-keys=1` 全部 200；再故意删掉 `cos:GetBucket` 应只在最后一个报 AccessDenied。

## 12. 实施进度与实测（截至本版）

已完成并验证：

- [x] `backend/cos-sign.mjs`（签名 V5，零依赖）、`backend/cos-bucket.mjs`（get/head/put/delete/list + claim CAS）
- [x] `scripts/test-cos-bucket.mjs`：**真桶 26/26 通过**，含「8 个并发条件写只有 1 个成功且落地的是赢家的内容」「stale claim 可被接管」「2 MiB 二进制往返字节一致」「list 分页不重不漏」「批量删除」
- [x] `backend/edgeone-entry.mjs` + `scripts/build-edgeone.mjs`：产物 **2.37 MiB 单文件**（wasm 已内联），`node20` 目标
- [x] `scripts/test-edgeone-worker.mjs`：本进程内用真 COS 跑完整协议，**14/14 通过**（health / 401 / 400 fail-fast / Add / 幂等重放 / Search 命中 / 第二个 Add / **并发 Add 双双落盘且均可检索** / capacity / reset 屏障 / 清空后可查）
- [x] `npm run check` 干净；`npm run test:backend`（Miniflare + R2 旧路径）**全绿**，无回归
- [x] npm scripts：`build:edgeone`、`test:cos`、`test:edgeone`

实测操作数（每次请求对 COS 的往返，本机跑）：`/add` ≈ get 4–5 + put 2–3 + delete 1；`/search` ≈ get 2–3；`/capacity` get 2。单次条件写固定 4 个操作（claim PUT → HEAD 目标 → 目标 PUT → claim DELETE）。

**注意**：本机到 `ap-guangzhou` 的单操作 240–370 ms（跨区 + 本机网络），所以本地看到 `/add` 2–6 s 是被放大的；函数与桶同地域时按每个操作 5–20 ms 估算，`/add` 应在数百毫秒级。部署后必须用真实端点复测这一项，以 120 s 上限为准绳。

未完成（需要控制台/凭据）：

- [ ] EdgeOne Makers 项目创建 + 环境变量填写 + `edgeone makers deploy ./dist/edgeone`
- [ ] DashScope key（`text-embedding-v4`）——当前 E2E 是词法路径；评测要求向量，缺这个 key 前 Smoke 不能跑
- [ ] 大陆可达性验证、Smoke 重跑、Evaluation Key 重绑端点

## 13. 实现备注

- `dist/server`（wrangler 产物）与 `dist/edgeone`（函数产物）互不影响；两个构建都先跑 `generate-callbacks`，生成的 `sqlite-wasm/callbacks.wasm` 在 `.gitignore` 里，不要指望它被提交。
- 本地凭据放 `onlion/.env.cos.local`（被 `.gitignore` 的 `.env*` 覆盖），`test:cos` / `test:edgeone` 读它；不要把 SecretKey 写进任何提交或日志。
- EdgeOne 环境变量值上限 1000 字节且**只对新部署生效**。
- `[[default]].js` 是产物名，不是手写入口；入口是 `backend/edgeone-entry.mjs`，测试导入产物里的具名 `worker` 导出来绕过 `onRequest` 的 env 构造。

## 14. 上线结果（生产可用）

**端点**：`https://api.nmgmemory.dpdns.org`

部署形态：EdgeOne Makers 项目 `nmg-memory-api-overseas`（`makers-pkhgtimnhjor`，加速区域「全球可用区（不含中国大陆）」），函数 `ap-hongkong`，存储 COS `nmg-1305793566`（`ap-guangzhou`），embedding DashScope `text-embedding-v4`。

DNS 链路（**三段都必须对，错一段就 401/418**）：

```
api.nmgmemory.dpdns.org  CNAME  api.nmgmemory.dpdns.org.pages.dnsoe4.com   ← EdgeOne 指定值，不是项目域名
_dnsauth.api...          CNAME  api.nmgmemory.dpdns.org.eoacme0.com        ← 证书续期的 ACME 验证，必须「仅 DNS」灰云
NS 托管在 Cloudflare      api 记录「已代理」（橙云）
```

踩过的坑，按代价从大到小：

1. **`export default function onRequest` 不算函数**：构建器静态扫描导出名单，esbuild 会把默认导出改写成 `export { onRequest as default }`，导出名变成 `default` → 函数不注册 → 全站 404。必须具名 `export function onRequest`。
2. **平台给的项目域名对大陆不可用**：`*.edgeone.cool` 是 3 小时预览链接；「不含中国大陆」区域的项目域名对大陆 IP 固定 401。绑定自定义域名是官方指定解法，且该区域**无需备案**。
3. **平台 `request.body` 不是 WHATWG ReadableStream**（没有 `getReader`），而 worker 用流式读取 → 必须归一化（`backend/edgeone-request.mjs`）。
4. **DashScope 单次最多 10 条输入**，超过直接 400 `batch size is invalid` → 客户端分块（`NMG_EMBED_BATCH_SIZE`）。
5. **跨区 + 跨境会有偶发连接失败**：香港函数 → 内地 DashScope 的 socket 会被重置，表现为 `/add` 随机 503 `embedding_network_error`。已在 `src/core/openai-embedding.ts` 里对网络错误/429/5xx 做 3 次退避重试；重试后连续 6 次 Add 全绿。
6. **CAA 记录**：Cloudflare 导入的 17 条 CAA 里包含 `letsencrypt.org`，续期没问题；曾误判为只有 `swisssign.com`。

实测延迟（从境外出口测，仅供参考）：`/health` 2–3.5 s，`/add` 10–25 s，`/search` 1–25 s，幂等重放 ~1 s，3 并发 Add 会因为单实例串行 + CAS 重试累加到 55 s。**没有超 120 s 上限，但偏慢**；最大的两个开销是「跨境 COS 往返」和「每请求冷启动」。若要提速，唯一划算的一步是把 COS 桶迁到 `ap-hongkong`（与函数同区），需要主账号建桶——子账号没有 `cos:PutBucket`（403），这是有意的限额。

## 15. 性能收敛（地域 + 并发）

上线后发现延迟远超预期，逐层定位并修复。**关键教训：`edgeone.json` 里的 `cloudFunctions.regions` 对已存在的项目不生效**，函数实际一直跑在 `ap-singapore`，而桶在香港/广州——每次都付跨境代价。地域必须在控制台按项目设置，且**下一次部署才生效**。

为此给入口加了 `x-nmg-region` 响应头（读 `context.server.region`），让"函数到底在哪"变成可观测事实而不是假设。

四项改动：

1. **函数地域 → `ap-hongkong`**（控制台，项目 `makers-pkhgtimnhjor`）
2. **COS 桶 → `nmg-hk-1305793566`（`ap-hongkong`）**，与函数同区
3. **CAS 写入重试 4 → 12 次 + 抖动**（`NMG_WRITE_ATTEMPTS`，`mutateUser`）。并发 16 时 4 次不够，冲突方会拿到假 503
4. 早前的 **embedding 网络错误重试 3 次**（`src/core/openai-embedding.ts`）

效果（同一批请求，实测）：

| 操作 | 优化前 | 优化后 |
|---|---|---|
| `/health` | 2–3.5 s | <0.2 s |
| `/add` 1 条 | 7.4–10 s | 1.2–3.1 s |
| `/add` 18 条（LoCoMo session） | 12.8 s（广州桶时 23.6 s） | **2.4 s** |
| `/search` | 2.8–11.3 s | **0.8 s** |
| **16 并发 `/add`** | 估算 >190 s（必超时） | **14.5 s，16/16 成功** |
| **16 并发 `/search`** | — | **6.7 s，16/16 成功** |

结论：评测方默认的 16 并发现在可以直接跑，不需要限流。回归：`npm run test:backend` 全绿（重试次数改动不影响 R2 路径）。
