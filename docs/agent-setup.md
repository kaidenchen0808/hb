# 接入手册

## AniCompanion（渲染端）

1. 从 [Releases](https://github.com/catsmice/AniCompanion/releases) 下载 `.dmg`（需 macOS 15+ / Apple Silicon）
2. 先启动本服务：`pnpm start`
3. AniCompanion → Settings (⚙️) → Agent backend → **OpenAI-compatible**
   - Endpoint: `http://127.0.0.1:8787`
   - API Key: 随意填（除非你在 `.env` 配了 `COMPANION_API_KEY`）
4. 连接指示器变绿即可对话。想换她的人格/名字/称呼：编辑 `persona/persona.yaml` 后重启本服务。

## Claude Code（全自动 hooks + MCP）

一键安装（推荐，与朋友通道相同）：

```bash
claude plugin marketplace add kaidenchen0808/hb
claude plugin install pet@companion
```

装好后 SessionStart hook 会自动部署 `~/.companion-layer`（node 运行时 + 大脑 + 桌宠 App）。

手工配置：

```bash
# MCP（手动汇报兜底 + 查询她知道的事）
claude mcp add companion -s user -- node /path/to/hb/bin/companion-mcp.js
```

hooks（把 `hooks/claude-settings-snippet.json` 的 `hooks` 字段合并进 `~/.claude/settings.json`，
路径改为本仓库绝对路径；依赖 `jq` 和 `curl`）：

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "bash /path/to/hb/hooks/report-event.sh PostToolUse" }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "bash /path/to/hb/hooks/stop-claude.sh" }] }
    ]
  }
}
```

配好后 Claude Code 每次工具调用会归档、每轮结束会聚合成一条"她听得懂"的事件。

## OpenCode

MCP 方式（`~/.config/opencode/opencode.json`）：

```json
{
  "mcp": {
    "companion": { "type": "local", "command": ["node", "/path/to/hb/bin/companion-mcp.js"] }
  }
}
```

OpenCode 即可通过 `companion_report` / `companion_get_context` 与她互通。
（hooks 自动上报依赖 OpenCode 的 plugin/hook 机制，版本迭代较快，
请以[官方文档](https://opencode.ai/docs)为准，参考 Claude Code 的
report-event.sh 写一个 fetch 上报到 `/api/events` 的 plugin 即可。）

## Codex（未安装时备用）

`~/.codex/config.toml`：

```toml
[mcp_servers.companion]
command = "node"
args = ["/path/to/hb/bin/companion-mcp.js"]
```

## 大脑（必须）

`.env` 三项（任意 OpenAI 兼容网关：LiteLLM / AI Hub / OpenRouter / GLM …）：

```ini
BRAIN_BASE_URL=http://127.0.0.1:4000/v1
BRAIN_API_KEY=sk-xxx
BRAIN_MODEL=your-model
```

## 验证清单

- [ ] `curl localhost:8787/health` 返回 `{"status":"ok",...}`
- [ ] `pnpm test` 全绿
- [ ] 跑一轮 Claude Code 后 `curl 'localhost:8787/api/events?limit=5'` 出现聚合事件
- [ ] AniCompanion 聊天正常、回复带表情变化
- [ ] 安静几分钟，看她是否主动聊起你刚才干的活
