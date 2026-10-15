---
kind: upgrade-guide
description: "workspace/create 总是登记新 Workspace，Workspace 视图新增成员目录字段。"
---

# Workspace 多根与目录共享

[English](guide.md) | 中文

## 变更

`workspace/create`（及 `ctx.workspaceRegistry.create`）总是登记新 Workspace，即使该目录已是其他 Workspace 的主目录或成员。此前该调用对已有登记返回 `created: false`；现在 `created` 恒为 `true` 且 id 全新。把创建当查找用的调用方必须先解析：`ctx.workspaceRegistry.resolvePrimaryByPath(path)` 回答主目录所属方，`resolveByPath(path)` 还会匹配成员目录。

`WorkspaceView` 线路值新增两个必填字段：`paths`（全部成员目录，主目录在前）与 `missingPaths`（投影时磁盘上不存在的成员）。两个新 Remote 方法变更成员关系：`workspace/addProject` 以 `workspace/path-exists` 拒绝重复成员、以 `workspace/path-invalid` 拒绝不可用目录；`workspace/removeProject` 拒绝主目录。模型可见的 `workspace-write` 策略文本从单个根字符串改为列出会话工作区根的 JSON 数组。

## 迁移

1. 把"创建即查找"的调用替换为显式的 `resolvePrimaryByPath` 检查，未命中才 `create`。
2. 原先假设一个 Workspace 只有一个目录的代码改读 `paths[0]`，UI 列表容忍 `missingPaths` 成员。
3. 通过 UI 对同一目录登记两次来确认迁移生效：两份登记共存，重复添加成员会提示已在工作区中。
