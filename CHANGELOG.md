# 更新日志

## [Unreleased]

## [1.0.8] - 2026-08-17

- Replace body-concatenating Wiki merges with a typed dual-mode draft contract.
  Fully visible existing pages use hash-guarded complete `replace` patches;
  truncated pages use `merge` patches containing only bounded
  `upsert_section` changes applied to the authoritative server-side page.
- Expose editable and protected section headings in truncated Drafter context,
  and reject edits to partially visible sections, conflicting parent/child
  upserts, duplicate headings, Core-owned sections, and legacy merge bodies.
- Validate the fully prepared page against workspace size limits before an
  atomic commit, preserving unseen content without duplicate H1 or section
  growth.
- Add an audited `force_commit` escape hatch for rewritten analyses after a
  `source-ref-grounding-v1` rejection. Only that semantic gate can be bypassed;
  shape, Domain Schema, SourceRef, size, lease, and task-state checks remain
  mandatory.

## [1.0.7] - 2026-08-12

- Make Finalize the first final-reconciliation action after incremental catch-up.
  Core now promotes existing provisional pages without another LLM rewrite only
  after auditing batch projection, unique requirement coverage, contradictions
  and review items, task-owned page hashes, and exact SourceRefs. Failed audits
  persist their reasons and route status to the semantic final projection.
- Add `llm_wiki_query_domain_pages` for exact, workspace-level Domain Schema
  metadata queries. It can inspect a page's Schema snapshot and Domain → ABE →
  BE classifications, or paginate pages matching schema and hierarchy filters
  without returning bulk page bodies.

## [1.0.6-1] - 2026-08-12

- Normalize the repository and internal workspace dependencies to the valid
  npm SemVer version `1.0.6-1`, preventing npm from attempting to download the
  private `@llm-wiki/core` workspace package from the configured registry.

- Make a completed `draft-shard` context explicitly require
  `llm_wiki_stage_page_drafts`; direct PagePatch commit is now exposed only as
  the explicit serial Writer fallback action.
- Separate context retrieval from staging readiness with
  `context_retrieval_complete`, `retrieved_not_staged_draft_shards`, and
  `staged_uncommitted_draft_shards`; `commit_ready` is false for an unstaged
  Drafter context.
- Persist hash-bound staged receipts in projection state and recover older or
  response-lost receipts from task-scoped draft files. `status` now routes the
  stable Writer to those receipts before launching replacement Drafters.
- Require coordinators and Drafters to treat only server-returned
  `accepted=true`, `staged=true`, a non-empty `draft_hash`, and a positive
  `patch_count` as staging success.
- Add Core, MCP STDIO, and prompt-contract regression coverage for the complete
  retrieved → staged → committed state transition.

## [1.0.5.2] - 2026-08-10

- Add a complete project-level `.cac/` integration that mirrors `.claude/`
  settings, Agents, and Skill entrypoint with CAC-specific names and
  `CAC_PROJECT_DIR`, while sharing the same `.mcp.json` HTTP daemon.
- Add a parity contract test so future Claude integration changes cannot ship
  without the corresponding CAC configuration update.
- Run the Claude Code `SessionStart` hook in cross-platform exec form so native
  Windows does not depend on Git Bash or PowerShell command parsing.
- Hide the detached supervisor and worker consoles on Windows, preventing an
  empty `node.exe` window from remaining open during Claude sessions.
- Wait for the supervisor process to spawn before polling MCP health, so startup
  failures are reported deterministically instead of appearing as a silent
  connection failure.

## [1.0.5.1] - 2026-08-10

- Migrate the Claude Code project registration from non-reconnecting STDIO to
  a loopback Streamable HTTP endpoint, while retaining STDIO for Codex and
  OpenCode compatibility.
- Add a portable `SessionStart` launcher and project-local supervisor. Every
  clone/device starts its own daemon; a crashed worker restarts with bounded
  exponential backoff and Claude Code performs native HTTP reconnection.
- Send ten-second HTTP/SSE keep-alive frames, keep a bounded SSE replay window,
  send one-minute protocol pings, and retry only transient `MCP_BUSY`,
  `TASK_BUSY`, and `WORKSPACE_LOCKED`
  results up to three times.
- Add an end-to-end regression that verifies an idle HTTP session, worker PID
  replacement, and a fresh 17-tool MCP session after restart.

## [V1.0.5] - 2026-08-10

- Remove the fixed-object Domain Schema protocol, inline Schema input,
  automatic batch selection, search/catalog/types pagination, destructive
  drop-invalid commits, and fixed-object Wiki metadata.
- Require `progressive-directory-v2` directories and Domain → ABE → BE
  disclosure for every configured Domain Schema.
- Return canonical classification scaffolds and BE pointer hints, accept both
  JSON Pointer and URI-fragment syntax, and derive non-empty Wiki BE metadata
  from the selected Schema node.
- Refill completed extractor invocations immediately with the same worker ID
  while extraction remains; recoverable validation stops no longer wait for a
  lease timeout.

## [V1.0.4] - 2026-08-10

- Add progressive directory Schema V2 with immutable snapshots and Domain → ABE → BE disclosure.
- Expose complete ABE JSON files to extraction Agents while allowing unrestricted JSON field layouts.
- Persist and render `schemaClassification` paths in Wiki pages, frontmatter, and retrieval content.
- Raise the progressive per-file guard from 80 KiB to 5 MiB so complete ABE JSON files are not rejected before disclosure.
- Unify every orchestration prompt on the latest role contract: the coordinator launches Drafters, a Drafter stages one shard, and the Writer starts only after receipts exist to commit them. The Writer never launches Drafters or fetches shard context in normal mode.

## [V1.0.3] - 2026-08-07

### 增量 Wiki 更新

- 新增 `llm_wiki_update_pages` MCP 工具，用于已完成 Wiki 的页面级增量维护，无需重新开启语义 Writer 投影。
- 工具采用 `inspect → apply` 两阶段协议：先返回当前 `wiki_revision`、目标文件 hash、页面或指定章节内容及章节清单，再使用这些乐观并发凭据提交更新。
- 支持 `upsert_section`、`replace_section`、`append_to_section` 和 `remove_section` 四种 Markdown 章节操作；同一次调用最多原子更新 20 个页面。
- 成功更新后自动重建 BM25、vector、embedding、graph 与 lint 工件，并通过 `current-generation.json` 原子发布新 generation。

### 安全性与可靠性

- 仅允许修改已经存在的 Agent 可写页面；拒绝路径穿越、符号链接、重复页面、重复章节、歧义章节和陈旧文件 hash。
- 新增或替换内容必须提交当前任务中的精确 SourceRef；既有页面 SourceRef 会从已发布索引中保留并合并。
- Related 与 Domain Classification 等 Core 管理章节禁止直接修改，仍由确定性投影维护。
- 更新复用页面事务 journal、任务级幂等 WAL、SourceRef 校验和稳定 generation 发布流程；精确重放不会重复写入。

### 版本与验证

- 根包、Core、MCP Server 和 CLI 版本统一升级至 `1.0.3`。
- MCP 工具总数增加至 17；新增章节解析、代码围栏隔离、增量更新、冲突拒绝、幂等重放和 generation 发布测试。
- 验证通过：Core 59 项、MCP Server 17 项、CLI 1 项测试。

## [V1.0.2] - 2026-08-07

### Bug 修复

- 修复 MCP 超大结果在 `next_action` 或错误详情过大时递归序列化导致 OOM 的问题；超限响应现在使用固定大小的恢复提示。
- 修复附件 `display_name` 伪造扩展名导致 HTML/Markdown 解析器选错的问题；以实际物理文件扩展名为准。
- 修复长 Markdown 块切片后所有 chunk 共用同一 locator 的问题；分片现在保留准确、单调的 UTF-16 偏移范围。
- 修复代码块、引用、frontmatter、inline code 和 HTML `pre/code` 中的示例链接污染 Related、Graph 和 lint 的问题。
- 明确 PagePatch 的 `replace`/`merge` 契约：`replace` 完整替换正文，`merge` 显式保留已有正文；补充页面关系和最终投影回归测试。
- 修复 Schema 类型短词误匹配长单词、CJK 重叠别名和同一文本多处 CJK 匹配的边界问题。

### 可靠性与恢复

- 页面事务升级为可恢复 journal 状态机：在 rename 前持久化 intent，记录目标旧/新 hash，并在启动时安全完成、回滚或报告 `RECOVERY_REQUIRED`。
- 幂等操作改为 `PENDING → COMMITTED/FAILED` WAL；副作用响应先写入 durable sidecar，重启后支持精确 replay，无法证明安全时 fail-closed。
- Finalize 引入 generation 发布协议：页面快照、BM25、vector、embedding、graph、lint 和 result 绑定同一 `wikiRevision`，通过 `current-generation.json` 原子切换。
- 增加 embedding 缓存 TTL/LRU、文件数和字节预算；终态 journal 的 backup/staging 按保留策略清理，恢复中的证据不会被 GC 删除。
- Embedding 响应取消非 streaming `response.text()` 回退，所有响应均在读取过程中执行字节上限。

### 依赖与验证

- 升级 `pdfjs-dist` 至 `6.2.108`，禁用 PDF scripting/eval，并将项目 Node.js 最低版本调整为 `22.13.0`。
- 固定 `fast-uri` `3.1.5` 与 `hono` `4.12.34`，同步更新 CI 构建环境。
- 增加事务恢复、幂等恢复、Finalize generation、embedding 响应上限和 replace/merge 回归测试。
- 验证通过：Core 56 项、MCP Server 17 项、CLI 1 项测试，生产依赖离线 audit 为 0 vulnerabilities。

## [V1.0.1] - 2026-08-07

### 领域 Schema 类型投影

- 实体页面现在从已验证的 `entityTypeId` 自动生成领域 Schema 元数据和“领域分类”正文章节。
- 可选 `conceptTypes` 与 `conceptTypeId` 获得同样的兼容式页面投影支持；未配置时不改变原有概念抽取行为。
- Page Requirement、PagePatch scaffold、staged draft 和最终提交统一携带领域分类，Core 根据 `covers` 重新计算，避免 Writer 漏填或伪造类型。
- 页面 frontmatter 新增 `domain_schema_id`、`domain_schema_version`、`domain_type_kinds`、`domain_type_ids`、`domain_type_names`。
- `llm_wiki_finalize` 增加 `refresh_page_metadata=true`，可对已完成任务的旧 Wiki 页面幂等补齐领域类型，并重建检索索引。
- 保持 `V1.0.0` 的领域 Schema、RelationTypes 为空、MCP 错误恢复和旧 PagePatch 格式兼容。
- 新增领域类型页面投影与旧页面刷新回归测试。

## [Unreleased] - 2026-08-06

### Writer 职责与 Related 一致性修复

- 消除 Skill 中“协调器 Writer loop 直接提交”与“稳定 Writer 是唯一提交者”的冲突：主 Agent 只获取 compact manifest、启动 drafter、校验 receipt 并唤醒 Writer；只有 `llm-wiki-writer` 调用 `llm_wiki_get_staged_page_drafts` 和 `llm_wiki_commit_pages`。
- 明确 hash-bound `staged_draft_receipts + patches=[]` 是当前服务端暂存提交形式；裸 `staged_draft_shard_ids` 仅保留兼容，禁止 Writer 误报“必须由主 Agent 提供实际 PagePatch”。
- Related 解析同时支持 canonical `[[...]]`、指向 Wiki 页面的 Markdown 链接，以及 Related 章节中的旧式 `wiki/...md` 路径；写盘时统一同步 frontmatter 与正文 canonical wikilink。
- Finalize、lint 和知识库概览使用同一套 Related 解析，避免页面正文有链接但 frontmatter 仍为 `related: []`。
- 跨 batch relation 优先使用同 batch localId，并仅在全局 localId 唯一或页面名称唯一时安全补全关联，避免漏链和误链。
- 新增 Related 格式归一化、非关系正文防误识别、self-link 清理和跨 batch 双向 scaffold 回归测试。
- 验证通过：Core 45 项、MCP Server 16 项、CLI 1 项测试全部通过。

### MCP 运行时稳定性与大任务背压

- 普通 `unhandledRejection` 不再调用 `server.close()` 或设置退出码；服务只记录 `unhandled-rejection` 并标记运行时 degraded，避免一个后台 Agent 的遗漏 Promise 关闭共享 STDIO。同步 `uncaughtException` 仍按致命异常优雅退出。
- MCP 路由增加全局 8 个、单任务 4 个并发上限，超限返回结构化 `MCP_BUSY`/`TASK_BUSY` 与 `retry_after_ms`，不再让 Core 的任务锁和工作区写锁无限排队；宿主取消的请求在进入排队操作前返回 `MCP_REQUEST_CANCELLED`。
- Schema、chunk index、analysis、page-plan 和 draft-shard 缓存增加字节水位与条数双重淘汰，batch 文件缓存增加 32 MiB 总水位，降低大 Schema/大任务触发 OOM 后表现为“Connection closed”的概率。
- MCP 结果默认限制为约 450 KiB，并在工具元数据声明 80–120 KiB 的宿主结果建议；大型 batch、Schema、page plan 继续使用分页，不再把完整上下文复制到 `structuredContent`。
- 运行时写入 `.llm-wiki/logs/mcp-runtime.jsonl`，记录 request ID、输入/输出字节、活跃调用计数、RSS/heap、构建提交号、心跳、信号和退出原因；构建时生成 `dist/build-info.json`，便于确认 Claude 实际运行的构建。
- `status`/`import` 明确 `pipeline_concurrency`：提取与投影重叠时总预算为 4（2 extractors + 2 drafters），提取结束后才释放到 4 个 drafters，避免把 `recommended_workers` 与 `max_drafters` 相加。

### Projection 状态机与 cursor replay 修复

- 禁止 `projection_complete=false` 的 server-side manifest 空 wave；非最终 shard 必须提交完整 PagePatch 或已校验的 staged draft，避免空提交被错误记入 `committedDraftShardIds`。
- 对 direct PagePatch 执行 shard 级完整校验：要求覆盖恰好一次、路径属于指定 shard、路径/operation/expectedFileHash 保持 scaffold 一致，且校验失败不会改变任何 projection 状态。
- `status`、page-plan 和 page commit 会自动审计旧任务的 shard coverage；发现历史空提交或损坏的 committed ledger 时，自动退回对应 shard、清除读取游标并返回可恢复的下一步动作。
- draft-shard cursor 首次读取后持久化 `max_chars` 与边界；重放 cursor 时固定原分页边界，并为旧任务迁移仅保存 next cursor 的状态，避免改变请求大小导致 tracking 分裂。
- 状态响应新增 `projection_complete`、`next_draft_shard_id` 和 `retrieved_uncommitted_draft_shards`，明确区分“已读取但未提交”和“已提交”数量。
- 新增空 wave、shard coverage、损坏任务自动恢复和 cursor replay 回归测试。
- 旧任务在 `status`、读取 page plan 或提交页面时会自动修复，不需要手工编辑 `task.json` 或反复重连 MCP；修复过程保持原子性，失败时不会部分推进 projection。
- 最终 coverage 不完整时不再返回“可完成”的假状态，而是重新暴露缺失 shard 及下一步恢复动作，避免 `projection_complete=true` 与 `INCOMPLETE_PAGE_COVERAGE` 相互矛盾。

### Writer 并行草稿流水线

- 页面 manifest 现在明确声明 `coordinator-owned-parallel-drafters` 执行模式：主协调器必须为互不重叠的 shard 启动最多 4 个 `llm-wiki-page-drafter`。
- 保留单一 Writer 提交者、路径不可分割约束和原子提交，避免为了提速引入同路径冲突、重复 coverage 或 Related 页面竞争。
- 串行 `llm-wiki-writer` 明确降级为无法启动 drafter 时的 fallback，不再被误当作默认并行 Writer。
- 补充 MCP 合约测试，防止后续提示词或工具描述回退到串行页面生成。

### 后台 Agent 优先调度

- `parallel_extraction` 对单 batch 任务也保持 `background-agent-first`，主 Agent 不再因文件较小而直接执行抽取。
- Skill 明确禁止主 Agent 在启动 worker 前调用 `get_batch` 或 `commit_analysis`；只有实际 worker 创建失败、工具缺失或 MCP 传输错误时才允许前台兜底。
- import 工具和状态响应增加 `required`、`mode`、`single_batch_background` 调度提示，并补充单 batch 回归测试和 MCP 合约检查。

### MCP 长连接与 STDIO 生命周期修复

- 心跳改用带独立超时预算的标准 `ping` 请求，避免 SDK 默认请求长期挂起后阻塞后续心跳。
- 移除心跳定时器的 `unref`，保证长时间没有工具调用时 MCP 进程仍保持存活；生产默认仍为每 5 分钟一次。
- 监听 STDIO 输入/输出的 `end`、`close` 和 `error`，对端退出时主动关闭协议并清理资源，避免出现“Claude 已断开但 Node 进程仍在”的僵尸连接。
- 未捕获的同步进程级异常现在会记录后优雅退出并交还给宿主重启；普通 `unhandledRejection` 只进入 degraded 日志，不关闭共享 STDIO；工具校验错误仍由路由器转换为可恢复的结构化结果。
- 增加短周期心跳的真实 STDIO 回归测试，验证连续 ping/pong 后仍可正常调用 `listTools`。

### 技术文档与运维说明

- 技术文档新增 MCP 长连接诊断 Runbook，说明 `ready`、`keepalive`、`shutdown-requested` 和 STDIO 管道关闭日志的含义及恢复动作。
- 记录 `LLM_WIKI_MCP_KEEPALIVE_MS`、`LLM_WIKI_MCP_KEEPALIVE_TIMEOUT_MS` 的默认值与边界，避免误把心跳失败、宿主关闭管道和普通工具校验错误混为同一类问题。
- 补充升级后的 `npm run build`、`npm test` 和 Claude `/mcp` 重启步骤，明确 `dist/` 不纳入 Git。

### 第二轮隐性 Bug 修复

- 强制 draft shard 按 cursor 顺序读取；跳过前置上下文的提交会返回可恢复的 `PAGE_PLAN_CURSOR_MISMATCH`，避免伪造“已完整读取”并绕过语义重写。
- 校验 OpenAI-compatible Embedding 返回的向量索引必须完整、唯一且在请求范围内，防止异常响应造成文档与向量错配；异常继续降级到本地特征哈希召回。
- 允许显式删除已失败任务遗留的知识库数据；仍阻止 importing、extracting、planning、committing、finalizing 等活动任务期间的删除。
- 复核 Schema/XLSX 边界处理，并补充 draft cursor、Embedding 异常索引和失败任务清理回归测试。

### Writer 页面写入与大上下文恢复

- 新增服务端持久化的页面 manifest 和 draft shard 流程。
- Writer 在生成页面前即可获得单次最多 50 个 patch 的硬限制。
- 每个 shard 最多包含 6 个 canonical page path；每次最多返回 4 个待处理 shard。
- shard 成功写入后立即保存 `draft_shard_ids`，Writer 重启或上下文压缩后从第一个未完成 shard 继续。
- final projection 必须完成全部 shard 后才能确认，不会因旧页面已有 coverage 而跳过语义重写。
- 大型页面计划只返回分片上下文，避免一次性生成 50+ 页面后重新生成前半部分。
- drafter 生成的 PagePatch 现在只写入任务级临时 staging；主协调器和 Writer 只传递 `{shard_id, draft_hash}` receipt，Writer 通过 `staged_draft_receipts` 在服务端校验 hash 并原子提交。
- draft-shard 响应强制限制在约 40K 字符，并对既有大页面发送确定性的头尾摘要；完整页面正文保留在服务端，避免上下文压缩或超限。
- 保留 `view=plan` 作为旧版 page-plan cursor 流程的兼容入口。

### 抽取与 MCP 稳定性

- 缩小 `get_batch` 锁范围，提升多 Worker 并行租约吞吐。
- 防止 Worker 之间重新分区正在使用的 batch；修复超大单行 batch 的安全切分偏移。
- 增加精确幂等重放和活动 lease 校验，减少验证失败后的重复计算。
- 缓存并发读取中的领域 Schema、分析结果、page-plan 和 shard 上下文。
- 所有页面 shard 未完成、patch 超限、coverage 不完整等错误均返回可恢复 MCP 结果，不触发连接断开。
- 分析 envelope 在生成前返回实体、关系、证据和 reviewItems 的数量限制。
- 取消任务时清理未完成 projection 的快照和缓存。

### 文档与测试

- 更新 Skill、Writer Agent、恢复指南和技术文档，统一采用 manifest → shard → durable commit 流程。
- 新增 50+ 页面分片写入、提前 finalize 拒绝、上下文恢复和 MCP 错误恢复测试。
- 全量测试通过：Core 40 项、MCP Server 16 项、CLI 1 项。
