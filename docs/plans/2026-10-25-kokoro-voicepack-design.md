# 设计：内置 Kokoro 高音质语音包（解决 TTS 生硬）

- 日期：2026-10-25
- 状态：设计已确认（brainstorm 逐段过审），待实现
- 范围：渲染端 `anicompanion/`（companion-layer TS 层零改动）

## 背景与目标

用户反馈 AniCompanion 的声音生硬（诊断：TTS 走 Apple 本地 compact 级语音，机器味重），想要"志玲姐姐"级别的悦耳女声。经澄清：**近似即可、自然悦耳为先**；不走系统语音下载；要 **app 内置解决方案**；**按需下载语音包、之后完全本地离线**（免费）。

目标：新增 on-device 神经网络 TTS——sherpa-onnx 运行时 + Kokoro-82M 中文 int8 模型，以"语音包"形式从 GitHub Release 一次下载、永久离线使用，声线含 8 款中文（默认温柔女声小妮）。

## 现状调研结论

- TTS 是插件制（`TTSProvider` enum registry：apple/miniMax/openAI/blueMagpie），加 case 即进 Settings 下拉；所有 service 输出 WAV Data，唇形 RMS/AudioQueue 管线与 provider 无关
- 项目零 SPM 依赖铁律（three.js 走 CDN、无第三方包）——解压用系统 `/usr/bin/ditto`，sha256 用 CryptoKit（系统框架），不引 ZIPFoundation
- sherpa-onnx 官方支持 macOS 全离线 + Kokoro 中文（含 Swift/Apple 集成先例、M 系列快于实时）；Kokoro 中文 dist：model + tokens + voices/*.bin（8 声线）+ espeak-ng-data，int8 量化版预计 ~90-160MB
- 用户 fork（catsmice/AniCompanion）可挂 Release 资产；VRMDownloader（已删）的 delegate-session 进度模式可复刻

## 决策记录（brainstorm 问答确定）

| 问题 | 决定 | 备选被拒原因 |
|---|---|---|
| 声音期望 | C：先解决生硬、自然悦耳即可，非必须志玲本人 | 克隆有声音权法律风险；近似音色目标下 Kokoro 免费达成 |
| 成本取向 | C：先免费；最终选**完全本地免费** | 云端 MiniMax 音质上限高但长期付费+联网，留作后备路径（app 已支持，零代码） |
| "内置"含义 | C：内置"语音包下载"——首启从 GitHub Release 拉模型到 app 数据目录，之后完全离线 | A（打进安装包）使包体 +100MB 级；B（内置云端 key）联网+付费 |
| 引擎选型 | 1：sherpa-onnx + Kokoro 中文 | MeloTTS 音质中上不及 Kokoro；Piper 达不到"悦耳"；三者集成工作量相同 |
| 量化版本 | int8 优先（~1/3 体积、更快、音质损失可忽略） | 双包（int8+fp32）让用户选——无必要 |
| 断点续传/自动升级 | 不做（YAGNI）：失败整包重试；manifest 版本号为未来留钩子 | 复杂度不值 |
| 语速设置 | 不做（默认 1.0） | 用户未要求 |

## 详细设计

### 1. 总体架构与数据流

```
Settings Voice 区（三态：未安装/下载中/已安装）
  → VoicepackStore（新；对标 VRMModelStore 模式）
      目录 ~/Library/Application Support/AniCompanion/Voicepack/kokoro/
      install()：空间预检 → delegate-session 下载 → sha256 → ditto 解压 → 原子落位
  → KokoroTTSService（新；实现 TTSServiceProtocol，与 AppleTTSService 同形）
      SherpaOnnxEngine 封装 libsherpa-onnx-c-api（官方预编译 dylib）
      文本 → 后台线程推理 → 24kHz 16bit WAV Data → 现有 AudioQueue/唇形管线零改动
```

### 2. 语音包分发

- Release 资产（产品主人手动发布）：`kokoro-zh-v1.zip`（官方 dist int8 版全套）+ `.sha256`
- `scripts/make-voicepack.sh`：下载官方 dist → 重打包 → sha256 → `gh release upload`（注释标注终端需代理）
- 安装五步：磁盘预检（≥2× 包体）→ 下载 `.download.tmp`（进度回调）→ CryptoKit sha256 比对 → `ditto -x -k` 解 `.staging/` → `FileManager.replaceItem` 原子落位 + 写 `manifest.json`（版本+日期）
- 任何一步失败清理临时物，不留半装状态

### 3. sherpa-onnx 集成与 KokoroTTSService

- 二进制：官方 macOS arm64 预编译 `libsherpa-onnx-c-api.dylib` + 头文件入 `AniCompanion/Libraries/sherpa-onnx/`，project.yml 声明 + `xcodegen generate`。**备选**：dylib 签名冲突时自编 static xcframework
- `SherpaOnnxEngine`（唯一碰 C API 的层）：`offline_tts_create`（Kokoro 配置、num_threads=2）句柄常驻；`offline_tts_generate(text, sid, speed)` → float32 samples；互斥锁单并发
- `KokoroTTSService.synthesize(text) async throws -> Data`：float32→int16→44 字节 WAV 头（24kHz mono）；惰性加载（首次合成 create，1-3s，常驻 ~500MB；reinit 销毁重建）；合成在后台线程
- 声线 = generate 的 sid 参数，与 Settings 下拉直通

### 4. Settings UI 与无缝体验

- `TTSProvider` 加 `.kokoro`（"Kokoro (on-device, 高音质)"）自动进下拉
- Voice 区三态：未安装 → 语音包卡片（体积说明+下载按钮+进度条+错误重试）；下载中 → 进度+百分比（关窗再开不丢，VoicepackStore 单例 @Published）；已安装 → 声线下拉（8 款友好名：小妮·温柔女声·默认/小贝/小晓/小依/云健/云希/云夏/云扬）+ 试听（复用 isTestingVoice）
- **体验闭环**：下载完成自动切 Kokoro + 自动试听一句
- `@AppStorage("tts_kokoro_voice")` 默认 `zf_xiaoni`；Save → reinit → makeTTSService 按 case 构造（与其他 provider 同构）
- 首跑向导不动（出厂 Apple，语音包为进阶选项）；全部新字符串 en + zh-Hant

### 5. 错误处理与边界

| 故障 | 行为 |
|---|---|
| 磁盘不足 | 预检报错不开始 |
| 断网 | 进度停+错误+重试；tmp 清理 |
| sha256 不符 / ditto 失败 | 清理+报错+重试 |
| 模型加载/推理失败 | 抛错 → 气泡提示一次 + 自动回落 Apple provider |
| 单句失败 | 冒泡显示，AudioQueue 跳过继续 |

边界：下载单例防重入；`isInstalled` 校验关键文件（model+tokens+voices/）存在，被手动删自动回未安装态；下载中切 provider/关窗不影响下载。

## 测试策略

- 单测（注入临时目录沿 VRMModelStore 先例）：VoicepackStore 安装判定/清单/校验；WAV 封装（纯函数：头字段+长度）；声线映射表完整性
- Engine/Service 依赖真实 dylib+模型，不进单测，manual checklist 覆盖：下载全链路（自动试听）、断网重试、8 声线切换、三方 provider 切换、删目录回落、静隐模式兼容、双语

## 实现拆分预估（6 task）

① dylib 接入 + SherpaOnnxEngine → ② VoicepackStore + 单测 → ③ KokoroTTSService + WAV + 单测 → ④ Provider case + Settings 三态 + 下载闭环 → ⑤ make-voicepack.sh + 本地化 → ⑥ CLAUDE.md

## 涉及文件（预估）

| 文件 | 改动 |
|---|---|
| 新 `AniCompanion/Libraries/sherpa-onnx/`（dylib + headers） | 二进制接入 |
| `project.yml` | dylib 引用（改后 xcodegen） |
| 新 `AniCompanion/Services/SherpaOnnxEngine.swift` | C API 封装 |
| 新 `AniCompanion/Services/KokoroTTSService.swift` | TTSServiceProtocol 实现 + WAV 封装 |
| 新 `AniCompanion/Services/VoicepackStore.swift` | 下载/校验/解压/清单 |
| `AniCompanion/Services/TTSProvider`（所在文件） | 加 case + 声线映射 |
| `AniCompanion/App/AppState.swift` | @AppStorage tts_kokoro_voice、makeTTSService 分支 |
| `AniCompanion/Views/SettingsView.swift` | Voice 区三态 UI |
| 新 `scripts/make-voicepack.sh` | 发布打包 |
| `Resources/Localizable.xcstrings` | 新字符串双语 |
| `CLAUDE.md` | TTS 节更新 |
