# 记忆子系统设计

> 她的「记得」由四层结构组成：越靠前越短命、越靠后越持久。全部状态在
> `~/.companion-layer/data/companion.db`（SQLite/WAL，双进程共享）与 app 端
> JSONL，升级重装不丢（安装器保留 `data/`）。

## 总览

```
第 1 层  对话窗口     app 端，40 条滑动窗口        每轮必带，聊着的那份记忆
第 2 层  facts 长期记忆  网关侧，异步提取沉淀       「她记得你」的核心
第 3 层  Agent 事件    hooks 实时上报              「她看到你在干活」的视野
第 4 层  好感度/关系阶段  行为信号累积（隐藏）        决定她是谁、怎么说话
                                              ↑ 全部在每轮 system prompt 组装时注入
```

## 第 1 层：对话窗口（短期）

- **载体**：app 端 `ConversationHistory`（内存 + `HistoryStore` JSONL 持久化，
  重启不丢、UI 可翻页加载更早历史）。
- **窗口**：`contextMessages` 取最近 **40 条** 发给大脑；更早的消息只展示不进上下文。
- **文件载荷压缩**：窗口内较早轮次的 `[文件 名]…[文件结束]` 内联载荷压到
  **头部 600 字摘要**（文件名+要点常驻），最后一条 user 消息保持全文。
  动机：20k 全文每轮重发撑 token；滑出窗口后她会"忘了"文件。
- gateway 侧 `chat_history` 表同步落库每轮对话（含代查结果）作存档；上下文
  组装权在 app 端（gateway 只透传 messages）。

## 第 2 层：facts 长期记忆（核心）

**提取**：每轮聊天流结束，`settleAfterChat` 异步调直连大脑从本轮对话提取
「明天她还愿意主动提起的事实」，只收三类：

| kind | 含义 | 示例 |
|------|------|------|
| `promise` | 承诺 | 主人说这周要早睡、约好明天去深圳湾 |
| `habit` | 习惯 | 几点下班、早茶习惯、用什么工具 |
| `preference` | 偏好 | 喜欢/讨厌什么、在研究什么 |

提取 prompt 明确忽略：寒暄、临时性问题、与用户无关的技术内容。单条截 200 字。

**双层去重**（防越记越啰嗦）：
1. 提取层：已有记忆（最近 12 条）注入提取 prompt——「这些是旧的，不要重复提」
2. 插入层：字符 **2-gram Jaccard 相似度 + 包含性**判定（真实案例：「要去深圳湾
   看月亮」vs「要去深圳湾看月亮，至今还没确认去了没有」——Jaccard 仅 0.4 但
   短句 bigram 全被长句包含，包含性要求短文 ≥4 个 bigram 防两字短词误伤）

**注入**：每轮 system prompt 的「你记得的关于主人的事」清单（带记录时间），
并叮嘱「合适的时机自然想起来，像女朋友一样，不要逐条背诵」。

## 第 3 层：Agent 事件（她的视野）

```
PostToolUse hook → POST /api/events → raw_events（归档，不进视野）
Stop hook       → POST /api/aggregate → 聚合器折叠会话 → agent_events
MCP companion_report → 直进 agent_events（跳过聚合，Agent 主动汇报）
```

- 聚合把高频工具调用折叠成一句人话（"改文件 6 次、跑命令 47 次，约 25 分钟"）
- 注入为「最近桌面上 Agent 的动静」（带时间戳），叮嘱「相关的才自然提起，
  不要播报清单」
- 她聊过即 `markAllConsumed`；未消费行绝不会被清理（见保留策略）

## 第 4 层：好感度与关系阶段（隐性）

- 行为信号（对话轮/触摸/回应主动开口/深夜在场/Agent 在场）→ affinity 累加，
  **只升不降**，无 UI 无数值
- 跨 `persona.yaml` 阶段阈值：`stranger(0) → familiar(150) → close(400) →
  soulmate(800)`，各阶段有指定**称呼**（address_user）与**语气基调**（tone）
- 阶段跃迁记录 milestone → 下轮注入告白指令（各阶段有专属告白风格），说出即清除
- ≥3 天未互动注入"想念"语气
- **称呼惯性压制**：改称呼后，指令明确「只用这一个称呼，绝不要跟着历史
  对话里的旧叫法」（40 条窗口的旧称呼会让模型模仿带偏——实测踩坑）

## 边界（哪些不记忆）

- `/` 技能选择：只拼当轮 system，不进消息序列、不落库、不提取 facts
- 代查 thinking 推理过程：不进上下文（只有结果落史）
- 与用户本人无关的技术内容：提取层明确忽略
- 好感度去重：相同 lastUser 3 分钟窗口内只结算一次（客户端"重新生成"
  重发同一句不重复加分；落库/记忆照常）

## 数据治理（pruneEvents，2026-10-28）

挂 `/api/aggregate` 低频入口、进程内每日执行一次、双进程并发幂等：

| 表 | 策略 | 保护 |
|----|------|------|
| raw_events | 留 30 天 | 聚合后即弃 |
| agent_events | 删已消费的，留 90 天 | **未消费行是她的视野，绝不动** |
| outbox | 删已投递的，留 90 天 | **未投递绝不动** |

## 关键文件

| 关注点 | 位置 |
|--------|------|
| 窗口/压缩 | `anicompanion/…/Models/ConversationHistory.swift` |
| facts 提取/去重/注入 | `src/memory/facts.ts`、`src/persona/promptBuilder.ts` |
| 事件聚合/视野/清理 | `src/memory/aggregator.ts`、`eventStore.ts` |
| 好感度/阶段/里程碑 | `src/memory/relationship.ts`、`persona/persona.yaml` |
| system 组装 | `src/persona/promptBuilder.ts`（buildContextBlock） |
