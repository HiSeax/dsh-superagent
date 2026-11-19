# superagent-board 设计（v0）

日期：2026-11-06
状态：已获用户口头批准（2026-11-06 16:32），待落 spec 复审

## 1. 目标

给 DSH 桌面端做一个**自己的任务看板**，一块页面同时看清两件事：

1. **团队**：主代理与每个成员此刻在干什么（谁是主代理、谁空闲、谁在处理哪个工单）
2. **工单**：所有工单按状态分布，能点开看触发、线程与最近一次报告

替换动机：现有 better-sidebar 的任务页层级不分、成员没有可读名字、动效弱。本项目做**独立插件**，不 fork、不依赖它。

## 2. 非目标（v0 明确不做）

- 新建工单、改优先级、改工单标题
- 改成员/子代理名字（DSH 宿主不支持，见 §7）
- 深色主题（只做浅色，颜色走 CSS 变量留接口）
- 移动端适配（DSH 桌面端优先）
- 历史归档检索、报表导出

## 3. 形态

两个产物，分两个仓库：

| 产物 | 位置 | 职责 |
|---|---|---|
| superagent 只读看板接口 + 动作接口 | `C:\Projects\superagent` | 提供工单/成员数据与 stop/retry/unfocus |
| `superagent-board` 插件 | 新仓库 `C:\Projects\superagent-board` | DSH 侧边栏页面：外壳 React + 主体 iframe |

### 3.1 页面结构

```
┌ superagent-board（侧边栏页面） ─────────────────┐
│ 外壳（React）：标题 / 刷新指示 / 最近更新时间     │
├─────────────────────────────────────────────────┤
│ 主体（iframe，自带前端）：                        │
│   ① 团队区：主代理卡 + 成员卡（状态点 + 任务行）  │
│   ② 工单区：按状态分组的列表，点开右侧详情        │
└─────────────────────────────────────────────────┘
```

外壳与 iframe 之间**只通过 HTTP 取数**（见 §4），不做 postMessage 数据推送。

页面形态（DSH 0.2.x 实测）：侧边栏页面是**客户端插件通过 slots 注册的 React 组件**（`sidebar.panellist` 列表 + layout 的 `main` keyed slot，两者同 id），宿主**没有 iframe 页面注册 API**。外壳组件内部再嵌 iframe；iframe 的 URL 由**插件自己的宿主路由**（`ctx.webServer.register`）提供，不使用宿主静态资源目录。

## 4. 数据通路

### 4.1 superagent 侧（只读 + 三动作）

- 监听：`127.0.0.1:8916`（仅回环；端口可配置）
- `GET /board.json` → 见 §5 schema
- `POST /board/action`，body `{ kind: "stop"|"retry"|"unfocus", ticketId }`，返回 `{ ok, message }`
- 鉴权：启动时生成 32 字节随机 token，写入 `<stateDir>/board-token`（`stateDir` 本身即 `~/.dsh/state/superagent`，权限 600），客户端带 `Authorization: Bearer <token>`
- 动作语义：stop / retry 复用现有 `engine.stopTicket` / `retryTicket`；unfocus = 取消该工单**所有订阅线程**的订阅（对该工单的每个 thread 调一次现有 `engine.unsubscribe`，线程粒度，会同时取消该线程上其他工单的订阅）。**不新增业务规则**

### 4.2 插件侧

- 插件宿主半起 `127.0.0.1:8917`，`GET /board.json`（另加 `GET /healthz`）聚合：superagent `GET http://127.0.0.1:8916/board.json`（Bearer token 读 `~/.dsh/state/superagent/board-token`）+ 别名层（§6）。宿主侧团队 `members` 继续留空（`startBoardServer({ team })` 保留注入缝）
- **团队 roster（v0 实际路径）**：由**页面外壳（客户端 React）**订阅 `ctx.sessions.list.getSnapshot().projectionsBySession[*].values.agentTeam`（Lead Session 的投影；`id/name/role/phase`，并用 session list 的 running 叠运行态），变化时 `postMessage({ type: 'roster', data: { members } })` 给 iframe；iframe 把 roster 与工单合并，不经过宿主网络取 roster
- **别名层同构**：`src/shared/alias.ts` 是唯一实现（活跃集 `evaluating|executing|review`、同成员取最新 `updatedAt`、`displayName`=标题且超 24 字截断）；宿主 `aggregate()` 与 iframe `app.js` 引用同一模块，不允许两份实现
- 页面是客户端 slots 注册的 React 组件；组件内嵌的 iframe 由**插件自己的宿主路由**提供（`ctx.webServer.register({ kind: 'prefix', path: '/superagent-board' })`，同源提供 `index.html`/`app.js`/`tokens.css`/`alias.js`，并把 `/board.json`、`/healthz` 代理到 8917），iframe 以 **2500 ms** 轮询 `/board.json`
- 任一源失败时返回**部分数据 + `degraded: { source, since }`**，页面显示不阻断的提示条；无 roster 时团队区显示“未获取到团队成员”，工单区照常

## 5. `board.json` schema（v0）

```jsonc
{
  "schemaVersion": 1,
  "generatedAt": "2026-11-06T16:40:00+08:00",
  "degraded": null,                 // 或 { "source": "superagent", "since": "..." }
  "main": { "id": "lead", "name": "lead", "role": "lead", "state": "working" },
  "members": [
    {
      "id": "local-source-dev",
      "name": "local-source-dev",          // 原 kebab 名
      "displayName": "Fix timezone handling in export button",          // 别名层结果；无工单时回退 name
      "role": "teammate",
      "state": "working",                  // working | idle | blocked | failed | unknown
      "ticketId": "T-2026-...",            // 当前工单，可为 null
      "ticketTitle": "Fix timezone handling in export button",
      "lastActivityAt": "2026-11-06T16:38:12+08:00"
    }
  ],
  "tickets": [
    {
      "id": "T-...",
      "title": "Fix timezone handling in export button",
      "state": "executing",                // new | evaluating | executing | review | done | blocked | failed | stopped
      "ownerMemberId": "local-source-dev",
      "updatedAt": "...",
      "summary": "最近一次报告前 200 字"
    }
  ]
}
```

## 6. 别名层（P0）

- 键：`memberId`（团队投影的 `name`）→ 值：该成员当前工单标题
- 取值：superagent `board.json` 里 `tickets` 的 `ownerMemberId` 匹配、状态属 `evaluating|executing|review`
- 显示优先级：`ticketTitle` → `name`（v0 没有手工别名，`displayName` 只是聚合结果，不单独维护）
- 无工单时：显示 `name` + 状态「空闲」
- 长度：**不截断中文**（board 内是 iframe 自己的排版，不受 DSH 80 字节会话标题限制）；超过 24 字截断加省略号，`title` 属性放全文

## 7. 已知约束（宿主能力）

- **团队成员名不可改**（`dsh-experimental-agent-team`：flat immutable roster，无 rename；name 只允许 lower-kebab-case）
- **子代理 label/description 创建后不可变**
- **会话标题可改但有 80 字节上限**，cold 子代理会话改不了
- 因此 board 用**别名层**满足"名字要说清在干什么"；DSH 原生 roster 仍显示 kebab 名（已知差异，v0 接受）

## 8. UI 规格

### 8.1 团队卡

- 主代理卡：更宽，白底 + 顶部 28px 信息带 `#f5f5f7`，「主代理」实心角标
- 成员卡：208×108，白底，1px `#e0e0e0` 边框，圆角 12
- 内容顺序：状态点（8px）＋ 任务行（13px/600，`#1d1d1f`）→ 任务副行（12px，`#7a7a7a`，显示工单标题或状态词）→ 底部角色小标 + 最近活动
- 状态色（固定，跟 DESIGN.md 的语义色对齐）：运行 `#0066cc`、空闲 `#7a7a7a`、阻塞/失败 `#d70015`、完成 `#1d7d3f`
- 运行中：状态点呼吸动画（`transform/opacity`，1.4s，`prefers-reduced-motion` 下停用）+ 卡顶 2px `#0066cc` 细边

### 8.2 工单区

- 分组列：新建 / 评估中 / 执行中 / 待审 / 完成（其余状态折叠进"异常"）
- 每行：标题 / 归属成员（显示别名）/ 更新时间；点开右侧详情面板列出触发、线程、最近报告摘要
- 动作按钮：`停止`、`重试`、`移出焦点`，**二次确认**（内联确认，不弹窗），执行中显示 spinner，完成后在行内回显 `ok/fail` 与原因。**移出焦点 = 取消该工单所有订阅线程**（逐一调用现有 thread 粒度 `engine.unsubscribe`，会同时取消同线程其他工单的订阅）；移出后该工单不再接收这些线程的新消息，恢复需重新订阅；无订阅线程时回 200 与说明，否则回 `unsubscribed: N`

### 8.3 视觉基准

唯一基准：`C:\md文件\design\apple\DESIGN.md`。关键 token：

- 画布 `#f5f5f7`、卡片 `#ffffff`、正文 `#1d1d1f`、次级 `#7a7a7a`
- 强调 `#0066cc`（focus 态 `#0071e3`）
- 分隔线 `#e0e0e0`，弱分隔 `#f0f0f0`
- 字阶：任务行 13/600、副行 12/400、区块标题 15/600；SF Pro → `-apple-system, "SF Pro Text", "Segoe UI", system-ui`
- 圆角：卡 12、按钮 8、角标 4；间距按 8px 网格（8/16/24/32）

## 9. 错误处理

| 场景 | 行为 |
|---|---|
| superagent 接口不可用 | 团队区正常、工单区显示"数据源中断（N 秒前），重试中"；外壳顶部黄色提示条 |
| 动作失败（409/400） | 行内红字显示服务端 `message`，不改变本地状态 |
| 数据里某工单缺 owner | 显示"未分配"，不猜 |
| iframe 加载失败 | 外壳显示"页面加载失败 + 重试按钮"，并给出插件端口 |

## 10. 验收

1. **契约测试**：`board.json` schema 校验（必填字段、状态枚举），缺字段时降级路径可跑
2. **别名层单测**：有工单 / 无工单 / 多工单择一 / 长标题截断
3. **动作接口测试**：stop/retry/unfocus 对不存在工单返回 404、对已完成工单返回 409、正常路径 200
4. **界面冒烟**：无头浏览器打开侧边栏页面，截图断言"主代理卡存在、成员卡 ≥1、每张卡有状态点与任务行、工单区有分组标题"
5. **降级演练**：停掉 superagent 接口，页面不白屏且出现提示条
6. **不回归**：DSH 宿主正常启动、better-sidebar 仍可用、superagent 现有功能不受影响

## 11. 风险

- 跨插件耦合：superagent `board.json` 的字段变更会影响 board；用 §5 的 schema 版本号（`schemaVersion`）与契约测试兜住
- 宿主团队投影在侧边栏页面是否可直接读取，需一次可行性验证（插件上下文提供 `agentTeam` 的前提）
- iframe + 本地 HTTP 若被 CSP 拦截，需回退到"外壳直取数据 + iframe 只渲染"（数据经 `postMessage` 传入）

## 12. 分期

- **v0（本 spec）**：只读看板 + 三个动作 + 别名层
- **v1（未定）**：筛选/搜索、按成员聚合视图、把工单卡拖到"暂停"
- **v2（未定）**：新建工单、批量操作、历史时间线

