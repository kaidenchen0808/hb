# 桌宠 Plugin 分发实现计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 朋友粘贴一行 `claude plugin marketplace add` + `plugin install` 后，SessionStart hook 后台自动下载部署大脑与桌宠 App，30~60 秒她开口"初次见面"。

**Architecture:** plugin（纯脚本，秒装）自带 hooks/MCP/skills；重资源（node 运行时 + brain bundle + App）打成 payload zip 发 GitHub Release；`ensure-installed.sh` 用 mkdir 原子锁 + 状态机做幂等并发安全的后台安装器；hook 脚本全部去 jq 化（纯 bash + payload 自带 node）。

**Tech Stack:** bash（系统自带，零外部依赖）、esbuild、vitest（集成测试用 child_process 跑 bash + node http 模拟下载源）、node 23（payload 内嵌运行时）。

**设计文档:** `docs/plans/2026-10-10-plugin-distribution-design.md`（先读，本计划不重复设计论证）

**全局约定:**
- 安装根目录 `$COMPANION_ROOT`（默认 `$HOME/.companion-layer`）——所有脚本/测试必须支持环境变量 override，测试绝不碰真实 HOME
- payload zip 结构：`payload/{node, brain.mjs, brain-mcp.mjs, persona/persona.yaml, AniCompanion.app.zip, VERSION}`
- 测试跳过位：`COMPANION_SKIP_APP=1`（不写 /Applications）、`COMPANION_SKIP_LAUNCHD=1`（只写 plist 不 load）、`COMPANION_SKIP_OPEN=1`（不 open App）；测试时三者全置 1 且 HOME 指向临时目录
- 每个任务一个 commit，`git add` 只加本任务文件（工作区有 unrelated 改动 `src/memory/reactions.ts`、`tests/memory.test.ts`，不要带进去）

---

### Task 1: esbuild 打包大脑

**Files:**
- Modify: `package.json`（devDependencies + scripts）
- Create: `.gitignore` 追加 `dist/`（如已有 dist 条目则跳过）

**Step 1: 安装 esbuild**

Run: `pnpm add -D esbuild`
Expected: package.json devDependencies 出现 esbuild

**Step 2: 加 build scripts**

`package.json` scripts 增加：

```json
"build:brain": "esbuild src/index.ts --bundle --platform=node --format=esm --outfile=dist/brain.mjs --external:better-sqlite3 && esbuild src/mcp/server-main.ts --bundle --platform=node --format=esm --outfile=dist/brain-mcp.mjs"
```

注意：`node:sqlite` 等 node builtin esbuild 自动 external，无需列出。若 bundle 时出现 dynamic import 警告，检查对应模块是否需要追加 `--external`。

**Step 3: 构建并冒烟**

```bash
pnpm build:brain && (PORT=18899 node dist/brain.mjs &>/tmp/brain-smoke.log & echo $! >/tmp/brain-smoke.pid) && sleep 2 && curl -s -m 2 http://127.0.0.1:18899/health
kill $(cat /tmp/brain-smoke.pid)
```

Expected: health 返回 `{"status":"ok",...}`。若失败看 `/tmp/brain-smoke.log`（常见：dotenv 找不到 .env——brain 读环境变量有默认值则无碍；DB_PATH 落在 cwd，冒烟时 cwd 是仓库根，可接受）

**Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml .gitignore
git commit -m "feat: esbuild 打包大脑为单文件 brain.mjs / brain-mcp.mjs"
```

---

### Task 2: ensure-installed.sh 安装器（TDD，核心任务）

**Files:**
- Create: `plugin/scripts/ensure-installed.sh`
- Test: `tests/installer.test.ts`

**Step 1: 写失败测试**

`tests/installer.test.ts` 完整代码：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer, type Server } from 'node:http'
import { execFileSync, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = join(REPO, 'plugin/scripts/ensure-installed.sh')
const VERSION = '0.1.0-test'

// --- 本地下载源：serve 一个假 payload zip ---
let server: Server
let port = 0
let downloadCount = 0

function makePayloadZip(dir: string): string {
  const payloadDir = join(dir, 'payload-src')
  mkdirSync(join(payloadDir, 'persona'), { recursive: true })
  // 假 node：可执行脚本，识别自己
  writeFileSync(join(payloadDir, 'node'), '#!/bin/sh\necho fake-node\n')
  chmodSync(join(payloadDir, 'node'), 0o755)
  writeFileSync(join(payloadDir, 'brain.mjs'), '// fake brain\n')
  writeFileSync(join(payloadDir, 'brain-mcp.mjs'), '// fake mcp\n')
  writeFileSync(join(payloadDir, 'VERSION'), VERSION + '\n')
  writeFileSync(join(payloadDir, 'persona', 'persona.yaml'), 'name: test\n')
  writeFileSync(join(payloadDir, 'AniCompanion.app.zip'), 'fake-app-zip')
  const zip = join(dir, `payload-${VERSION}.zip`)
  execFileSync('zip', ['-q', '-r', zip, 'payload'], { cwd: dir })
  return zip
}

function zipSha256(zip: string): string {
  return execFileSync('shasum', ['-a', '256', zip]).toString().split(' ')[0]
}

/** 跑一次安装器（继承环境 + 测试 override） */
function runInstaller(env: Record<string, string>, args: string[] = []) {
  return spawnSync('bash', [SCRIPT, ...args], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 30_000,
  })
}

function testEnv(root: string, extra: Record<string, string> = {}) {
  const home = join(root, 'home')
  mkdirSync(home, { recursive: true })
  return {
    HOME: home, // launchd plist 写 $HOME/Library/LaunchAgents，defaults 同理
    COMPANION_ROOT,
    PAYLOAD_BASE: `http://127.0.0.1:${port}`,
    EXPECT_VERSION: VERSION,
    COMPANION_SKIP_APP: '1',
    COMPANION_SKIP_LAUNCHD: '1',
    COMPANION_SKIP_OPEN: '1',
    COMPANION_INSTALL_LOG: join(root, 'install.log'),
    ...extra,
  }
}

let COMPANION_ROOT: string

beforeAll(async () => {
  const staging = mkdtempSync(join(tmpdir(), 'companion-installer-test-'))
  COMPANION_ROOT = join(staging, 'root')
  const zip = makePayloadZip(staging)
  const sha = zipSha256(zip)
  server = createServer((req, res) => {
    if (req.url?.endsWith('.sha256')) {
      res.end(`${sha}  payload-${VERSION}.zip\n`)
      return
    }
    downloadCount++
    res.setHeader('content-type', 'application/zip')
    res.end(readFileSync(zip))
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))
})

afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

describe('ensure-installed.sh', () => {
  it('全新安装：部署 node/brain/persona，状态 installed，写 launchd plist', () => {
    const res = runInstaller(testEnv(mkdtempSync(join(tmpdir(), 't-'))))
    expect(res.status).toBe(0)
    expect(existsSync(join(COMPANION_ROOT, 'node'))).toBe(true)
    expect(existsSync(join(COMPANION_ROOT, 'brain.mjs'))).toBe(true)
    expect(existsSync(join(COMPANION_ROOT, 'persona', 'persona.yaml'))).toBe(true)
    expect(readFileSync(join(COMPANION_ROOT, '.state'), 'utf8')).toContain(VERSION)
    const plist = join(process.env.HOME!, 'Library/LaunchAgents/companion-layer.plist')
    // HOME 被 override，plist 应在假 HOME 下
    const fakePlist = join(COMPANION_ROOT, '..', 'home', 'Library', 'LaunchAgents', 'companion-layer.plist')
    expect(existsSync(fakePlist)).toBe(true)
    expect(readFileSync(fakePlist, 'utf8')).toContain('brain.mjs')
  })

  it('同版本快路径：不发下载请求，毫秒返回', () => {
    const before = downloadCount
    const res = runInstaller(testEnv(mkdtempSync(join(tmpdir(), 't-'))))
    expect(res.status).toBe(0)
    expect(downloadCount).toBe(before) // 注意：此用例复用同一 COMPANION_ROOT，state 已 installed
  })

  it('并发 5 实例：只下载一次，部署完整', () => {
    const fresh = mkdtempSync(join(tmpdir(), 't-'))
    const env = testEnv(fresh)
    const before = downloadCount
    const procs = Array.from({ length: 5 }, () =>
      spawnSync('bash', [SCRIPT], { env, encoding: 'utf8', timeout: 30_000 }))
    procs.forEach((p) => expect(p.status).toBe(0))
    expect(downloadCount).toBe(before + 1)
    expect(existsSync(join(COMPANION_ROOT, 'brain.mjs'))).toBe(true)
    expect(existsSync(COMPANION_ROOT + '.install.lock')).toBe(false) // 锁已释放
  })

  it('版本变更重装：data/companion.db 保留（她不失忆）', () => {
    const db = join(COMPANION_ROOT, 'data', 'companion.db')
    mkdirSync(dirname(db), { recursive: true })
    writeFileSync(db, 'PRECIOUS MEMORY')
    const res = runInstaller(testEnv(mkdtempSync(join(tmpdir(), 't-')), { EXPECT_VERSION: '0.2.0-test' }), ['--force-version'])
    expect(res.status).toBe(0)
    expect(readFileSync(db, 'utf8')).toBe('PRECIOUS MEMORY')
    expect(readFileSync(join(COMPANION_ROOT, 'VERSION'), 'utf8')).toBe('0.2.0-test\n')
  })

  it('过期锁被清理后可正常安装', () => {
    const fresh = mkdtempSync(join(tmpdir(), 't-'))
    const env = testEnv(fresh)
    mkdirSync(COMPANION_ROOT + '.install.lock', { recursive: true })
    // 把 mtime 改到 11 分钟前 → TTL 过期
    execFileSync('touch', ['-t', '200001010000', COMPANION_ROOT + '.install.lock'])
    const res = runInstaller(env)
    expect(res.status).toBe(0)
    expect(existsSync(join(COMPANION_ROOT, 'node'))).toBe(true)
  })
})
```

注意用例间共享 `COMPANION_ROOT`（beforeAll 建一次），第 2/4 用例依赖前面的安装状态——按顺序执行，勿加并发。`--force-version` 参数用于测试强制重装。

**Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/installer.test.ts`
Expected: FAIL（脚本不存在）

**Step 3: 实现 ensure-installed.sh**

`plugin/scripts/ensure-installed.sh` 完整代码：

```bash
#!/usr/bin/env bash
# companion 首启安装器：幂等、并发安全（mkdir 原子锁）、全程静默、绝不阻塞会话
# 用法：bash ensure-installed.sh [--force-version]
#   本脚本设计为被 SessionStart hook 以 nohup 后台方式拉起，或由 install.sh 前台调用
# 环境变量（均可在测试中 override）：
#   COMPANION_ROOT   安装根目录（默认 ~/.companion-layer）
#   PAYLOAD_BASE     下载源基址（默认 GitHub Release；测试指向本地）
#   EXPECT_VERSION   期望版本（默认读脚本同目录 ../VERSION）
#   COMPANION_SKIP_APP/LAUNCHD/OPEN=1  测试跳过位
#   COMPANION_INSTALL_LOG  日志路径（默认 /tmp/companion-install.log）
set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPANION_ROOT="${COMPANION_ROOT:-$HOME/.companion-layer}"
PAYLOAD_BASE="${PAYLOAD_BASE:-https://github.com/chenxuewei/hb/releases/latest/download}"
DEFAULT_VERSION="$(cat "$SCRIPT_DIR/../VERSION" 2>/dev/null | tr -d '[:space:]')"
EXPECT_VERSION="${EXPECT_VERSION:-$DEFAULT_VERSION}"
LOG="${COMPANION_INSTALL_LOG:-/tmp/companion-install.log}"
LOCK_DIR="$COMPANION_ROOT.install.lock"
LOCK_TTL=600  # 秒：下载最坏情况上界
FORCE_VERSION=0
[ "${1:-}" = "--force-version" ] && FORCE_VERSION=1

log() { printf '%s %s\n' "$(date '+%m-%d %H:%M:%S')" "$*" >> "$LOG" 2>/dev/null || true; }

state_file() { cat "$COMPANION_ROOT/.state" 2>/dev/null || echo ""; }
write_state() { mkdir -p "$COMPANION_ROOT" && printf '%s' "$1" > "$COMPANION_ROOT/.state"; }

# ---------- 快路径：已装且版本一致（毫秒返回，不抢锁） ----------
if [ "$FORCE_VERSION" = "0" ] && [ "$(state_file)" = "installed:$EXPECT_VERSION" ]; then
  exit 0
fi

# ---------- mkdir 原子锁 ----------
acquire_lock() {
  if mkdir "$LOCK_DIR" 2>/dev/null; then
    printf '%s' "$$" > "$LOCK_DIR/pid"
    return 0
  fi
  # 锁存在：检查持有者存活 + TTL
  local holder_pid; holder_pid="$(cat "$LOCK_DIR/pid" 2>/dev/null || echo '')"
  local age; age=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || echo 0) ))
  if { [ -n "$holder_pid" ] && ! kill -0 "$holder_pid" 2>/dev/null; } || [ "$age" -gt "$LOCK_TTL" ]; then
    log "清除残留锁 (pid=${holder_pid:-?}, age=${age}s)"
    rm -rf "$LOCK_DIR"
    mkdir "$LOCK_DIR" 2>/dev/null && { printf '%s' "$$" > "$LOCK_DIR/pid"; return 0; }
  fi
  return 1  # 有人在装：静默退让
}
acquire_lock || exit 0
trap 'rm -rf "$LOCK_DIR"' EXIT

# ---------- 下载（直连 → ghproxy 镜像 → 放弃） ----------
download() { # $1=url $2=dest
  curl -sfL --connect-timeout 8 --max-time 300 -o "$2" "$1" 2>>"$LOG" && return 0
  local mirrored="https://ghproxy.com/$1"
  case "$1" in https://github.com/*)
    curl -sfL --connect-timeout 8 --max-time 300 -o "$2" "$mirrored" 2>>"$LOG" && return 0 ;;
  esac
  return 1
}

fail() { log "失败: $*"; write_state "absent"; exit 0; }  # 静默：下次 SessionStart 重试

write_state "installing:$EXPECT_VERSION"
mkdir -p "$COMPANION_ROOT.download"

# ---------- 下载 payload + sha256 校验 + 原子进位 ----------
ZIP_TMP="$COMPANION_ROOT.download/payload.zip.tmp"
SHA_TMP="$COMPANION_ROOT.download/payload.zip.sha256"
ZIP="$COMPANION_ROOT.download/payload.zip"
log "开始安装 v$EXPECT_VERSION from $PAYLOAD_BASE"
download "$PAYLOAD_BASE/payload-$EXPECT_VERSION.zip" "$ZIP_TMP" || fail "下载失败"
download "$PAYLOAD_BASE/payload-$EXPECT_VERSION.zip.sha256" "$SHA_TMP" || fail "下载校验文件失败"
want_sha="$(awk '{print $1}' "$SHA_TMP")"
got_sha="$(shasum -a 256 "$ZIP_TMP" | awk '{print $1}')"
[ "$want_sha" = "$got_sha" ] || { rm -f "$ZIP_TMP"; fail "sha256 不匹配 (want=$want_sha got=$got_sha)"; }
mv -f "$ZIP_TMP" "$ZIP"

# ---------- 部署（保 data/ 与用户 persona/） ----------
STAGE="$COMPANION_ROOT.download/stage"
rm -rf "$STAGE"; mkdir -p "$STAGE"
unzip -q "$ZIP" -d "$STAGE" || fail "解压失败"
SRC="$STAGE/payload"
[ -d "$SRC" ] || fail "payload 结构异常（缺 payload/ 目录）"
mkdir -p "$COMPANION_ROOT/data" "$COMPANION_ROOT/persona"
cp -f "$SRC/node" "$COMPANION_ROOT/node" && chmod +x "$COMPANION_ROOT/node"
cp -f "$SRC/brain.mjs" "$SRC/brain-mcp.mjs" "$COMPANION_ROOT/"
cp -f "$SRC/VERSION" "$COMPANION_ROOT/VERSION"
[ -f "$COMPANION_ROOT/persona/persona.yaml" ] || cp -f "$SRC/persona/persona.yaml" "$COMPANION_ROOT/persona/persona.yaml"
# .env：存在则保留（用户配的 GLM key 不丢）
if [ ! -f "$COMPANION_ROOT/.env" ]; then
  { echo "PORT=8787"; echo "DB_PATH=$COMPANION_ROOT/data/companion.db"
    echo "PERSONA_PATH=$COMPANION_ROOT/persona/persona.yaml"
    echo "BRAIN_API_FORMAT=claude-code"; } > "$COMPANION_ROOT/.env"
fi

# ---------- launchd 常驻（plist 总是写，load 可跳过） ----------
PLIST_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$PLIST_DIR"
PLIST="$PLIST_DIR/companion-layer.plist"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>companion-layer</string>
  <key>ProgramArguments</key><array>
    <string>$COMPANION_ROOT/node</string><string>$COMPANION_ROOT/brain.mjs</string>
  </array>
  <key>WorkingDirectory</key><string>$COMPANION_ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/tmp/companion.log</string>
  <key>StandardErrorPath</key><string>/tmp/companion.log</string>
</dict></plist>
EOF
if [ "${COMPANION_SKIP_LAUNCHD:-0}" != "1" ]; then
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null || log "launchctl load 失败"
fi

# ---------- 桌宠 App（写 defaults → 装 App → 清 quarantine → 拉起） ----------
if [ "${COMPANION_SKIP_APP:-0}" != "1" ]; then
  defaults write com.anicompanion.app chat_backend openAICompatible
  defaults write com.anicompanion.app chat_endpoint_openAICompatible "http://127.0.0.1:8787"
  defaults write com.anicompanion.app chat_api_key_openAICompatible ""
  defaults write com.anicompanion.app tts_enabled 1
  killall AniCompanion 2>/dev/null || true; sleep 1
  rm -rf /Applications/AniCompanion.app
  ditto -x -k "$SRC/AniCompanion.app.zip" /Applications/ || fail "App 解压失败"
  xattr -dr com.apple.quarantine /Applications/AniCompanion.app 2>/dev/null || true
  [ "${COMPANION_SKIP_OPEN:-0}" != "1" ] && open -a /Applications/AniCompanion.app 2>/dev/null || true
fi

rm -rf "$STAGE" "$ZIP" "$SHA_TMP"
write_state "installed:$EXPECT_VERSION"
log "安装完成 v$EXPECT_VERSION"
exit 0
```

要点：`fail()` 一律 `exit 0`（hook 语境静默）；下载/解压全走 `.download` 临时区，成功才落位；`trap EXIT` 释放锁。

**Step 4: 跑测试确认通过**

Run: `pnpm vitest run tests/installer.test.ts`
Expected: 5 passed。若"同版本快路径"用例因 COMPANION_ROOT 共享顺序问题失败，检查 `.state` 写入时机（installing→installed 只在成功末尾写）

**Step 5: Commit**

```bash
git add plugin/scripts/ensure-installed.sh tests/installer.test.ts
git commit -m "feat: ensure-installed 安装器 — mkdir 原子锁/状态机/sha256/镜像 fallback/数据保留"
```

---

### Task 3: mcp-launcher.sh（TDD）

**Files:**
- Create: `plugin/scripts/mcp-launcher.sh`
- Test: `tests/mcp-launcher.test.ts`

**Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin/scripts/mcp-launcher.sh')

describe('mcp-launcher.sh', () => {
  it('未就绪（无 node/brain-mcp）: 1 秒内退出，非零', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-'))
    const res = spawnSync('bash', [SCRIPT], { env: { ...process.env, COMPANION_ROOT: root }, encoding: 'utf8', timeout: 3000 })
    expect(res.status).not.toBe(0)
  })

  it('就绪：exec payload node 跑 brain-mcp.mjs（用假 node 打标验证）', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-'))
    writeFileSync(join(root, 'node'), '#!/bin/sh\necho "LAUNCHED $@"\n')
    chmodSync(join(root, 'node'), 0o755)
    writeFileSync(join(root, 'brain-mcp.mjs'), '// x\n')
    const res = spawnSync('bash', [SCRIPT], { env: { ...process.env, COMPANION_ROOT: root }, encoding: 'utf8' })
    expect(res.stdout).toContain('LAUNCHED')
    expect(res.stdout).toContain('brain-mcp.mjs')
    expect(res.status).toBe(0)
  })
})
```

**Step 2: 跑测试确认失败**

Run: `pnpm vitest run tests/mcp-launcher.test.ts` → FAIL（脚本不存在）

**Step 3: 实现**

```bash
#!/usr/bin/env bash
# MCP 启动器：plugin .mcp.json 的 command 指向这里
# 就绪 → exec payload node 跑 brain-mcp.mjs（进程被 claude 接管）
# 未就绪 → 快速失败（首个会话无 MCP，装好后下个会话自动恢复）
set -u
COMPANION_ROOT="${COMPANION_ROOT:-$HOME/.companion-layer}"
NODE="$COMPANION_ROOT/node"
MCP="$COMPANION_ROOT/brain-mcp.mjs"
[ -x "$NODE" ] && [ -f "$MCP" ] || exit 1
exec "$NODE" "$MCP"
```

**Step 4: 跑测试确认通过** → `pnpm vitest run tests/mcp-launcher.test.ts` → 2 passed

**Step 5: Commit**

```bash
git add plugin/scripts/mcp-launcher.sh tests/mcp-launcher.test.ts
git commit -m "feat: mcp-launcher — 就绪 exec / 未就绪快速退出"
```

---

### Task 4: hook 脚本去 jq 化迁移（TDD）

**Files:**
- Create: `plugin/scripts/report-event.sh`（从 `hooks/report-event.sh` 迁移改写）
- Create: `plugin/scripts/stop-claude.sh`（从 `hooks/stop-claude.sh`）
- Create: `plugin/scripts/ensure-running.sh`（从 `scripts/ensure-running.sh`，node 路径改 `$COMPANION_ROOT/node`）
- Test: `tests/hooks.test.ts`

要点：迁移不是复制——三处必须改：
1. **去 jq**：`session_id`/`tool_name` 用 bash 正则提取；`UserPromptSubmit` 的 80 字符截断用 `cut`；JSON 字符串转义用 `tr -d '\n"'` 粗清洗（hook 上报失败静默，可接受）
2. **node 路径**：`ensure-running.sh` 的 `nohup node src/index.ts` → `nohup "$COMPANION_ROOT/node" "$COMPANION_ROOT/brain.mjs"`，cwd `$COMPANION_ROOT`
3. **SessionStart 拉起安装器**：`report-event.sh` 的 SessionStart 分支加 `nohup bash "$SCRIPT_DIR/ensure-installed.sh" >>"$LOG" 2>&1 & disown`（毫秒返回）

**Step 1: 写失败测试**

`tests/hooks.test.ts`：

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createServer, type Server } from 'node:http'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const P = join(dirname(fileURLToPath(import.meta.url)), '..', 'plugin/scripts')
const received: any[] = []
let server: Server, port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => { received.push({ url: req.url, body }); res.end('{}') })
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => { port = (server.address() as any).port; r() }))
})
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())) })

const hookInput = JSON.stringify({ session_id: 'sess-123', tool_name: 'Bash', tool_response: { exit_code: 1, stderr: 'boom' } })

function runHook(script: string, extraEnv: Record<string, string> = {}) {
  return spawnSync('bash', [join(P, script)], {
    input: hookInput,
    env: { ...process.env, COMPANION_URL: `http://127.0.0.1:${port}`,
           COMPANION_ROOT: mkdtempSync(join(tmpdir(), 'hook-')),
           COMPANION_SKIP_INSTALLER: '1', ...extraEnv },
    encoding: 'utf8', timeout: 15_000,
  })
}

describe('hook 脚本（去 jq 化）', () => {
  it('report-event.sh: 上报事件 + 失败时额外上报 task_failed / report-failure', () => {
    received.length = 0
    const res = runHook('report-event.sh')
    expect(res.status).toBe(0)
    const urls = received.map((r) => r.url)
    expect(urls).toContain('/api/events')
    expect(urls).toContain('/api/report-failure')
    const evt = received.find((r) => r.url === '/api/events').body
    expect(evt).toContain('sess-123')
    expect(evt).toContain('Bash')
    expect(evt).toContain('"failed":true')
  })

  it('stop-claude.sh: 上报聚合事件', () => {
    received.length = 0
    const res = runHook('stop-claude.sh')
    expect(res.status).toBe(0)
    expect(received.find((r) => r.url === '/api/aggregate')).toBeTruthy()
  })
})
```

**Step 2: 跑测试确认失败** → FAIL

**Step 3: 实现**（report-event.sh 核心改写，stop-claude.sh / ensure-running.sh 同思路）

```bash
#!/usr/bin/env bash
# Claude Code hook → companion 事件上报（去 jq 版：纯 bash + 系统 curl）
set -u
COMPANION_URL="${COMPANION_URL:-http://127.0.0.1:8787}"
COMPANION_ROOT="${COMPANION_ROOT:-$HOME/.companion-layer}"
HOOK_TYPE="${1:-PostToolUse}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
input=$(cat)

# JSON 字符串字段粗提取（jq 不可用环境；字段缺失输出空）
json_str() { printf '%s' "$input" | sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1; }
session_id="$(json_str session_id)"; session_id="${session_id:-unknown}"
tool_name="$(json_str tool_name)"

# SessionStart：后台拉起安装器（毫秒返回，绝不阻塞）+ 拉活服务
if [ "$HOOK_TYPE" = "SessionStart" ] && [ "${COMPANION_SKIP_INSTALLER:-0}" != "1" ]; then
  nohup bash "$SCRIPT_DIR/ensure-installed.sh" >>"${COMPANION_INSTALL_LOG:-/tmp/companion-install.log}" 2>&1 & disown
fi
bash "$SCRIPT_DIR/ensure-running.sh" "$([ "$HOOK_TYPE" = "SessionStart" ] && echo both || echo layer)"

# 失败检测：exit_code 非零 或 stderr 含报错特征（数字比较需清洗）
failed="false"
if [ "$HOOK_TYPE" = "PostToolUse" ]; then
  exit_code="$(printf '%s' "$input" | sed -n 's/.*"exit_code"[[:space:]]*:[[:space:]]*\([0-9]*\).*/\1/p' | head -1)"
  if [ -n "$exit_code" ] && [ "$exit_code" != "0" ]; then failed="true"
  elif printf '%s' "$input" | grep -qiE '"stderr"[^"]*(error|failed|fatal)'; then failed="true"; fi
fi

payload='{"failed":'"$failed"'}'
if [ "$HOOK_TYPE" = "UserPromptSubmit" ]; then
  p="$(printf '%s' "$input" | sed -n 's/.*"prompt"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1 | cut -c1-80 | tr -d '\n"\\')"
  payload="{\"prompt\":\"$p\"}"
fi

curl -s -m 2 -X POST "$COMPANION_URL/api/events" -H 'Content-Type: application/json' \
  --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","session_id":"${session_id}","hook_type":"${HOOK_TYPE}","tool_name":"${tool_name}","payload":${payload}}
EOF

if [ "$failed" = "true" ]; then
  err_snippet="$(printf '%s' "$input" | sed -n 's/.*"stderr"[[:space:]]*:[[:space:]]*"\(.*\)".*/\1/p' | head -1 | tail -c 200 | tr '\n"\\' '   ')"
  curl -s -m 2 -X POST "$COMPANION_URL/api/events" -H 'Content-Type: application/json' \
    --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","session_id":"${session_id}","hook_type":"PostToolUse","tool_name":"task_failed_marker","payload":{"summary":"工具执行失败：${err_snippet}"}}
EOF
  curl -s -m 2 -X POST "$COMPANION_URL/api/report-failure" -H 'Content-Type: application/json' \
    --data-binary @- > /dev/null 2>&1 <<EOF || true
{"agent":"claude-code","summary":"${tool_name} 执行失败了"}
EOF
fi
exit 0
```

`ensure-running.sh` 迁移改动（其余照抄 `scripts/ensure-running.sh`）：

```bash
# ensure_layer 内的启动命令替换为：
(cd "$COMPANION_ROOT" && nohup "$COMPANION_ROOT/node" "$COMPANION_ROOT/brain.mjs" >> /tmp/companion.log 2>&1 &)
# REPO_DIR 相关行改为 COMPANION_ROOT="${COMPANION_ROOT:-$HOME/.companion-layer}"
```

`stop-claude.sh`：照抄现有，仅把 SCRIPT_DIR 相对路径指向新位置的同目录脚本、去 jq（session_id 同 json_str 函数）。

**Step 4: 跑测试确认通过** → `pnpm vitest run tests/hooks.test.ts` → 2 passed

**Step 5: 回归**：`pnpm vitest run`（全部测试，确认没破坏现有 26+ 用例）

**Step 6: Commit**

```bash
git add plugin/scripts/report-event.sh plugin/scripts/stop-claude.sh plugin/scripts/ensure-running.sh tests/hooks.test.ts
git commit -m "feat: hook 脚本去 jq 化迁移到 plugin/scripts — SessionStart 后台拉安装器"
```

---

### Task 5: plugin 骨架（marketplace + hooks.json + .mcp.json + skill）

**Files:**
- Create: `.claude-plugin/marketplace.json`
- Create: `plugin/.claude-plugin/plugin.json`
- Create: `plugin/hooks/hooks.json`
- Create: `plugin/.mcp.json`
- Create: `plugin/VERSION`
- Create: `plugin/skills/pet/SKILL.md`

**Step 1: marketplace.json**（仓库根）

```json
{
  "name": "companion",
  "owner": { "name": "chenxuewei" },
  "plugins": [{ "name": "pet", "source": "./plugin", "description": "会看着你写代码的桌面女友" }]
}
```

**Step 2: plugin.json**

```json
{
  "name": "pet",
  "version": "0.1.0",
  "description": "会看着你写代码的桌面女友 — 装完自动出现",
  "author": { "name": "chenxuewei" }
}
```

**Step 3: hooks/hooks.json**（exec 形式，路径用 ${CLAUDE_PLUGIN_ROOT}）

```json
{
  "hooks": {
    "PostToolUse": [
      { "matcher": "*", "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/report-event.sh", "args": ["PostToolUse"], "timeout": 10 }] }
    ],
    "UserPromptSubmit": [
      { "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/report-event.sh", "args": ["UserPromptSubmit"], "timeout": 10 }] }
    ],
    "SessionStart": [
      { "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/report-event.sh", "args": ["SessionStart"], "timeout": 10 }] }
    ],
    "Stop": [
      { "hooks": [{ "type": "command", "command": "${CLAUDE_PLUGIN_ROOT}/scripts/stop-claude.sh", "timeout": 15 }] }
    ]
  }
}
```

注意：脚本 shebang 是 bash，command 直接执行（依赖可执行位；Task 6 的 make-release 会 `chmod +x`，但 git 已保留可执行位——执行 `chmod +x plugin/scripts/*.sh` 后 commit）。timeout 单位按官方文档核实（若 hook timeout 只在 settings.json 支持，去掉该键）。

**Step 4: .mcp.json**

```json
{
  "mcpServers": {
    "companion": { "command": "${CLAUDE_PLUGIN_ROOT}/scripts/mcp-launcher.sh", "args": [], "env": {} }
  }
}
```

**Step 5: VERSION + skill**

`plugin/VERSION`：`0.1.0`（与 plugin.json version 同步维护；payload 版本以此为准）

`plugin/skills/pet/SKILL.md`：

```markdown
---
name: pet
description: 与桌面女友互动 — 让她说话、查她的状态。用户说"让她说话/她怎么了/桌宠状态"时用
---

# pet — 桌面女友互动

- 让她说话：`curl -s -X POST http://127.0.0.1:8787/api/say -d '{"text":"[happy] <台词>"}' -H 'Content-Type: application/json'`
- 她没反应/状态自检：读 `/tmp/companion-install.log` 与 `/tmp/companion.log` 最后 50 行；`bash ~/.companion-layer/../hb/scripts/check.sh` 四环节诊断（若仓库脚本存在），否则 curl health + pgrep AniCompanion
- 她没安装（~/.companion-layer 不存在）：告诉用户重启一个 Claude Code 会话即可自动安装
```

**Step 6: 本地验证 plugin 安装**

```bash
chmod +x plugin/scripts/*.sh
claude plugin marketplace add /Users/chenxuewei/hb --yes
claude plugin install pet@companion
```

Expected: `Successfully installed plugin: pet`。开新会话发一句 "hi"，然后 `tail -20 /tmp/companion-install.log` 确认 SessionStart 拉起了安装器（开发机已有 ~/.companion-layer 会走快路径或重装到新版本——先用 EXPECT_VERSION 对齐当前已装状态避免误触发重装，或临时设 COMPANION_ROOT 验证）。验证完可 `claude plugin uninstall pet` 还原。

**Step 7: Commit**

```bash
git add .claude-plugin plugin/.claude-plugin plugin/hooks plugin/.mcp.json plugin/VERSION plugin/skills
git commit -m "feat: plugin 骨架 — marketplace/hooks/mcp/skill，本地验证安装通过"
```

---

### Task 6: make-release.sh（payload 组装 + 冒烟）

**Files:**
- Create: `scripts/make-release.sh`
- Delete: `scripts/make-bundle.sh`（被取代；`scripts/install-friend.sh` 若仍被引用则一并清理）

**Step 1: 实现**

```bash
#!/usr/bin/env bash
# 打 payload-<ver>.zip 发 GitHub Release：node + brain + App + persona
set -euo pipefail
HB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$HB_DIR/dist"
NODE_CACHE="$HB_DIR/vendor/node-cache"
NODE_VER="v23.11.0"          # 与 package.json engines 对齐
NODE_TAR="node-$NODE_VER-darwin-arm64.tar.gz"
VER="$(tr -d '[:space:]' < "$HB_DIR/plugin/VERSION")"

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
die()  { printf '\033[1;31m错误: %s\033[0m\n' "$1" >&2; exit 1; }

step "构建 brain"
( cd "$HB_DIR" && pnpm build:brain )

step "准备 node 运行时（本地缓存，首次下载）"
mkdir -p "$NODE_CACHE"
if [ ! -x "$NODE_CACHE/bin/node" ]; then
  curl -sfL -o "$NODE_CACHE/$NODE_TAR" "https://nodejs.org/dist/$NODE_VER/$NODE_TAR" || die "node 下载失败"
  tar -xzf "$NODE_CACHE/$NODE_TAR" -C "$NODE_CACHE" --strip-components 1
fi

step "组装 payload/"
rm -rf "$DIST/payload-$VER"; mkdir -p "$DIST/payload-$VER/persona"
cp "$NODE_CACHE/bin/node" "$DIST/payload-$VER/node"
cp "$DIST/brain.mjs" "$DIST/brain-mcp.mjs" "$DIST/payload-$VER/"
cp "$HB_DIR/persona/persona.yaml" "$DIST/payload-$VER/persona/"
printf '%s\n' "$VER" > "$DIST/payload-$VER/VERSION"
BUILT_DIR=$(xcodebuild -project "$HB_DIR/anicompanion/AniCompanion.xcodeproj" -scheme AniCompanion \
  -configuration Release -showBuildSettings 2>/dev/null | grep -m1 BUILT_PRODUCTS_DIR | awk '{print $3}')
ditto -c -k --keepParent "$BUILT_DIR/AniCompanion.app" "$DIST/payload-$VER/AniCompanion.app.zip"

step "冒烟：payload 在隔离目录拉起 /health"
SMOKE=$(mktemp -d)
cp -R "$DIST/payload-$VER" "$SMOKE/payload"
( cd "$SMOKE" && PORT=18900 nohup ./payload/node payload/brain.mjs >/tmp/brain-release-smoke.log 2>&1 & echo $! > /tmp/brain-release.pid )
sleep 3
curl -sf -m 3 http://127.0.0.1:18900/health | grep -q '"status":"ok"' || { kill "$(cat /tmp/brain-release.pid)" 2>/dev/null; die "冒烟失败，看 /tmp/brain-release-smoke.log"; }
kill "$(cat /tmp/brain-release.pid)" 2>/dev/null || true

step "打包 + sha256"
( cd "$DIST" && rm -f "payload-$VER.zip" "payload-$VER.zip.sha256" && zip -q -r "payload-$VER.zip" "payload-$VER" )
shasum -a 256 "$DIST/payload-$VER.zip" | awk '{print $1"  payload-'$VER'.zip"}' > "$DIST/payload-$VER.zip.sha256"
echo "✅ $DIST/payload-$VER.zip ($(du -h "$DIST/payload-$VER.zip" | cut -f1))"
echo "发布：gh release create v$VER dist/payload-$VER.zip dist/payload-$VER.zip.sha256"
```

**Step 2: 跑通**

Run: `bash scripts/make-release.sh`
Expected: 冒烟通过，产出 `dist/payload-0.1.0.zip` + `.sha256`（首次会下载 node，~30MB，耐心）

**Step 3: Commit**

```bash
git add scripts/make-release.sh
git rm scripts/make-bundle.sh scripts/install-friend.sh 2>/dev/null || true
git commit -m "feat: make-release — payload 组装+冒烟+sha256，取代 make-bundle"
```

（`.gitignore` 确认 `dist/`、`vendor/node-cache` 被忽略）

---

### Task 7: install.sh 瘦身（微信兜底通道复用安装器）

**Files:**
- Modify: `scripts/install.sh`（全文重写，从 168 行缩到 ~40 行）

**Step 1: 重写**

```bash
#!/usr/bin/env bash
# 微信/AirDrop 兜底通道：payload.zip 随包分发，复用 plugin 安装器逻辑
#   bash install.sh [--glm <api-key>]
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GLM_KEY=""
[ "${1:-}" = "--glm" ] && GLM_KEY="${2:?--glm 需要 key}"

VER="$(unzip -p "$HERE/payload.zip" payload/VERSION | tr -d '[:space:]')"
[ -n "$VER" ] || { echo "payload.zip 不在当前目录"; exit 1; }

# 本地文件当下载源（python3 系统自带，起临时 http server）
SRV_PORT=18901
( cd "$HERE" && python3 -m http.server $SRV_PORT --bind 127.0.0.1 >/dev/null 2>&1 & echo $! > /tmp/payload-srv.pid )
trap 'kill "$(cat /tmp/payload-srv.pid)" 2>/dev/null' EXIT
sleep 1

PAYLOAD_BASE="http://127.0.0.1:$SRV_PORT" EXPECT_VERSION="$VER" \
  bash "$(dirname "$HERE")/plugin/scripts/ensure-installed.sh" || true
# 注：兜底包里 ensure-installed.sh 与 payload.zip 同目录分发，打包时一并放入

[ -n "$GLM_KEY" ] && {
  sed -i '' 's/^BRAIN_API_FORMAT=.*/BRAIN_API_FORMAT=hybrid/; s#^BRAIN_BASE_URL=.*#BRAIN_BASE_URL=https://open.bigmodel.cn/api/anthropic#; s/^BRAIN_API_KEY=.*/BRAIN_API_KEY='"$GLM_KEY"'/; s/^BRAIN_MODEL=.*/BRAIN_MODEL=GLM-5.3/' "$HOME/.companion-layer/.env"
}
launchctl unload "$HOME/Library/LaunchAgents/companion-layer.plist" 2>/dev/null || true
launchctl load "$HOME/Library/LaunchAgents/companion-layer.plist"
echo "完成 ✅ 直接去干活，收工那一刻她会自己开口。"
```

（兜底打包方式变为：`make-release.sh` 产物 payload-*.zip 重命名 payload.zip + `plugin/scripts/ensure-installed.sh` + `install.sh` 三件套打 zip——把这个说明写进 make-release.sh 末尾 echo）

**Step 2: 验证**

Run: 在临时目录组装三件套后 `COMPANION_ROOT=$(mktemp -d) HOME=$(mktemp -d) bash install.sh`（隔离验证，不碰真实环境）
Expected: state=installed、日志无报错

**Step 3: Commit**

```bash
git add scripts/install.sh
git commit -m "refactor: install.sh 瘦身为复用 ensure-installed 的兜底通道"
```

---

### Task 8: E2E 手动验证 + 文档收尾

**Step 1: E2E 清单**（真机、非隔离环境；先 `cp -R ~/.companion-layer ~/companion-backup`）

- [ ] `rm -rf ~/.companion-layer ~/.companion-layer.install.lock`，卸载重装 plugin，新开会话说句话 → 60s 内她出现开口（看 install.log 全链路）
- [ ] 双终端同时开两个 Claude Code 会话 → 只下载一次
- [ ] 已装状态下重启会话 → 快路径 <100ms（log 无新下载记录）
- [ ] 断网中途 kill 安装进程 → 恢复网络后下个会话续装成功
- [ ] 重装后记忆/好感度保留（聊天里问她之前说过的事）
- [ ] `gh release create v0.1.0 ...` 真发布，从 PAYLOAD_BASE 默认值全链路装一次

**Step 2: 更新 README**：安装章节改为一行命令 + 兜底通道两行；架构图加 plugin 分发链路

**Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 安装章节改为 plugin 一行命令"
```

---

## 执行顺序与依赖

```
Task 1 (esbuild) ──→ Task 6 (make-release) ──→ Task 8 (E2E)
Task 2 (安装器) ──→ Task 4 (hooks 迁移) ──→ Task 5 (plugin 骨架) ──↗
Task 3 (mcp-launcher) ──→ Task 5                                Task 7 (install.sh，依赖 2+6)
```

Task 1/2/3 可并行。风险最高的是 Task 2（并发锁）和 Task 5（plugin hooks.json 字段格式需以官方文档为准），实现时先查证再写。
