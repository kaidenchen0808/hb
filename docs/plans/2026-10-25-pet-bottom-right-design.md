# 设计：桌宠小型化 + 右下角常驻（QQ 宠物心智）

- 日期：2026-10-25
- 状态：设计已确认，待实现
- 范围：仅渲染端 `anicompanion/`（companion-layer TS 层零改动）

## 背景与目标

用户反馈 AniCompanion 桌宠尺寸太大、位置碍事。目标形态参照 QQ 宠物：

1. 尺寸小（QQ 宠物量级，屏幕高度约 1/6）
2. 常驻桌面**右下角**（托盘上方、避开 Dock）
3. **每次启动直接是小桌宠形态**（不再先出现 1000×650 大窗口）
4. 尺寸/位置/模式持久化，重启恢复

## 现状调研结论

- 主窗口是 `AppDelegate.swift` 手工创建的 `PetPanelWindow`（NSPanel 子类），windowed（1000×650）/pet（500×540 基准）两态复用
- pet 模式：borderless + nonactivatingPanel + floating + canJoinAllSpaces，裸 WKWebView 透明渲染
- 滚轮/捏合缩放 280–1100，仅内存保持；`petMode`、`currentPetSize`、窗口 frame **全部不持久化**
- 启动 `window.center()`；无停靠/位置记忆逻辑
- 无专注/勿扰模式（vision glance 的 `[silent]` 是按次自抑制，与本设计无关）
- Settings 的 Character 区几乎空白，是放新选项的自然位置（本设计暂不需要新设置项）

## 方案选择

- **A（已选）：默认值重定位 + 状态持久化**——只动窗口层，风险低
- B：A + 贴边吸附——后续增强候选
- C：A + QQ 宠物「走回去」动画——梦想清单，现阶段 YAGNI

## 详细设计

### 1. 启动流程与 petMode 持久化

```
现在：启动 → windowed 1000×650 居中 → 用户点 🐾 → enterPet() 500×540
之后：启动 → 直接 enterPet() → 小尺寸 → 右下角（或上次记住的位置）
```

- `@AppStorage("launchInPetMode")` 默认 `true`；用户显式切到 windowed 时写 `false`（老用户切一次即永久记住）
- 首次安装（无存储值）→ 默认 pet 右下角
- windowed 大窗口**面板化**：关闭 ≠ 退出 app，只是收起面板回到 pet 形态；仅 ⌘Q / 菜单 Quit 退出
- `enterPet()` 现有「先 resize → 装 webView → dispatch JS resize」顺序原样保留（CLAUDE.md 标注坑点）

### 2. 尺寸系统与气泡适配

| 参数 | 现在 | 改为 |
|---|---|---|
| 基准（进入 pet 时） | 500×540 | 280×300 |
| 滚轮/捏合下限 | 280 | 150 |
| 上限 | 1100 | 1100（不动） |

- `currentPetSize` 改为 `@AppStorage` 持久化
- **气泡不跟窗口缩**：最小可读宽 ~220pt，窗口不够宽时气泡横向溢出角色边界、向屏幕内侧（左）扩展；`bubbleSide(for:)` 翻转联动溢出方向
- 极小尺寸（<200 宽）气泡最多 3 行、超出省略号（台词在 companion-layer 侧本就限 1-2 句，不丢内容）

### 3. 位置系统（右下角计算与记忆）

```
x = visibleFrame.maxX - petWidth - 8
y = visibleFrame.minY + 8
```

- 用 `NSScreen.main?.visibleFrame`（自动扣菜单栏 + Dock，Dock 在任意边都正确）
- 持久化两层：

| 键 | 内容 | 写入时机 |
|---|---|---|
| `petFrame` | 最后位置 + 尺寸 | `windowDidMove` 防抖 500ms |
| `petAnchorScreen` | 停靠屏 `deviceIdentifier` | 同上 |

- 恢复优先级：存储的屏在线 → 原位；屏没了 → 主屏右下角（不 clamp 旧坐标）；无存储 → 主屏右下角
- 保险：恢复 frame 与所有屏 `visibleFrame` 都不相交 → 右下角
- 多屏：拖到副屏后记副屏，下次副屏原位出现

### 4. windowed 面板化与入口

打开 windowed 的 3 个入口：

1. 菜单栏 Character（⌘⇧D 改为「打开对话窗口」语义）
2. **双击她**（单击保留触摸/拖拽）
3. Settings（⌘,）照旧

- windowed 打开仍 1000×650 居中，不持久化其位置（面板心智）
- 关闭 windowed → 她「回」右下角（同一 NSPanel 两态复用，不会出现双份）
- `launchInPetMode = false` 的用户维持现状大窗口，零变化

### 5. 边界情况与错误处理

- 外接屏拔掉 / 分辨率突变 / frame 与所有屏不相交 → 回右下角
- 屏幕过窄 → 尺寸 clamp 到屏宽 90%
- UserDefaults 脏数据（NaN/负数/超大）→ 校验失败当无存储，走右下角
- **fail-safe 铁律：任何失败路径她都出现在右下角，绝不丢屏幕外**
- 崩溃丢最后一次拖动（防抖窗内）可接受
- three.js 相机不用动：fov 20° 固定、模型等比缩放，JS resize 事件带新尺寸自动更新 aspect

### 6. 测试与验证

**单元测试**（XCTest，渲染端新增 test target，只测位置计算纯函数模块 `PetFramePlanner`）：

- 右下角公式：Dock 底/右/左三种 `visibleFrame`
- 恢复优先级三分支 + 屏幕外检测
- 脏数据：NaN / 负数 / 超大值
- 尺寸 clamp：窄屏、超范围持久值

**手动验证清单**：

- [ ] 冷启动直接小桌宠右下角，无大窗口闪现
- [ ] 拖动/缩放后重启原位恢复
- [ ] 副屏拔掉后回落主屏右下角
- [ ] ⌘⇧D / 双击她开面板；红叉关面板她回右下角、app 不退；⌘Q 退出
- [ ] 小尺寸气泡左溢可读；拖到左半屏气泡翻右

**companion-layer**：零改动，`pnpm test` 过一遍确认无回归。构建按 `anicompanion/CLAUDE.md`（注意屏幕录制权限、bundle id 坑点）。

## 涉及文件

| 文件 | 改动 |
|---|---|
| `AniCompanion/App/AppDelegate.swift` | 启动流程、enterPet 初始 frame、持久化读写、windowWillClose 语义、双击手势 |
| `AniCompanion/App/AppState.swift` | 新增 @AppStorage 键（launchInPetMode / petFrame / petAnchorScreen / petSize） |
| `AniCompanion/Views/DesktopPet.swift` | 气泡溢出渲染、双击事件 |
| 新增 `PetFramePlanner` + test target | 位置计算纯函数 + XCTest |

## 后续增强候选（本次不做）

- B：贴边吸附
- C：拖走后走回右下角（walk 动画编排）
- 行为收敛（工作时段主动开口降频/静默）——属 companion-layer 层，另行设计
