# 范围级阶段协商

[English](phase-agreement.md) · [使用的术语](phase-agreement.terms.yaml)

**Status:** current

事件可携带可选的 `collaboration` 声明，与开启／结束生命周期独立。
缺失表示尚未声明阶段，不代表隐式执行许可。声明包含 `phase`（`discussion`、
`execution` 或首次切换前的 null）、`phaseRevision` 及待确认提案或 null。
只有提交切换才推进 `phaseRevision`，普通事件更新保留它。
全部修改仍要求当前事件 `expectedRevision` 与事件参与者权限；父子事件阶段不自动传播。

阶段变更沿用 `eventUpdate`，携带 `expectedPhaseRevision`、`proposalId` 和 `text`。
`phasePropose` 另提供 `target` 与可选 `requiredApprovers`。
默认确认集合是当前参与者；显式集合依协作约定声明受影响参与者。
提议者始终包含在内，提出提案即记录自身同意；其他指定确认人须是事件记录中的参与者。
这项声明不独立证明受影响集合完整，也不授予资源权限。

`phaseAgree` 记录指定确认人对该提案的确认。确认齐备后，具有事件修改权限的参与者可以
`phaseSwitch`。仅提议者可以 `phaseWithdraw`，替换前先撤回。
同一事件保留的历史中不允许复用提案 ID，避免旧确认误附到替代提案。
阶段操作要求事件处于开启状态；关闭和重开保留阶段声明及待处理提案，不自动切换。

首次提案使用阶段修订零。读取更新后的事件可获得后续操作所需的两个修订号。
历史与订阅通知沿用现有事务发布路径；事件目录和详情通过 InformationView 披露阶段、
版本与待确认提案。更广的[阶段草案](collaboration-phase.zh-CN.md)
保留活动目的、许可与在途操作的可调整设计。

这是协作状态，不是工具强制约束。执行阶段不授予执行许可；切换不会取消、等待或隔离正在运行的工具，
这些边界由宿主负责。讨论候选和执行请求可以使用普通黑板消息，不自动转成阶段提案。
