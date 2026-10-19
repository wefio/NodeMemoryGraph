# 仓库术语索引

[English](2026-09-08-repository-terminology-index.md) · [使用的术语](2026-09-08-repository-terminology-index.terms.yaml)

**Status:** implemented  
**Approved:** explicit
**Relates to:** [分布式术语设计](../../design/documentation-governance.md)

## 问题

Agent 在本仓库里搜索、什么都没找到，于是断定该能力不存在，然后**再建一遍**。这个失败模式——**搜不到 → 当作没有 → 新增**——正是本仓库元规则要禁止的重复造物：一处一规则。三个发现说明它是活的。

**已有的两张术语表都没接在检索上。** 仓库有一份概念地图（`docs/guides/concept-map.md`，双语），给每个产品概念一个操作含义并链接到其 contract owner；`agent-context.yaml` 也带机器可读的 `capabilities[].aliases`（例如 `memory-runtime` → `memory-daemon, durable-memory`），重复别名会被 `tools/repo-context.ts` 拒绝。但概念地图只有人读，而 aliases 只在**一条路径**上被消费——显式的 `agent:context --capabilities <名字>` 查询——不在搜索上。**不存在"描述一个概念 → 找到它的家"这条路径。**

**概念地图不覆盖撞名真正发生的那批词。** 它列的是产品概念（HistoryRecord、STG、LTG、AG、QPP），不列仓库的流程词汇：contract、assertion、check、stage、kind、evidence、context、route、receipt、narrow、gate。2026-09-08 观察到的每一处撞名都在这批词里：三处各自声明"跑什么"（`agent-context.yaml` 的 route `verify.blocking`、`NARROW_SHARED_CHECKS`、`contract.verification.checks`）；`invariants` 被写进 `WorkOrder` 却无人读取；`assertions` 是在 `invariants` 还存在时被引入的。这个代价仓库已经付过一次：书签功能因为一个词背了四种含义（其中两种在同一个文件里），从 "anchors" 改名为 "tesserae"（`rejected/2026-09-02-keep-bookmarks-named-anchors`）。

**没有任何东西强制"先搜索"。** `docs/decisions/README.md` 写着"创建记录前先搜索已有的 owner"——这是重复提醒，不是机械检查。而仓库的元规则偏好机械检查。

## 决策

对主题拥有的定义保留一条机器可读的查询和校验路径，不建第三张手工全量词典。每个概念只有一个 owner 不要求只有一个物理文件。[治理设计](../../design/documentation-governance.zh-CN.md#yaml-文件与查询合同)拥有标识、发现范围和查询行为；创建时重复检测是独立未完成义务。

1. 就近的 v2 `*.terms.yaml` 文件拥有词义和规范英文词形。原十四个流程词条保留名称、别名、状态和合同目标迁入主题定义；手工 `docs/glossary.yaml` 索引退役。聚合直接读取定义，不再维护第二张目录。
2. v2 词条以规范词形为键，只有同名异义时才限定作用域，以 `owner`、`anchor` 另指完整行为合同；简明词义不重新定义合同，也不复制其中全部条件和例外。
3. 命令行 resolver 消费规范名称和精确别名；兼容读取既有 v2 ID。这是仓库术语查询，不是接入 NMG memory 检索。
4. `glossary:check` 对登记元数据错误、标识冲突、不可解析的合同位置和接替关系失败关闭；继续在窄化和 full 验证中阻塞。可信策略摘要固定是独立未完成项，工作树检查不证明它已生效。
5. 限定目录的查询报告实际语料；跨 namespace 命中保留候选，不任选 owner，也不由局部未命中推断全仓不存在。
6. 覆盖显式限定为登记定义，包含迁移的流程词汇；产品地图生成与创建时去重仍待完成。元数据一致不证明未登记概念不存在。
7. 解析器仍接受存在的 v1 索引，保留其原三列 CLI 输出。有分布式来源时允许旧文件缺席；空语料或存在但错误的来源仍失败。v2 词条保留三列首行，追加 namespace、状态、定义和来源；有既有可选 ID 时仍输出 ID 行，新词不需要 ID；namespace 属于主题，不再是 v1 的 `repository`。消费者不能把全部 stdout 当成一条 TSV。
8. 用户要求的英文、中文、使用术语三件套共用一个 YAML 文件。可选 `references` 列规范英文词形，不复制定义；只有歧义词才用 `{term, namespace}` 限定。纯引用或明确无专门术语的文件可使用空 `terms`。引用格式错误、重复或在选中语料内未解析时失败，不为此越过局部范围读取，也不登记第二份定义。整体词汇语料为空仍失败。旧校验器不保证接受新形态；既有 v1 和带 ID 的 v2 仍可读取，不为新词生成 ID。namespace 不必强制声明，真正需要区分词义时再使用。

2026-09-08 的初版使用 v1 指针索引。分布式推广保留查询词汇，在主题 owner 处补充词义。既有校验器发现来源、报告实际范围，并在查询前拒绝错误语料；YAML 复用现有解析器，不需要 Markdown 词义副本或术语平台。

检查继续在 `verify:static`、窄化共享检查、`documentation` route 与两份 authored contract 中阻塞。这些执行绑定不证明可信基线固定或创建时保护已经生效。

## 考虑过的替代方案

- **写一份新的术语表文档。** 否决：仓库已有两张表，第三张正是本决策要防止的重复。扩展已有的。
- **继续依赖 `docs/decisions/README.md` 的"先搜索"提醒。** 否决：提醒正是元规则要用机械检查替换掉的东西；而且搜索会因为词汇不同而落空，概念却存在。
- **全量扫描文档找未登记术语。** 作为不可靠方案否决：自然语言没有机械的词边界，全量扫描只会产生噪声并成为 Goodhart 目标。守卫改为在创建时触发。
- **把索引放进 NMG memory 而不是仓库。** 作为主家否决：memory 是历史的、会话范围的，而仓库词汇必须能在 PR 里被评审、离线可用。memory 仍可承载别名作为 recall trigger。
- **分开维护 Markdown 词义与 YAML 元数据。** 未选：YAML 词条让词义与标识一起处理，不维护镜像定义。用户后续要求的三件套包含共用术语使用清单；可明确无专门术语，不能为填满一组而制造定义。
- **每篇术语文件复制已有词义。** 否决：规范词形引用保留唯一词义 owner；代价是检查引用，以及在 owner 位于局部范围之外时扩大查询范围，而不是放宽限定读取合同。
- **给每个词另编稳定 ID。** 用户明确同意简化后否决：规范英文词形已可作为键，真正同名异义时用 namespace 消歧；额外 ID 增加一份人工映射。接受的代价是改规范词形时同步迁移引用和同作用域接替名称；别名保留查找能力，不让旧引用静默有效。旧 ID 只保留读取兼容。
- **迁移后继续手工维护 v1 全表。** 否决：owner 或别名变化会要求同步两份目录。退役成本是来源／namespace 迁移及 CLI 追加信息；名称到 owner 的守恒检查与 v1 兼容 fixture 覆盖声明边界。缺少全部来源仍失败关闭。
- **采用形式化本体或 SKOS。** 否决：对单人维护太重；需要的属性只有 canonical 名、别名、唯一 owner、状态。

## 验证

截至 2026-09-08 已验证：

- 存在一张机器可读术语表，每条都解析到存在的 owner 文件与标题。
- `glossary:check` 对不可解析的 owner、重复 canonical 术语、被两次认领或与另一术语同名的别名、无 successor 的 deprecated 术语失败关闭。
- `glossary:check` 在窄化与 full 两条路径上都是阻塞项。
- 检索能把术语或别名解析到其 owner（`glossary:check --resolve`）。

## 未完成项

- 将登记的 [YAML 定义](../../design/documentation-governance.zh-CN.md#yaml-文件与查询合同)扩展到活跃设计以外的目录，以及从正文提取引用仍待完成。聚合结果是查询视图，不另加手工全量词典。
- 产品概念仍留在[概念地图](../../guides/concept-map.zh-CN.md)，尚未全部登记到本 resolver。
- 概念地图不由登记定义生成，两者仍可能漂移。
- 规则摘要未钉在 `.rcp/trusted-policy.json`：`trusted-verify` 从**已安装基线**读策略，只写进工作树的 obligation 在下一次 `trust-install` 之前是没有效果的声明。
- 对新增概念/契约/决策的**创建时重复检测**未实现；今天只拒绝登记元数据语料内的冲突。

## 后果

- 表是维护成本，会腐烂；让它活着的是校验器，不是纪律。
- 索引**不能**证明没有遗漏，只能证明每条已登记的术语只有一个家。“没找到”绝不能被读成“不存在”。上面的“未完成项”正是这个边界的一部分：产品术语与新建概念目前还不在守卫范围内。
- 别名有助于发现，但不保证命中。未来的创建时守卫必须处理登记词汇外的概念；当前元数据校验器不是这个守卫。
- 把每个名词都登记进来会让索引变成噪声；条目应当是**有 owner、有契约的概念**，不是通用词汇。
- 阻塞式术语检查可能被"改名"而不是"解决撞名"绕过；`status` 字段必须记录 successor。
