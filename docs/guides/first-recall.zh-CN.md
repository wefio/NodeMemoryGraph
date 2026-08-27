# 第一次回忆教程

[English](first-recall.md) · [概念地图](concept-map.zh-CN.md)

这个可执行演练展示 NMG 最小但完整的记忆闭环：

```text
remember -> 紧凑搜索目录 -> 精确 get
```

它会创建私有临时 SQLite 数据库，不启动 daemon，不调用 LLM 或 embedding provider，并在退出时删除临时库。它不会读写用户正常的 `~/.nmg` 记忆。

## 运行

在仓库根目录中，确保已经安装 Node.js 22.19 或更新版本及项目依赖，然后执行：

```powershell
npm run tutorial:first-recall
```

交互式终端会在四个步骤之间暂停；CI 或非交互环境会直接运行到底。测试使用的非交互形式是：

```powershell
npm run tutorial:first-recall -- --non-interactive
```

## 四个步骤分别证明什么

1. **Status** 指向一个空临时库，但不会为了查看状态而创建它。
2. **Remember** 把一条有作用域的偏好保存到稳定语义节点下。
3. **Search** 只返回紧凑候选目录和一个 `activeGraphId`。
4. **Get** 把该 graph ID 传回 NMG，并加载刚才保存的精确陈述。

最重要的是第 3、4 步之间的边界。目录信息便宜、允许有损，只负责帮助 Agent 决定回忆什么；精确 `get` 才是证据披露步骤，并会记录是哪次检索投影暴露了这条证据。

教程打印的都是普通 CLI 命令。当前参数契约由 CLI help 负责：

```powershell
npm run cli -- remember --help
npm run cli -- search --help
npm run cli -- get --help
```

## 为什么教程不会悄悄过时

演练直接调用产品使用的同一个 `runCli` 入口，并由 `tests/scripts/tutorial-first-recall.test.ts` 覆盖。测试会检查公开 npm 命令、Active Graph 传递、精确证据和临时数据清理。因此破坏性的 CLI 变化会让产品测试失败，而不是留下看似合理但已经失效的示例。

本页刻意不复制完整 CLI schema 或设计状态。CLI help 拥有语法，[概念地图](concept-map.zh-CN.md)拥有导航，[规范设计](../design/design.md)拥有架构。
