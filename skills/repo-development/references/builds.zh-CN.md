# 构建与生成产物

[English](builds.md) · [使用的术语](builds.terms.yaml)

每个 clone 只需配置一次格式化 hook：`git config core.hooksPath .githooks`。Pre-commit hook 会对 staged `.ts` 文件运行 Prettier。

可重新生成的输出**不**纳入版本控制（见被否决的决策[将构建产物纳入版本控制](../../../docs/decisions/rejected/2026-09-02-track-build-artifacts-in-git.zh-CN.md)）：

- `dist/`（根目录 tsc 构建产物）、`dsh/dsh-nmg/lib/`（tsdown 产物）和 `src/prompts/nmg-prompts.generated.ts`（由 `nmg-prompts.yaml` 生成）都被 gitignore；只有从不 `git add` 这些文件，树才能保持干净。
- 修改会影响生成输出的 `src/` 文件时，应通过重新生成来验证，而不是提交生成产物。

本地按以下顺序重现：

1. 根 package：运行 `npm ci`（添加依赖时运行 `npm install`），然后运行 `npm run build`——重新生成 `src/prompts/nmg-prompts.generated.ts` 和 `dist/`。
2. 有自己 lockfile 的子 package（当前为使用 pnpm 的 `dsh/dsh-nmg`）：运行 `cd dsh/dsh-nmg && pnpm install --frozen-lockfile && pnpm run build`——重新生成 `lib/`。`npm run verify:packages` 会自动使用 frozen lockfile 运行每个子 package。
   启动链接的 DSH web profile 前，还要遵循 adapter 的[启动前置条件](../../../dsh/dsh-nmg/README.md#启动前构建)。
3. 如果根 `package-lock.json` 与 `package.json` 不一致，`npm run check:lock` 会失败；使用 `npm install --package-lock-only` 修复。

子 package 的 `src/`、`package.json` 或 lockfile 发生变化时，`npm run agent:verify` 会通过 `verify:static` → `verify:packages`/`check:lock` 覆盖这些内容。