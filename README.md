# 工作台（workbench）

本库自研的 Obsidian 本地插件。用户使用说明见
`03-Personal/1.知识体系/2.工具使用/工作台插件使用说明.md`。

## 文件

| 文件 | 说明 |
| --- | --- |
| `manifest.json` | 插件清单（id: `workbench`） |
| `main.js` | 全部逻辑，纯 CommonJS，无构建步骤，改完直接「重新加载插件」 |
| `styles.css` | 样式，使用 Obsidian CSS 变量，跟随主题 |
| `data.json` | 运行期生成的设置，首次保存设置后出现 |

## 结构

```
main.js
├── 纯函数区（可脱离 Obsidian 单测）
│   ├── parseTaskLine / cleanDescription / statusFromSymbol
│   ├── applyStatusChange / structDepth / findChildBlockEnd
│   ├── insertAfterTaskBlock / removeCompletionNotes / hasCompletionNoteBelow
│   ├── findNewlyDoneChanges
│   └── parseFrontmatterDate / dateFromFilename / isInMonth
├── CompletionModal        # 完成情况询问框
├── WorkbenchView          # 三栏看板视图
├── WorkbenchPlugin        # 插件主体：扫描、快照、写回
└── WorkbenchSettingTab    # 设置页
```

纯函数通过 `module.exports.<name>` 挂到导出类上，便于用 Node 存根测试。

## 关键设计

- **所有范围共用同一条排除规则** `isSourcePathForScope(path, scope, settings)`：先过
  `isExcludedSourcePath()`，再按范围判断目录。**曾漏用于「全库」档**，导致仓库根 `AGENTS.md`
  里 Tasks 语法示例（`#action 待办任务 📅 2026-03-15`）被当成真任务。`isSourceFile()` 与 `scan()`
  现在都委托同一个纯函数，不会再有第二套逻辑。
- **三类扫描目录共用同一条排除规则** `isExcludedSourcePath()`：排除目录、`assets/`、以及
  `AGENTS`/`README`（仅空格、下划线、点或结尾分隔）与精确的 `说明.md`/`索引.md`。
  曾因 `isInPlanFolders` 漏用该规则，导致 `04-Operations/AGENTS.md` 被当成文档计数；
  规则对 `说明会记录.md`、`README-项目.md` 这类正文名**不误伤**（宁可少排除，不可误删）。
- **三个页签**：`state.tab` 为 `overview`（总览，默认）、`plan`（未来工作安排）、
  `review`（会议/项目行动项三栏看板）。页签不进扫描缓存键，切换只重绘。
  总览把「安排」与「到期待办」按日期合并成时间线，指标卡用 `goTab()` 跳到对应页签。
  总览的待办来自 `snapshot.allTasks`（未按范围过滤），因为总览需要跨月视野。
- **一个安排 = 一个笔记**：写在 `planFolders`（默认 `04-Operations`）下的
  `YYYY-MM-DD-事件.md`，frontmatter `二级分类: 工作安排`，符合仓库 AGENTS.md §3。
  识别见 `isPlanFile()` / `parsePlanFileName()`，生成见 `buildArrangementNote()`。
- **Calendar 自动落位**（`handleDailyNoteCreated`）：Calendar 插件只能配一个目录，
  没有按日期分支的能力，所以本插件在 vault `create` 事件里接手它生成的
  `04-Operations/YYYY-MM-DD-工作安排.md`：`日期 >= 今天` 就地填成一条**普通工作计划**
  （`buildDailyNote()` 直接复用 `buildArrangementNote()`，两者逐字节一致，
  这就是用户要的「与计划文件完全一致」；`kind: 'plan'` 而非独立类型，
  文件留在 `04-Operations`，进计划页）；`日期 < 今天` 改名 `YYYY-MM-DD-会议.md` 移入
  `calendarMeetingFolder`，套用 `calendarMeetingTemplate`（`renderMeetingTemplate()`
  替换 `<% tp.date.now() %>`、硬编码的 `modified`、并补 `#action` 占位与 H1 标题）。
  目标路径由纯函数 `dailyNoteTargetPath()` 计算（基础名见 `dailyFileBase()`），重名自动 `-2`/`-3`。
  **踩过的坑**：`fileManager.renameFile()` 会**原地改写** `TFile.path`，因此 busy 去重键
  必须在改名**之前**取出存好、在 `finally` 里用该原始键删除；否则 `delete(file.path)`
  删的是新路径，旧键永久泄漏，后续同名创建事件被静默吞掉（表现为「重复点击过去日期
  不再生成 `-2`」）。另外 `daily-notes.json` 的 `format` 必须与 `DAILY_NAME_RE` 一致，
  插件只接管 `YYYY-MM-DD-工作安排`（正则仍兼容历史遗留的 `-日报` 后缀）。
- **时间用 `⏰ HH:mm`**：Tasks 插件不认这个符号，会当普通描述文字忽略，因此不影响它对
  `📅` 的解析；插件侧 `parseTimeMarker()` 取出时间。
  frontmatter 的 `时间` **必须加引号**（YAML 1.1 会把 `10:00` 解析成 600）。
- **时间分组**：`timeBucket()` 把安排分为 今天/明天/本周内/下周/本月内/更远/未排期/已过去，
  周一为一周之首。
- **两类扫描目录**：`meetingFolders`（会议目录，文件一律算会议）+ `extraFolders`（附加目录，
  如商机/项目：`#action` 进看板，但只有 frontmatter 带 `会议类别` 的才算会议，见
  `isMeetingRecord()` / `frontmatterHasField()`）。任务按**来源文件日期**圈定范围，
  所以附加目录里方案/入口文档的待办也能出现在本月看板。
- **统计卡即筛选器**：`renderHeader()` 把五张卡渲染成 `<button>`，点击时只改视图状态
  （`scope` / `statusFilter`）并由 `applyFilter()` 重绘。`statusFilter` **不进**扫描缓存键，
  所以点状态卡不触发重新扫描，瞬时响应；只有 `scope` 变化才重扫。
- **会议行状态小标签同时锁会议**：会议行右侧的「进行中 7」如果只设 `statusFilter`，
  看板会拉出**全库**所有进行中的任务（几百项），而不是这一场的 7 项。所以点小标签时
  同时写 `meetingFilter`（会议文件路径）与 `statusFilter`，由纯函数
  `filterByMeeting(snapshot, meetingPath, onlyMine, now)` 收窄快照：`tasks` 只留这场会议的，
  `allTasks` 同步收窄供下游复用，并把 `monthTaskCount` / `monthMeetingCount`
  改成本场口径（`inMonth.length` / 1），避免两张本月卡与看板打架。三处退出入口：
  会议行小标签再点一次、工具条 chip 的 `×`、清单标题的「显示全部会议」；
  点上方统计卡或切换「范围」也会顺带清掉 `meetingFilter`。与 `statusFilter` 一样**不进**缓存键。
- **扫描缓存键**：统一由 `viewCacheKey(state)` 生成，含 `scope|search|rangeStart|rangeEnd`。
  时间区间参与扫描（在 `scan()` 里过滤），因此改日期会重扫；状态筛选只在渲染层过滤。
- **「只看我的」**：`taskInvolvesMe(task, selfNames)` 是纯函数。任务写了 `👤` → 只看执行人；
  没写 `👤` → 退回它所在文件的 `参会人员` / `参与人`（会议纪要与工作安排用了两个不同字段名，
  两个都收）。`scan()` 给每条任务打 `mine` 标记，开关本身**不进缓存键**，点按钮只重绘不重扫，
  与 `statusFilter` 同一套路。开启时 `applyMine()` 用浅拷贝收窄快照，并把
  `monthMeetingCount` / `monthTaskCount` 换成 `mineMonth*`，让五张卡同步收窄，避免数字与看板打架。
- **自选时间范围**：`scope === 'range'` 时用 `inDateRange()` 按闭区间圈会议，起止倒填自动交换，
  未给日期时回落到「本月 1 日 ~ 今天」。
- **先确认后落盘**：`setTaskStatus()` 在目标状态为 `done` 时**先** `askCompletion()`，
  返回 `null`（取消）就直接 return，一个字节都不写。编辑器路径（`handleEditorCompletion`）
  取消时用 `task.prevLine`（由 `findNewlyDoneChanges()` 带出）把那行还原成改动前的内容。
- **卡片勾选框**：`renderCard()` 在标题左侧渲染 `input[type=checkbox]`，勾选走
  `setTaskStatus(task, DONE)`（含完成时间与完成情况询问），取消走 `DOING`（撤销完成）。
  样式用 `input.wb-card-check[type="checkbox"]` 提高优先级——否则会被 Obsidian 全局复选框
  样式盖成 21px。
- **三态是推导的**：`deriveStatus(symbolStatus, startDate, today)`。`[x]`/`[-]`/`[/]` 照符号走；
  未勾选的 `[ ]` 只有「`🛫` 在未来」才算 `todo`，没有 `🛫` 或 `🛫` 已到都算 `doing`。
  因此「转为未开始」必须写入一个未来日期（取最小未来日 = 明天，见 `tomorrowOf()`），
  否则会被立刻重判为进行中。原始符号状态保留在 `symbolStatus` 字段，便于排查。
- **任务格式**：`- [ ] #action 内容 👤执行人 📅 截止 ➕ 创建`，兼容 Tasks 插件的
  自定义状态（`/` = In Progress）。
- **引用块支持**：`TASK_LINE_RE` 允许 `> - [ ] #action …` 形式；
  `structDepth()` 把 `>` 层级折算成缩进宽度，保证子行归属正确。
- **完成时间**：任务行只写标准 `✅ YYYY-MM-DD`（Tasks 可解析），精确到分钟的
  完成时间写在任务下方的缩进子行 `- ✅ YYYY-MM-DD HH:mm 完成情况：…`。
- **两处「修改」按钮**：计划页改安排本身（`updateArrangement` + `rewriteArrangementNote`），
  回顾页改任务四要素（`updateTask` + `applyTaskEdits`）。设计上都走「摘出不可编辑标记 →
  只替换目标字段 → 按固定顺序重排」，因此状态、🛫/✅/➕、完成情况子行一律不受影响。
- **改名规则**：`nextPlanPath(item, input, exists)` 是纯函数，**日期或事件名称任一变化**
  都重命名文件以符合 `YYYY-MM-DD-事件.md`（重名加 `-2`，标题过 `sanitizeFileName`）。
  修这个 bug 之前的写法只在日期变化时改名，导致「只改名称」时 `# 标题` 已更新、
  文件名没动——而 `parseArrangement` 的 title 取自文件名，于是看板上看起来「改名称失败」。
- **面板折叠**：计划页两个面板（未来工作安排 / 未来待办）的展开收起状态存在
  `view.state.planCollapsed` / `upcomingCollapsed`，**不进 DOM 局部变量**——早期写法用
  `let collapsed = false`，任何一次 `refreshViews()` 都会把它重置成展开。
- **编辑器勾选检测**：维护「文件路径 → 行数组」快照，`vault.on('modify')` 时用
  `findNewlyDoneChanges()` 对比，识别「刚被勾选完成」的任务；写回期间用
  `internalWrite` 标志避免自触发。
- **撤销清理**：撤销完成时用 `removeCompletionNotes()` 删除插件写入的子行，
  使再次完成能重新询问。
- **外部改动刷新**：`create` / `delete` / `rename` 三个事件都走 `refreshViews()`
  （250ms 防抖），只 `invalidateCache()` 不重绘是曾经的 bug——手动往
  `04-Operations` 丢一个文件进去，看板要等到下次交互才更新。`create` 时顺便
  `snapshotFile()`，否则新文件的第一次勾选会被当成「无快照」而跳过完成询问。

## 本地测试

Node 存根 + 真实仓库数据（不依赖 Obsidian）：

```bash
mkdir -p /tmp/wb-test/node_modules/obsidian   # 放入 obsidian API 存根
NODE_PATH=/tmp/wb-test/node_modules node /tmp/wb-test/test.js
```

测试覆盖：任务行解析（含引用块）、状态改写、子行插入与边界、勾选检测、
日期解析、全仓扫描计数与 grep 对齐、撤销清理、真实文件写回 dry-run。

## 修改后如何生效

1. 命令面板执行 `插件: 重新加载`，或用 CLI：`obsidian plugin:reload id=workbench`
2. 检查错误：`obsidian dev:errors`
3. 发现异常时先看 `obsidian dev:console level=error`
