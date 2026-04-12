---
feature_ids: [F160]
related_features: [F138]
topics: [windows, electron, desktop, bootstrap, debugging]
doc_kind: note
created: 2026-04-12
---

# F160: Electron 桌面化 — Windows 启动调试实录

> **Status**: done | **Owner**: 296569015 | **Branch**: feat/electron-desktop

## Why

F138 已实现了 Electron 壳体和 Inno Setup 安装包，但原始代码从未在 VSCode 开发环境下直接调试过。
本次工作目标：在 Windows 开发机上从源码直接跑通 Electron 桌面应用，验证可行性，并修复所有
Windows 特有的兼容性问题。

---

## 技术选型回顾

### 为什么选 Electron（而不是 Tauri / PWA）

| 方案 | 结论 |
|------|------|
| **Electron** | ✅ 选用。与项目技术栈（Node.js / Next.js）完全一致；node-pty、Puppeteer、Redis 二进制均有成熟支持；Puppeteer 可复用 Electron 内置 Chromium，无需额外打包浏览器。 |
| Tauri | 需要引入 Rust 工具链，团队学习成本高；后端仍需作为 sidecar 进程管理，架构更复杂。 |
| PWA + 系统服务 | 改动最小，但不是"真正的"桌面应用，缺少托盘、全局快捷键等桌面能力。 |
| NW.js | 社区几乎停滞，不推荐。 |

### 整体架构

```
Electron 主进程 (desktop/main.js)
    └── ServiceManager (desktop/service-manager.js)
            ├── Redis      :6399  (便携 exe 或系统 Redis，无则 memory 模式)
            ├── API Server :3004  (node packages/api/dist/index.js)
            └── Next.js    :3003  (node .../next/dist/bin/next start)
                               ↑
                    BrowserWindow 加载 http://localhost:3003
```

---

## 踩坑记录

### 坑 1：`require('electron')` 返回 undefined，`app` 是 undefined

**现象**：
```
TypeError: Cannot read properties of undefined (reading 'on')
  at app.on('ready', ...)
```

**根本原因**：
VSCode 本身用 Electron 构建。它在内部进程里设置了 `ELECTRON_RUN_AS_NODE=1`，
告诉 Electron 以"纯 Node.js 模式"运行（不加载 GUI 子系统）。
这个环境变量被所有从 VSCode 终端启动的子进程继承，包括我们的 Electron 进程。
在 Node 模式下，`electron` 的内置 GUI 模块（`app`、`BrowserWindow` 等）根本不存在。

**诊断过程**：
```js
// 在 Electron 进程内打印
console.log(process.env.ELECTRON_RUN_AS_NODE); // → "1"
console.log(process.type);                     // → undefined（应为 "browser"）
```

**解决方案**：
启动 Electron 时通过 `ProcessStartInfo.EnvironmentVariables.Remove('ELECTRON_RUN_AS_NODE')`
构造一个干净的环境变量集合，显式移除该变量。

**package.json start 脚本也同步修复**：
```json
"start": "powershell -NoProfile -Command \"$env:ELECTRON_RUN_AS_NODE=''; & '.\\node_modules\\electron\\dist\\electron.exe' '.'\""
```

> **注意**：`cross-env ELECTRON_RUN_AS_NODE=` 无效——`cross-env` 只能设值，无法 unset 从父进程继承的变量。

---

### 坑 2：API 启动失败（Redis PING failed）

**现象**：
```
[api] Fatal error: Redis PING failed: Connection is closed.
Check REDIS_URL or set MEMORY_STORE=1 for memory mode.
```

**根本原因**：
`service-manager.js` 在检测到没有 Redis 后，正确设置了 `MEMORY_STORE=1`，
但同时还向子进程传了 `REDIS_URL=redis://localhost:6399`。
API 读取环境变量时，`REDIS_URL` 优先于 `.env` 里的 `MEMORY_STORE=1`，
导致 API 仍然尝试连接 Redis。

**解决方案**：
```js
if (this.memoryMode) {
  env.MEMORY_STORE = '1';
  delete env.REDIS_URL;      // 必须显式删除，不能只加 MEMORY_STORE
} else {
  env.REDIS_URL = 'redis://localhost:6399';
}
```

---

### 坑 3：`spawn('node', ...)` 在 Electron 子进程里找不到 node

**现象**：API 进程 spawn error，或者 `_waitForPort` 超时。

**根本原因**：
`service-manager.js` 里 `_startProcess('api', 'node', [...])` 调用的是 PATH 里的 `node`。
但 Electron 进程启动时，继承的 PATH 不含 Node.js 安装目录
（VSCode 自己管理 Node 路径，启动 Electron 时传的是精简版 PATH）。

**解决方案**：
```js
function resolveNode() {
  const candidates = [
    'C:\\Program Files\\nodejs\\node.exe',
    'C:\\Program Files (x86)\\nodejs\\node.exe',
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return 'node'; // fallback
}
```

---

### 坑 4：`spawn('next.cmd', ...)` 在 Windows 上静默失败

**现象**：
API 日志显示正常，但 Next.js 进程完全没有日志，3003 端口始终不开放，60s 后超时。

**根本原因**：
Windows 上的 `.cmd` 批处理文件不能直接被 `child_process.spawn()` 执行。
`spawn` 只能直接执行 EXE 或有 shebang 的脚本；`.cmd` 文件需要通过 `cmd.exe /c` 调用。
`next.cmd` 静默失败（spawn 成功但进程立刻退出，没有 error 事件），所以难以察觉。

**解决方案**：
绕过 `.cmd` wrapper，直接用 `node` 调用 Next.js 的 JS 入口：
```js
const nextJs = path.join(
  this.root,
  'node_modules', '.pnpm',
  'next@14.2.35_...',
  'node_modules', 'next', 'dist', 'bin', 'next',
);
cmd = resolveNode();
args = [nextJs, 'start', '--port', String(this.frontendPort)];
```

---

### 坑 5：TypeScript 编译错误 — `cat.provider` 可能为 undefined

**现象**：`pnpm build` 失败：
```
src/routes/cats.ts(432,38): error TS2538: Type 'undefined' cannot be used as an index type.
```

**原因**：
合并 `origin/desktop` 时，`filterCatsForDesktop` 函数里
`PROVIDER_CLI_MAP[cat.provider]` 的 `cat.provider` 类型包含 `undefined`，
而对象索引不接受 `undefined`。

**解决方案**：
```ts
const cliName = (cat.provider ? PROVIDER_CLI_MAP[cat.provider] : undefined) ?? cat.provider ?? '';
```

---

### 坑 6：pnpm 不在 bash PATH 里

**现象**：Claude Code（VSCode 扩展）的 Bash 工具无法找到 `pnpm` 命令。

**原因**：
pnpm 安装在非标准路径 `C:\Users\Administrator\AppData\Local\pnpm\.tools\pnpm\9.15.4_tmp_14352_0\bin\`，
没有添加到系统 PATH，且 bash 环境（Git Bash / WSL）不读 Windows 用户 PATH。

**解决方案**：
所有 pnpm 命令通过 PowerShell 调用，并在调用前手动加入 PATH：
```powershell
$env:PATH = 'C:\Users\Administrator\AppData\Local\pnpm\.tools\pnpm\...\bin;' + $env:PATH
pnpm build
```

---

## 最终启动方式

由于 `ELECTRON_RUN_AS_NODE` 问题，**必须从系统 PowerShell（非 VSCode 终端）启动**：

```powershell
cd d:\code\clowder-ai\desktop
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
.\node_modules\electron\dist\electron.exe .
```

等待约 5 秒，Splash 画面出现 → 再等约 3 秒，主窗口加载完毕。

---

## 修改文件清单

| 文件 | 改动内容 |
|------|---------|
| `desktop/main.js` | 添加调试日志；修复重复变量声明 |
| `desktop/service-manager.js` | resolveNode()、memory 模式修复、Next.js 直接调用、日志写文件、超时 60s→120s |
| `desktop/package.json` | start 脚本清除 ELECTRON_RUN_AS_NODE；新增 cross-env 依赖；`"type": "module"` 探索后回滚 |
| `packages/api/src/routes/cats.ts` | 修复 TS2538 类型错误；合并 desktop 分支的猫猫过滤逻辑 |
| `docs/ROADMAP.md` | 合并冲突解决（保留 in-progress 状态 + desktop 新增行） |

---

## Git 分支结构

```
origin/main          ← 上游仓库（zts212653/clowder-ai）
myfork/main          ← 个人 fork（296569015/clowder-ai）
myfork/feat/electron-desktop  ← 本次工作分支
    ├── cb348c35  feat: merge Electron desktop shell from origin/desktop
    ├── b3b3edf5  fix(desktop): graceful memory-mode fallback when Redis unavailable
    ├── 86415a3f  fix(desktop): clear ELECTRON_RUN_AS_NODE before launch
    ├── 8e21183c  chore(desktop): remove accidentally committed temp ESM files
    ├── 41033923  fix(desktop): fix Next.js launch path and extend startup timeout
    └── 40753e05  fix(desktop): resolve all Windows startup issues
```

---

## 待完成事项

- [ ] 制作桌面快捷方式（一键启动 `.ps1` 脚本）
- [ ] 打包为 `.exe` 安装包（需安装 Inno Setup 6）
- [ ] 配置 API Key（Anthropic / OpenAI 等）
- [ ] 图标资源 `desktop/assets/icon.ico`（当前缺失，托盘功能跳过）
- [ ] 将 `resolveNode()` 改为读取注册表，支持非标准安装路径
