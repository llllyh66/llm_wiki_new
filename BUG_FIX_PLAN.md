# llm_wiki 1.0.8 Bug 全量修复计划与执行记录

> 对应审计：[BUG_AUDIT_REPORT.md](BUG_AUDIT_REPORT.md)
>
> 计划日期：2026-08-14
>
> 范围：`AUD-001`–`AUD-035`，全部必修，不保留“暂缓/接受风险”项
>
> 目标：建立唯一新流程、可审计投影、不静默漏召回的 1.0.8
>
> 执行状态：`AUD-001`–`AUD-035` 全部 Done，二次审计通过

## 0. 执行结果

| 批次 | 状态 | 完成结果 |
|---|---|---|
| R0 | Done | 保留 35 项追踪 ID，新增构建期召回、>10K、租约、真 OCR 专项回归 |
| R1 | Done | 长页默认 merge，全语义 requirement，Finalize 无条件快审计，无标题回退 |
| R2 | Done | progressive import、task-local BM25/feature store、后台 Embedding、全量持久多路索引 |
| R3 | Done | active generation 统一公开读，staging 校验后原子 pointer 发布 |
| R4 | Done | 宿主容量、通用 Agent 角色、token/epoch fencing、renew、quarantine、exact retry |
| R5 | Done | Skill/MCP/公开文档只剩当前 manifest→shard→receipt→Writer→Finalize 协议 |
| R6 | Done | 共享真 OCR、解码前图像防护、PDF 预算，PPTX 顺序与复合内容抽取 |
| R7 | Done | Core 72/72、MCP 23/23、CLI 3/3，Skill validator、build、pack dry-run、dependency audit、diff check 通过 |

## 1. 修复原则

1. **每个 Bug 先有失败测试**：测试必须在旧实现上稳定失败，再修改生产代码。
2. **不以警告代替正确性**：对数据丢失、未物化知识、索引不完整和 provisional 暴露采用 fail-closed。
3. **单一真相**：页面、BM25、Embedding、graph、lint、Domain Query 和 Finalize result 必须属于同一 generation manifest。
4. **唯一新协议**：新任务只允许 manifest → draft-shard → staged receipt → single writer → audited Finalize。旧数据迁移使用独立工具，不进入 Skill 主流程。
5. **租约必须可 fencing**：worker name 用于人类诊断，真正提交权由不透明 lease token/epoch 决定。
6. **召回完整性是发布条件**：部分 Embedding 或截断 corpus 不得标记为完成知识库。
7. **一个修复提交一类契约**：不把向量存储、Finalize 发布、Agent 调度和 OCR 改造混成一个难以回滚的提交。

## 2. 目标状态

```text
Register source + create task immediately
  -> parser emits bounded/overlapped verified chunk batches
  -> each batch atomically enters task-local BM25; async Embedding catches up
  -> retrieval returns ready results plus per-source/channel coverage
  -> capacity-aware Extractors with fenced renewable leases
  -> complete semantic Requirement Ledger
  -> path-disjoint Drafters -> hash-bound receipts -> one fenced Writer
  -> server-enforced lossless page operations
  -> Finalize validates every requirement and builds one staging generation
  -> lint/index/manifest pass
  -> atomic current-generation pointer publish
  -> every public query reads that generation
```

## 3. 修复批次和依赖顺序

| 批次 | 目标 | Bug | 合并门槛 |
|---|---|---|---|
| R0 | 锁定契约、最小复现和压力测试框架 | 全部 | 35 项都有独立测试 ID 和 fixture |
| R1 | 修复页面数据丢失与最终覆盖漏洞 | 001、002、003、014 | P0 复现全绿，Finalize 无法跳过 ledger |
| R2 | 重建渐进导入、构建期快速召回和完成后全量多路索引 | 004、005、015–019、030–035 | 首个完整 chunk 提前可搜，>10K 无静默漏召回，查询实际消费索引 |
| R3 | 统一 generation 发布和所有公开读路径 | 006、007、029 | 故障注入下无双重真相 |
| R4 | 修复 Agent 容量、身份、租约与背压 | 008–012、026、027 | Codex/Claude/CAC 真实多 Agent 用例全绿 |
| R5 | 删除当前协议中的旧流程并统一版本 | 013、028 | Skill/MCP 主路径零 legacy branch |
| R6 | 完成 OCR/PPTX 安全性、性能和内容覆盖 | 020–025 | fresh install 真实 OCR/PDF/PPTX 集成通过 |
| R7 | 全量回归、性能、崩溃恢复与发布验证 | 全部 | 所有 Definition of Done 满足 |

R1 是其他功能开发的前置门槛。R2 的新索引格式必须在 R3 generation manifest 中发布。R4 的新协议稳定后才最终精简 R5 Skill，避免提示词先于服务端实现。

## 4. R0：修复前契约与测试设施

### 4.1 新增测试设施

- `packages/core/test/fixtures/large-page/`：头、中、尾都有唯一已根据事实的 >40K 页面。
- `packages/core/test/fixtures/retrieval/`：慢导入/首 chunk、>10K docs、semantic-only、lexical-only、cross-boundary、中英改写、stable Wiki 干扰和同 path 多 section 数据集。
- `packages/core/test/fixtures/ocr/`：小型中英图片、超大维度头、多页扫描 PDF、取消测试。
- `packages/core/test/fixtures/pptx/`：文件名顺序与展示顺序不同、chart、SmartArt、embedded workbook。
- `packages/core/test/fault-injection.test.js`：Finalize generation 各阶段 kill/restart。
- `packages/core/test/multi-coordinator.test.js`：相同 worker name、旧 lease token、租约续租和过期竞争。
- `packages/mcp-server/test/host-capabilities.test.js`：总槽位 1–8、部分 spawn 失败、busy exact retry。

### 4.2 测试要求

- 每个 `AUD-xxx` 至少一个同名 test case，便于从 CI 直接追溯。
- 召回测试不只断言 `truncated` 字段；必须断言末尾目标实际被召回。
- 构建期测试必须在最后一个文件仍被 parser 阻塞时查询首个已发布 chunk，不能以 `import_files` 已完成代替“上传后快速可用”。
- Embedding 测试必须区分真实模型、未配置和服务故障；feature-hash 不能满足“Embedding available”断言。
- 崩溃恢复用独立子进程和 `SIGKILL`，不以普通异常代替。
- 多 Agent 测试同时检查语义调用数量、提交数量和磁盘 ledger，不只检查最终状态。

## 5. R1：页面完整性与 Finalize Coverage Ledger

### AUD-001 修复：服务端保证长页面无损更新

**实现**

1. 在 `existing_pages` 和 patch scaffold 中加入 `content_mode: full|excerpt`、`original_content_hash`、`section_manifest`。
2. `content_mode=excerpt` 时不生成 `replace`；默认生成服务端 section operation，仅更新指定 heading/requirement-owned block。
3. 如果业务必须完整 rewrite，Drafter 通过有界 cursor 读完所有 section，Core 记录 `full_content_read=true` 后才接受 replace。
4. commit 时使用 expected hash 做三方合并/冲突判定；不能从 excerpt 推断未读区域可删除。

**测试**

- `AUD-001 truncated replace rejected`。
- `AUD-001 section patch preserves head middle tail`。
- `AUD-001 full cursor rewrite may replace after complete read`。
- 多 requirement 同 path、hash conflict、页面上限 200K 回归。

**完成标准**

- 任何 Agent 从截断上下文生成的 patch 都无法删除未读 section。
- 审计复现中的中间 marker 在更新后仍存在。

### AUD-002 修复：建立全语义 Requirement Ledger

**实现**

1. 为 entity、concept、candidate page、claim、relation、contradiction、review item 和 unresolved question 生成稳定 requirement ID。
2. 对不需要独立页面的 fact requirement，必须绑定一个 owner page/section，不能仅依赖模型自觉。
3. contradiction/review/unresolved 建立专用“冲突与待复核”页或绑定到对应主题页，保留状态和 SourceRefs。
4. ledger 记录 `required|resolved|materialized|superseded`，`superseded` 需要新 requirement ID 和根据证据。
5. PagePatch 必须携带实际 requirement marker/结构化 section mapping，Core 验证内容不是只写 `covers` 元数据。

**测试**

- review-only、contradiction-only、claim-only、relation-only 各一个任务。
- requirement 写了 covers 但没有对应 section 时提交被拒绝。
- 一个矛盾被根据新证据显式 resolved 的迁移测试。

**完成标准**

- 任何已接受 Analysis 中的必要语义项都能追溯到最终 generation 的页面/section 或有证据的 resolution。

### AUD-003 修复：Finalize 无条件执行最终 ledger audit

**实现**

1. 将 `finalCompleted` 改为不可由空 acknowledgement 单独设置的派生状态。
2. Finalize 在构建 generation 前每次重新计算 ledger coverage、page hashes、SourceRefs、owner、contradictions/review resolution。
3. 最终投影的空 acknowledgement 只表示 shard traversal 完成，不表示语义审计通过。
4. 审计结果持久为 hash-bound artifact，Finalize 验证其 input hashes 未变更。

**测试**

- 精确复制审计中的两次空投影路径，断言第二次 Finalize 仍被拒绝。
- ledger 完整时空 acknowledgement 可正常结束 traversal。
- audit 后页面被外部更改时 Finalize 重新审计。

**完成标准**

- 不存在任何通过状态标志跳过最终 coverage audit 的路径。

### AUD-014 修复：无标题页面安全回退

**实现**

- snapshot 显式保留 relative path，回退标题由 relative basename 得到；不使用作用域外的 `file`。
- parse warning 进入 plan diagnostics，但不阻断其他页面。

**测试/完成标准**

- 无 frontmatter、无 H1、损坏 frontmatter、Unicode 文件名全部可规划，标题回退确定且无异常。

## 6. R2：全量多路召回与向量存储

### 6.1 构建期快速可用协议

```text
source durable-registered
  -> task_id returned
  -> parser emits verified chunk batch
  -> atomic task retrieval mini-generation publish
       ├─ BM25: synchronous ready（可用性保底）
       └─ Embedding: asynchronous queue（质量增强，不阻塞查询）
  -> retrieve_context reads one immutable ready snapshot
  -> Finalize builds complete generation indexes
  -> pointer atomically switches to published multi-route generation
```

构建期的可用性由 BM25 保底，真实 Embedding 异步追赶。所谓“两路召回”不得解释为必须等待两路都完成后才回答；否则慢向量服务会重新阻塞快速路径。每次响应必须告诉调用方本次实际使用了哪些路、每路覆盖多少文档，以及哪些 source 尚未可搜。

task retrieval mini-generation 必须不可变并可原子切换，避免查询读到一半 postings、一半 vectors。解析失败只标记对应 source/chunk，不得撤销其他已就绪 source；重试使用 source content hash 和 chunk policy fingerprint 保证幂等。

### 目标索引格式

generation/task retrieval manifest 至少包含：

```json
{
  "schemaVersion": 3,
  "generationId": "...",
  "tokenizerFingerprint": "...",
  "embeddingFingerprint": "...",
  "documentCount": 12345,
  "readiness": { "state": "source-ready", "readyDocuments": 12345, "totalDocuments": 12345, "exact": true },
  "sources": { "accepted": 3, "parsed": 3, "bm25Indexed": 3, "embeddingIndexed": 2, "failed": 0 },
  "documentsSha256": "...",
  "bm25": { "complete": true, "shards": [] },
  "vectors": { "complete": true, "dimensions": 0, "shards": [] },
  "graph": { "complete": true, "path": "graph.json" }
}
```

任一 requested channel `complete=false` 时，完成后查询不得宣称全通道可用。

### AUD-030 修复：注册先行、解析和索引渐进发布

**实现**

1. `import_files` 先校验路径和基础元数据，持久创建 ingestion/task/source records，立即返回 task ID 与 `retrieval_readiness=importing`。
2. 文件复制、解析/OCR 和 Chunk 改成可恢复后台阶段；每个 source 或有界 chunk batch 完整写入后更新 source epoch。
3. 在独立 staging 中更新 task-local BM25/文档 manifest，校验通过后原子切换 retrieval pointer。
4. 不再让长 parser 全程持有 workspace 全局写锁；只在短事务更新 source/task/index pointer 时持锁。
5. 幂等重试按 source hash、parser fingerprint、chunk policy fingerprint 复用已完成阶段。

**测试/完成标准**

- 第二个文件用 barrier 阻塞时，第一个文件的唯一词已能通过同一 task ID 命中。
- 扫描 PDF OCR 进行中时，已完成页面可搜，状态精确显示剩余页；kill/restart 后不丢已发布 chunk、不重复 doc ID。
- source 注册失败、解析失败、部分成功和取消均有确定状态，其他 ready source 不受影响。

### AUD-031 修复：真实通道身份和降级语义

**实现**

- 响应分开返回 `requested_channels`、`active_channels`、`effective_channels` 和 `fallback_channels`。
- 只有通过 embedding fingerprint/dimension 校验的真实向量索引才可出现在 `active_channels.embedding`。
- feature-hash 使用独立名称和权重；默认不作为与 BM25 等权的独立 RRF 证据，避免高度相关信号重复加分。
- 若产品必须保证真实 BM25+Embedding，两种可接受方案二选一：随发布包提供受测试的本地模型，或 workspace 初始化时要求配置并通过一次健康检查；文档不得继续把未配置状态写成真实两路可用。

**测试/完成标准**

- 默认 `provider=none` 时 `available_channels` 不含 Embedding，响应明确 `feature_hash.degraded=true`。
- provider 可用、超时、维度变化、模型切换分别返回真实且可机读的通道状态。
- 同一 lexical 信号不会因 BM25+feature-hash 被无条件双倍 RRF 加权。

### AUD-032 修复：Embedding 离开在线批量补算路径

**实现**

- source chunk 和 analysis commit 后写 durable embedding queue；worker 批量生成向量并发布新的 task retrieval snapshot。
- 在线查询只生成 query vector并查询已发布 ANN；不得为候选文档发起 Embedding。
- query vector 调用有独立严格延迟预算；超时立即降级 BM25，并保留可重试诊断，不等待默认 600 秒总预算。
- Finalize 在 pointer 切换前验证 stable Wiki 的全部必需向量；source/analysis 是否进入完成代索引由 manifest 明确声明，不能隐式首查补算。

**测试/完成标准**

- 冷缓存首次查询不会产生 document embedding 请求；只允许一个有界 query embedding 请求。
- embedding worker 被暂停或服务超时时，BM25 在在线预算内返回，coverage 显示部分/不可用。
- 构建完成后首次查询也不批量写向量缓存。

### AUD-033 修复：构建期 task-local 优先与稳定 Wiki 隔离

**实现**

- 构建期默认检索域为当前 task 的 ready source + committed analyses；对最新上传 source 设置保底候选配额。
- 上一 published generation 作为显式 `stable_wiki` 辅助通道，使用独立 top-k、权重和来源标签；默认不得占用 task-local vector quota。
- 如果用户主动要求全 workspace 联合查询，先在各 scope 内完整召回，再做跨 scope fusion，不能在召回前 `fairTake` 混切。

**测试/完成标准**

- 构造 10K 旧 Wiki + 1 个新 source，普通构建期查询必须命中新 source 的 lexical-only 和 semantic-only 目标。
- 不传 `batch_id` 也能得到 task-local source 保底；显式 stable Wiki 联合查询时两种 scope 可区分且可复现。

### AUD-034 修复：由 durable readiness 驱动阶段和通道

**实现**

- phase 由 task retrieval manifest、index completeness 和 publication pointer 共同派生，不直接等同于 `task.status`。
- 支持 `importing/source-ready/analyzing/wiki-staging/published/degraded` 状态机，定义每个转移的原子写和恢复规则。
- completed 但 generation/index 不完整时 fail-closed 为 degraded，不宣称多路完整；pointer 已发布时以 pointer 所指 manifest 为准。

**测试/完成标准**

- 在 task status 更新、index manifest 写入、generation build、pointer publish 的每个边界 kill/restart，phase 与 active channels 都反映实际耐久状态。
- 不存在仅改 `task.status` 就从两路切到“三路完成”的路径。

### AUD-035 修复：逐 source/逐通道 readiness 契约

**实现**

- import/status/retrieve 共享一个 schema，包含 source 的 `registered/copied/parsed/chunked/bm25-indexed/embedding-indexed/failed` 状态。
- 每个 channel 返回 `indexed_documents/total_documents/complete/degraded/index_generation`；retrieval 返回 `answer_scope` 和所读 manifest ID。
- `total_documents` 尚未知时必须 `exact=false`，不得用当前已见数量伪装最终总数。

**测试/完成标准**

- 多文件部分成功、OCR 中途取消、Embedding 积压、重启恢复时三类 API 读到相同 readiness。
- 当查询未命中且目标 source 尚未 indexed，调用方能仅依赖结构化字段给出正确解释。

### AUD-004 修复：全量 Embedding 索引

**实现**

- 构建期：source chunk 入库时加入向量队列，analysis commit 时加入 analysis docs；查询不再仅向量化前 1,000/2,000 个候选。
- 完成后：Finalize 在发布前为全部 stable Wiki sections 构建向量索引。
- 向量 provider 不可用时，显式返回 degraded 且运行全量 BM25；不把 feature hash 命名为真实 Embedding。
- ANN 召回后可与 BM25/Wiki RRF，但不允许 BM25 先硬截断向量语料。

**测试/完成标准**

- 审计的 1,101 文档 semantic-only 复现命中第 1,051 个文档。
- 20K 文档中目标分别位于首、中、尾，三者都能命中。
- channel status 的 indexed/skipped 与 manifest 完全一致；完成索引 `skipped=0`。

### AUD-005 修复：移除 10K 静默语料截断

**实现**

- 将 `maxDocuments` 从语义完整性上限改为单 shard/单查询内存预算。
- 按 doc ID 稳定分片，所有 shard 参与 lexical/vector 候选合并。
- 如果某 shard 缺失或 hash 错误，返回 `RETRIEVAL_INDEX_INCOMPLETE`，不默认仅搜已加载部分。

**测试/完成标准**

- 10,001、50,000 文档语料的尾部 lexical/semantic 目标都可召回。
- 删除一个 shard 时查询 fail-closed，恢复 shard 后可继续。

### AUD-015 修复：重叠 Chunk 与 parent-child 召回

**实现**

- Source 使用句子/段落/表行感知窗口，默认 overlap 10%–15%，不跨越不相关 heading。
- Analysis/Wiki section 使用相同 tokenizer 和 window policy，记录 parentDocumentId、window start/end。
- SourceRef 仍指向原文精确偏移；overlap 是召回文档，不会造成证据 locator 重写。
- RRF 后按 parent + evidence range 去重。

**测试/完成标准**

- 关系语句、否定词、表头+行、中英标点分别落在原 cut 两侧时仍能召回完整上下文。
- locator property tests 仍保证 quote 可从原文 slice 验证。

### AUD-016 修复：真实持久 BM25 索引

**实现**

- 使用确定 tokenizer fingerprint，持久 vocabulary、DF、doc length、term postings/TF。
- 新 source/analysis 文档增量写入 task index；Finalize 合并为 generation index。
- 查询路径读取索引而非重新 tokenize 全 corpus；对小语料保留可验证的 live scorer 作 oracle test，不作生产主路径。

**测试/完成标准**

- 持久索引与 oracle BM25 的 top-k/分数排序在 fixture 上一致。
- 查询不读取原始全 corpus 内容也能完成 BM25 候选。

### AUD-017 修复：可查询向量存储

**实现**

- 选择本地紧凑存储（如 SQLite + HNSW 扩展或可移植的 HNSW 文件），不再一向量一 JSON。
- manifest 存 doc ID、content hash、model/endpoint fingerprint、dimensions、generation、tombstone 和 index hash。
- 新 generation 不复用 fingerprint 不同的旧向量；内容 hash 相同时可复用。
- 移除或重命名当前 `vector.json` feature-hash 产物，避免把它当成真 Embedding。

**测试/完成标准**

- 构建、重启、增量更新、删除、model 切换、损坏 index 全部有用例。
- 50K 文档查询不需要为每个文档读 JSON/重新请求 Embedding。

### AUD-018 修复：证据感知的同 path 多 section 选择

**实现/测试**

- 用 MMR 或 section similarity 去重代替固定 2 条上限；per-path cap 作为最终预算而非早期硬切。
- 一个页面三个互不重复的命中 section 全部可返回；高度重复 section 只返回一个。

**完成标准**

- 多 section 命中不再因 path 相同被无条件删除。

### AUD-019 修复：provisional 读取 fail-closed

**实现/测试**

- 从 active generation 查询时不再需要扫描工作树 provisional owner。
- 构建期 task-scoped 查询仅包含该 task 允许的 source/analysis，不包含任何未发布 Wiki page。
- 注入损坏 task.json、原子替换窗口和权限错误，断言未发布 marker 始终不可见。

**完成标准**

- owner 状态不可验证时不存在任何 fail-open 排名路径。

## 7. R3：Generation 发布和公开读路径

### AUD-006 修复：Domain Query 共用 active generation

**实现**

- 提取公共 `resolvePublishedWikiRoot(workspace)`，`retrieve_context`、`queryDomainPages search/inspect`、lint/report 的用户可见路径共用。
- response 返回 generation ID + revision，不再只返回可能来自工作树的 hash。
- 若需要 task draft inspect，新建内部、显式 task-scoped 工具，不复用公开 Domain Query。

**测试/完成标准**

- 另一任务写入 classified provisional page 时，search 和 inspect 均只看到已发布 generation。

### AUD-007 修复：单 generation 原子发布

**实现**

1. Finalize 从上一 active generation + task transaction diff 生成 staging Wiki，不就地改写公开工作树。
2. 在 staging generation 内生成 source/index/overview/log、BM25、vector、graph、lint、page-source-refs 和 manifest。
3. 校验所有 artifact hash、ledger coverage、lint 和 retrieval completeness。
4. 仅通过一次 atomic pointer update 发布。
5. pointer 成功后再更新 task result；恢复器根据 pointer/manifest 完成 ledger，不再写 V1.0.1 固定路径。

**故障注入**

- staging pages、indexes ready、lint ready、manifest ready、pointer published、task completed 每个点 kill/restart。
- 无论在哪个点崩溃，公开查询要么全部看旧 generation，要么全部看新 generation。

**完成标准**

- lint 失败、Embedding 不完整或 graph 构建失败都不会改变任何公开读结果。

### AUD-029 修复：基于 manifest diff 的完整变更报告

**实现/测试**

- manifest 为每个 page 保存 path、origin（agent/source/index/overview/log）、old/new hash、created/updated/unchanged/deleted。
- Finalize result 的 created/updated 由上一 generation 和新 generation diff 生成。
- 用一次新 source page + overview/index/log 更新 fixture 验证报告完整且无重复。

**完成标准**

- result 列表与 generation manifest diff 完全一致。

## 8. R4：多 Agent、租约、恢复和背压

### AUD-008 修复：宿主容量感知调度

**实现**

- 协调器在首波调度前得到 `max_total_agents`、`coordinator_slots`、`available_background_slots`、`supports_named_roles`。
- Core 只返回理想 recommendation 和 pipeline limits；Skill 计算 effective wave，不再要求无条件“精确启动 4”。
- 部分 spawn 失败时保留已成功 worker 集合，仅回填空缺槽；不允许协调器同时重做已分配工作。

**测试/完成标准**

- 4 总槽位的 Codex 计划最多 3 个后台 Agent；投影重叠时能在 1+2 或 2+1 之间确定分配。
- 第 N 个 spawn 失败时不会重启前 N-1 个 worker 或转入重复前台抽取。

### AUD-009 修复：可移植 role contract

**实现**

- 将 Extractor/Drafter/Writer 权限、允许工具、输入和输出定义为简短、版本化 role contract。
- Claude/CAC 命名 Agent 只是 adapter；Codex 等宿主可使用通用 subagent + 签名 contract，不需要伪造 `subagent_type`。
- 增加宿主 adapter 合约测试，验证工具权限、稳定 ID、回执和不能并行 commit。

**完成标准**

- Skill 不再把 Claude `Agent(team_name/subagent_type)` 参数当成通用协议；每个目标宿主都有实际可调用路径。

### AUD-010 修复：有界续租

**实现**

- 新增 renew lease operation，输入 task/batch(or projection)/worker/lease token，返回新 expiry 和同 epoch token。
- 最小续租间隔、最大总租期、任务状态和 cancellation 都由 Core 校验。
- Agent 在语义生成阶段由宿主轻量 heartbeat 续租，不将 source 内容重发。

**测试/完成标准**

- 可控时钟下跨越原 30/60 分钟的活跃 Agent 不会被重新分配；停止心跳后在有界时间内可恢复。

### AUD-011 修复：fencing token/epoch

**实现**

- 每次新租约生成高熅 `lease_token` 和单调 epoch，持久化 hash，明文只返回持有者。
- `commit_analysis`、stage drafts、Writer commit、renew 都必须匹配 token+epoch。
- 重新授权后旧 token 即使 worker name 相同也被拒绝为 `STALE_LEASE_FENCE`。

**测试/完成标准**

- 两协调器复用同一 worker name，只有当前 token 可提交；旧 Agent 无法在新租约后写入。

### AUD-012 修复：新流程必须显式 worker/writer ID

**实现/测试**

- MCP schema 和 Core 新 protocol version 都将 worker/writer ID 设为 required；空值和缺省值结构化拒绝。
- 迁移工具如需读旧默认 ID，在离线迁移阶段转换，不进入新运行时。

**完成标准**

- 并行任务不存在 `worker-default`/`writer-default` 身份。

### AUD-026 修复：过期 projection artifact 隔离与 GC

**实现/测试**

- lease 过期时在 task lock 下把 plan/draft 移入 `orphaned/<projection-id>`，记录 reason/hash/retention deadline。
- 新 projection 仅能读当前 ID 且验证 writer/token。
- 重复过期、进程崩溃在 move 中间、GC 与恢复并发用例通过。

**完成标准**

- 过期文件不会被新投影使用，也不会无期增长。

### AUD-027 修复：可精确重放的 busy 合约

**实现/测试**

- Router 对 busy 返回 `retry_after_ms`、`operation`、有界 `retry_action` 或服务端 opaque replay token。
- 保留原 idempotency key；等待后重试同一操作，不转为 status/list loop。
- 造成 global/task 背压，验证第四次或客户端重试仍执行一次原操作，无重复副作用。

**完成标准**

- Skill、tool schema、Router 和 Core 对 busy 的唯一语义都是“延迟后精确重试原操作”。

## 9. R5：删除旧流程与版本统一

### AUD-013 修复：新流程与迁移完全隔离

**服务端**

- 从当前 tool list 删除 `llm_wiki_apply_projection`。
- `llm_wiki_get_page_plan_context` 删除 `view=plan`，只保留 `manifest|draft-shard`。
- `commit_pages` 删除裸 `staged_draft_shard_ids`，只接受 hash-bound receipts。
- retrieval channel 删除 `vector|graph` alias，仅保留精确 `bm25|embedding|wiki`。
- 删除 V1.0.1 固定路径写入和 `legacy-plan-compatibility` execution mode。
- old workspace 识别为 `MIGRATION_REQUIRED`，不在运行时自动修复旧 batch/plan/locator。

**Skill/Agents**

- 将核心 Skill 改为简短状态机：Import、capacity-aware extraction、manifest drafting、single writer、audited finalize、query/recovery。
- 移除 old server 6000 fallback、legacy complete SourceRef、legacy locator repair、Team 历史绕行和 apply projection 说明。
- 将宿主 adapter 差异放入各自的小型 adapter doc，不污染核心协议。
- 迁移说明放入 `docs/migrations/<from>-to-<to>.md`，CLI 迁移工具不在 Skill 中被调用。

**测试**

- tool snapshot 中不存在被删除入口/alias。
- 对 Skill/MCP/current runtime 运行禁用词扫描，核心新流程不得出现 `legacy`、`old server`、`view=plan`、`apply_projection`。
- 旧 workspace 只能经显式 migration fixture 迁移后打开，新 workspace 不运行任何兼容分支。

**完成标准**

- 当前新任务运行时只存在一条协议路径；迁移代码不能被新任务调用。

### AUD-028 修复：版本单一来源

**实现/测试**

- protocol server 从 package.json 或构建生成的 version module 读取版本，不再手写。
- 新增 root/core/mcp/cli/protocol/build-info 一致性测试。

**完成标准**

- 每次版本发布只需修改一个受控来源，协议 handshake 与包版本一致。

## 10. R6：OCR/PPTX 新改造

### AUD-020 修复：Import-scoped OCR session pool

**实现**

- `importSources` 创建最多 N 个 OCR Worker（默认 1，可配 1–2），所有需 OCR 的文件复用。
- 非 OCR 文件不创建 Worker；首个 OCR job 懒加载。
- 任意文件失败不终止整个 pool，operation finally 只统一 terminate 一次。

**测试/完成标准**

- 20 张图片只创建一次 worker/language directory；识别结果与单文件一致，失败时无进程/临时目录泄漏。

### AUD-021 修复：OCR 预算和取消

**实现**

- 配置 `maxPdfPages`、`maxOcrPages`、`maxRenderedPixelsTotal`、`maxOcrInputBytesTotal`、`maxOcrWallMs`、`maxOcrTextChars`。
- 超限时返回结构化 `SOURCE_PARSE_BUDGET_EXCEEDED`，附带已完成页数，但不把部分结果当完整导入。
- Core 的 MCP AbortSignal 传递至 source-store、parser、PDF 循环、render 和 OCR recognize。

**测试/完成标准**

- 超页数、超耗时、累计像素超限和中途取消均在预算内结束，锁和 Worker 被释放。

### AUD-022 修复：像素和解压炸弹防护

**实现**

- PDF scale 使用 `min(maxScale, sqrt(maxPixels/basePixels))`，允许小于 1，但设置可读的最小边长/失败阈值。
- canvas 创建前使用安全整数检查 width*height*channels，防止溢出。
- PNG/JPEG/WebP/BMP/TIFF 先读 header metadata，限制 width、height、pixels、frames、decoded bytes；动画只允许明确的帧策略。

**测试/完成标准**

- 构造巨型维度头、多帧 TIFF/WebP、巨型 PDF viewport，子进程在内存上限内返回结构化错误。

### AUD-023 修复：真实 OCR 发布门禁

**实现**

- CI 有一个不注入 fake recognizer 的真实 Tesseract 测试，使用仓库自有小 fixture。
- 在 fresh temp directory 执行 `npm pack` → 安装打包产物 → OCR，验证语言包在发布包中可 resolve。
- 显式校验 Node 20 和项目支持的当前 Node 版本。

**完成标准**

- 空 `node_modules` 经 fresh install 后，断网状态可识别 fixture 中英文并正常 terminate Worker。

### AUD-024 修复：权威 PPTX slide 顺序

**实现**

- 解析 `ppt/presentation.xml` 的 `p:sldIdLst`，通过 `ppt/_rels/presentation.xml.rels` 解析每个 target。
- 校验 target 在 archive 内、无 traversal、类型为 slide；重复/缺失 relation 结构化拒绝。
- locator.slide 是展示序号，metadata 另保存 slide part/relationship ID。

**测试/完成标准**

- `slide1.xml, slide2.xml, slide3.xml` 的权威展示顺序为 3,1,2 时，输出和 SourceRef locator 严格按 3,1,2。

### AUD-025 修复：PPTX 复合内容覆盖

**实现**

- Chart：解析 chart XML 的 series/category/value cache，如有 embedded workbook 则以受限 XLSX parser 验证。
- SmartArt：解析 diagram data model 中的文本和关系。
- Embedded workbook：使用现有 XLSX 安全上限，不执行公式/宏/外部连接。
- 未支持的 OLE/object 生成 `unextractedObjects` metadata 和已根据 review item，显式告知完整性缺口。

**测试/完成标准**

- chart 数值、SmartArt 节点、embedded sheet 行都进入 chunk/retrieval；不支持 object 不得静默消失。

## 11. 追踪矩阵：35 项 Bug 全覆盖

二次审计状态：下表 35 项全部 **Done**；逐项证据见
[BUG_AUDIT_REPORT.md](BUG_AUDIT_REPORT.md) 的“1.0.8 二次审计闭环矩阵”。

| Bug | 主要代码区域 | 先失败测试 | 实现产物 | 完成定义 |
|---|---|---|---|---|
| AUD-001 | Core page planning/transaction | truncated replace | section/full-read contract | 未读正文零丢失 |
| AUD-002 | requirement derivation/validation | review/contradiction/claim-only | semantic ledger | 每个必要项有最终 owner/resolution |
| AUD-003 | projection completion/Finalize | double empty final projection | unconditional audit | 无 audit bypass |
| AUD-004 | retrieval/embedding | semantic target >1000 | full vector index | semantic-only 尾部可召回 |
| AUD-005 | retrieval corpus | target >10K | sharded full index | 无静默 corpus cut |
| AUD-006 | Domain Query | provisional classified page | published root resolver | 只见 active generation |
| AUD-007 | Finalize/publication | kill/lint fail matrix | staging generation | 公开读只见完整旧/新版 |
| AUD-008 | Skill/scheduler | 4-slot host/partial spawn | capability-aware waves | 不超槽且不重复工作 |
| AUD-009 | host adapters | Codex role launch | portable role contract | 所有目标宿主可执行 |
| AUD-010 | lease lifecycle | controlled clock renewal | bounded renew | 活跃 worker 不被抢租 |
| AUD-011 | lease commits | same name/stale token | fence token+epoch | 旧持有者无法写入 |
| AUD-012 | schemas/Core IDs | missing worker/writer | required IDs | 无默认共享身份 |
| AUD-013 | Skill/MCP/runtime | forbidden legacy snapshot | one current protocol | 新任务零 legacy branch |
| AUD-014 | page plan | titleless page | safe fallback | 规划不崩溃 |
| AUD-015 | parser/retrieval chunking | boundary facts | overlap+parent IDs | 跨边界事实可召回 |
| AUD-016 | BM25 builder/query | persisted-vs-oracle | real inverted index | 查询实际消费索引 |
| AUD-017 | vector storage | restart/model switch/50K | compact ANN store | 无一向量一 JSON 主路径 |
| AUD-018 | hit selection | 3 unique same-path sections | MMR/diversity | 不因固定 2 条丢证据 |
| AUD-019 | provisional filter | corrupt owner task | fail-closed scope | 损坏状态不暴露草稿 |
| AUD-020 | import/OCR | 20-image worker count | shared pool | worker 加载次数有界 |
| AUD-021 | PDF/OCR/cancel | pages/time/cancel budgets | propagated signal+budgets | 超限可控结束 |
| AUD-022 | image/PDF decode | bomb fixtures | pixel/frame guards | 内存上限内失败 |
| AUD-023 | packaging/CI | fresh real OCR | package smoke gate | 离线真 OCR 可用 |
| AUD-024 | PPTX ordering | rel order != filename | presentation rel parser | locator 按展示顺序 |
| AUD-025 | PPTX completeness | chart/SmartArt/workbook | extraction/review metadata | 复合内容不静默消失 |
| AUD-026 | projection GC | expiry/crash/GC race | quarantine+retention | 旧 artifact 不可被复用 |
| AUD-027 | MCP backpressure | exhausted retry | exact retry token/action | 背压后重放原操作 |
| AUD-028 | version metadata | package/handshake mismatch | generated version | 全包版本一致 |
| AUD-029 | Finalize result | deterministic pages diff | manifest-derived report | 报告与 generation diff 一致 |
| AUD-030 | import/task lifecycle | slow second file barrier | progressive task/source publish | 全量导入结束前首 chunk 可搜 |
| AUD-031 | retrieval channel identity | provider none/failure | effective channel contract | fallback 不冒充 Embedding |
| AUD-032 | embedding online path | cold-cache request count/latency | async vector queue | 首查不补算文档向量 |
| AUD-033 | building corpus/fusion | 10K stable Wiki + new source | task-local quotas/scopes | 新上传 source 有召回保底 |
| AUD-034 | readiness/publication state | phase-boundary kill matrix | durable retrieval state machine | 阶段由真实就绪度派生 |
| AUD-035 | import/status/retrieve schema | partial multi-source lifecycle | shared readiness contract | 可判断每个 source/channel 是否可搜 |

## 12. 每批次验证命令

每个批次至少执行：

```bash
npm run build
npm test
npm audit --omit=dev --audit-level=high
git diff --check
```

root `npm test` 已依次包含 Core、MCP 和 CLI；CI 报告仍必须分别展示三者计数。

R2 额外执行渐进导入 barrier、冷首查请求计数/延迟、10K/50K retrieval benchmark 和索引损坏测试。R3 执行 Finalize kill matrix。R4 执行真实宿主多 Agent 冒烟。R6 必须从 fresh packed artifact 运行 OCR/PPTX，不使用开发目录的现成 `node_modules`。

## 13. 发布门禁

下一个发布候选版必须同时满足：

- [x] `AUD-001`–`AUD-035` 追踪矩阵全部 Done。
- [x] P0 数据完整性复现全部通过。
- [x] 构建期首 source 在后续导入未完成时已可经 task-local BM25 命中。
- [x] 构建期 BM25+Embedding 与完成后 BM25+Embedding+Wiki 路由及真实降级语义通过。
- [x] import/status/retrieve 共享逐 source/channel readiness、coverage 和 manifest 合约。
- [x] 完成代索引无固定 corpus/Embedding 静默裁剪。
- [x] 所有公开读工具统一 active generation。
- [x] 宿主容量、续租、旧 token fencing、Drafter receipt 和单 Writer 合约/集成通过。
- [x] 当前 Skill/MCP/Agent 无 old server 或可选旧流程分支。
- [x] 无注入真 OCR、PDF 预算、PPTX 顺序与复合内容测试通过。
- [x] Finalize 和 generation 公开可见性故障回归通过。
- [x] 当前支持的 Node `>=22.13.0` 环境全量回归通过。
- [x] Core/MCP/CLI 的 `npm pack --dry-run` 文件清单完整，production dependency audit 为 0 vulnerabilities。

## 14. 回滚和迁移策略

- 新 BM25/vector/generation/lease 格式全部使用新 schema version，不就地覆盖旧格式。
- 旧工作区由新版 Core 的耐久恢复路径重建 generation，当前 CLI/Skill 不暴露旧流程迁移命令。
- 回滚只切回上一个已验证 generation pointer；不覆盖当前页面或删除新索引证据。
- 旧客户端如不支持新协议，应显式收到 `CLIENT_UPGRADE_REQUIRED`，不在新 Core 中透明进入旧分支。

## 15. 完成报告模板

每个 Bug 关闭时必须记录：

```text
Bug ID:
Root cause fixed:
Production files changed:
Failing test before fix:
Passing test after fix:
Migration impact:
Performance impact:
Security/correctness impact:
Commit/PR:
Reviewer:
```

只有代码、失败测试、回归测试、迁移说明和相关 Skill/MCP 契约同时更新后，该 Bug 才能标记完成。
