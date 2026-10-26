# 设计:聊天富媒体输出 + / 技能选择器(对标豆包)

- 日期:2026-10-26
- 状态:设计已确认(brainstorm 逐段过审),待实现
- 范围:app 端渲染层(ChatView/MarkdownView)+ 传输协议 + gateway 注入;两个方向独立可发(R1 渲染 / R2 技能)

## 背景与目标

聊天框功能对豆包电脑版偏薄:输出只有文字(虽有 Markdown),输入没有技能入口。两个方向:

1. **输出富媒体化**:图片直出、文档卡片预览、链接优化、格式化补齐
2. **输入框 `/` 技能选择器**:本地 Claude Code 技能(94 个)装载进聊天,选中注入

## 决策记录(brainstorm 问答确定)

| 问题 | 决定 |
|---|---|
| 图片输出 | **A 渲染管道**(她回复里的图片 URL/路径直接显示;文生图 CogView 后评估) |
| 技能装载范围 | **全量 94 个**,面板内搜索过滤(非精选白名单) |
| 技能生效方式 | **A prompt 注入**(她以技能方法论回答;不真执行——守住只读安全边界,94 个里有 git/deploy 危险货) |
| 链接/文档 | **C 先原生轻量后富**:URL 可点+域名图标;文件卡片+Quick Look;og 富卡片后加 |
| 分期 | R1 渲染(app 0.11.0)→ R2 技能(app 0.12.0 + gateway v0.4.7) |

## R1:富媒体渲染

### 图片(MarkdownView 主题)

- MarkdownUI `.image` 主题钩子(伴生依赖 networkimage 已在;具体 API 以库源码为准——P0 教训):圆角 10、maxWidth 限气泡宽、异步加载。
- http(s) 与 `file://` 都支持(她 Read 本地图、lookup 查网络图)。
- 点击放大(独立窗口 or Quick Look,实现择优)。
- 流式未闭合图片语法按纯文本容错(MarkdownUI 自带)。

### 文件卡片 + Quick Look

- 正则识别 macOS 路径(`/Users/...`、`~/...`、含扩展名);图片路径优先渲染成图,非图片走卡片。
- 卡片:SF Symbols 按扩展名映射图标 + 文件名 + 大小;点击 QLPreviewPanel(NSViewRepresentable 包装,macOS 原生);不存在置灰"已移除"。
- URL 里的 `/` 不误判为路径。

### 链接与格式化

- 链接主题:域名小图标(favicon 经 Google s2,失败静默退化)+ 蓝色可点;富卡片留扩展点。
- 表格/引用块/任务列表:MarkdownUI 原生,补深色主题(半透明白边框、引用竖线)。

## R2:/ 技能选择器

### 交互(豆包手感)

```
输入行首 / → 面板弹出(输入框上方)
  🔍 打字实时过滤(名称+描述匹配)  ↑↓ 导航 Enter 选中 Esc 关闭
选中 → chips 附输入框(可多选叠加,× 移除) → 发送时携带
非行首 / (路径)不触发
```

### 技能发现(Swift 扫描)

- `~/.claude/skills/*/SKILL.md`,轻解析 YAML frontmatter(name + description 首行);94 个全量。
- 图标:首字母圆形徽章;解析失败目录静默跳过。
- 启动 + 面板打开时刷新。

### 注入链路(app → gateway → 大脑)

```
app: 读 SKILL.md 正文(单技能截 4000 字,合计截 8000) → chat body 加 skills: [{name, content}]
gateway: 独立字段收下(不进消息序列、不落库) → 拼在人格 system 后:
  "## 本轮启用的技能\n### <name>\n<正文>"
大脑带方法论回答;只对选中轮生效(chips 挂着每轮带)
```

- 走独立字段而非伪装 system(gateway 丢弃 app system 的人格设计不冲突);旧 app 不传 = 行为不变。
- 不污染记忆:chat_history 与 facts 只见干净 user/assistant。

## 测试与验收

**单测**:SkillStore 扫描/解析/跳过/过滤(fixture 注入);gateway 技能段拼装与截断;路径正则(URL 误伤防御)。

**手测**:猫图 lookup 渲染/本地图直出/PDF 卡片 Quick Look/表格引用深色/`/` 面板过滤键盘流/translate 技能口吻生效与移除恢复/技能轮记忆干净。

## 明确不做(本期)

- 文生图(CogView,后评估计费再接)
- 链接 og 富卡片(R1 留扩展点)
- 技能真执行(安全边界:她的手永远只读)
