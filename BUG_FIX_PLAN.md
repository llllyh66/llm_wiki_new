# llm_wiki V1.0.1 Bug 修复计划与实施方案

## 1. 目标与边界

本文基于 `BUG_AUDIT_REPORT.md`，覆盖其中 6 个确认问题（含依赖问题）和 7 个高概率问题。本文只定义修复设计、实施步骤、验证方法和完成标准；本轮不修改生产源码、测试、依赖或构建配置。

目标版本建议为 V1.0.2。修复完成前继续以 V1.0.1/main 的审计基线 `4ed5c2c` 作为对照，不移动 V1.0.1 标签。

## 2. 总体原则

1. 先锁定契约和失败用例，再改实现。每个修复先加入能稳定复现问题的测试，确认测试在旧实现上失败后再实现。
2. P1 修复先于 P2；持久化协议先于其上的 Finalize、缓存清理等功能。
3. 崩溃恢复不能依赖内存状态。所有恢复判断必须来自可 fsync 的 journal、目标文件 hash 和 task ledger。
4. 安全边界采用 fail-closed：无法证明输入类型、响应大小或恢复状态安全时，返回可恢复错误，不猜测继续执行。
5. 每个改动拆成可单独审查的提交；不在依赖升级提交中混入业务重构。
6. 每阶段都运行 Core、MCP、CLI 全套测试，并在最后运行 Node 20 的三平台 CI 与真实 MCP 宿主冒烟测试。

## 3. 修复批次和依赖顺序

| 批次 | 内容 | 优先级 | 依赖 | 合并门槛 |
|---|---|---:|---|---|
| R0 | 契约决策、基线测试和故障注入设施 | P1 | 无 | 所有现存问题都有稳定失败测试或明确风险测试 |
| R1 | BUG-002 MCP OOM | P1 | R0 | 超大/循环结果不会终止进程，输出严格小于上限 |
| R2 | DEP-001 依赖升级 | P1 | R0 | production audit 无 high，PDF 回归通过 |
| R3 | HP-001 + HP-002 可恢复事务与幂等 WAL | P1 | R0 | 全崩溃点重启后收敛且 exact replay |
| R4 | BUG-001 最终投影契约落地 | P1 发布门槛 | R0；建议在 R3 后 | Core 全套恢复为绿色，replace/merge 语义明确 |
| R5 | BUG-003、BUG-004、BUG-005 输入和证据正确性 | P2 | R0 | 类型、locator、graph property tests 通过 |
| R6 | HP-003 Finalize generation 发布协议 | P2 | R3 | 页面、索引、lint、result 指向同一 generation |
| R7 | HP-004、HP-005、HP-006 资源上限和 GC | P2 | HP-006 依赖 R3 | 内存/磁盘预算测试通过，恢复期数据不被清除 |
| R8 | HP-007 Schema matcher | P2 | R0 | 边界、重叠、歧义测试通过 |
| R9 | 未验证风险、跨平台和真实宿主验证 | 发布验证 | R1-R8 | Node 20 三平台、真实宿主、fresh package 全通过 |

## 4. R0：修复前准备

### 4.1 建立修复分支和证据基线

实施时执行：

```bash
git switch main
git pull --ff-only
git switch -c codex/v1.0.2-bugfix
npm ci
npm run build
npm test
```

保留 BUG-001 的当前失败结果作为基线。不要先改断言让 CI 变绿。

### 4.2 增加统一故障注入点

在事务、任务保存、幂等记录和 Finalize 的关键写入后加入仅测试可用的 fault hook，例如 `faultInjector.hit("transaction.pages_applied")`。生产默认实现为空操作，测试通过 child process 环境变量选择一个点并执行 `process.kill(process.pid, "SIGKILL")`。

建议覆盖的事件：

- `transaction.intent_durable`
- `transaction.backups_ready`
- `transaction.page_renamed`
- `transaction.pages_applied`
- `transaction.task_linked`
- `idempotency.pending_durable`
- `idempotency.operation_completed`
- `idempotency.response_durable`
- `finalize.pages_published`
- `finalize.indexes_built`
- `finalize.generation_published`
- `finalize.task_completed`

测试必须使用独立 Node 子进程和临时 workspace，不能通过抛普通异常代替 SIGKILL，因为 `finally`/catch 会掩盖真实崩溃窗口。

## 5. BUG-002：MCP 超大结果递归导致 OOM

### 推荐方案

把 `serializeResult` 改成最多两次、无递归的序列化流程。超限错误必须从固定 schema 构造，不能复制原始 `data.next_action`、`error.details` 或任意嵌套对象。

定义 `boundedNextAction(value)`：

- `tool` 只接受工具注册表中的字符串，并限制长度；非法值回退到 `llm_wiki_list_tasks`。
- `arguments` 只保留小型标量白名单，如 `task_id`、`batch_id`、`cursor`、`limit`；每个字符串和总 JSON 字节数都设上限。
- 不保留数组、任意 payload、嵌套 `next_action` 或宿主提供的大对象。

定义 `serializeFallback()`：直接序列化一个内部常量结构；如果该固定结构仍超过上限或序列化异常，返回预先构造的小型 JSON 字符串。该分支不得再次调用 `serializeResult`。

### 具体操作

1. 修改 `packages/mcp-server/src/tools.js`，将递归 catch 和递归 output-too-large 分支替换为线性控制流。
2. 提取 `safeErrorSummary` 和 `boundedNextAction`，对 error code、message、task_id 分别限制字符数。
3. 超限响应不设置 `structuredContent`，避免文本和对象在宿主侧重复占用内存。
4. 在最终返回前再次计算 UTF-8 字节数，并以 `MAX_MCP_OUTPUT_BYTES` 作为硬断言。
5. 在 `packages/mcp-server/test/contract.test.js` 增加普通超限、超大 `next_action.arguments`、循环引用、超大错误 details 测试。
6. 在 `packages/mcp-server/test/stdio.test.js` 或新建 `output-limit.test.js`，用 `--max-old-space-size=128` 启动子进程复现 0.5–5 MiB 输入。

### 完成标准

- 所有响应序列化路径无递归。
- 0.5 MiB、5 MiB 和循环对象均返回结构化小错误，Node 子进程不退出。
- 返回字节数小于 450 KiB，后续同一 STDIO 连接调用成功。

## 6. DEP-001：高危依赖 advisory

### 推荐方案

分开升级 PDF 解析依赖和 MCP SDK 链路，避免一次 lockfile 大改难以定位回归。不要使用 `npm audit fix --force`。

### 具体操作

1. 保存修复前依赖树：

   ```bash
   npm ls pdfjs-dist fast-uri hono @modelcontextprotocol/sdk
   npm audit --omit=dev --json
   npm audit fix --dry-run
   ```

2. 查询 advisory 指定的首个已修复版本和 PDF.js breaking changes；选择包含修复且支持 Node 20 的最小版本。版本号必须以实施当天的 npm/GitHub advisory 为准，不在计划阶段硬编码可能过期的版本。
3. 单独升级 `packages/core/package.json` 的 `pdfjs-dist`，更新 lockfile；复核 legacy import 路径、`getDocument` 参数和文本抽取 API。
4. 保留 `isEvalSupported: false`、`disableFontFace: true`、`useWorkerFetch: false`，并设置 PDF 页数、解压后字节数、单页文本和总解析时间上限。
5. 单独升级 `@modelcontextprotocol/sdk`，确认其锁定树不再包含有漏洞的 `fast-uri`/`hono`；若上游仍未解除，则使用 npm `overrides` 前先跑 SDK contract，不直接覆盖不兼容主版本。
6. 增加正常、损坏、加密、超大页数和安全 corpus PDF 测试；PDF 测试在 child process 中运行并设置内存上限。
7. 重新运行 `npm audit --omit=dev --audit-level=high`，归档 JSON 结果。

### 完成标准

- production dependency audit 无 high/critical。
- PDF 正常抽取结果与基线可解释一致，恶意/异常样本在资源上限内失败。
- MCP 16 个工具 schema、STDIO handshake 和错误通道无回归。

## 7. HP-001 + HP-002：可恢复事务和幂等 WAL

### 推荐方案

把页面事务和幂等执行统一为 durable operation。核心状态机建议为：

```text
PREPARED -> APPLYING -> PAGES_APPLIED -> TASK_LINKED -> COMMITTED
                    \-> ROLLING_BACK -> ROLLED_BACK
```

在第一次页面 rename 前写入并 fsync `operation.json`，内容至少包括：`operationId`、`transactionId`、`taskId`、`idempotencyKeyHash`、`requestHash`、目标路径、旧/新 hash、staging/backup 路径、预期 task delta、状态和时间戳。每次状态转换使用原子写并 fsync 文件及父目录。

幂等 shard 在调用副作用前写 `PENDING`，并引用同一个 `operationId`；成功后写 `COMMITTED + response`。重放遇到 `PENDING` 时不得直接再次执行，而是调用 operation-specific reconciler。

### 具体操作

1. 在 `packages/core/src/transaction.js` 增加 journal schema v2 和显式状态转换函数。
2. staging 全部生成并校验 hash 后，写 `PREPARED` intent；只有 intent durable 后才允许备份和 rename。
3. 每个目标应用后更新已应用集合；全部完成后写 `PAGES_APPLIED`。
4. 将 commits ledger 和 task 需要更新的字段写入 journal 的 `taskDelta`。ledger/task 成功后写 `TASK_LINKED`，最后记录 response 并写 `COMMITTED`。
5. 修改 `withIdempotency`：先持久化 `{status:"pending", requestHash, operationId}`，再执行操作；完成后原子替换为 committed response。
6. 给 `commit_analysis`、PagePlan/投影提交、`commit_pages` 分别实现 reconciler。恢复器根据 journal 状态和磁盘 hash 做三选一：安全完成、完整回滚、标记 `RECOVERY_REQUIRED`；不能在状态不明时猜测覆盖。
7. workspace 初始化时，在持有恢复锁和 `write.lock` 的情况下扫描未终态 journal。恢复完成前拒绝新的写操作，但允许只读状态查询返回恢复进度。
8. 对旧 schema v1 journal 保持只读兼容；没有足够证据自动恢复时给出明确人工处置报告，不删除。
9. 在 `packages/core/test/` 新增 child-process crash matrix，逐个 fault point 杀进程、重启 Core、重放同一 idempotency key。

### 恢复判定规则

- 目标 hash 等于 `newHash` 且 task 未链接：继续链接 ledger/task，再提交幂等 response。
- 目标 hash 等于 `oldHash` 且 staging 完整：从 PREPARED 继续应用。
- 部分目标为新 hash、其余为旧 hash：按 journal 完成剩余目标；若 staging 缺失但 backup 完整，则整体回滚。
- 目标既非 oldHash 也非 newHash：停止自动恢复，返回 `RECOVERY_REQUIRED`，保留全部证据。
- COMMITTED operation 的同 key、同 request 必须返回原 response；同 key、不同 request 必须返回冲突。

### 完成标准

- 每个 rename/journal/task/idempotency 崩溃点重启后都收敛到全提交或全回滚。
- 同一幂等 key 无重复 analysis、transaction、页面或 commit ledger 项。
- 未知外部修改不会被恢复流程覆盖。
- 恢复后 retrieval、result、task status 和 Wiki hash 一致。

## 8. BUG-001：最终投影 body 保留契约

### 推荐契约

建议明确：`replace` 是最终页面正文的完整权威替换，不隐式拼接 provisional body；`merge` 才用于显式保留现有内容。原因是自动拼接旧正文会保留重复、冲突或已被最终 reconciliation 否定的事实。

需要保留的 provisional 事实必须由最终 Writer 基于 SourceRef 重新写入 final patch，不能依赖 Core 隐式复制旧文本。

### 具体操作

1. 在 PagePatch schema、README、Skill Writer 指令中写明 create/replace/merge 三种语义。
2. 修改失败 e2e：最终检索使用 final patch 中实际存在的 `reconciled overview`；同时断言 `ProvisionalOnlyMarker` 不再可检索，证明完整替换生效。
3. 新增 merge 用例：显式 merge 时保留指定旧事实，并验证重复 Related/frontmatter 不产生。
4. 新增 final Writer 完整性用例：如果 provisional fact 仍有有效 SourceRef，Writer 必须在 final patch 中显式携带；Core 不负责语义猜测。
5. 若产品负责人选择“replace 也必须保留旧事实”，则不要复用字符串拼接；新增结构化 `preserve_sections`/`remove_sections` 合约，并对冲突做显式失败。该方案工作量和数据歧义明显更高，不作为默认建议。

### 完成标准

- 契约文档、tool schema、Skill prompt、实现和测试对 replace/merge 的定义一致。
- 当前唯一 Core 红测恢复为绿色，且包含“replace 不隐式保留、merge 显式保留”的双向断言。

## 9. BUG-003：display_name 伪造解析类型

### 推荐方案

把展示名和类型判定彻底分离。实际路径扩展名受支持时，它是权威类型；`display_name` 只作为 label。实际路径无扩展名时，需要受信宿主传入 `media_type`，并对 PDF/DOCX/XLSX 做文件签名/ZIP 结构校验。无法可靠判定时拒绝导入。

作为纵深防御，Markdown/HTML 共用危险原始 HTML 清理策略，至少移除 script、style、iframe、object 和事件属性；代码围栏内的示例文本不能被误清理。

### 具体操作

1. 在 `packages/core/src/source-store.js` 提取 `resolveSourceMediaType({sourcePath, displayName, declaredMediaType})`。
2. 若真实扩展名存在且受支持，忽略 display_name 扩展名；两者不一致时返回包含两者的 `SOURCE_TYPE_MISMATCH`，或按兼容策略记录 warning 后使用真实扩展名。安全默认建议直接拒绝。
3. 对 `%PDF-`、ZIP 容器中的 `word/`、`xl/` 条目做签名确认；二进制签名与扩展名不一致时拒绝。
4. 为 extensionless attachment 增加明确 schema 字段 `media_type`，并限定枚举；不要继续从可编辑展示名静默推断。
5. 将原始 HTML 清理放在统一文本规范化边界，确保错误分类也不能把可执行标签带入 Wiki renderer。
6. 增加 HTML/Markdown/TXT 的交叉 display_name、二进制扩展伪装、无扩展名和签名不符测试。

### 完成标准

- `real.html + spoof.md` 不能进入 Markdown parser。
- 所有二进制格式均验证签名；无法确定类型的输入以结构化错误退出。
- display_name 的修改不改变同一文件的 parser 选择和内容 hash。

## 10. BUG-004：长块分片 locator 错误

### 推荐方案

把 `splitText` 改成返回 `{text, relativeStart, relativeEnd}`，偏移相对于未 trim 的 block 原文；`chunkDocument` 再加上 `block.startOffset` 得到绝对 locator。明确 offset 单位为 JavaScript UTF-16 code unit，并在协议文档中固定。

### 具体操作

1. 将 `splitText(text, maxChars)` 替换为 `splitTextWithOffsets(text, maxChars)`。
2. 切片时记录原始 cursor；leading/trailing whitespace 的删除量分别计入 start/end，禁止先 trim 后再猜偏移。
3. paragraph/code/table 使用片段级绝对偏移；多个小 block 合并时 locator 为首块 start 到末块 end。
4. heading 的渲染前缀 `# ` 属于合成文本，locator 仍指向源 heading 内容；不要把合成字符计入源 offset。
5. 对 Markdown 规范化（CRLF 转 LF）建立 offset map，或把 locator 明确定义为规范化源文本偏移并让 SourceRef/UI 使用同一文本。推荐保留原始到规范化的映射，以便准确高亮原文件。
6. 表格 fragment 附带 cell/sheet 信息和片段 offset；不要只复制整表 locator。
7. 添加 property tests：区间单调、范围合法、source slice 与 quote 对应、Unicode surrogate 不被切断，并覆盖 CRLF、CJK、emoji、长代码块和长表格。

### 完成标准

- 10,000 字符单段的各 chunk locator 不再相同，且随片段单调前进。
- 任一 locator 都在源长度范围内；UTF-16 surrogate pair 不从中间切开。
- SourceRef UI/检索引用可以用 locator 定位到该 chunk 对应文本。

## 11. BUG-005：代码块链接污染关系图

### 推荐方案

建立一个共享的 Markdown 关系提取器，Finalize、buildGraph 和 lint 只能调用这一实现。提取前通过轻量 tokenizer 屏蔽 YAML frontmatter、fenced/indented code、inline code、HTML `code/pre` 和 blockquote。

关系规则建议为：正文中的显式 wikilink/合法 Wiki Markdown link可形成边；纯路径只在 Related section 中有效；代码、引用和 frontmatter 中的任何样例链接均不形成边。

### 具体操作

1. 在 `wiki-page.js` 或独立 `markdown-links.js` 中实现 `extractRelationshipReferences(content)`，返回 canonical slug 及来源位置/类型。
2. 复用 `canonicalRelatedPath` 和 `normalizeRelatedSlug`，统一处理 `wiki/`、`.md`、反斜杠、fragment、绝对 URL 和 traversal。
3. `enrichWikiRelations`、`buildGraph`、`lintWiki` 全部改用共享结果；删除 `core.js` 中直接对整文件运行的 wikilink 正则。
4. 图边按 `source + target` 去重，并过滤 self-edge；目标不存在仍交给 lint 报告，但不要生成格式不规范 target。
5. 测试 fence（反引号和波浪线）、嵌套/未闭合 fence、inline code、blockquote、HTML pre/code、普通正文 link、Related legacy path、URL 和 traversal。

### 完成标准

- 代码块/引用中的链接不会出现在 Related、graph 或 broken-link lint 中。
- 三个消费者对同一页面生成完全相同的 canonical 边集合。
- 合法正文关系和 Related 关系保持兼容。

## 12. HP-003：Finalize 多产物一致性

### 推荐方案

采用 generation 发布协议。所有派生产物先写入 `.llm-wiki/generations/<generationId>/`，manifest 记录输入 wikiRevision、taskId、各文件 hash 和状态；全部成功后原子更新 `current-generation.json`。检索只读取 current 指针，不读取正在构建的 generation。

Wiki source pages、Related enrichment、index/overview 先在 staging 中生成，并通过 R3 的页面事务一次发布；随后基于发布后的固定 wikiRevision 构建所有索引。

### 具体操作

1. 新增 `finalization.json`，状态为 `PREPARED -> PAGES_PUBLISHED -> INDEXES_READY -> PUBLISHED -> TASK_COMPLETED`。
2. source pages、relations、index.md、overview.md 先生成到 staging；`log.md` 使用 taskId 去重，保证重放安全。
3. 在 `write.lock` 下发布页面集合并记录唯一 wikiRevision。
4. 基于该 revision 构建 page-source-refs、bm25、vector、embedding、graph、lint，写入 generation 目录并校验 hash。
5. lint 通过后原子写 `current-generation.json`；task result 同时记录 `generation_id` 和 `wiki_revision`。
6. 启动恢复器扫描未终态 finalization：未发布 generation 可继续构建或删除 staging；已发布但 task 未完成则只补 task/result，不重建页面。
7. 修改 retrieval 读取 current generation；对没有 generation 指针的 V1.0.1 workspace 保持旧路径只读兼容，并在下一次 Finalize 迁移。

### 完成标准

- 任一 Finalize fault point 重启后，读取者只能看到旧完整 generation 或新完整 generation。
- task result、lint、graph、BM25、embedding 均记录同一 generation/wikiRevision。
- Finalize 重放不会重复 log、关系或 source page。

## 13. HP-004：embedding cache 无界增长

### 推荐方案

引入 workspace 级缓存预算、可达性清理和 LRU/TTL。建议默认值先通过真实样本测算后确定；初始候选为 512 MiB、50,000 文件、30 天 TTL，均允许配置覆盖。

### 具体操作

1. 在 workspace config 增加 `embedding.maxCacheBytes`、`maxCacheFiles`、`cacheTtlDays`，并做上下界校验。
2. cache entry schema 增加 `createdAt`/`lastUsedAt`；为避免每次读取写盘，可按小时节流更新 mtime 或维护小型访问 manifest。
3. Finalize 成功后收集当前 generation 可达 document hash；GC 先删过期且不可达项，再按 LRU 删除不可达项直到预算内。
4. GC 使用独立 lock；遍历时拒绝 symlink，只删除校验通过的 fingerprint/hash 路径。
5. 保留当前 generation 正在引用的向量，即使暂时超预算；记录 warning 并停止新增 cache，而不是破坏当前检索。
6. 评估 Float32 二进制存储以减少 JSON 体积；若采用，增加 schema version 和旧 JSON lazy migration。

### 完成标准

- 重复导入和多个 fingerprint 后缓存稳定在配置预算内。
- GC 不删除当前 generation 或正在写入的 entry。
- 并发检索、Finalize 和 GC 不产生损坏 JSON/向量。

## 14. HP-005：非 streaming embedding response 内存峰值

### 推荐方案

生产 fetch 必须提供 Web `ReadableStream`。如果 `response.body.getReader` 不存在，直接返回 `EMBEDDING_UNSUPPORTED_RESPONSE_BODY`，不要调用 `response.text()`。同时使用 Content-Length 做早期拒绝，但不能把它当作唯一边界。

### 具体操作

1. 删除 `readBoundedResponseText` 中无 reader 时的 `response.text()` 分支。
2. 在读取前检查可信格式的 `content-length > maximumBytes` 并 cancel/abort。
3. streaming 分支继续逐 chunk 计数；超限时 `reader.cancel()` 加 `AbortController.abort()`。
4. 避免反复字符串拼接造成额外峰值：先保存有界 Uint8Array chunks，最后一次 decode/concat。
5. 错误响应的 64 KiB 限额和成功响应的 16 MiB 限额都走同一个 reader。
6. 测试无 body、无 getReader、伪造小 Content-Length 但实际超大、分块超限、UTF-8 多字节边界和慢流超时。

### 完成标准

- 任意响应都在读取过程中执行字节限制，没有“完整读入后检查”的路径。
- 64–128 MiB 模拟响应在小 heap 子进程中有界失败，Core 降级到 feature-hash fallback。

## 15. HP-006：journal backup 无界增长

### 推荐方案

该项必须在 R3 的状态机完成后实施。只清理已 `COMMITTED`/`ROLLED_BACK` 且超过恢复保留期的 backup/staging；保留小型不可变 transaction metadata 供审计。未终态和 `RECOVERY_REQUIRED` journal 永不自动删除。

### 具体操作

1. 在 config 增加 `journal.retentionDays`、`maxBackupBytes`，默认值通过实际 workspace 测算；提供 GC dry-run 结果结构。
2. journal 终态后写 `cleanupEligibleAt`。GC 在 journal lock 下扫描并校验 transaction ID/path，拒绝 symlink。
3. 先删除 backup/staging，后把 metadata 标记 `artifactsCleanedAt`；中途崩溃可安全重放。
4. 超预算时按最老的已终态事务清理；不能通过删除未终态事务来满足预算。
5. 在 workspace open 或 Finalize 后以低频触发，不放在每个页面提交的关键延迟路径上。
6. 如需用户操作，新增只读 `journal_gc_plan` 和显式 `journal_gc_apply` API；默认自动模式也必须输出清理统计。

### 完成标准

- 大量 replace 后 backup bytes 按策略回落。
- 崩溃恢复窗口内的 backup 保留完整；未终态 journal 不被 GC。
- GC 自身中途退出后可重放，且不会删除 workspace/journal 根目录之外文件。

## 16. HP-007：Domain Schema substring 误匹配

### 推荐方案

Latin 文本按 Unicode 字母/数字 token 和连续 token 序列做完整匹配；CJK 使用最长匹配和显式优先级。返回 match evidence（字段、alias、span、match kind、score），分数接近或并列时不自动唯一选择。

### 具体操作

1. 建立 Unicode tokenizer，避免 JavaScript `\b` 对非 ASCII 的局限。
2. exact id/name/alias 最高分；完整 token/phrase 次之；description/property 只作低权重召回，不允许单独触发高置信自动选择。
3. CJK 对重叠别名执行 longest-match；同长度冲突按 schema priority，仍并列则返回 ambiguous candidates。
4. `rankedSchemaMatches` 返回 score 之外的 `matched_terms` 和 spans，供 Agent 解释和调试。
5. 设定最小分差/置信阈值；未达到时要求显式 type id，而不是静默选第一项。
6. 添加英文短别名嵌在长单词、连字符、大小写、CJK 重叠、类型/属性同名和并列分数测试。

### 完成标准

- 三字符 alias 不会命中更长 Latin 单词内部。
- CJK 重叠结果稳定且可解释；歧义不会被伪装成确定选择。
- 旧的 exact id/name/alias 查询结果保持兼容。

## 17. 未验证风险的处置方案

这些项目在审计中尚未确认为 bug，应作为发布前威胁模型和平台验证任务，不与已确认 bug 混写。

### 17.1 外部路径读取

- 明确 MCP 输入是否属于受信 operator 能力。若不可信，把附件限定在宿主 materialization roots/workspace allowlist。
- 使用 realpath 后再校验根目录；覆盖 symlink、hardlink、路径替换竞态和 workspace 外文件。
- domain schema path 使用相同边界，不保留第二套较弱规则。

### 17.2 Embedding SSRF 和错误泄露

- 若 endpoint 可由项目/Agent 配置，仅允许 `https` 和显式 host allowlist；默认拒绝 loopback、link-local、私网和 cloud metadata 地址。
- 每次重定向重新校验目标；限制重定向次数。
- 外部错误只返回状态码和固定摘要，不回传可能包含 secret 的前 1,000 字符原文；详细信息写入受控日志并脱敏。

### 17.3 Windows 原子写和目录耐久性

- 在 Node 20 Windows/macOS/Linux 跑真实覆盖写、rename existing target、目录 fsync 能力和 kill/restart 测试。
- 对 Windows replace 采用经测试的双 rename/backup 协议；失败时保留 journal，不假设 POSIX 语义。

### 17.4 Build artifact drift

- MCP 启动时比较 `dist/build-info.json` 与 package version/source build stamp，不一致时快速失败并提示 `npm run build`。
- 发布 CI 从 fresh checkout 生成 tarball，解包后直接运行 MCP smoke test，确保 npm package 自带可执行 dist。

## 18. 每批次的验证命令

```bash
npm run build
npm test
npm audit --omit=dev --audit-level=high
```

发布候选还需要：

1. GitHub Actions Node 20：Ubuntu、macOS、Windows 全绿。
2. Node 20 和当前 LTS 的 child-process crash/OOM 测试。
3. fresh checkout -> `npm ci` -> build -> package/tarball smoke。
4. Codex、Claude Code、OpenCode 各跑单文件、多 batch、断线重连和重复幂等 key。
5. 检查 `git diff --check`、版本号、CHANGELOG、build-info 和 lockfile 一致。

## 19. 建议提交拆分

1. `test: add v1.0.1 bug regression fixtures and fault injection harness`
2. `fix(mcp): bound oversized result serialization without recursion`
3. `chore(deps): upgrade pdf parser security fixes`
4. `chore(deps): upgrade mcp sdk transitive security fixes`
5. `feat(core): add recoverable operation and page transaction journal v2`
6. `fix(core): make idempotent operations crash-replayable`
7. `docs(core): define final projection replace and merge semantics`
8. `test(core): align projection assertions with the documented contract`
9. `fix(core): resolve parser type independently from display name`
10. `fix(core): preserve source offsets across long-block splitting`
11. `fix(core): share context-aware wiki relationship parser`
12. `feat(core): publish finalize artifacts by generation`
13. `feat(core): enforce embedding response and cache budgets`
14. `feat(core): add recoverable journal retention and garbage collection`
15. `fix(core): use token-aware domain schema matching`
16. `test: add node20 cross-platform and real-host release smoke coverage`

## 20. V1.0.2 发布完成定义

- BUG-002、DEP-001、HP-001、HP-002 已关闭，BUG-001 契约已明确并全栈一致。
- 所有 CONFIRMED 和 HIGH-PROBABILITY 条目都有回归测试；高概率条目经故障注入后转为已验证修复。
- Core、MCP、CLI 全套测试通过，production audit 无 high/critical。
- Node 20 三平台 CI 通过，Windows 原子写和 kill/restart 有实测证据。
- fresh package 的 MCP build-info 与 V1.0.2 commit 一致。
- 真实 Codex/Claude Code/OpenCode 宿主完成 handshake、长任务、断线重连和幂等重放。
- 迁移和回滚文档完成：V1.0.1 journal/cache 可读，V1.0.2 写入的新 schema 有版本标记，降级限制明确。
