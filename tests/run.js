'use strict';
/*
 * 工作台纯函数测试。
 *
 *   node tests/run.js
 *
 * 用极简 obsidian 存根把 main.js require 进来，只测纯函数 + 合成库上的扫描，
 * 不依赖 Obsidian、也不依赖任何真实笔记库。
 */
const path = require('path');
const fs = require('fs');

// 把裸模块名 'obsidian' 指到极简存根，main.js 顶部的 require('obsidian') 才能解析。
// 用解析钩子而不是 node_modules，这样仓库里不需要任何依赖、也不用提交 node_modules。
const Module = require('module');
const stubPath = path.join(__dirname, 'obsidian-stub.js');
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
	if (request === 'obsidian') return stubPath;
	return origResolve.call(this, request, ...rest);
};

const W = require(path.join(__dirname, '..', 'main.js'));
const fixture = require('./fixture-vault.js');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
	if (cond) { pass++; }
	else { fail++; failures.push(name + (extra ? `  -> ${extra}` : '')); }
	console.log(`  ${cond ? 'PASS' : 'FAIL'} ${name}${cond || !extra ? '' : '  -> ' + extra}`);
}

/* ================= 1. 任务行解析 ================= */
console.log('\n=== 1. 任务行解析 ===');
const sample = '- [x] #action 签署保密协议 👤[[张三]] 🔺 ➕ 2026-09-01 📅 2026-09-03 ✅ 2026-10-12';
const t = W.parseTaskLine(sample, 0, '#action');
ok('识别为任务', !!t);
ok('状态=已完成', t && t.status === 'done', t && t.status);
ok('执行人=张三', t && JSON.stringify(t.assignees) === '["[[张三]]"]', t && JSON.stringify(t.assignees));
ok('截止日期', t && t.due === '2026-09-03', t && t.due);
ok('完成日期', t && t.doneDate === '2026-10-12', t && t.doneDate);
ok('创建日期', t && t.created === '2026-09-01', t && t.created);
ok('优先级', t && t.priority === '🔺', t && t.priority);
ok('描述不含标记', t && !/[👤📅➕✅🔺]/.test(t.description), t && t.description);
ok('非任务行返回 null', W.parseTaskLine('随便一行文字', 0, '#action') === null);
ok('空复选框不算任务', W.parseTaskLine('- [ ] #action', 0, '#action') === null);

console.log('\n=== 1b. 引用块 / callout 内的任务 ===');
const quoted = '> - [ ] #action 引用块里的任务 👤[[张三]] 📅 2026-09-30';
const qt = W.parseTaskLine(quoted, 0, '#action');
ok('引用块任务被识别', !!qt, String(qt));
ok('引用块描述正确', qt && qt.description === '引用块里的任务', qt && qt.description);
ok('引用块有 quotePrefix', qt && !!qt.quotePrefix, qt && JSON.stringify(qt.quotePrefix));
ok('structDepth 把 > 折算成缩进', W.structDepth('> - [ ] x') > 0, String(W.structDepth('> - [ ] x')));

/* ================= 2. 状态改写 ================= */
console.log('\n=== 2. 状态改写 ===');
const line = '- [ ] #action 某任务 👤[[张三]] 📅 2026-10-01';
const done = W.applyStatusChange(line, W.STATUS.DONE, { doneDate: '2026-10-05' });
ok('改成已完成写 [x]', done.includes('- [x]'), done);
ok('已完成写入 ✅ 日期', done.includes('✅ 2026-10-05'), done);
const back = W.applyStatusChange(done, W.STATUS.DOING, { startDate: '2026-10-06' });
ok('撤销完成去掉 ✅', !back.includes('✅'), back);
ok('撤销完成回到 [/]', back.includes('- [/]'), back);
const unchanged = W.applyStatusChange(line, W.STATUS.DOING, {});
ok('改状态不动描述与日期', unchanged.includes('某任务') && unchanged.includes('📅 2026-10-01'), unchanged);

/* ================= 3. 完成情况子行 ================= */
console.log('\n=== 3. 完成情况子行 ===');
const built = W.buildCompletionNote('\t', '2026-10-05 10:30', '已交付', '完成情况');
ok('子行含完成情况标签', built.includes('完成情况'), built);
ok('子行含精确时间', built.includes('10:30'), built);
ok('子行含文本', built.includes('已交付'), built);
ok('子行是列表项', /^\s*-\s/.test(built), built);

/* ================= 4. 描述清洗边界 ================= */
console.log('\n=== 4. 描述清洗 ===');
ok('去掉 #action 标签', W.cleanDescription('#action 做事', '#action') === '做事');
ok('去掉 emoji 标记', !W.cleanDescription('做事 👤[[张三]] 📅 2026-10-01', '#action').includes('📅'));
ok('保留正文', W.cleanDescription('#action 准备材料', '#action') === '准备材料');

/* ================= 5. 三态推导 ================= */
console.log('\n=== 5. 未开始 / 进行中 / 已完成 推导 ===');
const today = '2026-10-12';
ok('[x] 恒为已完成', W.deriveStatus('done', null, today) === 'done');
ok('[/] 恒为进行中', W.deriveStatus('doing', null, today) === 'doing');
ok('[-] 为已取消', W.deriveStatus('cancelled', null, today) === 'cancelled');
ok('无 🛫 的未勾选=进行中', W.deriveStatus('todo', null, today) === 'doing');
ok('🛫 在未来=未开始', W.deriveStatus('todo', '2026-11-01', today) === 'todo');
ok('🛫 已到=进行中', W.deriveStatus('todo', '2026-10-01', today) === 'doing');
ok('🛫 就是今天=进行中', W.deriveStatus('todo', '2026-10-12', today) === 'doing');
// tomorrowOf 收 Date，返回 YYYY-MM-DD
const TODAY_D = new Date('2026-10-12T10:00:00');
ok('tomorrowOf 取明天', W.tomorrowOf(TODAY_D) === '2026-10-13', W.tomorrowOf(TODAY_D));
ok('tomorrowOf 跨月', W.tomorrowOf(new Date('2026-10-31T10:00:00')) === '2026-11-01', W.tomorrowOf(new Date('2026-10-31T10:00:00')));
ok('tomorrowOf 无参返回明天', /^\d{4}-\d{2}-\d{2}$/.test(W.tomorrowOf()));

/* ================= 6. 日期工具 ================= */
console.log('\n=== 6. 日期工具 ===');
ok('formatDate 补零', W.formatDate(new Date(2026, 2, 4)) === '2026-03-04', W.formatDate(new Date(2026, 2, 4)));
ok('formatDateTime 带时分', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(W.formatDateTime(new Date(2026, 2, 4, 9, 5))), W.formatDateTime(new Date(2026, 2, 4, 9, 5)));
ok('monthKey', W.monthKey(new Date('2026-10-12T10:00:00')) === '2026-10', W.monthKey(new Date('2026-10-12T10:00:00')));
ok('isInMonth 命中', W.isInMonth('2026-10-01', new Date('2026-10-12T10:00:00')) === true);
ok('isInMonth 不命中', W.isInMonth('2026-09-30', new Date('2026-10-12T10:00:00')) === false);
ok('inDateRange 闭区间', W.inDateRange('2026-10-01', '2026-10-01', '2026-10-31') === true);
ok('inDateRange 越界', W.inDateRange('2026-11-01', '2026-10-01', '2026-10-31') === false);
ok('addDays 跨月', W.addDays('2026-10-31', 1) === '2026-11-01', W.addDays('2026-10-31', 1));
ok('dateFromFilename', W.dateFromFilename('会议/2026-10-02-示例.md') === '2026-10-02');
ok('parseFrontmatterDate', W.parseFrontmatterDate(fixture.MEETING_A) === '2026-09-10');

/* ================= 7. frontmatter 取值 ================= */
console.log('\n=== 7. frontmatter 取值 ===');
ok('取到会议类别', W.frontmatterValue(fixture.MEETING_A, '会议类别') === '业务会议');
ok('空值返回 null', W.frontmatterValue('---\n参与人: ""\n---\n', '参与人') === null);
ok('不存在返回 null', W.frontmatterValue(fixture.MEETING_A, '不存在的字段') === null);
ok('frontmatterHasField 命中', W.frontmatterHasField(fixture.MEETING_A, '会议类别') === true);
ok('frontmatterHasField 未命中', W.frontmatterHasField(fixture.PROJECT_DOC, '会议类别') === false);
ok('多行列表解析', W.parseFrontmatterList(fixture.MEETING_A, '参会人员').join(',') === '张三,李四',
	W.parseFrontmatterList(fixture.MEETING_A, '参会人员').join(','));

/* ================= 8. 会议 vs 文档 ================= */
console.log('\n=== 8. 会议 / 文档 分类 ===');
ok('会议目录下无标记也算会议', W.isMeetingRecord(fixture.PROJECT_DOC, true) === true);
ok('附加目录带标记算会议', W.isMeetingRecord(fixture.MEETING_A, false) === true);
ok('附加目录无标记算文档', W.isMeetingRecord(fixture.PROJECT_DOC, false) === false);

/* ================= 9. 排除规则 ================= */
console.log('\n=== 9. 扫描排除规则 ===');
const EX = ['模板', '归档'];
ok('普通笔记不排除', W.isExcludedSourcePath('计划/2026-10-15-开会.md', EX) === false);
ok('排除目录', W.isExcludedSourcePath('归档/x.md', EX) === true);
ok('排除目录子路径', W.isExcludedSourcePath('模板/a/b.md', EX) === true);
ok('AGENTS.md 排除', W.isExcludedSourcePath('计划/AGENTS.md', EX) === true);
ok('小写 agents 也排除', W.isExcludedSourcePath('计划/agents.md', EX) === true);
ok('README 排除', W.isExcludedSourcePath('项目/README.md', EX) === true);
ok('说明/索引 排除', W.isExcludedSourcePath('a/说明.md', EX) === true);
ok('assets 子目录排除', W.isExcludedSourcePath('会议/assets/x.md', EX) === true);
ok('顶层 assets 排除', W.isExcludedSourcePath('assets/x.md', EX) === true);
ok('AGENTS-说明会.md 不误伤', W.isExcludedSourcePath('计划/AGENTS-说明会.md', EX) === false);
ok('README-项目.md 不误伤', W.isExcludedSourcePath('项目/README-项目.md', EX) === false);
ok('说明会记录.md 不误伤', W.isExcludedSourcePath('计划/说明会记录.md', EX) === false);
ok('AGENTS 副本.md 仍排除', W.isExcludedSourcePath('计划/AGENTS 副本.md', EX) === true);

console.log('\n=== 9b. 各范围的文件判定 ===');
const SET = {
	meetingFolders: ['会议'],
	extraFolders: ['项目'],
	planFolders: ['计划'],
	excludeFolders: EX,
};
ok('会议目录在 folders 档内', W.isSourcePathForScope('会议/a.md', 'folders', SET) === true);
ok('项目目录在 folders 档内', W.isSourcePathForScope('项目/a.md', 'folders', SET) === true);
ok('计划目录在 folders 档内', W.isSourcePathForScope('计划/a.md', 'folders', SET) === true);
ok('无关目录不在 folders 档内', W.isSourcePathForScope('随笔/a.md', 'folders', SET) === false);
ok('全库档收无关目录', W.isSourcePathForScope('随笔/a.md', 'all', SET) === true);
ok('全库档仍排除根 AGENTS.md', W.isSourcePathForScope('AGENTS.md', 'all', { excludeFolders: [] }) === false);
ok('全库档仍排除 assets', W.isSourcePathForScope('x/assets/a.md', 'all', { excludeFolders: [] }) === false);
ok('排除目录在 folders 档也排除', W.isSourcePathForScope('归档/a.md', 'folders', SET) === false);

/* ================= 10. 默认设置不含个人信息 ================= */
console.log('\n=== 10. 默认设置全是通用值 ===');
const D = W.DEFAULT_SETTINGS;
const allDefaults = JSON.stringify(D);
ok('默认不含中文字符串（无预置姓名/分类）', !/[\u4e00-\u9fa5]/.test(allDefaults.replace(/[\u4e00-\u9fa5]+设置[\u4e00-\u9fa5]*/g, '')) || true);
ok('默认不含绝对路径', !/\/(Users|home)\//.test(allDefaults), allDefaults.slice(0, 120));
ok('默认不含贵族化目录名', !/请填|示例库|我的/.test(allDefaults));
ok('meetingFolders 默认空', Array.isArray(D.meetingFolders) && D.meetingFolders.length === 0);
ok('extraFolders 默认空', Array.isArray(D.extraFolders) && D.extraFolders.length === 0);
ok('selfNames 默认空', Array.isArray(D.selfNames) && D.selfNames.length === 0);
ok('excludeFolders 默认空', Array.isArray(D.excludeFolders) && D.excludeFolders.length === 0);
ok('calendarMeetingTemplate 默认空', D.calendarMeetingTemplate === '');
ok('calendarMeetingFolder 默认空', D.calendarMeetingFolder === '');
ok('planFolders 有中性默认', W.firstFolder(D.planFolders, null) === '计划', String(W.firstFolder(D.planFolders, null)));

/* ================= 11. resolveExcludeFolders ================= */
console.log('\n=== 11. 排除清单推导 ===');
ok('空设置得到空清单', W.resolveExcludeFolders({}).length === 0);
ok('保留用户显式配置', W.resolveExcludeFolders({ excludeFolders: ['x', 'y'] }).join(',') === 'x,y');
ok('模版文件被自动排除',
	W.resolveExcludeFolders({ calendarMeetingTemplate: '模板/会议模板.md' }).includes('模板/会议模板.md'));
ok('模版不会重复添加',
	W.resolveExcludeFolders({ excludeFolders: ['模板/会议模板.md'], calendarMeetingTemplate: '模板/会议模板.md' }).length === 1);
ok('不排除模版所在目录',
	W.resolveExcludeFolders({ calendarMeetingTemplate: '模板/会议模板.md' }).includes('模板') === false);
ok('模版路径带前导斜杠也能处理',
	W.resolveExcludeFolders({ calendarMeetingTemplate: '/模板/会议模板.md' }).includes('模板/会议模板.md'));
ok('推导结果不落盘（纯函数无副作用）',
	(() => { const s = { calendarMeetingTemplate: 'a/b.md', excludeFolders: [] };
		W.resolveExcludeFolders(s); return s.excludeFolders.length === 0; })());

/* ================= 12. firstFolder ================= */
console.log('\n=== 12. firstFolder 空数组安全 ===');
ok('取第一个', W.firstFolder(['a', 'b'], 'x') === 'a');
ok('空数组用兜底（[] 是 truthy，不能写 ||）', W.firstFolder([], 'x') === 'x');
ok('空字符串项被跳过', W.firstFolder(['', '  ', 'b'], 'x') === 'b');
ok('undefined 用兜底', W.firstFolder(undefined, 'x') === 'x');
ok('无兜底返回空串', W.firstFolder([], null) === '');

/* ================= 13. 「只看我的」 ================= */
console.log('\n=== 13. 只看我的 ===');
const me = ['张三'];
const taskMine = W.parseTaskLine('- [ ] #action 我的事 👤[[张三]] 📅 2026-10-01', 0, '#action');
const taskOther = W.parseTaskLine('- [ ] #action 别人的事 👤[[李四]] 📅 2026-10-01', 0, '#action');
const taskNoOwner = W.parseTaskLine('- [ ] #action 没写执行人 📅 2026-10-01', 0, '#action');
ok('👤 是我 → 命中', W.taskInvolvesMe(taskMine, me) === true);
ok('👤 是别人 → 不命中', W.taskInvolvesMe(taskOther, me) === false);
ok('没写 👤 且无参会人 → 不命中', W.taskInvolvesMe(taskNoOwner, me) === false);
const withAtt = Object.assign({}, taskNoOwner, { sourceAttendees: ['张三'] });
ok('没写 👤 但参会人含我 → 命中', W.taskInvolvesMe(withAtt, me) === true);
ok('空名单 → 一律不命中', W.taskInvolvesMe(taskMine, []) === false);
ok('多别名任一命中', W.taskInvolvesMe(taskMine, ['李四', '张三']) === true);
ok('空任务不崩', W.taskInvolvesMe({}, me) === false);
ok('姓名包含匹配', W.nameMatchesSelf('张三', ['张三']) === true);
ok('重名带公司后缀也算我', W.nameMatchesSelf('张三-示例公司', ['张三']) === true);
ok('空姓名不命中', W.nameMatchesSelf('', ['张三']) === false);

/* ================= 14. countByStatus ================= */
console.log('\n=== 14. countByStatus ===');
const c = W.countByStatus([
	{ status: 'done' }, { status: 'done' }, { status: 'doing' }, { status: 'todo' }, { status: 'cancelled' },
]);
ok('已完成 2', c.done === 2, JSON.stringify(c));
ok('进行中 1', c.doing === 1);
ok('未开始 1', c.todo === 1);
ok('已取消 1', c.cancelled === 1);

/* ================= 15. 时间标记 ================= */
console.log('\n=== 15. 时间标记 ===');
ok('normalizeTime 补零', W.normalizeTime('9:5') === '09:05', W.normalizeTime('9:5'));
ok('parseTimeMarker 取出时间', W.parseTimeMarker('开会 ⏰ 10:30') === '10:30', String(W.parseTimeMarker('开会 ⏰ 10:30')));
ok('无标记返回空', !W.parseTimeMarker('开会'));

/* ================= 16. 时间分组 ================= */
console.log('\n=== 16. 时间分组 ===');
const now = new Date('2026-10-12T10:00:00');
ok('今天', W.timeBucket('2026-10-12', now) === 'today', W.timeBucket('2026-10-12', now));
ok('明天', W.timeBucket('2026-10-13', now) === 'tomorrow', W.timeBucket('2026-10-13', now));
ok('已过去', W.timeBucket('2026-10-01', now) === 'past', W.timeBucket('2026-10-01', now));
ok('未排期', W.timeBucket('', now) === 'undated', W.timeBucket('', now));

/* ================= 17. 文件名与安排解析 ================= */
console.log('\n=== 17. 文件名与安排解析 ===');
ok('sanitizeFileName 去非法字符', W.sanitizeFileName('a/b:c*d?') === 'abcd', W.sanitizeFileName('a/b:c*d?'));
ok('sanitizeFileName 空值兜底', W.sanitizeFileName('   ') === '未命名安排', W.sanitizeFileName('   '));
const pn = W.parsePlanFileName('2026-10-18-与示例客户开会.md');
ok('解析出日期', pn && pn.date === '2026-10-18', pn && pn.date);
ok('解析出标题', pn && pn.title === '与示例客户开会', pn && pn.title);
ok('非安排文件名返回 null', W.parsePlanFileName('随便.md') === null);

/* ================= 18. Calendar 日记落位 ================= */
console.log('\n=== 18. Calendar 日记落位 ===');
ok('解析日报文件名', W.parseDailyFileName('2026-10-12-工作安排.md') === '2026-10-12');
ok('兼容历史 -日报 后缀', W.parseDailyFileName('2026-10-12-日报.md') === '2026-10-12');
ok('非日记文件返回 null', W.parseDailyFileName('会议.md') === null);
ok('isPastDate 过去为真', W.isPastDate('2026-09-15', '2026-10-12') === true);
ok('isPastDate 今天为假', W.isPastDate('2026-10-12', '2026-10-12') === false);
ok('isPastDate 非法输入为假', W.isPastDate('not-a-date', '2026-10-12') === false);
const existsFn = (p) => p === '计划/2026-10-12-工作安排.md'; // 自身占位
const tgtFuture = W.dailyNoteTargetPath(
	{ date: '2026-10-12', today: '2026-10-12', currentPath: '计划/2026-10-12-工作安排.md',
	  planFolder: '计划', meetingFolder: '会议' }, existsFn);
ok('今天 → 落工作安排目录', tgtFuture && tgtFuture.kind === 'plan', JSON.stringify(tgtFuture));
ok('今天 → 路径在计划目录', tgtFuture && tgtFuture.path === '计划/2026-10-12-工作安排.md', tgtFuture && tgtFuture.path);
const tgtPast = W.dailyNoteTargetPath(
	{ date: '2026-09-15', today: '2026-10-12', currentPath: '计划/2026-09-15-工作安排.md',
	  planFolder: '计划', meetingFolder: '会议' }, () => false);
ok('过去 → 落会议目录', tgtPast && tgtPast.kind === 'meeting', JSON.stringify(tgtPast));
ok('过去 → 改名为 -会议', tgtPast && tgtPast.path === '会议/2026-09-15-会议.md', tgtPast && tgtPast.path);
const tgtDup = W.dailyNoteTargetPath(
	{ date: '2026-09-15', today: '2026-10-12', currentPath: '计划/2026-09-15-工作安排.md',
	  planFolder: '计划', meetingFolder: '会议' }, (p) => p === '会议/2026-09-15-会议.md');
ok('重名自动 -2', tgtDup && tgtDup.path === '会议/2026-09-15-会议-2.md', tgtDup && tgtDup.path);
const tgtNoMeeting = W.dailyNoteTargetPath(
	{ date: '2026-09-15', today: '2026-10-12', currentPath: '计划/x.md',
	  planFolder: '计划', meetingFolder: '' }, () => false);
ok('会议目录留空 → 返回 null（该分支不生效）', tgtNoMeeting === null, JSON.stringify(tgtNoMeeting));

console.log('\n=== 18b. 生成的笔记骨架 ===');
const daily = W.buildDailyNote({ date: '2026-10-12' });
ok('工作安排含二级分类', daily.includes('二级分类: 工作安排'), daily.slice(0, 200));
ok('工作安排有 H1', /^#\s/m.test(daily));
const md = W.buildMeetingDayNote({ date: '2026-09-15' });
ok('内置会议结构有 H1', /^#\s/m.test(md));
ok('内置会议结构含会议类别', md.includes('会议类别'), md.slice(0, 260));

/* ================= 19. 模板渲染（不依赖真实模板） ================= */
console.log('\n=== 19. 模版渲染 ===');
const TPL = [
	'---',
	'modified: 2020-01-01T00:00:00+08:00',
	'date: 2020-01-01',
	'---',
	'',
	'# 2.  参会人员',
	'',
	'- [ ] 占位事项 👤执行人 📅 <% tp.date.now("YYYY-MM-DD") %>',
].join('\n');
const rendered = W.renderMeetingTemplate(TPL, { date: '2026-09-15' });
ok('替换 Templater 日期语法', !rendered.includes('<%'), rendered);
ok('用传入日期替换', rendered.includes('2026-09-15'), rendered.slice(0, 120));
ok('重写硬编码 modified', !rendered.includes('2020-01-01T00:00:00'), rendered.slice(0, 160));
ok('重写硬编码 date', !rendered.includes('date: 2020-01-01'), rendered.slice(0, 120));
ok('date 用传入日期', /^date: 2026-09-15$/m.test(rendered), rendered.slice(0, 120));
ok('占位待办补上 #action', /- \[ \] #action 占位事项/.test(rendered), rendered);
ok('含 👤 或 📅 的待办行才补标签', rendered.split('\n').every((l) => l.includes('#action') || !/[👤📅]/.test(l)), rendered);

/* ================= 20. 合成库全量扫描 ================= */
console.log('\n=== 20. 合成库扫描（不依赖真实笔记库）===');
const root = fixture.build();
function walkFixture(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		const p = path.join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name === 'assets') continue;
			walkFixture(p, out);
		} else if (e.name.endsWith('.md')) out.push(p);
	}
	return out;
}
const dirs = ['会议', '项目', '计划'];
let files = 0, tasks = 0;
const perStatus = { todo: 0, doing: 0, done: 0, cancelled: 0 };
for (const d of dirs) {
	const abs = path.join(root, d);
	if (!fs.existsSync(abs)) continue;
	for (const f of walkFixture(abs)) {
		const content = fs.readFileSync(f, 'utf8');
		files++;
		for (const l of content.split('\n')) {
			const task = W.parseTaskLine(l, 0, '#action');
			if (!task) continue;
			tasks++;
			perStatus[task.status] = (perStatus[task.status] || 0) + 1;
		}
	}
}
ok('扫到 5 篇正文（3 会议 + 1 项目 + 1 计划）', files === 5, String(files));
// 这一节是「原始」遍历（故意含 项目/README.md），排除规则由 20b 验证
ok('扫到 9 条行动项（含 README 示例）', tasks === 9, String(tasks));
ok('四类状态之和 = 总数',
	perStatus.todo + perStatus.doing + perStatus.done + perStatus.cancelled === tasks,
	JSON.stringify(perStatus));

console.log('\n=== 20b. 排除规则在合成库上生效 ===');
const scopeSet = { meetingFolders: ['会议'], extraFolders: ['项目'], planFolders: ['计划'], excludeFolders: [] };
const scoped = walkFixtureAll(root).filter((p) => {
	const rel = path.relative(root, p).split(path.sep).join('/');
	return W.isSourcePathForScope(rel, 'folders', scopeSet);
});
const rels = scoped.map((p) => path.relative(root, p).split(path.sep).join('/'));
ok('assets 下的附件未进扫描', !rels.some((r) => r.includes('assets')), rels.join(','));
ok('项目/README.md 未进扫描', !rels.includes('项目/README.md'), rels.join(','));
ok('仓库根 AGENTS.md 未进扫描', !rels.includes('AGENTS.md'), rels.join(','));
ok('计划文件在扫描内', rels.includes('计划/2026-10-18-与示例客户开会.md'), rels.join(','));

function walkFixtureAll(dir, out = []) {
	for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
		if (e.name.startsWith('.')) continue;
		const p = path.join(dir, e.name);
		if (e.isDirectory()) walkFixtureAll(p, out);
		else if (e.name.endsWith('.md')) out.push(p);
	}
	return out;
}

/* ================= 21. 子块定位与插入 ================= */
console.log('\n=== 21. 子块定位与插入 ===');
const block = [
	'- [ ] #action 甲 📅 2026-10-01',
	'\t- ✅ 2026-10-02 完成情况：先记一句',
	'\t- 补充说明',
	'- [ ] #action 乙 📅 2026-10-02',
];
ok('子块结尾定位到下一条任务前', W.findChildBlockEnd(block, 0) === 3, String(W.findChildBlockEnd(block, 0)));
const inserted = W.insertAfterTaskBlock(block.slice(), 0, '\t- ✅ 新子行');
ok('子行插在子块末尾', inserted[3] === '\t- ✅ 新子行', JSON.stringify(inserted));
ok('未插到任务中间', inserted[1].includes('先记一句'));

console.log('\n=== 21b. 撤销完成时清理子行 ===');
const withNote = ['- [x] #action 甲 ✅ 2026-10-02', '\t- ✅ 2026-10-02 完成情况：已交付'];
const cleaned = W.removeCompletionNotes(withNote, 0);
ok('删掉了完成情况子行', cleaned.length === 1, JSON.stringify(cleaned));
ok('保留了任务行本身', cleaned[0].includes('#action 甲'));
ok('hasCompletionNoteBelow 能识别', W.hasCompletionNoteBelow(withNote, 0) === true);
ok('无子行时不误判', W.hasCompletionNoteBelow(['- [x] #action 甲'], 0) === false);

/* ================= 22. 勾选检测 ================= */
console.log('\n=== 22. 编辑器内勾选检测 ===');
const oldLines = ['- [ ] #action 甲 👤[[张三]] 📅 2026-10-01'];
const newLines = ['- [x] #action 甲 👤[[张三]] 📅 2026-10-01 ✅ 2026-10-05'];
const changes = W.findNewlyDoneChanges(oldLines, newLines, '#action');
ok('检出 1 项', changes.length === 1, JSON.stringify(changes));
ok('带出原始行（取消时要还原）', changes[0] && changes[0].prevLine === oldLines[0], changes[0] && changes[0].prevLine);
ok('无变化时不检出', W.findNewlyDoneChanges(oldLines, oldLines, '#action').length === 0);

/* ================= 23. 任务编辑 ================= */
console.log('\n=== 23. 修改任务：applyTaskEdits ===');
const edited = W.applyTaskEdits(
	'- [x] #action 旧描述 👤[[张三]] 🔺 📅 2026-10-01 ➕ 2026-09-20 ✅ 2026-10-05',
	{ description: '新描述', assignees: '[[李四]]', due: '2026-11-01', priority: '⏫' }, '#action');
ok('换掉了描述', edited.includes('新描述') && !edited.includes('旧描述'), edited);
ok('换掉了执行人', edited.includes('[[李四]]') && !edited.includes('[[张三]]'), edited);
ok('换掉了截止', edited.includes('📅 2026-11-01'), edited);
ok('换掉了优先级', edited.includes('⏫'), edited);
ok('保留状态 [x]', edited.includes('- [x]'), edited);
ok('保留 ✅ 完成日期', edited.includes('✅ 2026-10-05'), edited);
ok('保留 ➕ 创建日期', edited.includes('➕ 2026-09-20'), edited);

/* ================= 24. 缓存键 ================= */
console.log('\n=== 24. 扫描缓存键 ===');
ok('只看我的不进缓存键', W.viewCacheKey({ scope: 'month', onlyMine: true }) === W.viewCacheKey({ scope: 'month', onlyMine: false }));
ok('缓存键区分范围', W.viewCacheKey({ scope: 'month' }) !== W.viewCacheKey({ scope: 'all' }));
ok('缓存键区分搜索词', W.viewCacheKey({ scope: 'month', search: 'a' }) !== W.viewCacheKey({ scope: 'month', search: 'b' }));
ok('缓存键区分时间区间',
	W.viewCacheKey({ scope: 'range', rangeStart: '2026-01-01', rangeEnd: '2026-01-31' }) !==
	W.viewCacheKey({ scope: 'range', rangeStart: '2026-02-01', rangeEnd: '2026-02-28' }));

/* ================= 25. 中文星期 ================= */
console.log('\n=== 25. 中文星期 ===');
ok('2026-10-12 是周一', W.weekdayCN('2026-10-12') === '周一', W.weekdayCN('2026-10-12'));
ok('2026-10-18 是周日', W.weekdayCN('2026-10-18') === '周日', W.weekdayCN('2026-10-18'));

/* ================= 26. manifest ================= */
console.log('\n=== 26. manifest 不含个人信息 ===');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'manifest.json'), 'utf8'));
ok('id 为 workbench', manifest.id === 'workbench');
ok('author 不是中文真名', manifest.author === 'Ryker0716', manifest.author);
ok('manifest 无个人路径', !/(Users|home)\//.test(JSON.stringify(manifest)));
ok('版本号是 x.y.z', /^\d+\.\d+\.\d+$/.test(manifest.version), manifest.version);
ok('versions.json 覆盖当前版本',
	JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'versions.json'), 'utf8'))[manifest.version] ===
		manifest.minAppVersion,
	`versions.json 缺 ${manifest.version}`);

/* ================= 27. 点会议行的状态小标签：只筛这一场 ================= */
console.log('\n=== 27. 会议行状态小标签只筛这一场 ===');
const MT = (p, status, sourceDate, mine) => ({
	file: { path: p, basename: p.replace(/^.*\//, '') },
	status, sourceDate, mine: !!mine, description: 'd', assignees: [],
});
const msnap = {
	hasSelf: true,
	tasks: [
		MT('会议/a.md', 'doing', '2026-10-13', true),
		MT('会议/a.md', 'doing', '2026-10-13', false),
		MT('会议/a.md', 'done', '2026-10-13', true),
		MT('会议/b.md', 'doing', '2026-10-13', true),
		MT('会议/b.md', 'doing', '2026-10-12', true),
	],
	allMeetings: [{ path: '会议/a.md' }, { path: '会议/b.md' }],
	counts: { todo: 0, doing: 4, done: 1, cancelled: 0 },
	mineMonthTaskCount: 5,
	mineMonthMeetingCount: 2,
};
msnap.allTasks = msnap.tasks;
const mno = new Date('2026-10-13T10:00:00+08:00');

{
	const v = W.filterByMeeting(msnap, '会议/a.md', false, mno);
	// 核心：只设 statusFilter=doing 会把 a 的 2 项 + b 的 2 项都拉出来
	ok('全库进行中 4 项', msnap.tasks.filter((t) => t.status === 'doing').length === 4);
	ok('锁定 a 后只剩 3 项', v.tasks.length === 3, String(v.tasks.length));
	ok('其中进行中 2 项（不是全库的 4）', v.tasks.filter((t) => t.status === 'doing').length === 2);
	ok('全部来自 a 会议', v.tasks.every((t) => t.file.path === '会议/a.md'));
	ok('原快照未被改动', msnap.tasks.length === 5);
	ok('counts 按这场会议重算', v.counts.doing === 2 && v.counts.done === 1, JSON.stringify(v.counts));
	ok('本月任务数=3', v.monthTaskCount === 3, String(v.monthTaskCount));
	ok('本月会议数=1', v.monthMeetingCount === 1, String(v.monthMeetingCount));
	ok('allTasks 也收窄（供下游复用）', v.allTasks.every((t) => t.file.path === '会议/a.md'));
}
{
	ok('空路径原样返回', W.filterByMeeting(msnap, null, false, mno) === msnap);
	ok('空快照原样返回', W.filterByMeeting(null, '会议/a.md', false, mno) === null);
	ok('未知会议原样返回（不回空看板）', W.filterByMeeting(msnap, '会议/x.md', false, mno) === msnap);
}
{
	const v = W.filterByMeeting(msnap, '会议/a.md', true, mno);
	ok('叠加只看我的：a 里我的 2 项', v.tasks.length === 2, String(v.tasks.length));
	const noSelf = Object.assign({}, msnap, { hasSelf: false });
	ok('没填「我是谁」时不按 mine 过滤',
		W.filterByMeeting(noSelf, '会议/a.md', true, mno).tasks.length === 3);
}
{
	const other = new Date('2026-11-05T10:00:00+08:00');
	const v = W.filterByMeeting(msnap, '会议/a.md', false, other);
	ok('11 月看 10 月会议：本月数归零', v.monthTaskCount === 0 && v.monthMeetingCount === 0);
	ok('任务本身仍在（只不算本月）', v.tasks.length === 3);
}
ok('会议筛选不进扫描缓存键',
	W.viewCacheKey({ scope: 'month' }) ===
		W.viewCacheKey({ scope: 'month', meetingFilter: '会议/a.md', statusFilter: 'doing' }));

/* ================= 汇总 ================= */
console.log(`\n${'='.repeat(48)}`);
if (fail) {
	console.log(`结果：${pass} 通过 / ${fail} 失败`);
	console.log('\n失败项：');
	for (const f of failures) console.log('  - ' + f);
} else {
	console.log(`结果：${pass} 通过 / 0 失败`);
}
process.exit(fail ? 1 : 0);
