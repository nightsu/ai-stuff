# Issue tracker: GitHub

本仓库的 issues 和 PRD 使用 GitHub Issues 管理。所有操作使用 `gh` CLI。

## 约定

- 创建：`gh issue create --title "..." --body "..."`
- 阅读：`gh issue view <number> --comments`
- 列出：使用 `gh issue list`，并根据状态和标签过滤
- 评论：`gh issue comment <number> --body "..."`
- 添加或移除标签：使用 `gh issue edit`
- 关闭：`gh issue close <number> --comment "..."`

在仓库内运行时，通过 `git remote -v` 推断 GitHub 仓库。

## Pull requests as a triage surface

**PRs as a request surface: no.**

PR 默认不进入 triage 队列。若以后需要，可将该值改为 `yes`。

## Skill conventions

- “publish to the issue tracker”：创建 GitHub issue。
- “fetch the relevant ticket”：运行 `gh issue view <number> --comments`。

## Wayfinding operations

`/wayfinder` 使用一个 GitHub issue 作为 map，子 issue 作为 decision tickets。

- Map：添加 `wayfinder:map` 标签。
- Child ticket：优先使用 GitHub sub-issue；不可用时，通过任务列表和 `Part of #<map>` 建立关系。
- 类型标签：`wayfinder:research`、`wayfinder:prototype`、`wayfinder:grilling`、`wayfinder:task`。
- Blocking：优先使用 GitHub 原生 issue dependencies；不可用时，在正文顶部使用 `Blocked by: #<n>`。
- Claim：`gh issue edit <n> --add-assignee @me`
- Resolve：写入结论、关闭 issue，并把上下文链接追加到 map 的 Decisions-so-far。
