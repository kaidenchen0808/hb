# 桌宠 plugin 分发方案设计

日期：2026-10-10
状态：已确认（与产品主人逐段评审通过）

## 背景与目标

当前离线 bundle 安装（unzip → bash install.sh）对朋友有四道坎，全部要消灭：

1. **前置依赖**：node ≥ 23.6 / pnpm / jq，朋友机器上大概率没有
2. **要开终端**：解压 zip、跑 install.sh
3. **Gatekeeper 拦截**：ad-hoc 签名 App 首开被拦，要教"右键 → 打开"
4. **步骤多**：收 zip → 解压 → 跑脚本 → 处理拦截

决策：不走"单一 App zip + 首启向导"（方案 A），改走 **Claude Code plugin 分发 + hook 首启自装**（方案 D）。理由：目标用户必在用 Claude Code，plugin 机制恰好覆盖接入层（hooks/MCP/skills），重资源由首次 hook 自动下载，把安装成本压到"粘贴一行命令"。

已查证的关键事实（2026-10-09 官方文档）：

- plugin 可自带 `hooks/hooks.json`（全部事件，结构与 settings.json 一致）、`.mcp.json`（command 可指向任意可执行）、skills
- 一行非交互安装：`claude plugin marketplace add <source> && claude plugin install <name>@<marketplace>`
- plugin 装完 hooks 即注册，下一会话 SessionStart 必触发；hook cwd 是用户项目目录，引用 plugin 文件必须用 `${CLAUDE_PLUGIN_ROOT}`
- 重二进制不适合塞 plugin 仓库（git clone 120s 超时风险），首启下载安装是官方推荐的替代路径

## 用户旅程（最终体验）

朋友的全部操作 = 粘贴一行：

```bash
claude plugin marketplace add chenxuewei/companion && claude plugin install pet@companion
```

plugin 本体几十 KB（纯脚本，秒装）。之后照常打开 Claude Code 干活：

```
SessionStart hook（startup，后台不阻塞）
  └─ ensure-installed.sh：检测未安装 → nohup 后台安装进程，脚本毫秒级退出
       │  ← 后台进程 disowned，claude 关不关都不影响
       ├─ 下载 payload ~60MB ......... 10s~2min（GitHub 直连失败自动切 ghproxy）
       ├─ 部署 + launchd load ........ ~3s
       └─ xattr 清 quarantine + open App ~2s
            └─ 她出现，开口"初次见面"  ← 距 hook 触发 = 下载耗时 + ~5s，无需重启/新会话
```

前置依赖归零：node/pnpm/jq 由 payload 自带；claude CLI 是用户本来就有的。

**硬约束**：startup 型 SessionStart hook 虽然后台运行，但 Claude 首个回复会等它结束——ensure-installed 必须 spawn 后台进程后立即 exit 0，绝不同步等下载。

## Gatekeeper 无感处理

从网络下载的 App 带 quarantine 属性，首开被拦。安装器在 `open` 前执行：

```bash
xattr -dr com.apple.quarantine /Applications/AniCompanion.app
```

自己的产品、用户主动安装，与 brew cask `--no-quarantine` 同理。朋友永远不需要知道"右键打开"是什么。

## 仓库与 plugin 结构

一个仓库两用：`hb` 根目录注册为 marketplace，plugin 源码在 `plugin/` 子目录。

```
hb/
  .claude-plugin/marketplace.json     # 声明 pet plugin → ./plugin（相对路径 source）
  plugin/
    .claude-plugin/plugin.json
    hooks/hooks.json                  # 四事件，exec 形式引用 ${CLAUDE_PLUGIN_ROOT}/scripts/...
    .mcp.json                         # command → scripts/mcp-launcher.sh
    scripts/
      report-event.sh                 # 现有 hooks/ 迁移
      stop-claude.sh
      ensure-installed.sh             # 新：首次安装器
      ensure-running.sh               # 已有：SessionStart 顺带拉活
      mcp-launcher.sh                 # 幂等 ensure → exec node brain-mcp.js
    skills/pet/SKILL.md               # /pet 说话、/pet status 自检
```

注意：plugin 根目录的 `bin/` 会导致 claude.ai/Cowork 拒装，脚本一律放 `scripts/`。

### hooks 细节

- `hooks.json` 与现有 settings 里的 hooks 结构一致，原样拷贝；命令改 exec 形式（command + args），引用 `${CLAUDE_PLUGIN_ROOT}`（执行 cwd 是用户项目目录，不能相对路径）
- SessionStart 只用 `type: command`（startup 时 MCP 未连接）
- 上报地址 `localhost:8787` 不变；服务未起时静默失败 + 顺带 ensure-running（现有逻辑）

### MCP 首启时序

plugin 装完 claude 立即拉 MCP server，此时大脑可能没就绪。`.mcp.json` 指向 `mcp-launcher.sh`：就绪则 exec，未就绪快速失败退出。首个会话无 MCP 工具（不影响 hooks 主通道：当次会话报错安慰/收工反应均正常，plugin hooks 加载时即注册），装好后下个会话自动恢复。

## 安装器（ensure-installed.sh）

### 下载源与原子性

- payload：GitHub Release `payload-<version>.zip`（node 23 官方 arm64 单文件 + esbuild 打包的 brain.js + brain-mcp.js + AniCompanion.app.zip + persona），附 sha256
- 下载源 fallback：GitHub 直连 → ghproxy 镜像 → 失败静默退出等下次 SessionStart 重试
- 下载落临时目录，sha256 校验通过后原子 `mv` 进位——不留半个坏目录；校验失败重下一次，再失败放弃
- 部署目标 `~/.companion-layer`：node + brain.js + persona + hooks + launchd plist

### 并发控制：mkdir 原子锁 + 状态机

macOS 无 `flock` 命令，用 `mkdir` 原子锁（零依赖）：

```
ensure-installed.sh 入口：
  1. mkdir ~/.companion-layer.install.lock   ← 原子，全局只有一个窗口成功
  2. 成功者 → 写 pid + 时间 → 下载/部署/launchd/xattr/open → 写 installed 标记 → 释放锁
  3. 失败者（其他窗口）→ 静默退出（毫秒返回）
```

死锁残留：抢锁失败时检查锁目录 pid/mtime——持有者已死或超 10 分钟（下载最坏上界）→ 清锁重试一次。

状态机（快路径只读状态文件，不抢锁）：

```
absent ──→ installing ──→ installed
              │ 状态文件 ~/.companion-layer/.state
              └ 中断 → 下次抢到锁后续装/重装（重装前只清代码目录）
```

### 其他触点幂等性（无需锁）

| 触点 | 并发行为 |
|---|---|
| ensure-running | 先 curl /health；两窗口同时冷启动最多多一个进程因端口占用秒退，无害 |
| `open -a AniCompanion` | macOS 单实例语义，重复 open 仅前置窗口 |
| 事件上报 | 纯 HTTP POST，服务端天然并发 |
| MCP launcher | 每会话独立进程，claude 管理生命周期 |

## 更新机制

- plugin 带 `VERSION` 文件声明期望 payload 版本；SessionStart 快路径比对，不一致 → 锁内重部署
- **数据与代码分离**：`data/companion.db`（记忆/好感度）与用户改过的 `persona/` 重装时原样保留——她不失忆
- plugin 本体更新走 `/plugin update`（marketplace auto-update 默认关，手动够用）

## 错误处理（安装器全程静默，绝不打断 agent 会话）

| 故障 | 行为 |
|---|---|
| 下载失败 | 切镜像；再失败静默退出，下次 SessionStart 幂等重试 |
| 下载中断进程被杀 | 临时目录 + 原子 mv；状态机回 absent 续装 |
| sha256 失败 | 重下一次，再失败等下次 |
| 服务起不来 | 日志 `/tmp/companion-install.log`；`/pet status` 一键诊断（复用 check.sh 四环节） |
| 残留锁 | TTL + pid 检测清理 |

## 发布物

`make-bundle.sh` → `make-release.sh`：

1. esbuild 打 `src/` → `brain.js` / `brain-mcp.js`（依赖全纯 JS + node:sqlite，零打包风险）
2. 组装 payload：node 二进制（本地缓存 node-v23-macos-arm64）+ brain + AniCompanion.app.zip + persona → `payload-<version>.zip` + sha256
3. 产物冒烟：本地拉起 → `/health` ok 才算成功
4. 上传 GitHub Release

**兜底通道保留**：微信 zip 给网络差的朋友；`install.sh` 瘦身，复用同一套 ensure-installed 逻辑。

## 测试

- 现有 vitest 单测全保留（brain.js 是同一份源码的产物）
- 新增集成测试（本地 http server 模拟下载源）：
  - 并行 5 个 ensure-installed → 只下载一次、部署完整
  - 伪造过期锁 → 被清理
  - mcp-launcher 未就绪快速退出 / 就绪正常 exec
- E2E 手动清单：全新机器完整链路、旧版升级（记忆保留）、断网中断恢复、双窗口并发
- make-release 产物冒烟

## 二期（本期不做）

- OpenCode 适配：JS 进程内插件 + npm 分发（无 marketplace），复用同一 payload/大脑，仅接入层不同
- x64 payload（朋友们现全为 Apple Silicon）
- DMG 分发形态
