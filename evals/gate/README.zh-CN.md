# 自动召回门禁探针

[English](README.md) | [简体中文](README.zh-CN.md) · [术语](README.terms.yaml)

运行：

```powershell
npm run eval:gate
```

这个确定性、无 LLM 的探针测量英文、中文、德文、法文、日文与西班牙文中显式召回意图的假正例与假负例。它有意小规模且有策展：用它暴露语言覆盖缺口并防止回退，而不是声称生产流行度，也不是把额外正则当作学习策略去调参。
