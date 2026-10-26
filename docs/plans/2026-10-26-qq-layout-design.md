# 设计:QQ 式主窗口布局(聊天左 / 角色右 / 可拖动分隔条)

- 日期:2026-10-26
- 状态:设计已确认(brainstorm 逐段过审),待实现
- 范围:仅 `anicompanion/AniCompanion/Views/MainView.swift`(布局对调 + 分隔条)+ 一个纯逻辑工具 + 单测;桌宠小窗形态不动

## 背景与目标

现状是 VRM 角色居左(弹性主导)、聊天面板居右(~360 固定)。用户要**腾讯 QQ 聊天布局心智**:消息流是主角居左,她像"QQ 秀资料卡"一样常驻右侧,中间一道可拖动的分栏线,比例拖到哪记到哪。

## 决策记录(brainstorm 问答确定)

| 问题 | 决定 |
|---|---|
| 改造幅度 | C:对调 + 聊天主导弹性 + 可拖分隔条 + 比例记忆(非纯镜像/非只调比例) |
| "桌宠放右边"的范围 | A:只指主窗口的 VRM 角色区;右下角桌宠小窗(迷你形态)保持现状 |
| 默认比例 | 聊天 58% / 角色 42%(窗口 900pt 最小时她 ≈378pt,高于 300pt minWidth) |
| 拖动范围 | clamp 30% ~ 70%,两边各留最小生存空间 |
| 分隔条样式 | 1pt 半透明线;hover 光标 ↔ + 微亮;8pt 拖动热区;SwiftUI DragGesture(不碰 AppKit) |

## 布局结构

```
┌─────────────────────────────┬──┬──────────────────┐
│  ChatView(消息流+输入框)     │拖│   VRM 角色        │
│  宽度 = 窗口宽 × ratio       │条│   minWidth 300    │
│  默认 58%                    │  │   默认 42%         │
└─────────────────────────────┴──┴──────────────────┘
  左:聊天(QQ 消息流心智)          右:她(QQ秀资料卡心智)
```

```swift
HStack(spacing: 0) {
    ChatView(...).frame(width: windowWidth * ratio)   // 左:聊天
    PanelDivider(ratio: $chatRatio)                    // 8pt 热区 / 1pt 视觉线
    ThreeVRMRenderView(...).frame(minWidth: 300)       // 右:角色
}
.frame(minWidth: 900, minHeight: 600)                  // 窗口最小尺寸不变
```

## 组件设计

### PanelDivider(新,~40 行)

- `@Binding var ratio: CGFloat`;8pt 宽热区,中间 `Rectangle().fill()` 1pt 线。
- hover 态:`.onHover` 切换线体 opacity + `NSCursor.resizeLeftRight` push/pop。
- `DragGesture(minimumDistance: 1)`:`ratio = clamp(ratio + translation.width / windowWidth, 0.3, 0.7)`——translation 直接映射比例增量,松手即持久化(@AppStorage 自动写)。
- 拖到 clamp 边界继续拖:ratio 不变但手势活跃,不跳变。

### 持久化

- `@AppStorage("main_chat_ratio") private var chatRatio = 0.58`。
- 渲染时对存储值防御性 clamp(防手改 plist 的脏值)。
- 往返场景零额外管理:进桌宠模式拆 MainView → 退出恢复;静隐/语言切换/重启同理。

## 不动的部分

- `LiveCaptionOverlay` 挂在 VRM 区 overlay,随她挪到右侧,零改动。
- VRM 键盘相机控制(W/S/A/D/Q/E/R/F):分隔条是兄弟视图,鼠标事件不穿透,无冲突。
- 桌宠小窗(右下角常驻、拖拽、quiet form)完全不动。
- ChatView 内部(消息流/输入框/思考面板)零改动。

## 测试与验收

- **单测**:抽纯逻辑 `PanelLayout.computeRatio(_ raw: CGFloat) -> CGFloat`(clamp),XCTest 覆盖:正常值原样、越界(0.05/0.95/负数/NaN)钳到边界、默认 0.58。
- **手测清单**:
  - [ ] 拖动跟手无跳变,光标 ↔ 正确
  - [ ] 松手重启 app 比例保留
  - [ ] 拖到两极限(30%/70%)聊天与她都 ≥300pt 可用
  - [ ] 窗口拉伸两边按比例同步
  - [ ] 进出桌宠模式布局比例不丢
  - [ ] 她区域内 W/S/A/D 相机控制照常
  - [ ] 字幕浮层跟随她在右侧正常显示

## 明确不做(YAGNI)

- 分隔条双击复位默认(后续可加)
- 比例按会话记忆(AppStorage 全局一份足够)
- 桌宠小窗位置调整
