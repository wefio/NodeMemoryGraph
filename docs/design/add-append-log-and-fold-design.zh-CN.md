# Add 写不可变日志条目，之后再折叠进分区

**Status:** draft
**Created:** 2026-10-28

## 问题

`Add` 现在是对整个用户分区的"读-改-写"，并由每用户的 manifest CAS 串行化。每一次尝试
都要付出：读 manifest、下载分区、导出 SQLite、上传分区、条件写 manifest。同一用户的并发
Add 会在 CAS 上排队：16 路并发就是 16 轮，而每轮搬动的是兆字节。

在已部署服务（`ap-hongkong`）上实测：同一用户 16 并发、每次 8 条消息：

| 指标                       | 数值                           |
| -------------------------- | ------------------------------ |
| 成功率                     | 16/16，零失败                  |
| p50                        | 17.7 s                         |
| p95                        | 27.1 s                         |
| 探针分区快照               | 3.0–3.9 MB                     |
| 一次 8 条消息 Add 改动的页 | 8 KiB × 72–86 页（576–688 KB） |

评测方从另一侧看到的是同一形状：`/add` 从 36 s 升到 95 s、最后 120 s 平台超时，而
`/health`、`/search` 一直是毫秒级。增量页写已经实测过并被否决：一次 8 条消息的 Add 改
72–86 页，而预算是 32 页（`PART_DELTA_LIMIT` = 256 KiB），13 次里 0 次命中；且 overlay
是内联在**所有写者都在争用**的那个 manifest 里的。

有两条建议不适用于我们的部署形态，是核实过的而非假设：这里跑的是 EdgeOne **云函数**
（`Nodejs20.19`，没有边缘中间件阶段）；服务里**没有任何数据库或队列客户端**，存储只有
COS over HTTPS（无 VPC、无 TCP）。运行时也不提供 `waitUntil`，所以"先返回、后台再写"
无法做到持久化保证。

## 目标

让"受理"变便宜，且与突发规模无关，同时不削弱 `Add` 已经承诺过的东西。

契约要求：返回 200 就意味着数据已持久化，且同一用户后续 `Search` 能检索到；`request_id`
在重试下幂等。因此目标不是"异步写"，而是**持久受理 + 延迟压实**：受理只需一次不可变的
HTTPS 写，之后有界折叠，读路径能看见尚未折叠的内容。

非目标：不改 embedding、排序、payload 上限、存储引擎；不引入任何托管服务；不放宽幂等与
持久化契约。

## 设计

### 1. 日志条目

`users/<key>/log/<received_ms 定长>-<request_hash>.json`，用
`x-cos-forbid-overwrite` 写入，让名字本身就是幂等键，且已存在的对象不能被覆盖：

```
{ v: 1, generation, user_id, session_id, request_id, request_hash,
  fingerprint, received_at, messages: [{ role, content, indexText? }] }
```

名字按字典序即到达顺序，折叠依赖这一点。结构化（图片）内容的 `indexText` 必须在 PUT 之前
准备好——那一步是 CPU、可能还是视觉模型调用，仍留在请求路径上。

### 2. 受理

校验 → 在日志里找 `<seq>-<request_hash>`（重放返回已存响应；fingerprint 不同则
`409 request_id_reused`）→ 准备消息 → PUT 条目 → 200，回显与今天一致，外加 `task_id` 与
`status: "complete"`。

`complete` 描述的是**持久化**而非压实：PUT 之后条目已持久化，并通过日志感知的读路径立刻
可读。如果评测方对 `/add/status/<task_id>` 的语义理解更严格，那就属于下面的未决问题。

### 3. 读路径

`Search` 合并两个来源：它本来就要做的分区检索，以及该用户的 pending 日志条目（按条目数与
字节数双重有界，`PENDING_READ_LIMIT`）。pending 条目用与分区记录相同的方式打分，并用既有的
"按身份取最高分"规则融合，因此 pending 记录既不会与已折叠的重复（身份相同），也不会凭空
压过它。

### 4. 折叠

在一次受理之后——或在请求开始时发现 pending 已超阈值——把**最多 `MERGE_BATCH` 条**在一个
分区写里折叠：按名字顺序读条目，在一个 SQLite 会话里依次应用，把它们的回执写进 manifest，
原子提交分区与 manifest，然后批量删除已折叠的条目。

一次折叠只付一次分区往返，与吸收多少条无关，这正是关键：16 路突发只需要两次折叠，而不是
十六次分区重写。工作量按条数与字节数双重封顶，避免单条超大条目把折叠拖成无界。

### 5. 幂等与回执

pending 期间条目的名字就是幂等键；折叠之后由分区里的回执接替。折叠会跳过回执已存在的条目，
因此"已提交但删除前崩溃"是无害的。删除永远发生在提交之后，绝不提前。

### 6. 配额

`USER_LIMIT`（1 GiB）与 `MAX_RECEIPTS`（16 384）按分区 + pending 合计计算。`/capacity`
分别上报两者。当 pending 将超过 `PENDING_BYTES_LIMIT` 时，`Add` 改为**执行折叠**而不是
继续受理，日志因此不会无界增长；调用方看到的是"慢一点但成功"，不是被拒绝。

### 7. 存储格式

manifest 增加 `pending`（计数）与 `format: "nmg-shards-v4"`。`loadManifest` 已经会拒绝
未知格式，因此旧部署会**明确失败**而不是静默忽略 pending 数据——这是正确的失败方式，但也
意味着回滚前必须先把日志排空。

### 8. Reset

`Reset` 提升 generation 并删除日志前缀。条目携带写入时的 generation，且 `mutateUser` 现有
的 `user_reset` 守卫保留，因此与 reset 竞争的折叠无法复活旧数据。

### 9. 可观测

`/health limits` 上报 `add_mode`、`pending_read_limit`、`merge_batch`；`/capacity` 上报
`pending_entries`、`pending_bytes`、`folded_total`。`Add` 响应增加分阶段耗时
（`accept`、`fold`），让下一个延迟问题能从响应回答，而不是翻日志。

## 冻结接口（切片 1）

以下内容在并行开工前固定，避免三个写者对"接缝"的理解不一致。改这里属于设计变更，不是
实现细节。

### 日志条目

```
name:    users/<userKey>/log/<received_ms 定长 13 位>-<request_hash>.json
         用 x-cos-forbid-overwrite 写入；名字即幂等键
body:    { v: 1, generation, user_id, session_id, request_id, request_hash,
           fingerprint, received_at, messages: [{ role, content, indexText? }] }
```

`userKey` 是 `keyFor(userId)`，`request_hash` 是现有的 `hash(requestId)`，
`fingerprint` 是现有的 `hash(JSON.stringify({ sessionId, messages }))`。
`messages[].content` 与 `indexText` 按 **为 `rememberBatch` 准备好的同一份**存储，
这样折叠后记录的 statement 与 pending 记录打分用的文本完全一致。

### `onlion/backend/append-log.mjs`（新文件；只接收注入的 bucket）

```js
export const LOG_ENTRY_VERSION = 1;   // 必须等于条目里的 `v`
export const MAX_PENDING_READ = 8;    // 每次检索最多打分的 pending 条数
export function logPrefix(userKey)                                   // "users/<k>/log/"
export function logEntryName(receivedAt, requestHash)                // 定长、可按字典序排序
export async function putLogEntry(bucket, userKey, entry)            // { name, created }
export async function readLogEntry(bucket, userKey, name)            // entry | null
export async function findLogEntry(bucket, userKey, requestHash)     // { name, entry } | null
export async function listPending(bucket, userKey, options)          // [{ name, entry }] 按到达顺序
export async function deleteLogEntries(bucket, userKey, names)       // 批量，幂等
export function foldPlan(entries, limits)                            // 纯函数：{ fold, keep }
```

`bucket` 就是现有的 COS 契约（`get`/`head`/`put`/`delete`/`list`）。本模块**不得**
import `worker.mjs`、`storage.mjs` 或 SQLite。

### `onlion/backend/storage.mjs` 增补

```js
export const STORAGE_FORMAT_V4 = "nmg-shards-v4";
export function manifestFormat(manifest)  // pending > 0 ? v4 : (存在 delta ? v3 : v2)
export function pendingCount(manifest)
export function withPending(manifest, count)
export async function clearLog(bucket, userKey)  // reset 路径；前缀必须等于 logPrefix()
```

`commitManifest` 写 `manifestFormat(manifest)`；`loadManifest` 接受 v4。只有
`pending > 0` 时格式才变成 v4——这正是"开关关闭时盘上字节不变"的保证所在。

`clearLog` 的前缀取自 `append-log.mjs`，不在本地重复声明字符串。两半并行开发期间刻意避免
这个运行时依赖，为的是任一半能单独跑起来；两者一起发布之后，"前缀不可能漂移"比"模块能
单独加载"更值钱。

### worker 接缝（单写者）

```js
const addMode = (env) => (env.NMG_ADD_MODE === "log" ? "log" : "sync");  // 实测前默认同步
async function acceptAdd(env, input)                       // 返回 200 响应体，日志条目已持久化
async function foldPending(env, userId, limits)            // { folded, remaining }
async function pendingForSearch(env, userId, limit)        // 临时记录，最多 MAX_PENDING_READ 条
```

`pendingForSearch` 返回与页面同形的条目（`id`/`content`/`score`/`stored_at`，`id` 前缀
`pending:`），这样现有的"按身份取最高分"融合逻辑无需改动即可复用。每条 pending 在检索时
消耗一次 embedding 调用，按 `MAX_PENDING_READ` 封顶。

## 不变量（每条都要变成测试）

- **I1** 返回 200 之后，同一用户后续 `Search` 必能检索到该数据，无论它仍在 pending 还是
  已折叠。
- **I2** 同一 `request_id` 的重试返回逐字节相同的响应；fingerprint 不同则 409。
- **I3** 折叠幂等：任何崩溃点之后重试都不会产生重复记忆，以回执存在性为守卫。
- **I4** 任何分区写不跨越 generation；reset 之前写入的内容不能在之后重新出现。
- **I5** 读路径不做折叠。折叠只发生在 `Add`（或显式维护路由）上，读延迟因此不继承写竞争。
- **I6** pending 读取按条目数与字节数有界，`Search` 开销不随日志规模线性增长。

## 失败矩阵

| 崩溃点                 | 状态                | 下一个请求                            |
| ---------------------- | ------------------- | ------------------------------------- |
| 日志 PUT 之前          | 什么都没写          | 重试正常受理                          |
| PUT 之后、响应丢失     | 条目已持久化        | 重试命中条目，返回相同回显            |
| 折叠提交前崩溃         | 条目完好            | 下次折叠重做（无回执）                |
| 折叠已提交、删除前崩溃 | 条目与回执同时存在  | 折叠跳过（I3），删除重试              |
| 两个折叠竞争           | manifest CAS 串行化 | 落败者重试，条目仍有效                |
| reset 与折叠竞争       | generation 已变更   | 折叠放弃；按现有行为 `user_reset` 409 |

## 迁移

无需回填：升级后第一次 `Add` 写一个日志条目，现存分区继续服务。`NMG_ADD_MODE=sync` 可恢复
今天的路径，且仍会读取与折叠 pending 条目，因此开关是可逆的、不丢数据。**代码**回滚则不同：
manifest 变成 v4 之后必须先排空 pending，这是有文档的操作步骤，不是自动降级。

## 工作量分解

| 部分                                      | 文件                                  | 净行数   |
| ----------------------------------------- | ------------------------------------- | -------- |
| 日志模块（条目形状、put/read/list、回执） | `onlion/backend/append-log.mjs`（新） | ~150     |
| 受理路径                                  | `onlion/backend/worker.mjs`           | ~70      |
| 读路径合并 pending                        | `worker.mjs`（+ 排序融合）            | ~70      |
| 折叠                                      | `worker.mjs`，复用 `addOneBatch`      | ~60      |
| 配额与健康面                              | `worker.mjs`                          | ~30      |
| manifest `pending`、格式 v4、日志清理     | `onlion/backend/storage.mjs`          | ~50      |
| 测试（不变量、故障注入、16 路突发）       | `onlion/scripts/test-backend.mjs`     | ~250     |
| **合计**                                  |                                       | **~680** |

可分别验收的切片：

1. **管道，不改行为** —— manifest `pending`、格式 v4、日志模块、`/capacity` 字段；`Add`
   仍同步。
2. **受理 + 折叠 + 感知 pending 的读路径** —— 必须一起上，由 `NMG_ADD_MODE=log` 控制；
   用 16 路突发与同步路径对照验证。
3. **默认打开、决策记录、benchmark 说明。**

## 未决问题

1. **pending 条目在读时如何打分。** 每次检索为它们做 embedding 会多出最多
   `PENDING_READ_LIMIT` 次调用；只做词法打分便宜但更弱。两种都有界，但选择会改变 I1 在
   实践中的含义。
2. **`status: "complete"` 可以主张什么。** 服务已经返回 `task_id` 并提供
   `/add/status/<task_id>`。如果评测方把该端点当作"已处理"的证据而非"已持久化"，这个取值
   需要先对齐。
3. **结构化内容的 `indexText` 成本。** 若它调用视觉模型，它就是受理路径上的同步步骤，会
   给 Add 延迟设一个折叠无法消除的下限。

## 被否决的替代方案

- **发射后不管的后台写。** 运行时没有 `waitUntil`，后台任务不保证执行，200 有时就等于
  "丢了"。
- **`Add` 走增量/overlay 写。** 实测 13 次 0 次命中 32 页预算；抬高上限会让 manifest
  变得更大，而 manifest 是所有写者争用的对象。
- **加大重试预算或缩短退避。** 只是把 503 换成更长的等待，120 s 平台上限照样生效。
- **在检索路径上折叠。** 会把写竞争搬进读延迟，而读是当前唯一快的东西。
- **引入队列或数据库服务。** 这个运行时到不了它们，而且会给当前部署引入并不存在的依赖。
