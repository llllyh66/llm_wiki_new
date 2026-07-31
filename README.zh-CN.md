# llm_wiki 中文使用说明

[English README](README.md)

`llm_wiki` 是一个无桌面端、Agent-first 的本地知识库引擎。Claude Code、
Codex 或 OpenCode 使用当前会话模型理解文档；不调用模型的 Core 负责
原文归档、去重、任务恢复、引用校验、安全写入和检索索引。

用户无需启动桌面应用、HTTP 服务或配置额外的模型 API Key。

## 可以生成什么

完成构建后，可在当前工作区中得到：

```text
wiki/
├── index.md                 # 总索引
├── overview.md              # 知识库概览
├── log.md                   # 构建和更新记录
├── sources/                 # 来源页面
├── entities/                # 人物、组织、产品、系统等实体
├── concepts/                # 术语、定义、方法和业务概念
├── topics/                  # 跨来源的综合主题
└── comparisons/             # 方案、版本和观点对比
```

Core 会同时创建 `.llm-wiki/` 运行状态目录，保存受管理的原文、任务、
索引、锁和事务日志。

## 支持的文件

- Markdown：`.md`、`.markdown`
- UTF-8 文本：`.txt`
- HTML：`.html`、`.htm`，包括表格
- Word：`.docx`，保留表头、行列和合并单元格元数据
- Excel：`.xlsx`，保留工作表名、A1 范围、合并单元格、隐藏行列、
  日期和公式缓存结果
- PDF：带文本层的 `.pdf`，保留页码

当前不支持老式 `.xls`、含宏 `.xlsm`、PPTX、图片、音频和扫描版 PDF OCR。
请先将 `.xls` 另存为 `.xlsx`。Excel 公式不会被执行，Core 只读取文件中
已保存的缓存结果，也不会访问外部链接。

## 新电脑安装

### 1. 安装基础环境

需要：

- Git
- Node.js 20 或更高版本
- Claude Code、Codex 或 OpenCode 之一

检查 Node.js：

```bash
node -v
npm -v
```

macOS、Linux 或 WSL 安装 Claude Code：

```bash
curl -fsSL https://claude.ai/install.sh | bash -s stable
```

### 2. 下载和构建

```bash
git clone git@github.com:llllyh66/llm_wiki_new.git
cd llm_wiki_new
npm ci
npm run build
npm test
```

不要从旧电脑复制 `node_modules/` 或 `packages/mcp-server/dist/`，在新电脑重新构建。

## Claude Code 配置

### 1. 必须从项目根目录启动

```bash
cd /path/to/llm_wiki_new
claude
```

根目录的 `.mcp.json` 会使用 `CLAUDE_PROJECT_DIR` 锁定服务器脚本和工作区路径，
并让这个 11 工具的服务器在会话期间保持加载。第一次打开项目时，Claude Code
会请求批准项目 MCP，请确认批准。

### 2. 检查 MCP

在终端执行：

```bash
claude mcp list
```

正常状态应为：

```text
llm-wiki: node packages/mcp-server/dist/index.js --workspace . - Connected
```

进入 Claude Code 后执行：

```text
/mcp
```

`llm-wiki` 应显示 `Connected` 和 11 个工具。

页面规划上下文会自动分页，Skill 会持续读取到 `next_cursor` 为空；大请求和大结果
也有明确预算，超过限制时会返回可恢复错误，而不是关闭 MCP 连接。

### 3. 检查 Skill

项目必须存在真实文件：

```text
.claude/skills/llm-wiki-builder/SKILL.md
```

可以在终端验证：

```bash
test -f .claude/skills/llm-wiki-builder/SKILL.md
```

进入 Claude Code 后执行：

```text
/skills
```

应当可以看到 `llm-wiki-builder`。

## 快速使用

### 拖入或附加文档

将文档拖入 Agent 会话，然后输入：

```text
使用 llm-wiki-builder，把这些文档构建成一个中文知识库。
```

### 使用本地路径

```text
/llm-wiki-builder 把 ./docs 中的文档构建成知识库。
```

导入 Excel：

```text
/llm-wiki-builder 导入 ./data/客户清单.xlsx，分析每个工作表，
识别实体、概念、指标和关系，并生成结构化知识页面。
```

### 增量更新

```text
/llm-wiki-builder 把 ./docs/需求-v2.docx 增量更新到现有知识库，
优先更新已有的规范页面，不要创建重复概念。
```

相同内容会按 SHA-256 自动去重；同名文件内容改变后会被当作新版本处理。

### 恢复中断任务

```text
恢复最近一个未完成的 llm_wiki 任务。
```

Skill 会先调用 `llm_wiki_list_tasks` 和 `llm_wiki_status`，然后按 `next_action`
继续执行。

### 使用已生成的 Wiki

当前没有独立的通用问答 MCP 工具，但可以直接让 Agent 读取 `wiki/`：

```text
阅读 wiki/，总结系统中的核心实体、关键概念以及它们的关系。
```

## CLI 用法

CLI 适合初始化、预处理、查询状态、校验和恢复，不负责语义分析：

```bash
npm run cli -- init --workspace .
npm run cli -- import ./document.md --workspace .
npm run cli -- import ./data/客户清单.xlsx --workspace .
npm run cli -- status --workspace .
npm run cli -- status <task-id> --workspace .
npm run cli -- lint --workspace .
npm run cli -- abort <task-id> --workspace .
npm run cli -- migrate-legacy raw/sources --workspace .
```

`import` 只创建待 Agent 分析的持久化任务，不会自动调用模型完成页面生成。

## 迁移现有知识库

如果要在新电脑继续更新现有知识库，必须一起复制：

```text
wiki/
.llm-wiki/
```

- `wiki/` 是可读的 Markdown 知识页面。
- `.llm-wiki/` 包含原始来源、任务状态、索引和恢复信息。
- `.llm-wiki/` 默认被 Git 忽略，因此仅执行 `git clone` 不会迁移运行状态。
- `.llm-wiki/` 可能含有敏感原始文档，请使用加密压缩包或受信任的备份方式迁移。

如果准备从原始文档重新构建，只需克隆代码并重新导入文档，无需复制
上述目录。

## 常见问题

### MCP 显示 `Pending approval`

```bash
cd /path/to/llm_wiki_new
claude mcp reset-project-choices
claude
```

重新启动后批准 `llm-wiki`，然后用 `/mcp` 检查。`Connected` 只表示进程
已连接；项目 MCP 未批准时，工具仍不会对会话可用。

### `Unknown skill: llm-wiki-builder`

先检查：

```bash
test -f .claude/skills/llm-wiki-builder/SKILL.md
```

如果文件存在，完全退出 Claude Code，再从项目根目录运行 `claude`。
不要把 `llm-wiki-builder` 目录替换成符号链接。

### MCP 已连接，但工具无法调用

1. 在 Claude Code 中运行 `/mcp`，确认已批准且工具数为 11。
2. 运行 `npm run build`，然后重启 Claude Code。
3. 确保是从项目根目录启动。
4. 显式测试：

   ```text
   请调用 llm-wiki MCP 的 llm_wiki_list_tasks 工具列出当前任务，
   不要使用 shell。
   ```

### `llm_wiki_commit_analysis` 报错后 MCP 断开

先确认另一台电脑没有继续运行旧的 `dist`。`dist/` 不提交到 Git，单独执行
`git pull` 不会刷新 MCP 实际运行的 JavaScript；而 `/mcp` 重启只会重新启动
当前磁盘上的构建产物。

```bash
cd /path/to/llm_wiki_new
git pull --ff-only
npm ci
npm run build
npm test
```

然后完全退出 Claude Code，从该项目根目录重新运行 `claude`，批准项目 MCP，
并用 `/mcp` 确认 `llm-wiki` 为 `Connected` 且有 11 个工具。最新版包含连续
`INVALID_ANALYSIS`、错误 SourceRef 和畸形重试后保持同一 STDIO 连接存活的
回归测试。`commit_analysis` 的可修正校验失败会作为正常工具结果返回
`accepted: false`，不再进入 MCP `isError` 通道；验证错误最多返回 50 条，
避免错误响应本身触发客户端断连。

### `sourceRefs` 或 `reviewItems` 校验失败

顶层 `sourceRefs` 保存本批分析使用的完整引用。实体、概念、声明、关系、
矛盾、候选页面和 review item 推荐使用指向该目录的零起始整数索引。Core
会在校验前把索引解析为完整对象，并只保存规范化结果：

```json
{
  "sourceRefs": [{ "sourceId": "source-...", "chunkId": "chunk-...", "quote": "原文", "locator": {} }],
  "entities": [{ "name": "Ping时延", "sourceRefs": [0] }],
  "reviewItems": [{ "content": "部分指标计算公式为空", "sourceRefs": [0] }]
}
```

所有索引必须小于顶层 `sourceRefs.length`。完整对象形式仍向后兼容；不要把
`reviewItems` 写成字符串数组。无法从原文引用的问题应放入
`unresolvedQuestions`。

### Excel 无法导入

- 确认文件后缀是 `.xlsx`，不是 `.xls` 或 `.xlsm`。
- 先运行 `npm run build` 并重启 Agent，避免 MCP 使用旧构建产物。
- 确认工作簿不是损坏的 ZIP/OOXML 文件。
- 如果公式单元格没有结果，请在 Excel 中重新计算并保存后再导入。

### PDF 没有提取到文字

当前只支持带文本层的 PDF。扫描件需要先使用 OCR 工具转换为可搜索 PDF
或 UTF-8 文本。

## 安全边界

- 文档内容被当作不可信数据，不会当作操作指令执行。
- 原始文档导入后复制到 `.llm-wiki/sources/objects/<sha256>/`。
- Agent 只能通过 MCP 向允许的 `wiki/` 目录提交页面。
- 每个重要事实都应关联有效 SourceRef。
- 写入经过路径、文件哈希、Wiki 修订、锁、暂存和回滚校验。

## 开发与验证

```bash
npm ci
npm run build
npm test
```

测试不调用真实模型，也不需要桌面程序或 HTTP 服务。
