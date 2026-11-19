# Changelog

All notable changes to `dsh-windows-superagent` (formerly `dsh-superagent`) are recorded here.
This is a research prototype; entries describe user-visible behaviour, not a stability promise.

## 0.2.6

- **The question card now times out after 100 s / 选择卡 100 秒超时** — `ask_user_question` runs in `timed`
  mode for the orchestrator presets. A card nobody answers returns `pending` and the turn continues, so a
  person away from the UI no longer blocks the session or the Source inbox behind it (WeChat messages used
  to queue indefinitely). The question stays answerable afterwards.
  主控 preset 的 `ask_user_question` 改为 `timed` 模式：无人应答 100 秒后返回 `pending`、回合继续，
  不再无限阻塞会话与 Source 收件箱（此前微信消息会一直排队）。

- **GitHub is optional: a local git repository stands in / GitHub 可选，本地 git 兜底** — a configured
  GitHub Source that cannot be probed (CLI unset, signed out, repository unreadable or read-only) is
  reported on the panel instead of stopping setup; an unconfigured Source downgrades silently. The
  deployment then works in a local repository: `executor.repositoryPath` (default
  `<stateDir>/workspace/repo`), created with `git init -b main` and one empty commit when missing. With an
  empty `executor.prepare`, a ticket workspace is prepared with `git worktree add`, so workers run without
  any remote; a non-empty prepare command behaves exactly as before. Without GitHub no `gh` shim or git
  credential helper is written and the GitHub Source stays paused.
  配置了 GitHub 但探测失败（CLI 未设置/未登录/仓库不可读或只读）只在面板提示，不再阻塞启动；未配置则
  静默降级。此时用本地仓库工作：新增 `executor.repositoryPath`（默认 `<stateDir>/workspace/repo`，
  缺失自动 `git init -b main` 并做一次空提交）；`executor.prepare` 为空时用工单目录 `git worktree add`
  准备，无远端也能开工；prepare 非空时行为不变。无 GitHub 时不写 `gh` 垫片与 git 凭据助手，GitHub Source 保持暂停。

## 0.2.5

- Recognize environments written before the rename (`LEGACY_MARKERS`), so setup no longer ends
  `setupPending`/`agentCliSignedOut` on an upgraded installation.
- Register the pre-rename presets as aliases so sessions created before the rename resume.
- Append each startup step to `<stateDir>/boot.log`.

## 0.2.4

- Rename `dsh-superagent` → `dsh-windows-superagent` across packages, plugin ids, presets, host subpaths,
  bundled skills and scripts. Environment variables (`DSH_SUPERAGENT_*`), the state directory and KV keys
  are unchanged, so an upgrade keeps its data.

## 0.2.3

- The grill skill only opens the question card when a person must decide, and one round is one call
  carrying every question.

## 0.2.2

- Ask the person from the main Session with the official `ask_user_question` card (grill rounds).
- Board: temporary workers and the lead ticket are classified correctly.
