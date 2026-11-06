# Lumina MCP Server

让 Cursor、Claude Code、Claude Desktop 等外部 Agent 通过 MCP 查询（以及可选地写入）Lumina 的 `wiki/`，并用**调用方自己的模型**生成答案。

## 两种接入方式

| 方式 | 何时可用 | 能力 |
|------|----------|------|
| **HTTP**（App 内） | Lumina 正在运行，且 Settings → MCP server 已启用 | 全部工具；共享 App 的热索引（FlexSearch + QMD）；`ingest_with_lumina` 仅此方式提供 |
| **stdio CLI** | 任何时候（不需要 App 运行） | 检索 + 可选写入；QMD 只读复用 App 已建好的索引和已下载的 embedding 模型（不会自行下载或生成 embedding） |

### HTTP 配置

Settings → **MCP server** → 打开开关 → Save。首次启用会生成 bearer token。把面板里的 HTTP 片段复制到 `~/.cursor/mcp.json`（或其他客户端的 MCP 配置）：

```json
{
  "mcpServers": {
    "lumina": {
      "url": "http://127.0.0.1:8765/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### stdio 配置

用 App 自带的 Electron 运行时以 Node 模式启动 CLI，无需单独安装 Node：

```json
{
  "mcpServers": {
    "lumina": {
      "command": "/Applications/Lumina.app/Contents/MacOS/Lumina",
      "args": [
        "/Applications/Lumina.app/Contents/Resources/app.asar/dist/main/mcp/cli.js",
        "--vault", "/path/to/vault"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

CLI 参数：

- `--vault <path>`：默认 vault（工具调用不传 `vault` 时使用）。优先级：`--vault` > 环境变量 `LUMINA_VAULT` > App 最近打开的 vault。App 的 vault 列表非空时可省略。
- `--allow-write`：注册写入工具（或在 App 里打开 “Allow writing wiki pages”，CLI 会读取同一设置）。
- `--user-data <dir>`：App 的 userData 目录（默认 `~/Library/Application Support/Lumina`），用于读取 QMD 设置和 embedding 模型。

开发环境：`npm run build:main && npm run mcp -- --vault <path>`（`npm run` 会向 stdout 打印头部，客户端配置里请直接用 `electron dist/main/mcp/cli.js`）。

## 多 vault

可访问的 vault = App 的 vault 列表（Vault switcher 历史），CLI 额外包括显式传入的 `--vault`。列表外的路径一律拒绝。

- `list_vaults()` 返回 `[{name, path, default, initialized}]`。
- 所有工具和两个 Prompt 都接受可选参数 `vault`：可以是名称（不区分大小写）或完整路径；省略时使用默认 vault（HTTP：App 当前打开的 vault；CLI：`--vault`）。同名 vault 需用路径区分。
- HTTP 模式下当前打开的 vault 使用 App 的热索引；其他 vault 按需加载独立索引（最多同时 3 个，LRU 释放），QMD 复用该 vault 已有的索引，不在此时生成 embedding。
- 写入开关对所有 vault 统一生效；`ingest_with_lumina` 也可指定 `vault`，所有 vault 的 Lumina ingest 共用一个串行队列。

## 工具

| 工具 | 默认 | 说明 |
|------|------|------|
| `list_vaults()` | ✅ | 可访问的 vault 列表及默认 vault |
| `search_wiki(query, limit?)` | ✅ | QMD 就绪时走 hybrid（BM25 + 向量），否则 FlexSearch |
| `get_article(filename)` | ✅ | 读取 `wiki/` 下页面（frontmatter + 正文）；`wiki/` 前缀可省略 |
| `list_articles(prefix?, tag?, limit?)` | ✅ | 按目录前缀 / 标签过滤，最近修改优先 |
| `get_backlinks(title)` | ✅ | 哪些页面 `[[链接]]` 到该标题 |
| `ingest_source(path, mode?)` | ✅ | 提取 `raw/` 源文件内容（与 App 内同一实现，只读） |
| `lumina_status()` | ✅ | vault、页面数、搜索引擎、QMD 状态、已启用能力 |
| `write_wiki_page(path, content, overwrite?)` | 需 Allow write | 只能写 `wiki/**.md`；已存在需 `overwrite: true` |
| `append_wiki_log(operation, title, details?)` | 需 Allow write | 按 `## [YYYY-MM-DD] op \| title` 格式追加到 `wiki/log.md` |
| `ingest_with_lumina(path, note?)` | 需 Allow ingest（仅 HTTP） | 由 Lumina 自己的 LLM 完整执行 ingest；串行执行，发送进度通知，返回回复与变更文件 |

## Prompts（用调用方的模型生成答案）

MCP 没有让服务端“借用”调用方模型的通用方式（sampling 客户端支持很少），因此 Lumina 提供 Prompt 模板，由调用方的模型按步骤调用上面的工具：

- `answer_from_wiki(question)`：检索 → 阅读 → 带 `wiki/...` 引用作答；wiki 没覆盖时明确说明。
- `ingest(path)`：把 vault 的 `CLAUDE.md` + `INGEST.md` 映射为 MCP 工具（`write_wiki_page` 代替 shell heredoc 等），让调用方模型完成 ingest。需要开启写入。

在 Cursor 中可直接让 Agent “用 lumina 的 answer_from_wiki 回答 …”，或在支持 Prompt 的客户端里选择该 Prompt。

## 安全边界

- 不暴露 `shell`、API key、聊天记录。
- HTTP 只绑定 `127.0.0.1`，必须携带 bearer token（常量时间比较），并校验 Host / Origin 以防 DNS rebinding 与浏览器跨站调用。
- 写入与 Lumina ingest 两个开关默认关闭；切换即时生效（无需重启服务）。Regenerate 会立即使旧 token 失效。
- `write_wiki_page` 拒绝绝对路径、`..`、隐藏目录、非 `.md`、`raw/`，并按 realpath 校验，符号链接也无法逃出 `wiki/`。
- `ingest_with_lumina` 只接受 `raw/` 下已存在的文件，附加说明最长 500 字符，在独立会话中串行执行（不影响 App 内对话），20 分钟超时。

## 代码结构

| 文件 | 作用 |
|------|------|
| `src/mcp/server-factory.ts` | 注册工具 / Prompt（与传输无关） |
| `src/mcp/vault-registry.ts` | `vault` 参数解析、按需加载与 LRU 缓存 |
| `src/mcp/backend.ts` | `LuminaBackend`：vault 读取、搜索、Prompt 文本 |
| `src/mcp/wiki-write.ts` | 受限写入与 log 格式 |
| `src/mcp/cli.ts` | stdio 入口（不加载 electron） |
| `src/core/vault-runtime.ts` / `headless-config.ts` | CLI 用的无 Electron vault 服务与配置解析 |
| `src/main/services/mcp-http-service.ts` | 127.0.0.1 HTTP + 鉴权 |
| `src/main/services/mcp-app-server.ts` | App 内生命周期与设置同步 |
| `src/main/services/lumina-ingest-runner.ts` | `ingest_with_lumina` 执行器 |
