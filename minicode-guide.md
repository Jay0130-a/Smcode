# MiniCode 新功能使用指南

## 长期记忆（memory）

在 `~/.mini-code/settings.json` 中设置 `"memory": { "enabled": true }` 开启。
- 对话结束后自动抽取重要信息（任务、文件变更、错误教训）写入长期记忆库。
- 新对话开始时用 BM25+向量混合检索召回相关记忆，注入上下文。
- 记忆分 `session`（项目级）和 `global`（跨项目）两种范围。
- 生命周期：记忆 30 天未访问降为 dormant（不再注入），90 天归档，180 天过期清理。

## 知识库（knowledge base）

把本地文件夹文档作为知识库源，启动时自动导入：
`"memory": { "enabled": true, "knowledgeBase": { "dirs": ["docs"] } }`
支持 .md/.txt/.rst 等格式，自动切片（按标题/段落/重叠窗口）后向量化。
也可用命令 `minicode kb import <dir> --name <name>` 手动导入。

## Trace 追踪

设置 `"trace": { "enabled": true }` 后，每轮对话会记录完整执行链路
（用户输入、LLM 请求、工具调用、压缩行为、token 统计、耗时），
输出到 `~/.mini-code/traces/<项目名>/traces.jsonl`。
在 TUI 中用 `/trace` 查看最近 trace 摘要。

## LLM-as-Judge 评测

设置 `"judge": { "enabled": true }` 后，在 TUI 中输入 `/evaluate`，
用大模型按 rubric 多维度（正确性/完整性/工具使用/清晰度）给最近一轮打分，
输出结构化分数与理由，报告保存到 `~/.mini-code/reports/`。
