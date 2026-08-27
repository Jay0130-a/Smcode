# Changelog

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本遵循
[Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2025-08-27

### Added

- **CI 流水线**（`.github/workflows/ci.yml`）：push / PR 自动执行类型检查
  （`tsc --noEmit`）、ESLint、全部测试与覆盖率统计，Node 20 / 22 双版本矩阵验证。
- **测试覆盖率**：新增 `npm run test:coverage`（Node 原生 v8 coverage，零新增依赖），
  在 CI 中随每次提交生成覆盖率报告。
- **CHANGELOG 与语义化版本规范**：建立 Keep a Changelog 格式的变更记录，
  从 `0.1.0` 升版到 `0.2.0`。

### Fixed

- **ESLint 配置修复**：`.mjs` 测试脚本（`run-tests.mjs` / `smoke-kb.mjs`）此前未声明
  Node 全局变量，导致 `npm run lint` 报 20 个 `no-undef` 错误；现已为 `.mjs` 文件
  补充 globals 配置，并移除 `smoke-kb.mjs` 中未使用的变量。

[0.2.0]: https://github.com/<owner>/<repo>/compare/v0.1.0...v0.2.0
