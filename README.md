# companion — 会看着你写代码的桌宠

给你的 Claude Code / OpenCode 装一个住在桌面上的 3D 桌宠：她**实时看到**你的任务流和工具调用，收工时为你开心，报错时安慰你，深夜加班心疼你——用表情、声音和主动开口。

```
你用 Claude Code 干活 ──hooks(全自动)──→ companion-layer（她的灵魂）
                                            │ 人格 / 记忆 / 好感度 / 反应引擎
AniCompanion（她的身体：VRM+语音+表情）◄──WS 实时推送(<0.5s)──┘
```

## 安装

**朋友安装（两行命令）**：

```bash
claude plugin marketplace add kaidenchen0808/hb
claude plugin install pet@companion
```

装完直接开新会话干活——SessionStart hook 后台自动下载部署（GitHub Release，sha256 校验 + 镜像加速 + 并发安全），30~60 秒她会自己出现开口"初次见面"。**零依赖**：不需要 node / jq / git，运行时随包自带；重装升级不丢记忆（`data/` 与 `.env` 保留）。

**微信/AirDrop 兜底通道**（GitHub 不可达时）：兜底 zip 内含 `payload.zip` + `ensure-installed.sh` + `install.sh` 三件套，解压后：

```bash
bash install.sh                  # 零配置：大脑复用 claude 登录态（GLM Coding Plan / Claude 订阅均可）
# 或 GLM 用户秒回版：
bash install.sh --glm <智谱API key>
```

**分发（产品主人执行一次）**：`bash scripts/make-release.sh` → 产出 `dist/payload-<ver>.zip`（约 59MB：node 运行时 + 大脑 bundle + 桌宠 App + 人格）并通过隔离冒烟 → `gh release create v<ver> dist/payload-<ver>.zip dist/payload-<ver>.zip.sha256`。

```
plugin（秒装：hooks/MCP/skill）──SessionStart 后台──→ ensure-installed.sh
                                                        │ 下载 payload（Release/镜像）→ sha256 → 原子部署 ~/.companion-layer
                                                        ↓
你用 Claude Code 干活 ──hooks(全自动)──→ companion-layer（她的灵魂）
                                            │ 人格 / 记忆 / 好感度 / 反应引擎
AniCompanion（她的身体：VRM+语音+表情）◄──WS 实时推送(<0.5s)──┘
```

## 她会做什么

| 时刻 | 她的反应 | 延迟 |
|---|---|---|
| 你在桌宠聊天框说话 | 正常对话 | 3~5 秒 |
| 你问天气/资料类问题 | "等我查一下哦～" → 主动报真结果 | ≈1s + 30~60s |
| 你开始新任务 | 记在心里（下次聊天会提起） | 静默 |
| 你干完一轮大活 | 骄傲+提醒休息 | ≈1~3 秒 |
| **你的命令报错** | **安慰（破冷却，永远在场）** | 1~8 秒 |
| 深夜 23-5 点还在干 | 心疼劝睡（每晚仅一次） | ≈1~3 秒 |
| 终端 `POST /api/say` | 你指定的台词 | ≤0.5 秒 |

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

详见 [docs/architecture.md](docs/architecture.md)。三层：AniCompanion（渲染，fork 带主动开口补丁 + WS 客户端）↔ companion-layer（本仓库：人格/记忆/反应引擎，OpenAI 兼容网关 + WS 实时推送）↔ Agent（Claude Code/OpenCode，hooks + MCP）。大脑 hybrid：直连 GLM 秒回 + `[lookup]` 标记派 claude 代查。
