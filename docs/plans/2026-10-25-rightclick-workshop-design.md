# 设计：右键菜单 + 桌宠工坊 + 显示模式（陪伴/静隐）

- 日期：2026-10-25
- 状态：设计已确认（brainstorm 逐段过审），待实现
- 范围：仅渲染端 `anicompanion/`（companion-layer TS 层零改动）

## 背景与目标

桌宠形态（QQ 宠物式右下角小窗）已落地，但用户可操作性不足：她不显示任何菜单、VRM 模型管理藏在 Settings 的 Character 区深处、没有"让她安静一会儿"的开关。目标：

1. 桌宠上**右键弹菜单**：显示模式切换、「桌宠工坊…」、「设置…」、退出桌宠
2. **桌宠工坊**独立窗口：用户自助导入 VRM 模型、在多模型间切换
3. SettingsView 新增**「模式」**（陪伴/静隐）与**「关于」**两区

## 现状调研结论

- 当前**没有任何右键菜单**（全仓无 contextMenu/NSMenu 命中）；桌宠模式的 `PetDragView`（裸 NSView）只处理拖动/单击摸头/双击退出，未覆写 `rightMouseDown`
- `VRMModelStore` 已具备工坊核心能力：双目录模型发现（bundle 只读 + 用户目录）、`importModel`（NSOpenPanel → 拷入，重名加 " 2"）、`embeddedTitle`（解析 VRM 0.x/1.0 内嵌标题）、`resolve` 用户目录优先；UI 藏在 `SettingsView` 的 `VRMModelPicker`
- `SettingsView`（480×640，edit-then-save）双挂载：Settings Scene（⌘，）+ MainView sheet；无"关于"页
- 配置全部 `@AppStorage`；`petMode: Bool` 是窗口形态开关，与"显示模式"正交
- 已知坑直接相关：同一 view 双 sheet 只弹一个（新窗口用 `Window` 规避）；`enterPet` 先 setFrame 再装 webView 的顺序铁律；本地化必须走 `Localizable.xcstrings`

## 决策记录（brainstorm 问答确定）

| 问题 | 决定 | 备选被拒原因 |
|---|---|---|
| "模式"指什么 | **显示模式**：陪伴（现状）/ 静隐（缩小驻留角落） | 语音模式、勿扰模式均非所需 |
| 静隐形态 | **B：缩小驻留角落**（半透明小形态贴右下，不说话不冒泡，点击恢复、右键弹菜单） | 完全隐藏需要额外常驻唤回入口；隐藏+通知链路更长 |
| 右键「设置」打开什么 | **A：复用现有 SettingsView**，加「关于」「模式」两区 | 新建精简设置页 → 两个设置页心智分裂 |
| 工坊与现有 VRMModelPicker 关系 | **A：工坊独立窗口，功能从 Settings 挪过去**，Character 区留"管理模型…"跳转 | 两处保留完整功能 → 双入口维护同一件事易长歪 |
| 工坊预览 | 第一版**纯名字列表**（显示名+文件名+来源标签），无 3D 缩略图 | 3D 预览需离屏渲染/截图缓存，成本高，YAGNI |
| 静隐期间推送消息 | **静默丢弃显示，不补播**（WS 不断；服务端记忆/好感度照常累积，反应引擎自带冷却） | 排队补播会恢复后刷屏 |
| 静隐尺寸 | **固定常量 ~80×86pt**，不可配置 | 用户可配尺寸是过度设计 |
| 模式在 Settings 的生效时机 | 跟随 **edit-then-save**（保存时生效）；即时切换由右键菜单承担 | Settings 保持"配置"心智 |

## 详细设计

### 1. 右键菜单（新）

挂点：`PetDragView`（`Views/DesktopPet.swift`）新增覆写 `rightMouseDown`，弹 AppKit `NSMenu`（桌宠模式无 SwiftUI 树，NSMenu 是唯一正路）：

```
右键她 →
├─ 陪伴模式 / 静隐模式     （勾选式，随当前状态）
├─ ─────────────
├─ 桌宠工坊…
├─ 设置…
└─ 退出桌宠（与双击同款 onExit）
```

- 菜单项事件经闭包回调转发 `AppDelegate`（与现有 `onTap`/`onExit` 风格一致）
- 窗口聊天模式**不加**右键（已有 ⚙️，避免两套心智）
- 「桌宠工坊…」「设置…」的打开链路：`AppDelegate` → `AppState.workshopRequested / settingsRequested`（@Published）→ App 层 `.onChange` → `openWindow(id:)`（SwiftUI 原生，规避 selector 魔法）

### 2. 显示模式状态机（新）

- `AppState` 新增 `displayMode: DisplayMode`（enum：`companion` / `quiet`），与 `petMode: Bool` **正交**——静隐只是桌宠形态的子状态，窗口模式下不生效（持久化照写，效果进桌宠时体现）
- 持久化 `@AppStorage("display_mode")`
- 三个改同一状态的入口：右键菜单勾选、Settings「模式」区、点击驻留形态恢复

### 3. 静隐模式

**视觉**：复用同一 VRM 渲染（零美术资源）——窗口缩到固定 ~80×86pt、`WKWebView.alphaValue` 降到 ~40%、驻留屏幕右下角（复用 `PetFramePlanner` bottom-right 锚定）。她还是她，只是躲起来休息。

**进出逻辑**（`AppDelegate.enterQuiet()` / `exitQuiet()`，与 enterPet/exitPet 同层）：

- 进入：保存当前 pet 位置/尺寸 → 缩窗+降透明+移角落；若正在说话立即停 TTS、清气泡
- 静隐期间：不 TTS 不冒泡；companion-layer 推来的 say 帧静默丢弃显示（WS 不断，服务端状态不受影响）
- 恢复：单击驻留形态 → 恢复原位置/尺寸/透明度；双击保持"退出桌宠"；右键菜单勾选切回
- 启动：`display_mode == quiet` 且进桌宠 → 直接以静隐形态出现（先定 frame 再显示，不闪现大形态）
- 静隐期间可拖动驻留形态，但恢复时回保存的原位置（驻留位置不持久化）

### 4. 桌宠工坊（独立窗口）

- `AniCompanionApp` 注册 `Window("Pet Workshop", id: "workshop")`，普通 titled 窗口 ~520×420
- **即时生效**（无 Save 按钮，符合"换装照镜子"直觉；区别于 Settings 的 edit-then-save）：
  - 模型列表：`VRMModelStore.availableModels()` 现成数据；每行 = 内嵌标题显示名 + 文件名小字 + 来源标签（内置/已导入）；当前模型打勾，点击即切换（现有 `loadModel` live 重载链）
  - 导入："Import VRM…" → NSOpenPanel（限定 `.vrm`）→ 现成 `importModel`；成功后自动选中新模型
  - 删除：仅用户导入模型可删（bundled 禁用），确认 alert；删当前模型则先切回内置再删

**Settings 侧交接**：`VRMModelPicker` 整体移除，Character 区改为「当前模型：小光」+「管理模型…」→ 同款 `openWindow` 呼出工坊。单一事实来源。

右键「设置…」同链路打开 Settings 窗口（⌘， 的 Settings Scene 保留不变）。

### 5. SettingsView 新增两区

**「模式」区**（`SettingsSection(title: "Mode", icon: "person.fill")`，插在 Connection 之前）：

- 显示模式 Picker（segmented：陪伴/静隐），本地 @State 副本，`saveSettings()` 时应用
- footer 说明：静隐 = 缩到屏幕角落安静休息，不说话不冒泡；点击她随时唤回

**「关于」区**（所有区最后）：

- app 图标 + 名称 + 版本号（`CFBundleShortVersionString`）+ 一句话简介
- 致谢：Alicia Solid 版权说明（文案来自 `ATTRIBUTION.md`，版权敏感必带）、three-vrm / three.js / Mixamo 动画来源
- 纯静态 `Text`，无交互无保存语义

所有新字符串走 `Text("…")` + `Localizable.xcstrings`（en + zh-Hant）。

## 错误处理与边界

- 导入失败（磁盘满/权限）→ 工坊内 alert 友好提示，列表不变
- 删除当前模型 → 顺序保证：先切回内置（live reload）再删文件；`FileManager` 失败 alert 提示并回滚 UI 勾选
- 模型文件被外部手动删 → `availableModels()` 只列实际存在文件 + `effectiveVRMModelFilename` fallback，天然防御
- 切换后 JS 加载失败 → 沿用现有失败路径（JS console → 日志，保持上一帧），工坊勾选与 `vrm_model_filename` 一致即可
- 说话中途进静隐 → 停 TTS + 清气泡
- 工坊/设置用 `Window` 不用 sheet → 规避"同一 view 双 sheet"坑

## 测试策略

单测（anicompanion 已有 XCTest target，`PetFramePlanner` 纯逻辑先例）：

- `DisplayMode` 状态机转换
- 静隐 frame 规划：扩展 `PetFramePlanner` 测试（缩小尺寸 + 角落锚定 + 恢复原位）
- `VRMModelStore` 删除/回退/重名导入（注入临时目录）

手工 checklist（沿 `docs/manual-checklist` 先例）：

- 右键菜单全项；静隐进出全链路（含说话中途进入、启动直达静隐不闪现）
- 工坊导入 → 切换 → 删除当前模型 → 回退内置
- Settings 两区显示与保存生效；zh-Hant / en 双语过一遍

## 涉及文件（预估）

| 文件 | 改动 |
|---|---|
| `Views/DesktopPet.swift` | `PetDragView` 覆写 `rightMouseDown` → NSMenu + 回调闭包 |
| `App/AppState.swift` | `displayMode`、`workshopRequested`/`settingsRequested` |
| `App/AppDelegate.swift` | `enterQuiet()`/`exitQuiet()`、菜单动作分发 |
| `App/AniCompanionApp.swift` | `Window(id: "workshop")` 注册 + openWindow 桥接 |
| `Views/SettingsView.swift` | 移除 `VRMModelPicker`、新增「模式」「关于」区、Character 区跳转行 |
| 新 `Views/WorkshopView.swift` | 工坊窗口内容 |
| `Character/VRMModelStore.swift` | 删除模型 API（导入/发现已有） |
| 新 `PetFramePlanner` 扩展 | 静隐 frame 计算（纯几何） |
| `Resources/Localizable.xcstrings` | 全部新字符串（en + zh-Hant） |
