# llm_wiki V1.0.1 Bug 审计报告

## 1. 审计结论

审计基线为 main 分支、标签 V1.0.1，HEAD 为 4ed5c2c（feat: project domain schema types into wiki pages）。审计期间未修改任何生产源码、测试或构建配置；仅执行了构建、测试、静态检查、依赖审计和临时目录中的最小复现。

结论：V1.0.1 不建议在修复 P1 问题、处理依赖高危 advisory、并明确最终投影的页面保留语义前作为稳定发布版交付。当前没有确认的 P0；但 MCP 结果序列化存在可将服务进程打到 OOM 的 P1 DoS，锁定依赖中有 PDF.js 高危 advisory，Core 主测试套件仍为红色。

审计发现：

- 6 项确认问题：5 项运行时/数据正确性或安全问题，1 项为确定的测试/契约失败；另有 3 个直接依赖 advisory。
- 7 项高概率问题，集中在进程崩溃恢复、幂等记录、Finalize/index 原子性、缓存和持久化耐久性。
- 多个未验证风险：外部路径读取边界、embedding SSRF、Windows 原子替换语义、恶意 PDF 可利用性和多进程故障恢复。
- Core 47 项测试中 46 通过、1 失败；MCP 16/16 通过；CLI 1/1 通过。

建议发布门槛：

1. 先修复 BUG-002、DEP-001 中的高危依赖和 HP-001/HP-002 的崩溃恢复路径。
2. 明确 BUG-001 是“最终语义重写允许丢弃 provisional body”还是“必须保留旧事实”；在契约确定前不要简单修改断言。
3. 增加进程级、跨进程、恶意输入和 Node 20/Windows 的测试，再进行真实 MCP 宿主验证。

## 2. 范围、基线和方法

### 2.1 范围

覆盖 Core 任务状态机、批次/lease、Evidence/SourceRef、解析器、Domain Schema、PagePlan、PagePatch、事务、Finalize、检索和 embedding；MCP STDIO 生命周期、工具路由、并发背压、取消、错误恢复、结果大小限制、日志和构建产物；CLI、Skill、Claude Agents、MCP 配置、构建链和依赖；以及崩溃窗口、幂等性、路径安全、跨平台行为、DoS 和数据正确性。

### 2.2 基线证据

- Git：main...origin/main，工作区初始干净。
- 版本：root/core/mcp/cli 均为 1.0.1；标签为 V1.0.1。
- 本机：Node v24.18.0、npm 11.16.0、macOS。
- 构建：npm run build 通过；Core 仅执行 node --check，MCP 构建是复制 src 到 dist 并生成 build-info，CLI 仅执行 node --check。
- npm test 在 Core 阶段停止，47 项中 1 项失败；MCP 16/16 通过；CLI 1/1 通过；失败用例单独重复仍失败。
- npm audit --omit=dev --audit-level=high 报告 3 项 advisory，2 high、1 moderate。
- .github/workflows/ci.yml 声明 Node 20，矩阵为 Ubuntu/macOS/Windows；本次未实际获得远程 CI 运行结果。

### 2.3 证据等级

- CONFIRMED：已由可重复测试、最小复现或直接依赖审计确认。
- HIGH-PROBABILITY：代码路径已证明存在故障窗口或资源问题，但本次未做进程 kill、断电、Windows 或多进程注入。
- UNVERIFIED-RISK：风险成立的前提依赖宿主、部署或外部服务边界，不能仅凭当前仓库断言为产品 bug。

## 3. 架构和状态模型

    Agent/Skill
      -> MCP STDIO / HeadlessToolRouter
      -> LlmWikiCore
      -> Source Store -> parser -> chunks -> bounded batches
      -> worker lease -> AnalysisEnvelope + SourceRef
      -> page plan/projection -> PagePatch or staged draft
      -> write.lock + transaction journal -> wiki pages
      -> Finalize -> source pages/aggregate pages/indexes/lint
      -> retrieval: BM25 + embedding/fallback + Wiki graph

Core 实例内通过 taskLocks 和 workspaceWriteTail 排队；进程间通过 task lock、sources.lock 和 write.lock 协调。PagePatch 事务有 expectedFileHash 和回滚逻辑，但 transaction journal、task commits、idempotency record 的提交顺序不是一个可恢复的统一 WAL。

主要状态：

    importing -> prepared/extracting -> planning -> committing -> finalizing -> completed
                              -> failed/cancelled
    incremental projection -> final projection -> Finalize

同一任务的 lease、PagePlan cursor、PagePatch scaffold 和 SourceRef 有较完整校验；provisional 页面在任务未完成时会从检索结果中隐藏；MCP 正常错误、背压、取消和 STDIO idle heartbeat 的现有测试通过。

## 4. Confirmed Bugs

### BUG-001：最终投影测试确定失败，且暴露 provisional body 保留语义不一致

- 分类：TEST/CONTRACT；模块：Core projection、Wiki writer、retrieval。
- 严重度：P2（CI 阻断）；置信度：1.00。
- 精确位置：
  - packages/core/test/e2e.test.js:1468-1473：最终 patch 把页面 body 设置为 reconciled summary。
  - packages/core/test/e2e.test.js:1490-1493：仍用 ProvisionalOnlyMarker 查询同一页面并断言命中。
  - packages/core/src/wiki-page.js:90-95：body 取自 incoming patch，不从 existing body 合并。
  - packages/core/src/transaction.js:63-65：对 replace patch 调用 prepareWikiPageContent。
- 前置条件：运行用例 micro-batch Wiki projection uses one writer, hides provisional pages, and requires final reconciliation。
- 最小复现：

    node --test --test-name-pattern='micro-batch Wiki projection uses one writer' packages/core/test/e2e.test.js

- 期望：用例成功，最终页面可被用测试查询召回；如果产品契约是保留 provisional-only facts，则旧事实应仍存在。
- 实际：稳定失败于 e2e.test.js:1493，实际值为 false、期望值为 true。
- 证据：最终 patch body 只有 Projected Entity 和 reconciled overview；prepareWikiPageContent 用 incoming body 替代 provisional body，因此 ProvisionalOnlyMarker 不再存在。
- 根因：测试假设与最终语义重写实现不一致。当前证据不能证明这是必需保留旧正文的产品 bug，也不能证明丢弃旧正文就是正确契约。
- 影响：root npm test 红色；若业务要求保留旧事实，则存在事实丢失；若最终 Writer 被允许完全重写，则测试断言错误。
- 数据损失/重复/死锁：存在条件性内容丢失；未发现死锁。
- 临时规避：最终测试改用最终 summary 查询，或由 Writer 将需要保留的事实显式写入 final patch。
- 最小修复方向：先在文档和 PagePatch contract 中明确 replace 的保留规则；若 replace 是完整重写则改测试并新增“不隐式保留”的断言；若必须保留，则在最终 Writer 的 merge 语义中显式合并旧正文。
- 回归测试：同时覆盖完整 replace、显式 merge、provisional marker 保留/丢弃三种契约。

### BUG-002：MCP 超大结果的递归截断可把进程打到 OOM

- 分类：MCP/DoS；模块：HeadlessToolRouter。
- 严重度：P1；置信度：1.00。
- 精确位置：packages/mcp-server/src/tools.js:57-91，尤其是 68-86。
- 前置条件：结果 JSON 超过 MAX_MCP_OUTPUT_BYTES（450 KiB），且 data.next_action 本身含有大字符串或大对象。
- 最小复现：

    node --max-old-space-size=128 --input-type=module -e 'import { HeadlessToolRouter } from "./packages/mcp-server/src/tools.js"; const huge={next_action:{tool:"llm_wiki_list_tasks",arguments:{payload:"x".repeat(520000)}},ok:true}; const router=new HeadlessToolRouter({listTasks:async()=>huge}); await router.callMcp("llm_wiki_list_tasks",{});'

  该子进程触发 V8 heap out of memory；使用普通默认 heap 也复现了进程 OOM，审计过程中未在主 Agent 进程中重复。
- 期望：超限结果被一次性变成有界的 MCP_OUTPUT_TOO_LARGE，连接保持可用。
- 实际：serializeResult 将 data.next_action 原样放回新的超限 wrapper，并再次递归调用 serializeResult；没有深度、字节或次数上限，最终因重复 JSON stringify 触发 OOM。
- 根因：错误恢复动作没有独立的有界 schema，且超限 wrapper 继续携带原始 next_action。
- 影响：Node MCP 进程退出，所有共享 STDIO 调用中断；比普通可恢复的 output-too-large 严重。
- 数据损失/重复/死锁：当前调用结果丢失；长任务可能需要重新连接并依赖已持久化的 lease/idempotency。
- 临时规避：调用端不要向未严格校验的参数字段传递大字符串；运营侧重启 MCP。该规避不应作为发布安全措施。
- 最小修复方向：超限时仅保留固定长度的 tool 名、task_id 和允许字段；删除或摘要 next_action.arguments；使用一次性 fallback，不再递归 serializeResult。
- 回归测试：在独立 child process 中注入 0.5 MiB next_action，断言进程正常退出、返回小于上限的结构化错误，并覆盖循环/嵌套 next_action。

### BUG-003：源文件解析类型由可伪造的 display_name 决定

- 分类：输入校验/内容安全；模块：Source Store、parser。
- 严重度：P2；置信度：1.00。
- 精确位置：
  - packages/core/src/source-store.js:50-63 用 path.resolve(input.path) 读取实际文件，却用 displayName 的扩展名选择 parser。
  - packages/core/src/parser.js:153-160 HTML parser 会移除 script/style；错误选择 Markdown 时不会走该清理。
- 前置条件：实际文件扩展名和 display_name 扩展名不一致。
- 最小复现：将内容 <script>alert(1)</script><h1>Title</h1><p>Body</p> 写入 real.html，再调用 core.importFiles({files:[{path: realHtml, display_name: "spoof.md"}]})。
- 期望：按真实文件类型解析，或明确拒绝 extension mismatch。
- 实际：manifest.mediaType 为 text/markdown，chunk 文本仍包含 script 标签；真实 Markdown 伪装为 .html 也会走 HTML 清洗。
- 根因：path.extname(displayName) 优先级高于 path.extname(sourcePath)，display_name 同时承担展示名和 parser 类型。
- 影响：HTML 清洗可被绕过；Markdown/HTML/XLSX/PDF 的解析、检索和后续 Wiki 写入可能错误；若 Wiki renderer 允许 HTML，存在内容注入面。
- 数据损失/重复/死锁：可能造成解析内容丢失或未经预期清洗的内容进入知识库；无死锁证据。
- 临时规避：调用方确保 display_name 扩展名与实际文件一致，并不要把用户可编辑 display_name 当作安全边界。
- 最小修复方向：以实际路径扩展名为 parser 来源；display_name 只作为 label；如果宿主只能提供别名，至少校验两者一致并拒绝不一致。
- 回归测试：真实 HTML 以 .md display_name 导入、真实 Markdown 以 .html display_name 导入、二进制/不支持扩展名 mismatch。

### BUG-004：超长块分片的 SourceRef locator 全部指向整块

- 分类：Evidence/可追溯性；模块：parser、SourceRef。
- 严重度：P2；置信度：1.00。
- 精确位置：packages/core/src/parser.js:387-395。每个 splitText(piece) 都写入同一 block.startOffset 和 block.endOffset。
- 前置条件：一个 paragraph/code/table block 超过 maxChunkChars。
- 最小复现：长度 10,000 的单段 Markdown、maxChunkChars=1000 调用 parseManagedSource。实际输出 17 chunks；除 H1 外的 16 个 chunk 都是 startOffset=8、endOffset=10008。
- 期望：每个 chunk 的 locator 能映射到对应 piece 在原始文档中的准确区间；至少 start/end 不应全部相同。
- 实际：所有分片的 locator 相同；parseBlocks 和 splitText 还会 trim/trimStart，使原始空白偏移进一步不可逆。
- 根因：splitText 只返回文本，不返回原文相对偏移；chunkDocument 使用 block 级 pendingStart/pendingEnd。
- 影响：Agent 只能得到整段证据范围；引用、回溯和 source UI 高亮可能指向错误位置；表格/长代码块尤其明显。
- 数据损失/重复/死锁：不删除源文档，但降低证据精度并可能造成错误归因。
- 临时规避：避免超过 chunk 上限的单段；将文档预先按段落/标题拆开。
- 最小修复方向：splitText 返回 text/startOffset/endOffset，从未 trim 的规范化源文本计算边界；对 table/code 也保留片段到原文的映射。
- 回归测试：property test 验证每个 chunk 的 source slice 包含其 quote，分片区间单调、不重叠或明确允许重叠，并覆盖 Unicode、CRLF、表格和代码块。

### BUG-005：代码块中的链接被当作 Wiki 关系和图边

- 分类：Projection/graph/lint correctness；模块：wiki-page、Core graph、lint。
- 严重度：P2；置信度：1.00。
- 精确位置：
  - packages/core/src/wiki-page.js:267-284 的 extractWikiLinks/extractRelatedReferences 对整个正文使用正则，没有排除 fenced code block 或 blockquote。
  - packages/core/src/core.js:3338-3344 在 Finalize 中用该结果建立双向关系。
  - packages/core/src/core.js:3845-3853 buildGraph 直接对完整文件做 wikilink 正则。
  - packages/core/src/lint.js:17 也复用该解析结果。
- 最小复现：调用 extractRelatedReferences，输入为 fenced markdown 内容和 [[topics/in-code]]、[inside](wiki/entities/in-link.md)；实际返回 topics/in-code 和 entities/in-link。
- 期望：代码示例、引用材料和非 Related 普通文本中的 link 不产生知识图边；只有明确的 canonical body link 或 Related 语法产生边。
- 实际：Finalize 会把可解析的代码示例转成关系，graph.json 还可能产生不规范的 target 字符串，lint 可能报告错误 broken link/orphan。
- 根因：关系解析器和 buildGraph 使用全局正则，没有共享 Markdown block tokenizer 和统一 canonicalization。
- 影响：双向 Related 污染、图检索误召回、lint 噪声，且一次 Finalize 会改写页面关系。
- 临时规避：不要在 Wiki 正文代码块中放 wikilink 或 Markdown Wiki path。
- 最小修复方向：先剥离 fenced code、HTML code/pre 和 blockquote，再分别解析 canonical body links 与显式 Related section；buildGraph/lint/Finalize 必须共用一个解析器。
- 回归测试：代码块、blockquote、inline code、正文真实 link、Related 中 legacy path、绝对 URL 和 traversal path。

### DEP-001：V1.0.1 锁定依赖含高危 advisory

- 分类：第三方依赖/安全供应链。
- 严重度：P1（PDF 解析路径）；置信度：1.00（依赖漏洞确认），可利用性置信度需另测。
- 审计命令：NPM_CONFIG_LOGS_DIR=/private/tmp npm audit --omit=dev --audit-level=high。
- 实际结果：
  - pdfjs-dist@5.7.284：high，GHSA-hq66-cqwq-w95j，恶意 PDF 打开时 arbitrary JavaScript execution advisory。
  - fast-uri@3.1.4：high，GHSA-7p8r-x3mc-p8w7，host confusion via backslash authority introducer；由 MCP SDK 的 ajv 链路引入。
  - hono@4.12.32：moderate，GHSA-8j4g-w8fx-2239，CORS middleware ReDoS；由 MCP SDK 的 node-server 链路引入。
- 精确位置：
  - packages/core/package.json:10-11 声明 pdfjs-dist 范围。
  - package-lock.json:1144-1150 锁定 pdfjs-dist 5.7.284。
  - packages/core/src/parser.js:184-209 对不可信 PDF 调用 PDF.js。
  - package-lock.json:742、879 为 fast-uri/hono。
- 现有缓解：PDF 调用设置 isEvalSupported=false、disableFontFace=true、useWorkerFetch=false，但不能把上游 advisory 自动等价为已修复。
- 影响：恶意 PDF 的安全边界需要单独验证；MCP SDK transitive advisory 需要根据实际 STDIO/SDK 路径评估，但 release 仍不应带 high advisory。
- 最小修复方向：升级到包含修复的版本并对 PDF parser 做回归/恶意样本测试；npm audit 提示 pdfjs-dist 需要可能的 breaking upgrade，不能直接盲目使用 --force。
- 临时规避：关闭 PDF 导入，或只接收受信 PDF；MCP 部署保持 STDIO、不要将未使用的 HTTP 链路暴露为服务。

## 5. High-Probability Bugs

### HP-001：Page transaction 在 rename、journal、task state 之间没有崩溃恢复协议

- 分类：持久化/分布式恢复；严重度：P1；置信度：0.95。
- 精确位置：
  - packages/core/src/transaction.js:69-83 先 rename 目标页，之后才生成 journal。
  - packages/core/src/transaction.js:84-113 计算 revision 并写 transaction.json。
  - packages/core/src/core.js:2085-2129 之后才把 transactionId 写入 commits、修改 task state、保存 task。
  - packages/core/src/transaction.js:126-132 只在已有 transactionId 被引用时读取 journal；启动流程没有扫描未引用 journal 并恢复。
- 故障窗口：进程在目标 rename 后、journal 写入前；journal 写入后、commits/task state 持久化前；或多页面 rename 中间被 kill。
- 期望：重启后可识别 prepared/applied/committed transaction，自动完成或回滚，并保持 task/journal/wiki 一致。
- 预计实际：页面已经存在但 task 没有 commit record；重试 create 可能变成 FILE_HASH_CONFLICT；Finalize 的 pageRecords 可能遗漏孤立页面。
- 证据等级：代码明确存在窗口，本次没有注入 process kill，因此仍标为 HIGH-PROBABILITY。
- 临时规避：保留 .llm-wiki/journal，人工检查 transaction.json、目标文件和 task commits 后再 rebase；不要直接删除 journal。
- 最小修复方向：写入带状态的 intent/WAL 并 fsync；rename 前记录目标和备份，启动时扫描未完成 transaction；把 task commit ledger 和 transaction 状态设计为可恢复协议。
- 回归测试：在每个关键点注入 SIGKILL，重启 Core，验证 pages、commits、result、retrieval indexes 和 idempotency 都能收敛。

### HP-002：幂等记录在副作用之后写入，崩溃时 exact replay 不成立

- 分类：幂等性/持久化；严重度：P1；置信度：0.95。
- 精确位置：packages/core/src/task-store.js:393-411；operation() 在 406 行执行，idempotency shard 直到 410 行才写入。
- 前置条件：任何带 idempotency_key 的 operation 在副作用完成后、record 写盘前进程退出。
- 期望：同 key、同 request 在重启后返回原 response，不重复副作用。
- 预计实际：副作用可能已经落地，但 shard 不存在；重试重新执行并遇到 hash conflict、重复写或另一个错误，而不是 exact replay。
- 说明：同一 Core/同一 task 的锁降低并发竞态，但不能覆盖进程崩溃。
- 最小修复方向：把 request intent、in-progress/committed 状态和 response 放入可恢复 journal；或让每个副作用以 idempotency key 为 durable transaction identity。
- 回归测试：在 operation 成功后写 idempotency record 前 kill，重启后重复同 key，断言只产生一个 transaction/analysis/page commit。

### HP-003：Finalize 和领域 metadata refresh 跨页面、索引、lint 的写入不是统一事务

- 分类：Finalize/索引一致性；严重度：P2；置信度：0.90。
- 精确位置：packages/core/src/core.js:2268-2293 依次写 source pages、relations、index、overview、log、page-source-refs、bm25/vector/embedding/graph/lint，再保存 completed task。
- 风险：进程在任意中间步骤退出时，页面和 indexes 可能来自不同版本；任务状态在 finalizing，虽可再次 Finalize，但没有显式阶段 marker 或版本一致性校验。
- 现有缓解：Finalize 重跑通常会重建部分内容；这降低了持久伤害，但没有替代 crash injection 证明。
- 修复方向：将 Finalize 输出拆成可恢复阶段，每阶段带 generation/revision；或建立一次性的 derived-artifact manifest，所有 index 以同一 generation 发布。
- 回归测试：每个 write 后 kill/restart，检查 wikiRevision、page-source-refs、graph、lint 和任务 result 的 generation 一致。

### HP-004：embedding JSON cache 没有大小、TTL 或删除策略

- 分类：资源耗尽/检索；严重度：P2；置信度：0.95。
- 精确位置：packages/core/src/embedding.js:47-75 在 .llm-wiki/indexes/embeddings/<fingerprint> 下按 document hash 写文件，没有 eviction；:245-255 每个 vector 单独持久化。
- 影响：重复导入、不同内容 hash、不同 endpoint/model fingerprint 会持续增长；大向量以 JSON 存储，磁盘可远超知识库本身。
- 修复方向：按 workspace 配置设置最大 bytes/files，LRU/TTL，Finalize 或 delete 时回收不可达 hash；对 vector 做紧凑二进制格式或明确预算。
- 回归测试：生成超过预算的文档版本，断言 cache 不超过上限并保留命中率可解释。

### HP-005：embedding 非 streaming response 分支在限额前先完整读入内存

- 分类：外部服务/DoS；严重度：P2；置信度：0.90。
- 精确位置：packages/core/src/embedding.js:204-208。当 response.body 没有 getReader 时直接 await response.text()，之后才检查 Buffer.byteLength。
- 影响：不可信或错误配置的 endpoint 可以在 16 MiB 检查前制造更大的字符串和 heap 峰值。
- 修复方向：对所有 fetch Response 统一使用 byte-counting stream；无 body reader 时使用受控 reader/AbortController，不能以 response.text() 作为前置步骤。
- 回归测试：mock 无 stream body 返回超大文本，断言在 bounded memory 下失败。

### HP-006：journal backup/staging 生命周期可能造成长期磁盘增长

- 分类：资源生命周期；严重度：P2；置信度：0.90。
- 精确位置：packages/core/src/transaction.js:19-22 创建 transactionRoot/backupRoot；成功路径只在 120-123 删除 stagingRoot，没有清理 backupRoot 或已完成 transaction 目录。
- 影响：每次 replace 都可能保留完整旧页面；多轮增量任务和大页面会造成磁盘增长。
- 修复方向：保留可配置审计期限或压缩/配额；完成后将 journal 标记为 immutable record，备份按策略清理；删除前提供可审计 dry-run。
- 回归测试：大量 replace 后检查 journal/backup bytes，验证 GC 规则和恢复期仍可用。

### HP-007：领域 Schema matcher 是 substring 匹配，短别名可能误选类型

- 分类：Domain Schema/语义正确性；严重度：P2；置信度：0.80。
- 精确位置：packages/core/src/domain-schema.js:752-766 的 term 过滤及 :210-224 的多模式匹配。
- 风险：非 CJK 只要求长度至少 3，匹配未按词边界；别名可能在更长单词中误命中，自动选择错误 entity/concept/relation constraints。
- 说明：当前契约没有明确必须词边界匹配，因此不提升为 CONFIRMED。
- 修复方向：对 Latin token 使用边界/词法匹配，对 CJK 设计 longest-match/优先级，并在 selection response 中返回匹配区间。
- 回归测试：短别名作为长单词子串、CJK 重叠别名、类型/属性同名。

## 6. Unverified Risks and Test Gaps

### 6.1 路径和权限边界

- packages/core/src/source-store.js:50-78 接受任意 path.resolve 后的本地文件，未限制在 workspace；domain-schema.js:16-31 对 domain_schema_path 也允许 workspace 外路径。
- README/Tool schema 将其描述为 Agent-visible path，因此这可能是有意的宿主能力，不在当前证据上断言为漏洞。
- 若 MCP 输入可被不可信 Agent 控制，则可能读取 /etc、用户目录或其他项目文件。应由宿主 attachment materialization 或 Core allowlist 明确边界。
- 建议测试：workspace 内、workspace 外、符号链接、硬链接、路径竞态、敏感文件拒绝；明确文档 Agent-visible 是否等于任意本地路径。

### 6.2 Embedding SSRF 和 secret/response 泄露

- packages/core/src/embedding.js:16-43 允许 env/config 指定 endpoint，:120-150 直接 fetch，没有 host/protocol allowlist。
- 对受信 operator 配置，风险可接受；若配置由项目/Agent 影响，则存在 loopback、cloud metadata、内网 SSRF。
- 错误消息会截取外部响应 body 前 1,000 字符，需确认不会泄漏 token/内部返回。

### 6.3 Windows 原子替换和目录耐久性

- packages/core/src/utils.js:52-87 对 temp 文件执行 fsync 后直接 rename，没有目录 fsync；Windows 下目标存在时 rename/replace 语义需要真实 CI 证明。
- CI 已声明 windows-latest，但本次只在 macOS/Node 24 执行；不能把配置当作运行结果。

### 6.4 多进程和 kill/restart

现有测试覆盖同进程锁、MCP backpressure 和协议错误，但未覆盖：

- 两个 Node 进程同时 lease/commit/finalize/delete。
- 锁持有进程 SIGKILL、PID reuse、损坏 lock 文件和 stale lock。
- transaction rename/journal/task/idempotency 的每个崩溃点。
- power-loss 风格的 fsync/rename durability。

### 6.5 Parser/format fuzz

已有 DOCX/XLSX/PDF/HTML 格式测试，但没有：

- 恶意 PDF corpus 和当前 PDF.js advisory 的可利用性验证。
- ZIP bomb、XML entity、超大 sharedStrings、异常 worksheet relationship 的 property/fuzz 组合。
- UTF-16 surrogate、CJK、CRLF、长单行、代码块和表格 locator property tests。

### 6.6 MCP/Skill/Agent contract

现有 contract tests 已确认 16 个工具、Claude agent MCP 继承、错误通道和 STDIO 生命周期基本一致。仍缺：

- 工具 JSON Schema 与 router/Core 实际运行时校验的一致性测试；当前 router 直接接收 args，不能假定所有 MCP host 都会先做 schema validation。
- 超大 next_action、循环 next_action、超大错误字段的 child-process isolation test。
- 真实 Claude Code/OpenCode/Codex host 的 handshake、idle、重启和 build-info 版本验证。

### 6.7 Build artifact drift

- 审计开始时本地 packages/mcp-server/dist/build-info.json 仍报告上一版本 commit 477bd87；源代码 HEAD 已是 4ed5c2c/V1.0.1。重新执行 npm run build 后才恢复一致。
- dist/ 被 .gitignore 忽略，.mcp.json 和 opencode.json 都直接启动 dist/index.js；fresh checkout 在未先 build 时没有可运行的 dist。
- README 已要求先 npm run build，因此这是发布/运维脆弱性而非当前源码逻辑的单独 CONFIRMED bug；仍建议把 build freshness 纳入启动检查或发布包检查。

## 7. Bug Matrix

| ID | 状态 | 严重度 | 置信度 | 主要影响 |
|---|---|---:|---:|---|
| BUG-001 | CONFIRMED test/contract | P2 | 1.00 | Core CI 红；最终 body 保留语义不明 |
| BUG-002 | CONFIRMED | P1 | 1.00 | MCP 结果递归导致 Node OOM/STDIO 中断 |
| BUG-003 | CONFIRMED | P2 | 1.00 | display_name 伪装改变 parser，可能绕过 HTML 清洗 |
| BUG-004 | CONFIRMED | P2 | 1.00 | 长块分片 locator 错误，SourceRef 不精确 |
| BUG-005 | CONFIRMED | P2 | 1.00 | 代码块 link 污染 Related/graph/lint |
| DEP-001 | CONFIRMED dependency | P1 | 1.00 | pdfjs high；fast-uri high；hono moderate |
| HP-001 | HIGH-PROBABILITY | P1 | 0.95 | kill 后孤立页面、journal 和 task ledger 分裂 |
| HP-002 | HIGH-PROBABILITY | P1 | 0.95 | 副作用落地但 idempotency replay 丢失 |
| HP-003 | HIGH-PROBABILITY | P2 | 0.90 | Finalize 多产物版本不一致 |
| HP-004 | HIGH-PROBABILITY | P2 | 0.95 | embedding cache 长期磁盘耗尽 |
| HP-005 | HIGH-PROBABILITY | P2 | 0.90 | 非 streaming embedding response heap 峰值 |
| HP-006 | HIGH-PROBABILITY | P2 | 0.90 | journal backup 无界增长 |
| HP-007 | HIGH-PROBABILITY | P2 | 0.80 | Schema 类型自动选择误命中 |

## 8. 测试覆盖矩阵

| 能力 | 现有覆盖 | 本次结果 | 缺口 |
|---|---|---|---|
| Core e2e/state/projection | e2e 37 项 | 36 pass / 1 fail | crash/restart、跨进程、最终 body 语义 |
| Core formats | formats 6 项 | 通过 | fuzz、恶意 PDF、资源上限压力 |
| Wiki page | wiki-page 4 项 | 通过 | fenced code/blockquote graph |
| MCP contract | contract 13 项 | 13/13 | oversized recursive next_action |
| MCP STDIO | stdio 3 项 | 3/3 | 真实宿主、异常进程 OOM |
| CLI | cli 1 项 | 1/1 | 多平台、错误恢复 |
| Build | node --check + dist copy | 通过 | typecheck/lint/package runtime matrix |
| Dependencies | npm audit | 3 advisory | 修复后重新 audit |
| OS/Node | CI 配置 Node20 + 3 OS | 本地 Node24/macOS | 实际 CI 结果未纳入本次证据 |

## 9. 建议新增的 Top 10 回归测试

1. MCP child-process output cap：注入大 next_action，验证只序列化一次且进程不退出。
2. Transaction crash matrix：在 rename、journal、commits、task save、idempotency save 各点 SIGKILL 后重启恢复。
3. Idempotency crash replay：副作用成功、record 尚未写入时重试同 key，只允许一个 durable commit。
4. Source type mismatch：实际 HTML/Markdown/TXT 与 display_name 交叉组合，验证拒绝或按实际类型解析。
5. Chunk locator property：长 paragraph/code/table 分片区间映射原文，覆盖 Unicode/CRLF/trim。
6. Graph parser context：fence、blockquote、inline code、Related section 和 canonical body link 的边集合。
7. PDF security regression：修复版本、恶意样本、isEvalSupported=false 配置和异常资源上限。
8. Multi-process lock race：两个独立 Node 进程同时 lease、commit_pages、finalize、delete。
9. Cross-platform atomic write：Node20 Windows/Ubuntu/macOS 上重复写现有 JSON/Markdown，含 kill/restart。
10. Embedding budget/SSRF：超大非 streaming response、cache quota、endpoint allowlist 和 response redaction。

## 10. 优先修复计划

### P0：当前无确认项

无需立即按 P0 阻断，但不要因此跳过 P1。

### P1：发布前必须处理

1. BUG-002：改为一次性有界的 MCP error serialization，加入 child-process OOM regression。
2. DEP-001：升级/替换 PDF.js 和 transitive advisory 版本；重新跑 audit、PDF corpus 和全平台测试。
3. HP-001/HP-002：建立可恢复 transaction/idempotency WAL，明确重启后的 reconciliation。
4. 明确 BUG-001 的 replace/merge contract；在 contract 明确前保留红色测试作为 release blocker。
5. 评估外部路径和 embedding endpoint 是否属于受信 operator-only 能力；若不是，增加 allowlist。

### P2：随后处理

1. BUG-003：parser 类型只由实际文件类型决定。
2. BUG-004：为 split pieces 生成准确 locator。
3. BUG-005：统一 Markdown link parser，排除代码块/引用，graph/lint/Finalize 共用。
4. HP-003：Finalize/index generation 引入 generation manifest。
5. HP-004/HP-006：embedding/journal 增加磁盘预算和回收。
6. HP-005：所有 embedding response 走 bounded streaming。
7. HP-007：领域类型选择使用词边界/最长匹配并暴露 match spans。

## 11. 真实宿主验证建议

本次未使用真实 Codex/Claude Code/OpenCode 宿主，也未调用真实模型；MCP STDIO 测试使用 Node test harness。修复 P1 后，建议在同一 main commit 上执行：

- fresh checkout -> npm ci -> npm run build -> 启动 .mcp.json 和 opencode 配置，确认 build-info 的 packageVersion/gitCommit。
- Claude Code/Codex/OpenCode 各完成一次单文件和多 batch 流程，覆盖 context compaction 后 recovery。
- idle heartbeat、宿主断开、MCP 重启、丢失 tool response、重复 idempotency key。
- Windows Node20 与 macOS/Linux Node20 的同一套测试和 package install。

## 12. 审计限制

- 未修改生产代码，未实现修复；报告中的最小修复是设计建议。
- 本机只有 Node24/macOS 实测；Node20/Windows 仅检查了 CI 配置。
- 未做真实 kill/restart、断电模拟、跨进程并发和恶意 PDF exploit 验证，因此相关条目标为 HIGH-PROBABILITY 或 UNVERIFIED-RISK。
- 依赖 audit 已联网完成；advisory 的当前 parser 调用链是否可利用仍需针对修复版本和恶意样本验证。
- npm run lint、npm run typecheck 未定义可执行脚本；本次不能把 node --check 视为 lint/typecheck。
