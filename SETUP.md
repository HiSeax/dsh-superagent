# Setup (start here)

This is the short, Windows-first path. The full, canonical walkthrough lives in
[`packages/dsh-superagent/SETUP.md`](packages/dsh-superagent/SETUP.md) — an agent can follow
it with you: *“Read SETUP.md in packages/dsh-superagent and set up dsh-superagent with me.”*

中文摘要见下方「中文速览」。

## Prerequisites

- **DeepSeek Harness 0.2+** with the `dsh` CLI on `PATH`
  (default Windows location:
  `C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`).
- **Node.js ≥ 18** and **pnpm**.
- A **GitHub account for the agent** (a personal access token with repo scope) and, if you
  want the chat channels, a **Feishu** app and/or a **WeChat iLink bot**.
- A **dedicated OS account** is recommended if you care about command isolation — see the
  Windows caveat in the README.

## Steps (Windows)

```powershell
# 0) from the repository root
pnpm install
pnpm --filter dsh-superagent check          # typecheck + tests + build
pnpm --filter dsh-superagent-board build

# 1) create a dedicated profile and probe it
$dsh = "C:\Users\<you>\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
& $dsh superagent --from-default-profile web
powershell -ExecutionPolicy Bypass -File packages\dsh-superagent\scripts\install-windows.ps1 -Profile superagent -Dsh $dsh -DryRun
powershell -ExecutionPolicy Bypass -File packages\dsh-superagent\scripts\install-windows.ps1 -Profile superagent -Dsh $dsh

# 2) point the plugin at a state directory
#    edit <DSH_HOME>\profiles\superagent\cordis.patch.yml  →  config.stateDir
#    sanitized example: examples/profiles/desktop/cordis.patch.example.yml

# 3) start / check the service
node packages\dsh-superagent\scripts\dsh-superagent.mjs status --profile superagent
node packages\dsh-superagent\scripts\dsh-superagent.mjs start  --profile superagent

# 4) open the panel — the one-time URL (with token) is printed to
#    <stateDir>\.artifacts\dsh-superagent-superagent-*.log
```

Then configure the **Policy** (accept mode, admission table, proactive rules) from the DSH
settings UI / Source cards — see
[`examples/policy.admission.example.md`](examples/policy.admission.example.md). Start in
`observe`, read the recorded decisions, then switch to `auto`.

## 中文速览

1. 装好 **DSH 0.2+**、**Node ≥ 18**、**pnpm**，准备好 agent 用的 GitHub 账户（以及可选的飞书/微信通道）。
2. 仓库根执行 `pnpm install`，再 `pnpm --filter dsh-superagent check`、`pnpm --filter dsh-superagent-board build`。
3. 建专用 profile（`dsh superagent --from-default-profile web`），用
   `scripts\install-windows.ps1 -Profile <name>` 挂载（先 `-DryRun` 看一眼）。
4. 编辑 `<DSH_HOME>\profiles\<name>\cordis.patch.yml` 设置 `stateDir`（示例：
   `examples/profiles/desktop/cordis.patch.example.yml`）。
5. `node packages\dsh-superagent\scripts\dsh-superagent.mjs status|start --profile <name>`；
   面板一次性 URL 在 `<stateDir>\.artifacts\*.log`。
6. 先用 `observe` 模式跑，读完记录的决策再考虑切 `auto`。完整细节见
   [`packages/dsh-superagent/SETUP.md`](packages/dsh-superagent/SETUP.md)。
