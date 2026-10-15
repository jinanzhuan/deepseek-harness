---
kind: upgrade-guide
description: "workspace/create always registers a new Workspace, and Workspace views carry member-directory fields."
---

# Workspace multi-root and shared directories

English | [中文](guide.zh.md)

## Change

`workspace/create` (and `ctx.workspaceRegistry.create`) always registers a new Workspace, even when the directory already heads or belongs to another Workspace. Previously the call returned the existing registration with `created: false`; now `created` is always `true` and the id is fresh. Callers that used creation as a lookup must resolve first: `ctx.workspaceRegistry.resolvePrimaryByPath(path)` answers the primary owner, and `resolveByPath(path)` also matches member directories.

The `WorkspaceView` wire value gains two required fields: `paths` (every member directory, primary first) and `missingPaths` (members absent on disk at projection time). Two new Remote methods mutate membership: `workspace/addProject` refuses a duplicate member as `workspace/path-exists` and an unusable directory as `workspace/path-invalid`; `workspace/removeProject` refuses the primary path. The model-visible `workspace-write` policy text now lists the session workspace roots as a JSON array instead of a single root string.

## Migration

1. Replace create-as-lookup calls with an explicit `resolvePrimaryByPath` check followed by `create` only on a miss.
2. Read `paths[0]` wherever code assumed one directory per Workspace, and tolerate `missingPaths` members in UI lists.
3. Confirm the migration by registering the same directory twice through the UI: both registrations coexist, and adding an existing member reports that it is already in the workspace.
