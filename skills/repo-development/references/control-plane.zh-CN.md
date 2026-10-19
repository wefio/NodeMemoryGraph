# agent:verify 之外的 Repository Control Plane

[English](control-plane.md) · [使用的术语](control-plane.terms.yaml)

`npm run agent:verify` 会自动发现唯一覆盖当前 scope 的 contract，并执行等价的 reconcile——普通改动默认走这条路径（见 [`ci-cd-and-quality.md` §7.11](../../../docs/design/ci-cd-and-quality.zh-CN.md)）。只有以下 `agent:verify` 未覆盖的场景才使用独立的 `nmg-rcp` CLI（先给 contract path）：

- **不打开浏览器检查 CI 状态：** `nmg-rcp forge-status --pr <n>` 会读取 forge 的 status-check 汇总（`checks[]`，包含 name/conclusion）。在声称“检查通过”或判断 PR 可合并之前使用。
- **运行 reconcile 前检查它将执行的操作：** `nmg-rcp plan <contract>`；contract 本身已改变时使用 `nmg-rcp compile <contract>`。
- **检查验证证据：** `nmg-rcp receipt-list` / `nmg-rcp receipt-verify <receipt>` / `nmg-rcp receipt-scan`——receipts 位于 `.rcp/receipts/`，并且只追加写入。
- **在 reconcile 失败后重试，或显式运行 workspace-ready 检查：** `nmg-rcp reconcile <contract> --apply --workspace-ready [--recover-attempt]`。
- **通过 forge provider 绑定 PR 或创建 draft PR：** `nmg-rcp forge-bind <contract> --pr <n>` / `nmg-rcp forge-create <contract> --base main --head <branch>`。

`--apply` 从不默认启用；除非显式指定 `--apply`，reconcile 只生成计划。Contract 状态或验证与设计文档不一致时，应在同次改动中更新 owning document（Skill entry 或本文、[`ci-cd-and-quality.md`](../../../docs/design/ci-cd-and-quality.zh-CN.md)、[RCP decision](../../../docs/decisions/implemented/2026-08-29-repository-control-plane.zh-CN.md)）。改进了工具却不更新文档，Agent 就不会使用它。

**默认不要递归扫描超大目录。** 这是 Agent 对搜索、inventory、大小估算和仓库观察的操作规则——不是声称运行时会按大小拒绝请求。除非任务明确要求，否则避开已知的大型数据集、benchmark、virtual environment 和生成目录。从命名文件或窄路径开始；不要为了估算某目录是否很大就遍历整个目录。确实需要扫描大树时，先取得针对路径的明确授权，并将扫描限制在授权范围内。宽泛 wildcard 不能替代授权。

对 RCP，应先选择窄的 contract include，再进行观察。目录 pruning 只能避开 include 无法到达的子树，不是大小保护；宽泛 pattern 仍可能触及大树。绝不要为了降低成本而静默省略 scope 内文件，因为这会改变 observation/digest 语义。运行时观察行为由 [RCP truth domains](../../../docs/design/ci-cd-and-quality/repository-control-plane.zh-CN.md) 拥有。