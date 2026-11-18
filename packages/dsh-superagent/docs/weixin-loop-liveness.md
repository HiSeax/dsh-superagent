# 微信 Source 长轮询「静默死亡」：证据、门禁、探针与看门狗补丁（AI Expert，2026-11-11）

> 状态：**看门狗补丁已落地（2026-11-11 14:17–14:33，未重启，待装包/重启生效）**。改动 3 个文件
> （`src/sources/weixin.ts` 主补丁、`src/sources/poll.ts`、`src/sources/feishu-loops.ts`）；新增 2 个文件
> （`tests/weixin-lifecycle.spec.ts` 门禁、`scripts/weixin-liveness.mjs` 只读探针）。落地差异见 §5.1.1。
> 注解：本文件写作时 §5.1 的 diff 是草案；实际实现与它有三处差异，§5.1.1 逐条说明，以该节为准。

---

## 1 现象与证据（生产，2026-11-11）

| 证据 | 值 | 判读 |
|---|---|---|
| `trigger` max(at) / `thread.lastAt` | `2026-11-11T03:56:25.591Z` | 11:56:25 之后无入站 |
| `kv weixin-inbound:*` | `2026-11-11T03:55:09.814Z` | 同上 |
| `disposition` | `{"fanout":["15be26a0…"],"at":"2026-11-11T03:55:09.819Z","acked":[...]}` | 最后一条消息被完整处理，无 `filtered` |
| `settings-version:13` | `sources.weixin={enabled:true,...}` | 不是被 disable |
| `weixin-bot.json` mtime | `2026-11-06T01:11:18` | 没有被 `expireCredentials` 改名，未触发重扫码 |
| 只读探针（持久化游标） | `HTTP 200 / ret=null / errcode=null / get_updates_buf` 原样回显 / `msgs=[]` | 凭证与游标都有效；服务器侧无新消息 |

结论：**不是凭证失效、不是 Source 被 disable，是进程内的 poll 循环已经退出（并再没被拉起）**。

## 2 代码层面的死亡路径

```ts
// src/sources/weixin-bot.ts:494-530  run()
while (!signal.aborted) {
  ...
  const outcome = await this.poll(signal)
  await this.api!.notify('stop').catch(() => {})
  if (signal.aborted) return
  if (outcome !== 'auth') return     // ← poll() 返回 'aborted' 时，整个 Source 生命周期结束
  ...
}

// src/sources/weixin-bot.ts:399-425  poll()
while (!signal.aborted) {
  try { page = await this.api!.updates(cursor) } catch (error) {
    if (isAuthError(error)) return 'auth'          // 只有 -14 会走重登
    ... this.wait(...)                             // 其它失败退避后继续
    continue
  }
  ...
}
return 'aborted'                                   // ← signal.aborted 时（正常退出路径）
```

`return 'aborted'` 只有在 `signal.aborted` 时才该发生，此时 `run()` 的 `if (signal.aborted) return` 已经先返回；
**但任何"signal 没被 abort 而 poll 退出"的路径（等待被外部 wait 实现提前 resolve、接口层吞掉异常、内部循环提前跳出）都会让 `run()` 静默结束**，且：

```ts
// src/sources/weixin.ts:106-115
ctx.effect(() => {
  const context = sourceContext(host, kind)
  bot.attach(context)
  const controller = new AbortController()
  const running = bot.run(controller.signal).catch(...)   // 只有 .catch()，没有 finally / 看门狗 / 重建
  return async () => { bot.detach(); controller.abort(); await running }
}, 'weixin: bot')
```

对照飞书（它能自愈）：

```ts
// src/sources/feishu-loops.ts:43-66  watch()
while (!signal.aborted) {
  if (!enabled(ctx)) { ... continue }
  const running = new AbortController()
  const check = setInterval(() => { if (!enabled(ctx)) running.abort() }, 5000)   // ← 每 5 s 复查存活/开关
  ...
  try { await consume(ctx, running.signal) }
  catch (error) { if (!running.signal.aborted) ctx.report('feishu', { state: 'error', detail: String(error) }) }
  finally { clearInterval(check); signal.removeEventListener('abort', stop) }
  if (running.signal.aborted) continue
  retry = consumerRetry(retry, Date.now() - began)      // 1 s；短命运行 → 指数退避到 60 s
  await delay(retry, undefined, { signal }).catch(() => {})
}
```

**差异**：飞书的消费者**每次退出都会被 while 重新拉起**（带退避），微信的 `run()` 退出就是终点。

---

## 3 门禁（已落地，期望失败）

`tests/weixin-lifecycle.spec.ts`

```ts
vi.spyOn(bot, 'poll').mockImplementation(async () => {
  polls += 1
  if (polls >= 2) controller.abort()
  return 'aborted'            // signal 仍存活，poll 却返回 'aborted'
})
await bot.run(controller.signal)
expect(polls).toBeGreaterThanOrEqual(2)
```

实测（vitest 4.1.8，`C:\Projects\superagent`）：

```
× keeps polling when a poll returns "aborted" while the signal is still live
AssertionError: run() must not end the Source when poll() returns "aborted" with the signal still live:
  expected 1 to be greater than or equal to 2
 ❯ tests/weixin-lifecycle.spec.ts:81:8
```

同批基线：`vitest run tests/weixin.spec.ts tests/weixin-lifecycle.spec.ts` → **1 failed | 1 passed，Tests 1 failed | 13 passed**（既有 13 条全绿）。

修复落地后这条应转绿；若有人把补丁回退，它立刻变红——这就是它的作用。

---

## 4 探针（已落地，正/负样本都实测）

`scripts/weixin-liveness.mjs`

```
node scripts/weixin-liveness.mjs [--state-dir <dir>] [--timeout <ms>] [--json] [--token <override>]
```

- 游标：从 `orchestrator.sqlite` 的 `kv.weixin-updates` **只读**读取（`DatabaseSync({readOnly:true})`）；
- 凭证：`weixin-bot.json`（token 从不打印）；
- **游标原样回显、回复丢弃**：不会推进游标，因此不会吞掉主循环本要读的消息，可在宿主运行时安全执行；
- 退出码：`0` live / `1` stale-credential(-14) / `2` transport·http·api 错误 / `3` 配置缺失。

实测：
```
$ node scripts/weixin-liveness.mjs --timeout 20000
verdict: live
  http 200 in 18549 ms; ret=null errcode=null
  messages waiting beyond the saved cursor: 0; cursor echoed unchanged: true
  credential: c49e7511c1cd@im.bot from <your-home>\.dsh\state\superagent\weixin-bot.json

$ node scripts/weixin-liveness.mjs --token not-a-real-token-000000000000000000 --timeout 20000 --json
  "verdict": "stale-credential", "httpStatus": 200, "errcode": -14, "errmsg": "session timeout"   → exit 1
```

判据：同一游标下「正样本 live」＋「坏 token 得 -14」同时成立 ⇒ **"凭证失效" 与 "循环静默死亡" 可被明确区分**。

---

## 5 最小补丁方案（diff 草案，未应用）

### 5.1 主补丁：`src/sources/weixin.ts` 补看门狗（对齐 feishu-loops 的重建循环）

```diff
--- a/src/sources/weixin.ts
+++ b/src/sources/weixin.ts
@@
   ctx.effect(() => {
     const context = sourceContext(host, kind)
     bot.attach(context)
     const controller = new AbortController()
-    const running = bot.run(controller.signal).catch((error: unknown) => {
-      try { context.report(WEIXIN_POLL, { state: 'error', detail: `The Weixin Source stopped: ${String(error)}` }) } catch { /* unregistered */ }
-      ctx.logger.warn('dsh-superagent weixin loop failed: %s', String(error))
-    })
-    return async () => { bot.detach(); controller.abort(); await running }
+    // `run()` ends the whole lifecycle when a long poll comes back without a stale token (see its `if (outcome !== 'auth') return`).
+    // A supervisor keeps the Source alive instead of trusting one run: a run that ends while the plugin is still wanted is
+    // restarted after a backoff, exactly as the Feishu consumer is (src/sources/feishu-loops.ts:43-66).
+    let retry = 1_000
+    const running = (async () => {
+      while (!controller.signal.aborted) {
+        const began = Date.now()
+        try { await bot.run(controller.signal) } catch (error: unknown) {
+          if (controller.signal.aborted) return
+          try { context.report(WEIXIN_POLL, { state: 'error', detail: `The Weixin Source stopped: ${String(error)}` }) } catch { /* unregistered */ }
+          ctx.logger.warn('dsh-superagent weixin loop failed: %s', String(error))
+        }
+        if (controller.signal.aborted) return
+        // Still wanted? `ctx.config(SOURCE)` is undefined once the Source is disabled or uninstalled.
+        if (!context.config(SOURCE)) {
+          try { context.report(WEIXIN_POLL, { state: 'paused', detail: 'Off' }) } catch { /* unregistered */ }
+          return
+        }
+        retry = Date.now() - began >= 60_000 ? 1_000 : Math.min(retry * 2, 60_000)
+        ctx.logger.warn('dsh-superagent weixin loop ended after %d ms; restarting in %d ms', Date.now() - began, retry)
+        await new Promise(resolve => { const timer = setTimeout(resolve, retry); controller.signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
+      }
+    })()
+    return async () => { bot.detach(); controller.abort(); await running }
   }, 'weixin: bot')
```

要点（评审时请确认）：
1. **重建循环放在插件层**（`ctx.effect`），而不是改 `WeixinBot.run()` 的返回语义——这样 `run()` 那条"token stale 时先重登再走"的既有测试（`tests/weixin.spec.ts:165`）语义不变。
2. `context.config(SOURCE)` 为 undefined ⇒ 已被 disable/卸载，直接退出，避免"关掉后还在偷偷重启"。
3. 退避策略复用飞书口径：一次跑了 ≥60 s 的循环重启用 1 s，否则指数退避到 60 s（`feishu-loops.ts:67-69` 的 `consumerRetry`）。
4. 每次重建都写一行 `ctx.logger.warn`（这是本次事故里**最缺的**东西：进程内的死亡没有任何日志）。

#### 5.1.1 落地记录（实际实现与上面草案的差异）

实际改动：`src/sources/weixin.ts`（主补丁）、`src/sources/poll.ts`、`src/sources/feishu-loops.ts`。

1. **抽成具名函数 `superviseWeixin(source, signal)`**，并导出 `WeixinSupervisor` 接口（`run` / `loggedIn` /
   `report` / `warn` / 可选 `wait`）。`apply()` 只负责装配：`run: signal => bot.run(signal)`、
   `loggedIn: () => bot.readCredentials() !== undefined`、`report`（包住 `context.report(WEIXIN_POLL, …)` 以容忍
   kind 先注销）、`warn`。这样门禁不必伪造完整 Cordis 上下文就能驱动它，同时第 3 条测试仍能验证入口确实接上了它。
2. **不用 `context.config(SOURCE)` 判断"是否还要跑"，改用 `bot.readCredentials()`**。原因：Source 被 disable 时
   `run()` 并不返回（它自己空转 `IDLE_MS` 等待），那条分支在真实路径上不会命中；真正需要拦住的是"`run()` 因为
   没人扫码而结束"——`run()` 的注释明确写了 a login that does not finish stops instead of issuing codes nobody
   scans，若无条件重建就会反复出二维码。只有已保存登录时才重建。
3. **退避函数上移到 `src/sources/poll.ts`**（`consumerRetry`，原定义在 `feishu-loops.ts`），`feishu-loops.ts` 保留
   `export { consumerRetry }`，因此 `feishu.ts` 的公共出口与 `tests/sources.spec.ts:307-310` 的既有断言不变。两个
   Source 共用同一条退避策略，而不是复制一份。
4. **`wait` 可注入**：生产用 `node:timers/promises` 的 `delay`（可被 abort 立即唤醒），测试传 stub，避免每条测试
   白等 1 s。
5. **门禁扩到 3 条**（`tests/weixin-lifecycle.spec.ts`）：①signal 仍存活时 `poll()` 返回 `'aborted'` → 必须发生第二次
   poll，且 `WEIXIN_POLL` 报 `starting`、日志含 `restarting`；②无已保存登录时**不**重建（只 poll 一次，日志含
   `without a saved login`）；③**接线测试**：用最小 Cordis 上下文调用 `apply()`，断言插件入口确实安装了 supervisor。
   第③条做过变异验证——把 `apply()` 里的 `superviseWeixin({...})` 换回 `bot.run(...)` 后该测试 5 s 超时失败。

实测（2026-11-11 14:33，未重启）：

```
$ npx vitest run tests/weixin.spec.ts tests/weixin-lifecycle.spec.ts
✓ tests/weixin.spec.ts (13 tests)
✓ tests/weixin-lifecycle.spec.ts (3 tests)
Test Files 2 passed (2) · Tests 16 passed (16)

$ npx tsc --noEmit
tsc exit=0
```

基线与既有失败：`tests/sources.spec.ts` 的 6 条 `feishu event consumer` 用例在本机 **HEAD 原树（无本补丁）上同样
失败**（各约 10 s 超时 / 临时目录 EPERM）；已用 `git archive HEAD` 导出干净树对照确认，与本补丁无关。

#### 5.1.2 与宿主看门狗的配合（2026-11-11 15:16 补强）

看门狗（`~/.dsh/daemon/desktop-watchdog.ps1`，control4-liveness）每轮 `GET /orchestrator/api/state`，读
`health['weixin-poll']`，按 **`state` + `at` 的年龄** 判 `ok/warn/fail`（`$WeixinStaleSec`；`error` 直接 fail），
fail 连续 `$AlertAfter`（默认 2）次才 `Set-Alert`。它**只报警不重启**（重启只走显式 `POST /restart` 或 host missing）。

因此 supervisor 必须做两件看门狗做不到的事，否则会互相抵消：

1. **每次报告都带 `at`**。起初 supervisor 的 `starting` 报告没有 `at`，而看门狗在 `at` 缺失时判 `warn`（"starting
   without a timestamp"），`warn` 又会清零 `PluginFailures` 并清掉已有告警——恰好在重启窗口里把探测打瞎。现在
   `starting` / `error` 两条报告都带 `at: new Date().toISOString()`。
2. **连续快速死亡升级为 `error`**。否则每次重建都会刷新 `at`，一个"起来就死"的抖动循环在看门狗眼里永远是新鲜的
   `ok`。现在连续 3 次"几乎立刻结束"（`ranMs < 60 s`）就把 `WEIXIN_POLL` 报成 `error`（detail 含 `keeps ending`），
   看门狗随即 fail → 2 次后告警；一次跑满 60 s 的运行会把计数清零。

对应断言见 `tests/weixin-lifecycle.spec.ts`：第一条断言 `at` 可被 `Date.parse`，新增一条断言连续三次快速结束报 `error`。


### 5.2 可选小补丁：让 `run()` 不再把"非 abort 的 aborted"当正常结束

```diff
--- a/src/sources/weixin-bot.ts
+++ b/src/sources/weixin-bot.ts
@@
       const outcome = await this.poll(signal)
       await this.api!.notify('stop').catch(() => {})
       if (signal.aborted) return
-      if (outcome !== 'auth') return
+      // `poll()` only returns 'aborted' when the signal aborted, which is handled above; returning 'aborted' while the
+      // signal is live is a loop ending nobody asked for, so say so instead of leaving the Source silently dead.
+      if (outcome !== 'auth') { this.log(`poll loop ended unexpectedly outcome=${outcome}`); return }
```

这条**不修行为**，只补日志；若嫌 `log()` 走 `ctx.logger.warn` 太重，可改为一行 `context.state.set`（见 5.3）。
单独依赖 5.1 也能自愈，5.2 只是让"为什么退出"在下一次事故里可查。

### 5.3 可选：把 poll 状态落到 kv（本次事故查不到死因的根因）

```diff
--- a/src/sources/weixin-bot.ts
+++ b/src/sources/weixin-bot.ts
@@
       this.reportPoll('ready', `Listening to direct messages; ${this.received} received`)
+      // HealthBoard is in-memory only, so a dead loop leaves no trace outside the process; keep the last poll's outcome.
+      context.state.set(KV.weixin.pollState, { at: this.stamp(), cursor, received: this.received })
```

需要在 `src/kv.ts` 的 `KV.weixin` 里加 `pollState` 键；**这会新增一条 kv 记录**，属数据面变更，需单独评审。

---

## 6 验收顺序（补丁落地时）

已经通过（2026-11-11 14:33，未重启）：
1. `npx vitest run tests/weixin-lifecycle.spec.ts` → **3 passed**（含接线测试；改前为 1 failed 的红门禁）；
2. `npx vitest run tests/weixin.spec.ts` → 既有 13 条仍全绿（尤其 `:165` 的 stale-token 重登、`:194` 的 3 次失败报告）；
3. `npx tsc --noEmit` → exit 0。

仍需装包 + 重启后才能验（**不由本文作者执行**）：
4. 隔离 profile（独立 stateDir + 独立端口，微信 Source 可保持 disabled，用 stub）跑一轮：插件禁用后**不再重启**（5.1.1 第 2 点）；
5. 上线后 `node scripts/weixin-liveness.mjs --json` 作为巡检命令（退出码可直接进监控），并在面板上确认出现
   `The poll loop ended; restarting in … ms` 的 `starting` 状态时能被人看到。
