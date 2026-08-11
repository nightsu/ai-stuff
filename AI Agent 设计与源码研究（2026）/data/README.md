# 社区快照数据说明

[community-snapshot-2026-07-31.csv](community-snapshot-2026-07-31.csv) 是 [01-candidate-pool.md](../01-candidate-pool.md) 已有表格的可机读转录，不是重新抓取结果，也不能用于证明这些历史值可复放。

- `snapshot_date=2026-07-31`：只记录原文给出的日期。
- `captured_at_unknown=true`：原研究没有保留日内抓取时间；不得补造时间戳。
- `raw_payload_retained=false`：原始 GitHub API 响应没有随研究包保存，因此无法在本包内重放历史查询。
- `has_discussions`：GitHub 仓库是否启用 Discussions 的布尔字段；不是 discussion 数量。
- `discussions_count=N/A`：原研究没有保存讨论数量，不能由 `has_discussions` 推断。
- `contributors=N/A`：第二张候选表没有记录 contributors，不做跨表补值或猜测。
- `source_url`：只记录 repository endpoint。该 endpoint 不返回 contributors 总数，也不返回本文人工整理的 latest release 字段；因此不能把同一行所有字段都归因于 `source_url`。
- repository 基础字段（stars、forks、`open_issues_count`、`has_discussions`、`pushed_at`、license）的 endpoint pattern：`https://api.github.com/repos/{owner}/{repo}`。
- contributors 的 endpoint pattern：`https://api.github.com/repos/{owner}/{repo}/contributors?per_page=100&page={n}`；原表称其通过分页近似，但分页响应未留存，历史数值不可复放。
- latest release 的 endpoint pattern：`https://api.github.com/repos/{owner}/{repo}/releases/latest`；原表中的 release 文本只是不可复放的表格转录，且 `N/A` 不应解释为仓库历史上一定没有 release。
- CSV 的 `provenance` 明确标记 `unreplayable_table_transcription` 及 repository endpoint 的字段覆盖限制；它不是历史可验证性声明。

这些限制不妨碍把 CSV 用作“文档在该日期记录了什么”的审计材料，但它不能替代带响应体和抓取时间的原始数据归档。
