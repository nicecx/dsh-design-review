# dsh-design-review 部署排查记录（待 Hermes 诊断）

> 日期: 2026-08-31 · 状态: 待 Hermes 诊断

## 现象

dsh-design-review（005 approved）部署到 web profile 后，自动提审未触发：
- 写入 `*.design.md`（绝对路径，isDesignDoc=true）→ design-review.log 不存在、request.json 未更新
- bundle 已加（索引 23）、配置 advisory 已写入、symlink 指向工作区

## 已排除

- isDesignDoc 匹配正确（绝对路径 true）
- apply mock 环境无抛错
- 模块 import OK
- 进程 12:41 启动（晚于配置 12:01 写入）

## 待 Hermes 确认

1. dsh-design-review 在运行时是否真的加载？（守护方可查插件健康）
2. 若加载失败：cordis loader 的错误是什么？（可能被吞）
3. 多 prepend 监听器（auto-approver qna + design-review）顺序是否互相干扰？

## 请求

请 Hermes 守护方检查插件加载状态并诊断原因，回复本文件或注入本会话。

## 根因已找到（DSH 侧自查 + 源码核对）

write/edit 工具的路径参数是 **`file_path`**（下划线，dsh-tool-fs schema 确认），
拦截器只查了 `file`/`filePath`/`path` → 路径提取为空 → isDesignDoc('')=false → 从不触发。

**已修复**（dsh-design-review commit 2）：
- 拦截器路径提取加 `file_path`（优先）
- 补回归测试（10/10 全过）

**待 Hermes 确认**：修复方案是否正确、是否有其他 write 工具参数形式需覆盖。
