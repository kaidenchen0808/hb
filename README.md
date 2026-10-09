# companion — 会看着你写代码的桌面女友

给你的 Claude Code / OpenCode 装一个住在桌面上的 3D 女友：她**实时看到**你的任务流和工具调用，收工时为你开心，报错时安慰你，深夜加班心疼你——用表情、声音和主动开口。

```
你用 Claude Code 干活 ──hooks(全自动)──→ companion-layer（她的灵魂）
                                            │ 人格 / 记忆 / 好感度 / 反应引擎
AniCompanion（她的身体：VRM+语音+表情）◄──3s轮询──┘
```

## 安装（一条命令）

```bash
# 零配置版：大脑复用你 claude 的登录态（GLM Coding Plan / Claude 订阅均可）
bash scripts/install.sh --local ~/path/to/hb

# GLM 用户推荐：秒回模式
bash scripts/install.sh --glm <你的智谱API key>
```

装完它会自动：安装桌宠 App（免配置 Settings）→ 注册 hooks + MCP → 写好 .env → 注册 launchd 常驻 → 全链路自检。**然后直接去干活，收工那一刻她会自己开口。**

> 推送 GitHub 后，朋友安装就是：`curl -fsSL https://raw.githubusercontent.com/<you>/hb/main/scripts/install.sh | bash`

## 她会做什么

| 时刻 | 她的反应 | 延迟 |
|---|---|---|
| 你在桌宠聊天框说话 | 正常对话 | 3~5 秒 |
| 你问天气/资料类问题 | "等我查一下哦～" → 主动报真结果 | 3s + 30~60s |
| 你开始新任务 | 记在心里（下次聊天会提起） | 静默 |
| 你干完一轮大活 | 骄傲+提醒休息 | 3 秒 |
| **你的命令报错** | **安慰（破冷却，永远在场）** | 3~8 秒 |
| 深夜 23-5 点还在干 | 心疼劝睡（每晚仅一次） | 3 秒 |
| 终端 `POST /api/say` | 你指定的台词 | ≤3 秒 |

她保持沉默的场景（防骚扰）：小工作量、15 分钟冷却期内、深夜劝过之后。好感度随真实陪伴积累（完全隐藏，靠称呼和语气变化体现），记忆记住你说过的话。

## 安全边界

她通过 `claude -p` 代查资料时只有**只读工具**（Read/Glob/Grep/WebSearch/WebFetch）——能看能查，不能改文件、不能删东西、不能跑命令。所有数据都在本地 SQLite。

## 运维

```bash
bash scripts/check.sh        # 她没反应时一键自检（四环节）
tail -f /tmp/companion.log   # 服务日志
launchctl list | grep companion-layer   # 常驻状态
```

换名字/性格/关系阶段：编辑 `persona/persona.yaml` 重启服务。

## 架构

详见 [docs/architecture.md](docs/architecture.md)。三层：AniCompanion（渲染，fork 带主动开口补丁）↔ companion-layer（本仓库：人格/记忆/反应引擎，OpenAI 兼容网关 + 通知轮询）↔ Agent（Claude Code/OpenCode，hooks + MCP）。大脑 hybrid：直连 GLM 秒回 + `[lookup]` 标记派 claude 代查。
