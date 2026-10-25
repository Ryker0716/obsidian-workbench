'use strict';

/*
 * 工作台（Workbench）— Obsidian 本地插件
 *
 * 功能：
 *   1) 统计本月会议次数，并列出会议清单与各自的行动项数量；
 *   2) 汇总会议纪要里的行动项（#action），按「未开始 / 进行中 / 已完成」三栏看板展示；
 *   3) 勾选完成时：任务行写入标准 ✅ 完成日期 + 精确到分钟的完成时间写入完成情况备注，
 *      并弹窗询问「完成情况」，内容写成任务下方的缩进子行；
 *   4) 在普通笔记视图里直接勾选任务（Tasks 插件或原生复选框），同样会触发询问。
 *
 * 任务格式（兼容 Tasks 插件的 emoji 格式）：
 *   - [ ] #action 任务内容 👤执行人 📅 2026-10-10 ➕ 2026-10-01
 *   - [/] #action 进行中的任务 🛫 2026-10-08
 *   - [x] #action 已完成的任务 ✅ 2026-10-12
 *   	- ✅ 2026-10-12 10:32 完成情况：已签署 NDA，邮件回执已收到
 */

const {
	Plugin,
	ItemView,
	Modal,
	Notice,
	Setting,
	PluginSettingTab,
	TFile,
	debounce,
} = require('obsidian');

const VIEW_TYPE_WORKBENCH = 'workbench-view';

const STATUS = {
	TODO: 'todo',
	DOING: 'doing',
	DONE: 'done',
	CANCELLED: 'cancelled',
};

const STATUS_LABEL = {
	todo: '未开始',
	doing: '进行中',
	done: '已完成',
	cancelled: '已取消',
};

const COL_CLASS = {
	todo: 'wb-col-todo',
	doing: 'wb-col-doing',
	done: 'wb-col-done',
	cancelled: 'wb-col-todo',
};

const DONE_SYMBOLS = new Set(['x', 'X']);
const DOING_SYMBOLS = new Set(['/']);
const CANCELLED_SYMBOLS = new Set(['-']);

// 允许任务写在引用块 / callout 里，如 "> - [ ] #action ..."
const TASK_LINE_RE = /^(\s*(?:>\s?)*)(\s*)([-*+])\s+\[(.)\]\s*(.*)$/;
const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const START_RE = /🛫\s*(\d{4}-\d{2}-\d{2})/;
const DONE_DATE_RE = /✅\s*(\d{4}-\d{2}-\d{2})/;
const CREATED_RE = /➕\s*(\d{4}-\d{2}-\d{2})/;
const ASSIGNEE_RE = /👤\s*([^\s👤📅➕✅🛫🔺⏫🔼🔽⏳]+)/g;
const PRIORITY_RE = /🔺|⏫|🔼|🔽/;
const COMPLETION_NOTE_RE = /完成情况\s*[：:]/;

/**
 * 工作安排目录的兜底默认。留空会让「回顾」页扫不到任何文件，
 * 所以这里给一个中性名字；首次启动的引导页会引导用户改成自己的目录。
 */
const DEFAULT_PLAN_FOLDER = '计划';

/**
 * 取目录列表里第一个有效项。注意 `[]` 是 truthy，
 * 所以不能写 `list || [兜底]`——空列表时会拿到 undefined。
 */
function firstFolder(list, fallback) {
	const hit = (list || []).find((f) => f && String(f).trim());
	return hit ? String(hit).trim() : fallback || '';
}

const DEFAULT_SETTINGS = {
	// 会议目录：这些目录里的 .md 一律算会议。首次安装为空，请到设置里填成你自己的目录。
	meetingFolders: [],
	// 附加目录：里面的 #action 也进看板；其中只有带 `会议类别` 的才算会议、计入会议数
	extraFolders: [],
	// 未来工作安排目录：`YYYY-MM-DD-事件.md`，一个安排一个笔记
	planFolders: [DEFAULT_PLAN_FOLDER],
	// Calendar 点出来的文件：日期 < 今天 落会议目录，日期 >= 今天 落工作安排目录。
	// 开始日期落位目录留空时该分支自动跳过，不会误建到别处。
	calendarDailyRouting: true,
	calendarMeetingFolder: '',
	calendarMeetingTemplate: '',
	taskTag: '#action',
	// 「只看我的」判定用：填自己的姓名/别名（多个用顿号或换行分隔），留空则按钮禁用
	selfNames: [],
	defaultScope: 'month',
	writeStartDate: true,
	promptInView: true,
	promptInEditor: true,
	completionLabel: '完成情况',
	promptPresets: ['已按时完成', '部分完成', '延期完成', '受阻待跟进'],
	excludeFolders: [],
	// 首次安装引导是否已处理（用户点了「跳过」或配好了目录就置 true）
	onboardingDismissed: false,
};

/* ------------------------------------------------------------------ */
/* 纯函数（可脱离 Obsidian 单测）                                       */
/* ------------------------------------------------------------------ */

function pad2(n) {
	return String(n).padStart(2, '0');
}

function formatDate(d) {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function formatDateTime(d) {
	return `${formatDate(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function monthKey(d) {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

function statusFromSymbol(symbol) {
	if (DONE_SYMBOLS.has(symbol)) return STATUS.DONE;
	if (DOING_SYMBOLS.has(symbol)) return STATUS.DOING;
	if (CANCELLED_SYMBOLS.has(symbol)) return STATUS.CANCELLED;
	return STATUS.TODO;
}

/**
 * 由「复选框符号 + 开始日期」推导看板状态：
 *   - 已勾选 / 已取消 / 显式 [/] ：照符号走；
 *   - 未勾选的 [ ]：只有「开始日期在未来」才算未开始；
 *     没有开始日期，或开始日期已到（含今天），一律算进行中。
 */
function deriveStatus(symbolStatus, startDate, today) {
	if (symbolStatus !== STATUS.TODO) return symbolStatus;
	if (!startDate) return STATUS.DOING;
	const ref = today || formatDate(new Date());
	return startDate > ref ? STATUS.TODO : STATUS.DOING;
}

/** 明天（用于把任务转成「未开始」时的最小未来开始日） */
function tomorrowOf(d) {
	const base = d || new Date();
	return formatDate(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1));
}

function cleanDescription(body, taskTag) {
	let t = String(body == null ? '' : body);
	if (taskTag) t = t.split(taskTag).join(' ');
	t = t.replace(/👤\s*[^\s👤📅➕✅🛫🔺⏫🔼🔽⏳⏰]+/g, ' ');
	t = t.replace(/[📅🛫✅➕]\s*\d{4}-\d{2}-\d{2}/g, ' ');
	t = t.replace(/[📅🛫✅➕]\s*/g, ' ');
	t = t.replace(/⏰\s*\d{1,2}:\d{2}/g, ' ');
	t = t.replace(/[🔺⏫🔼🔽⏳]/g, ' ');
	t = t.replace(/\*\*([^*]+)\*\*/g, '$1');
	t = t.replace(/\[\[([^\]|]+)\|([^\]]+)\]\]/g, '$2');
	t = t.replace(/\[\[([^\]]+)\]\]/g, '$1');
	return t.replace(/\s+/g, ' ').trim();
}

function parseTaskLine(line, lineNumber, taskTag, today) {
	const m = TASK_LINE_RE.exec(line);
	if (!m) return null;
	const quotePrefix = m[1];
	const indent = m[2];
	const bullet = m[3];
	const symbol = m[4];
	const body = m[5];
	if (taskTag && !body.includes(taskTag)) return null;

	const assignees = [];
	let am;
	ASSIGNEE_RE.lastIndex = 0;
	while ((am = ASSIGNEE_RE.exec(body)) !== null) assignees.push(am[1]);

	const description = cleanDescription(body, taskTag);
	if (!description) return null;

	const start = (START_RE.exec(body) || [])[1] || null;
	const symbolStatus = statusFromSymbol(symbol);

	return {
		lineNumber,
		indent: `${quotePrefix}${indent}`,
		quotePrefix,
		bullet,
		symbol,
		symbolStatus,
		status: deriveStatus(symbolStatus, start, today),
		body,
		description,
		assignees,
		due: (DUE_RE.exec(body) || [])[1] || null,
		start,
		time: parseTimeMarker(body),
		doneDate: (DONE_DATE_RE.exec(body) || [])[1] || null,
		created: (CREATED_RE.exec(body) || [])[1] || null,
		priority: (PRIORITY_RE.exec(body) || [])[0] || null,
		rawLine: line,
		hasCompletionNote: false,
	};
}

/** 改写任务行的状态符号，并按需增删 ✅ / 🛫 标记 */
function applyStatusChange(line, status, opts) {
	opts = opts || {};
	const m = TASK_LINE_RE.exec(line);
	if (!m) return line;
	const head = `${m[1]}${m[2]}${m[3]} `;
	const body = m[5];
	const symbol =
		status === STATUS.DONE ? 'x' : status === STATUS.DOING ? '/' : status === STATUS.CANCELLED ? '-' : ' ';
	let out = `${head}[${symbol}] ${body}`;
	out = out.replace(/\s*✅\s*\d{4}-\d{2}-\d{2}/g, '');
	out = out.replace(/\s*🛫\s*\d{4}-\d{2}-\d{2}/g, '');
	out = out.replace(/\s+$/, '');
	if (status === STATUS.DONE && opts.doneDate) out += ` ✅ ${opts.doneDate}`;
	if ((status === STATUS.DOING || status === STATUS.TODO) && opts.startDate) out += ` 🛫 ${opts.startDate}`;
	return out;
}

function charWidth(ch) {
	return ch === '\t' ? 4 : 1;
}

function leadingWidth(line) {
	const m = /^(\s*)/.exec(line);
	let w = 0;
	for (const ch of m[1]) w += charWidth(ch);
	return w;
}

/**
 * 结构缩进深度：把引用块层级（> / >>）与空格缩进折算成可比较的宽度，
 * 使引用块内的任务子行也能被正确归入同一缩进块。
 */
function structDepth(line) {
	let depth = 0;
	let s = String(line);
	const lead = /^\s*/.exec(s)[0];
	for (const ch of lead) depth += charWidth(ch);
	s = s.slice(lead.length);
	while (s.startsWith('>')) {
		depth += 4;
		s = s.slice(1);
		const sp = /^\s?/.exec(s)[0];
		s = s.slice(sp.length);
	}
	const rest = /^\s*/.exec(s)[0];
	for (const ch of rest) depth += charWidth(ch);
	return depth;
}

function isBlankish(line) {
	return /^[>\s]*$/.test(line);
}

/** 任务行下方缩进块的结束位置 */
function findChildBlockEnd(lines, taskIndex) {
	const baseDepth = structDepth(lines[taskIndex]);
	let i = taskIndex + 1;
	while (i < lines.length) {
		const l = lines[i];
		if (isBlankish(l)) break;
		if (structDepth(l) <= baseDepth) break;
		i++;
	}
	return i;
}

function hasCompletionNoteBelow(lines, taskIndex) {
	const end = findChildBlockEnd(lines, taskIndex);
	for (let i = taskIndex + 1; i < end; i++) {
		if (COMPLETION_NOTE_RE.test(lines[i])) return true;
	}
	return false;
}

function buildCompletionNote(taskIndent, when, text, label) {
	const indent = `${taskIndent}\t`;
	const body =
		text && String(text).trim()
			? String(text).trim().replace(/\s*\n\s*/g, '；')
			: '（未填写）';
	return `${indent}- ✅ ${when} ${label}：${body}`;
}

/** 在任务及其缩进子块之后插入一行 */
function insertAfterTaskBlock(lines, taskIndex, newLine) {
	const at = findChildBlockEnd(lines, taskIndex);
	const out = lines.slice();
	out.splice(at, 0, newLine);
	return out;
}

/** 撤销完成时，清掉本插件自动写入的完成情况子行，避免残留旧结论、并让再次完成能重新询问 */
function removeCompletionNotes(lines, taskIndex) {
	const end = findChildBlockEnd(lines, taskIndex);
	const out = [];
	for (let i = 0; i < lines.length; i++) {
		if (i > taskIndex && i < end) {
			const l = lines[i];
			if (COMPLETION_NOTE_RE.test(l) && /^[\s>]*[-*+]\s*✅/.test(l)) continue;
		}
		out.push(lines[i]);
	}
	return out;
}

function parseFrontmatterDate(content) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!m) return null;
	const fm = m[1];
	let dm = /^date:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(fm);
	if (!dm) dm = /^modified:\s*["']?(\d{4}-\d{2}-\d{2})/m.exec(fm);
	return dm ? dm[1] : null;
}

/** frontmatter 里是否存在某个非空字段（用于识别「会议类别」这类会议标记） */
function frontmatterHasField(content, field) {
	return frontmatterValue(content, field) !== null;
}

/** 取 frontmatter 某个字段的值（去引号、去空白；不存在或为空返回 null） */
function frontmatterValue(content, field) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
	if (!m) return null;
	// 注意：冒号后只能用 [ \t]*，不能用 \s*——否则会吃掉换行、把下一行当成值
	const re = new RegExp(`^[ \\t]*${field}[ \\t]*:[ \\t]*(.*)$`, 'm');
	const hit = re.exec(m[1]);
	if (!hit) return null;
	const v = hit[1].trim().replace(/^["']|["']$/g, '');
	if (v === '' || v === '[]' || v === 'null' || v === '~') return null;
	return v;
}

/** 是否算一场「会议」：会议目录下的都算；附加目录下只有带 `会议类别` 的才算 */
function isMeetingRecord(content, inMeetingFolder) {
	if (inMeetingFolder) return true;
	return frontmatterHasField(content, '会议类别');
}

/* ---------------- 「只看我的」：谁是我 ---------------- */

/**
 * 解析 frontmatter 里的列表字段（多行 `- X` 或 flow `[A, B]`），返回字符串数组。
 * 用于取会议的 `参会人员`——`frontmatterValue()` 只会拿到第一行的空值。
 */
function parseFrontmatterList(content, field) {
	const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content || '');
	if (!m) return [];
	const re = new RegExp(`^[ \\t]*${field}[ \\t]*:[ \\t]*(.*)$`);
	const out = [];
	const push = (v) => {
		const s = String(v == null ? '' : v).trim().replace(/^["']|["']$/g, '');
		if (s) out.push(s);
	};
	let collecting = false;
	for (const line of m[1].split('\n')) {
		const hit = re.exec(line);
		if (hit) {
			collecting = true;
			const inline = hit[1].trim();
			if (inline.startsWith('[')) {
				inline.replace(/^\[|\]$/g, '').split(',').forEach(push);
			} else if (inline) {
				push(inline);
			}
			continue;
		}
		if (!collecting) continue;
		const item = /^[ \t]*-[ \t]*(.+)$/.exec(line);
		if (item) {
			push(item[1]);
			continue;
		}
		if (/^[ \t]*$/.test(line)) continue; // 列表中间的空行不算结束
		break; // 遇到别的键：结束
	}
	return out;
}

/**
 * 把 `👤` 执行人或「参会人员」这类字段拆成人名数组。
 * 支持 `[[名字]]`、`[[文件名|名字]]`（取竖线后的显示名），以及 `、`/`，`/`,`/`/` 分隔的多人。
 */
function parsePersonList(raw) {
	if (raw == null) return [];
	const out = [];
	String(raw)
		.split(/[、,，/;；]+/)
		.forEach((piece) => {
			let s = String(piece).trim();
			if (!s) return;
			s = s.replace(/\[\[([^\]]+)\]\]/g, (_all, inner) => {
				const parts = String(inner).split('|');
				const name = (parts[parts.length - 1] || parts[0]).trim();
				if (name) out.push(name);
				return ' ';
			});
			// wikilink 之外的残留文字（如 `xx团队（yy）`）也当作一个名字，去掉括号噪声
			const rest = s.replace(/[（）()]/g, ' ').trim();
			if (rest && !/^[-\s]*$/.test(rest)) out.push(rest);
		});
	return out.filter(Boolean);
}

/**
 * 某个名字是否就是「我」。
 * 用精确匹配 + `名字-公司` / `名字（备注）` 这类后缀写法，避免 `includes` 带来的误命中。
 */
function nameMatchesSelf(name, selfNames) {
	const n = String(name == null ? '' : name).replace(/\s+/g, '');
	if (!n) return false;
	return (selfNames || []).some((s) => {
		const t = String(s == null ? '' : s).replace(/\s+/g, '');
		if (!t) return false;
		return n === t || n.startsWith(`${t}-`) || n.startsWith(`${t}（`) || n.startsWith(`${t}(`);
	});
}

/**
 * 这条行动项是否与我相关（回顾页「只看我的」的判定）。
 * 规则：任务写了 `👤 执行人` → 只看执行人是否含我（写了别人就与我无关）；
 *      任务没写执行人 → 退一步看我是否参加了它所在的那场会议（frontmatter `参会人员`）。
 */
function taskInvolvesMe(task, selfNames) {
	if (!task) return false;
	const mine = (selfNames || []).filter(Boolean);
	if (!mine.length) return false;
	const assignees = parsePersonList((task.assignees || []).join('、'));
	if (assignees.length) return assignees.some((n) => nameMatchesSelf(n, mine));
	return (task.sourceAttendees || []).some((n) => nameMatchesSelf(n, mine));
}

/** 按状态汇总任务数（看板三栏与统计卡共用）。today 可选：给了就顺带数出逾期数 */
function countByStatus(tasks, today) {
	const c = { todo: 0, doing: 0, done: 0, cancelled: 0, overdue: 0 };
	const ref = today || formatDate(new Date());
	(tasks || []).forEach((t) => {
		if (!t) return;
		if (c[t.status] !== undefined) c[t.status] += 1;
		if (isOverdueTask(t, ref)) c.overdue += 1;
	});
	return c;
}

/**
 * 是否已过截止期：未完成（未开始/进行中，且未取消）且截止日期早于今天。
 * 已完成的任务哪怕过线也不算逾期——已经交代过了。
 * @param {object} task 解析出的任务
 * @param {string} todayStr YYYY-MM-DD
 */
function isOverdueTask(task, todayStr) {
	if (!task || !task.due) return false;
	if (task.status === STATUS.DONE || task.status === STATUS.CANCELLED) return false;
	return task.due < todayStr;
}

/**
 * 会议行里点了状态小标签后的收窄（纯函数，便于单测）。
 *
 * 为什么需要它：会议行右侧的「进行中 7」如果只设 statusFilter，
 * 看板会把**全库**所有进行中的任务都拉出来，而不是这一场的 7 项。
 * 所以点小标签时必须同时锁定会议。
 *
 * @param {object} snapshot 扫描快照
 * @param {string|null} meetingPath 锁定的会议文件路径
 * @param {boolean} onlyMine 是否叠加「只看我的」
 * @param {Date} now 用于算「本月」口径
 */
function filterByMeeting(snapshot, meetingPath, onlyMine, now) {
	if (!meetingPath || !snapshot) return snapshot;
	const mine = onlyMine && snapshot.hasSelf ? (t) => t.mine : () => true;

	const pool = snapshot.allTasks || snapshot.tasks || [];
	const all = pool.filter((t) => t.file && t.file.path === meetingPath && mine(t));
	// 这场会议在当前范围内没有任务了（例如切了范围），自动解除，避免空看板
	const known = (snapshot.allMeetings || []).some((m) => m.path === meetingPath);
	if (!all.length && !known) return snapshot;

	const tasks = (snapshot.tasks || []).filter(
		(t) => t.file && t.file.path === meetingPath && mine(t),
	);
	const ref = now || new Date();
	const inMonth = all.filter((t) => isInMonth(t.sourceDate, ref));
	return Object.assign({}, snapshot, {
		tasks,
		allTasks: all,
		counts: countByStatus(tasks, formatDate(ref)),
		// 两张「本月」卡也收窄到这场会议，避免卡片数字与看板打架
		monthTaskCount: inMonth.length,
		monthMeetingCount: inMonth.length ? 1 : 0,
	});
}

/**
 * 「已逾期」透视（纯函数，便于单测）。
 *
 * 为什么需要它：逾期任务往往来自**过去的会议**（比如 9 月的会排出 📅 9-20，
 * 10 月还没做完）。回顾页默认按「会议日期」圈范围，过去会议的任务根本不在
 * 当前范围的看板里，用户想查「过期的待办」无从下手。所以这个透视和
 * filterByMeeting 一样从 allTasks（本次扫描的全量池）里取，
 * 跨范围把所有未完成且 📅 早于今天的任务拉出来。
 *
 * @param {object} snapshot 扫描快照
 * @param {boolean} onlyMine 是否叠加「只看我的」
 * @param {Date} now 用于算「今天」
 */
function filterOverdue(snapshot, onlyMine, now) {
	if (!snapshot) return snapshot;
	const today = formatDate(now || new Date());
	const mine = onlyMine && snapshot.hasSelf ? (t) => t.mine : () => true;
	const pool = snapshot.allTasks || snapshot.tasks || [];
	const tasks = pool.filter((t) => isOverdueTask(t, today) && mine(t));
	return Object.assign({}, snapshot, {
		tasks,
		// allTasks 保持全量池不动：后续「锁定某场会议」仍要能从池子里筛
		counts: countByStatus(tasks, today),
	});
}

/* ---------------- 未来工作安排（一件事 = 一个笔记） ---------------- */

const PLAN_DATE_PREFIX_RE = /^(\d{4}-\d{2}-\d{2})-(.+)$/;
const TIME_MARKER_RE = /⏰\s*(\d{1,2}:\d{2})/;

/* ---------------- Calendar 自动落位与联动 ---------------- */

/**
 * Calendar 生成的文件名：`YYYY-MM-DD-工作安排.md`。
 * 仍然兼容历史上的 `YYYY-MM-DD-日报.md`，避免改名前的旧文件变成孤儿；
 * 但新生成的统一用「工作安排」——它与 frontmatter 的 `二级分类: 工作安排` 同名，
 * 也直接落进 `parsePlanFileName()`，所以它就是一个普通计划文件，不是独立文件类型。
 */
const DAILY_NAME_RE = /^(\d{4}-\d{2}-\d{2})-(?:工作安排|日报)$/;
/** Calendar 生成的会议名：`YYYY-MM-DD-会议.md`（过去日期点出来的落位） */
const MEETING_DAY_NAME_RE = /^(\d{4}-\d{2}-\d{2})-会议$/;

/** 由 Calendar 文件名解析出日期（兼容旧的 `-日报` 后缀） */
function parseDailyFileName(fileName) {
	const base = String(fileName || '').replace(/\.md$/, '');
	const m = DAILY_NAME_RE.exec(base);
	return m ? m[1] : null;
}

/**
 * Calendar 文件名的基础部分（不含 `.md`）。
 * 新生成的一律是 `YYYY-MM-DD-工作安排`，与工作安排目录里计划文件的命名、二级分类一致。
 */
function dailyFileBase(dateStr) {
	return `${dateStr}-工作安排`;
}

/**
 * 判断一个「过去的日期」相对今天的位置。
 * 只有严格早于今天才算过去；今天与未来一律走「今天及以后」分支。
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} todayStr 参照日 YYYY-MM-DD
 */
function isPastDate(dateStr, todayStr) {
	if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || ''))) return false;
	return String(dateStr) < String(todayStr);
}

/**
 * 算出 Calendar 生成文件的目标路径。
 * 规则（用户 2026-10-12 定）：日期 < 今天 → 会议目录，名为 `YYYY-MM-DD-会议.md`；
 * 日期 >= 今天 → 工作安排目录，名为 `YYYY-MM-DD-工作安排.md`（就是一个普通计划文件）。
 * `exists` 用于避让重名，同名已存在时依次追加 `-2`、`-3`（用户选择：重名就新建，不删不改已有文件）。
 * @param {{date:string, today:string, planFolder:string, meetingFolder:string}} opts
 * @param {(p:string)=>boolean} exists
 */
function dailyNoteTargetPath(opts, exists) {
	const date = String(opts.date || '');
	const current = String(opts.currentPath || '');
	const planFolder = String(opts.planFolder || '').replace(/\/+$/, '');
	const meetingFolder = String(opts.meetingFolder || '').replace(/\/+$/, '');
	if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !planFolder) return null;
	// 占用判定要排除「当前这个文件自己」，否则刚刚创建的文件会被当成重名而多加 -2
	const taken = (p) => p !== current && Boolean(exists(p));
	const past = isPastDate(date, opts.today);
	const build = (folder, base) => {
		let candidate = `${folder}/${base}.md`;
		let n = 2;
		while (taken(candidate)) {
			candidate = `${folder}/${base}-${n}.md`;
			n += 1;
		}
		return candidate;
	};
	if (!past) {
		// 今天及以后：直接建成一条普通工作安排（命名与二级分类一致）
		return { path: build(planFolder, dailyFileBase(date)), kind: 'plan', moved: false };
	}
	if (!meetingFolder) return null;
	// 用户选择：同一过去日期再次点击时新建 `-2`，不删也不改已有会议记录
	return { path: build(meetingFolder, `${date}-会议`), kind: 'meeting', moved: true };
}

/**
 * 把用户配置的会议纪要模版渲染成一条可用的会议笔记。
 * 模版里的 Templater 语法（`<% tp.date.now(...) %>`）脱离 Templater 上下文时要自己替换，
 * 否则生成的笔记里会残留语法字符串。同时在 `# 1.  基本信息` 前补一行 `# 日期 标题`
 * ——插件生成的纪要统一带这行 H1，模版本身通常没有。
 */
function renderMeetingTemplate(template, input) {
	const date = String(input.date || '');
	const time = normalizeTime(input.time) || '';
	const now = input.now || new Date();
	const title = String(input.title || '').trim();
	const place = String(input.place || '').trim();
	const stamp = `${formatDateTime(now).replace(' ', 'T')}:00+08:00`;
	let text = String(template || '')
		.replace(/<%\s*tp\.date\.now\("YYYY-MM-DDTHH:mm:ss\+08:00"\)\s*%>/g, stamp)
		.replace(/<%\s*tp\.date\.now\("YYYY-MM-DD"\)\s*%>/g, date);
	// 模版的 modified / date 可能是写死的常量（不是 Templater 语法），必须替换成本次生成的值，
	// 否则生成的会议笔记会带着模版作者当时的日期。
	text = text.replace(/^modified:.*$/m, `modified: ${stamp}`);
	if (date) text = text.replace(/^date:.*$/m, `date: ${date}`);
	// 模版里的「会议主题/时间/地点」三行是空的，按已知信息补上
	text = text.replace(/^(- \*\*会议主题\*\*)[ \t]*：.*$/m, `$1：${title}`);
	if (time) text = text.replace(/^(- \*\*会议时间\*\*:).*$/m, `$1 ${date} ${time}`);
	else text = text.replace(/^(- \*\*会议时间\*\*:).*$/m, `$1 ${date}`);
	if (place) text = text.replace(/^(- \*\*会议地点\*\*：).*$/m, `$1${place}`);
	// 模版里「像待办」的行（含 👤 或 📅）若没写任务标签，照抄出来不会进工作台看板；补上以保持联动。
	// 只补这类行，避免把模版里普通的示例复选框也变成统计对象。
	const taskTag = String(input.taskTag || '#action');
	text = text
		.split('\n')
		.map((l) => {
			if (l.includes(taskTag)) return l;
			if (!/[👤📅]/.test(l)) return l;
			return l.replace(/^([ \t>]*-[ \t]+\[[ \t]\][ \t]+)/, `$1${taskTag} `);
		})
		.join('\n');
	const lines = text.split('\n');
	// 模版 frontmatter 收尾后多了一行孤立的 `---`（模版自身的历史笔误），
	// 真实会议纪要里没有；渲染时去掉，避免出来一个空分隔块。
	for (let i = 1; i < lines.length; i += 1) {
		if (lines[i] === '---' && lines[i - 1] === '---') {
			lines.splice(i, 1);
			break;
		}
	}
	if (!lines.some((l) => /^#\s+\d{4}-\d{2}-\d{2}/.test(l))) {
		const titleLine = `# ${date}${title ? ` ${title}` : ''}`.trimEnd();
		const idx = lines.findIndex((l) => /^#\s+1\./.test(l));
		if (idx === -1) lines.unshift(titleLine, '');
		else lines.splice(idx, 0, titleLine, '');
	}
	return lines.join('\n');
}

/** 兜底：没配置模版、或模版读不到时，用这份内置结构生成会议笔记 */
function buildMeetingDayNote(input) {
	const now = input.now || new Date();
	const date = input.date;
	const time = normalizeTime(input.time) || '';
	const place = String(input.place || '').trim();
	const title = String(input.title || '').trim() || '会议记录';
	const lines = [];
	lines.push('---');
	lines.push(`date: ${date}`);
	lines.push(`modified: ${formatDateTime(now).replace(' ', 'T')}:00+08:00`);
	lines.push('二级分类: 会议纪要');
	lines.push('一级分类: 业务');
	lines.push('会议类别: 业务会议');
	lines.push('关联项目:');
	lines.push('参会人员: []');
	lines.push('状态: 已完成');
	lines.push('tags: [主题/]');
	lines.push('---');
	lines.push('');
	lines.push(`# ${date} ${title}`);
	lines.push('');
	lines.push('> [!summary] 会议摘要');
	lines.push('> ');
	lines.push('');
	lines.push('# 1.  基本信息');
	lines.push(`- **会议主题**：${title}`);
	lines.push(`- **会议时间**: ${date}${time ? ` ${time}` : ''}`);
	lines.push(`- **会议地点**：${place}`);
	lines.push('- **会议形式**：□ 线下 □ 线上 □ 混合');
	lines.push('- **主持人**：');
	lines.push('- **记录人**：');
	lines.push('');
	lines.push('# 2.  参会人员');
	lines.push('| 姓名  | 单位  | 备注  |');
	lines.push('| --- | --- | --- |');
	lines.push('|     |     |     |');
	lines.push('');
	lines.push('# 3.  会议背景 / 目的');
	lines.push('- ');
	lines.push('');
	lines.push('# 4.  讨论要点');
	lines.push('## 1 1️⃣ 议题一');
	lines.push('- 主要观点：');
	lines.push('- 结论：');
	lines.push('');
	lines.push('# 5.  形成的共识 / 决议');
	lines.push('- ');
	lines.push('');
	lines.push('# 6.  待办事项（Action Items）');
	lines.push('');
	lines.push(`- [ ] #action 任务内容 👤执行人 📅 ${date}  `);
	lines.push('');
	lines.push('# 7.  补充记录');
	lines.push('- 临时想法：');
	lines.push('- 重要关系线索：');
	lines.push('');
	return lines.join('\n');
}

function normalizeTime(t) {
	const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(t == null ? '' : t).trim());
	if (!m) return null;
	const h = parseInt(m[1], 10);
	const mi = parseInt(m[2], 10);
	if (h > 23 || mi > 59) return null;
	return `${pad2(h)}:${pad2(mi)}`;
}

/** 从任务行正文里取 ⏰ HH:mm 时间标记 */
function parseTimeMarker(body) {
	const m = TIME_MARKER_RE.exec(body || '');
	return m ? normalizeTime(m[1]) : null;
}

function addDays(dateStr, n) {
	const d = new Date(`${dateStr}T00:00:00`);
	d.setDate(d.getDate() + n);
	return formatDate(d);
}

/* ------------------- 任务行编辑（供「修改」按钮用） ------------------- */

/**
 * 用表单值重写任务行的「描述 / 执行人 / 截止 / 优先级」，
 * 只动这四项，其余标记（🛫 ✅ ➕ 完成情况）与缩进原样保留。
 * 传 null 表示该字段不变，传 '' 表示清空。
 */
function applyTaskEdits(line, edits, taskTag) {
	edits = edits || {};
	const m = TASK_LINE_RE.exec(line);
	if (!m) return line;
	const indent = `${m[1]}${m[2]}`;
	const bullet = m[3];
	const symbol = m[4];
	let body = m[5];

	const take = (regex) => {
		const mm = regex.exec(body);
		if (!mm) return null;
		body = body.replace(mm[0], ' ');
		return mm[0];
	};
	// 先把可编辑标记摘出来
	const tags = { due: null, start: null, done: null, created: null, priority: null };
	tags.due = take(DUE_RE);
	tags.start = take(START_RE);
	tags.done = take(/✅\s*\d{4}-\d{2}-\d{2}/);
	tags.created = take(CREATED_RE);
	tags.priority = take(PRIORITY_RE);
	const assigneeRaw = take(/👤\s*[^\s👤📅➕✅🛫🔺⏫🔼🔽⏳]+(?:\s*、\s*[^\s👤📅➕✅🛫🔺⏫🔼🔽⏳]+)*/);
	const tagRaw = body.includes(taskTag) ? taskTag : null;
	if (tagRaw) body = body.replace(tagRaw, ' ');

	// 描述：去掉末尾残留的问候性空格
	let desc = edits.description == null ? body.replace(/\s+/g, ' ').trim() : String(edits.description).trim();

	const due = edits.due === undefined ? tags.due : edits.due ? `📅 ${edits.due}` : null;
	const assignees =
		edits.assignees === undefined
			? assigneeRaw
			: String(edits.assignees || '').trim()
				? `👤 ${String(edits.assignees).trim()}`
				: null;
	const priority = edits.priority === undefined ? tags.priority : edits.priority || null;

	let out = `${indent}${bullet} [${symbol}] `;
	const parts = [];
	if (tagRaw) parts.push(tagRaw);
	if (desc) parts.push(desc);
	if (assignees) parts.push(assignees);
	if (due) parts.push(due);
	if (tags.start) parts.push(tags.start);
	if (tags.created) parts.push(tags.created);
	if (tags.done) parts.push(tags.done);
	if (priority) parts.push(priority);
	out += parts.join(' ');
	return out;
}

/** 相对今天的时间分组键 */
function timeBucket(dateStr, now) {
	const today = formatDate(now || new Date());
	if (!dateStr) return 'undated';
	if (dateStr < today) return 'past';
	if (dateStr === today) return 'today';
	if (dateStr === addDays(today, 1)) return 'tomorrow';
	const dow = (new Date(`${today}T00:00:00`).getDay() + 6) % 7; // 周一=0
	const weekEnd = addDays(today, 6 - dow);
	if (dateStr <= weekEnd) return 'thisWeek';
	if (dateStr <= addDays(weekEnd, 7)) return 'nextWeek';
	if (dateStr.slice(0, 7) === today.slice(0, 7)) return 'thisMonth';
	return 'later';
}

const TIME_BUCKET_ORDER = ['past', 'today', 'tomorrow', 'thisWeek', 'nextWeek', 'thisMonth', 'later', 'undated'];
const TIME_BUCKET_LABEL = {
	past: '已过去',
	today: '今天',
	tomorrow: '明天',
	thisWeek: '本周内',
	nextWeek: '下周',
	thisMonth: '本月内',
	later: '更远',
	undated: '未排期',
};

const WEEKDAY_CN = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** 日期 → 中文星期（让日期更醒目、更有信息量） */
function weekdayCN(dateStr) {
	if (!dateStr) return '';
	const d = new Date(`${dateStr}T00:00:00`);
	if (isNaN(d.getTime())) return '';
	return WEEKDAY_CN[d.getDay()];
}

/** 事件名 → 安全的文件名片段 */
function sanitizeFileName(name) {
	const cleaned = String(name == null ? '' : name)
		.replace(/[\\/:*?"<>|#^[\]]/g, '')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.slice(0, 60) || '未命名安排';
}

/** 文件名 → {date, title}；不符合 `YYYY-MM-DD-事件` 返回 null */
function parsePlanFileName(fileName) {
	const base = String(fileName || '').replace(/\.md$/, '');
	const m = PLAN_DATE_PREFIX_RE.exec(base);
	if (!m) return null;
	return { date: m[1], title: m[2] };
}

/**
 * 算出修改后的新路径；无需改名时返回原路径。
 * 日期或事件名称任一变化都要跟改名，否则文件名与 `# 标题` 会不一致。
 * @param {{path:string,fileName:string,title:string}} item 当前安排
 * @param {{date?:string,title?:string}} input 表单值
 * @param {(p:string)=>boolean} exists 路径是否已被占用
 */
function nextPlanPath(item, input, exists) {
	const oldPath = item.path;
	const named = parsePlanFileName(item.fileName);
	if (!named) return oldPath;
	const nextDate = (input && input.date) || named.date;
	const nextTitle = sanitizeFileName(String((input && input.title) || '').trim() || named.title);
	if (nextDate === named.date && nextTitle === named.title) return oldPath;
	const folder = oldPath.slice(0, oldPath.lastIndexOf('/') + 1);
	const base = `${nextDate}-${nextTitle}`;
	let candidate = `${folder}${base}.md`;
	let n = 2;
	while (exists(candidate) && candidate !== oldPath) {
		candidate = `${folder}${base}-${n}.md`;
		n += 1;
	}
	return candidate;
}

/** 判断某文件是否是一条「工作安排」 */
function isPlanFile(content, fileName, planFolderMatch) {
	if (parsePlanFileName(fileName)) return true;
	return Boolean(planFolderMatch) && frontmatterValue(content, '二级分类') === '工作安排';
}

/** 解析一条工作安排笔记 */
function parseArrangement(content, fileName) {
	const named = parsePlanFileName(fileName);
	const date = named ? named.date : parseFrontmatterDate(content);
	const title =
		frontmatterValue(content, '标题') || (named ? named.title : String(fileName || '').replace(/\.md$/, ''));
	const time = normalizeTime(frontmatterValue(content, '时间')) || parseTimeMarker(content);
	const h1 = /^#\s+(.+)$/m.exec(content);
	return {
		date: date || null,
		time: time || null,
		title: title,
		heading: h1 ? h1[1].trim() : null,
		place: frontmatterValue(content, '地点'),
		attendees: frontmatterValue(content, '参与人'),
		status: frontmatterValue(content, '状态'),
		secondary: frontmatterValue(content, '二级分类'),
	};
}

/** 生成一条工作安排笔记的 Markdown */
function buildArrangementNote(input, now) {
	const when = now || new Date();
	const date = input.date;
	const time = normalizeTime(input.time);
	const title = String(input.title || '').trim() || '未命名安排';
	const lines = [];
	lines.push('---');
	lines.push(`modified: ${formatDateTime(when).replace(' ', 'T')}:00+08:00`);
	lines.push(`date: ${date}`);
	lines.push('一级分类: 运营');
	lines.push('二级分类: 工作安排');
	lines.push(`时间: "${time || ''}"`);
	lines.push(`地点: "${(input.place || '').trim()}"`);
	lines.push(`参与人: "${(input.attendees || '').trim()}"`);
	lines.push('状态: 待处理');
	lines.push('tags: [工作安排]');
	lines.push('---');
	lines.push('');
	lines.push(`# ${title}`);
	lines.push('');
	lines.push('> [!info] 安排信息');
	lines.push(`> **时间**：${date}${time ? ` ${time}` : '（未定）'}`);
	lines.push(`> **地点**：${(input.place || '').trim()}`);
	lines.push(`> **参与人**：${(input.attendees || '').trim()}`);
	lines.push('');
	if (input.note && String(input.note).trim()) {
		lines.push('## 要点 / 准备事项');
		lines.push('');
		lines.push(String(input.note).trim());
		lines.push('');
	}
	lines.push('## 会前准备');
	lines.push('');
	lines.push('%%待办写法：- [ ] #action 内容 📅 YYYY-MM-DD（会进工作台看板）%%');
	lines.push('');
	lines.push('- ');
	lines.push('');
	lines.push('## 会后记录');
	lines.push('');
	lines.push('- ');
	lines.push('');
	return lines.join('\n');
}

/**
 * 生成「今天及以后」的 Calendar 笔记正文。
 * 用户选择（2026-10-12）：**与「＋ 新增安排」完全一致**——它就是一个普通计划文件，
 * 不是独立的「日报」类型。因此这里直接复用 `buildArrangementNote()`，
 * 标题取 `工作安排`（与文件名 `YYYY-MM-DD-工作安排.md` 一致，避免文件名与 H1 打架）。
 */
function buildDailyNote(input) {
	const now = (input && input.now) || new Date();
	const date = String((input && input.date) || '');
	return buildArrangementNote({ date, title: '工作安排' }, now);
}

/**
 * 就地改写一条已存在的安排笔记（保留正文其余内容，尤其是会前准备里的待办）。
 * 只更新：frontmatter 的 date/时间/地点/参与人、`# 标题`、安排信息 callout 的三行。
 */
function rewriteArrangementNote(content, input, now) {
	const when = now || new Date();
	const date = input.date;
	const time = normalizeTime(input.time) || '';
	const title = String(input.title || '').trim() || '未命名安排';
	const place = String(input.place || '').trim();
	const attendees = String(input.attendees || '').trim();

	let out = content;
	// frontmatter
	out = out.replace(/^date:\s*\d{4}-\d{2}-\d{2}/m, `date: ${date}`);
	out = out.replace(/^modified:\s*.*$/m, `modified: ${formatDateTime(when).replace(' ', 'T')}:00+08:00`);
	out = out.replace(/^时间:\s*.*$/m, `时间: "${time}"`);
	out = out.replace(/^地点:\s*.*$/m, `地点: "${place}"`);
	out = out.replace(/^参与人:\s*.*$/m, `参与人: "${attendees}"`);
	// 如果原本没有这些行（老笔记），补进 frontmatter 末尾
	const addIfMissing = (key, line) => {
		if (new RegExp(`^${key}:`, 'm').test(out)) return;
		out = out.replace(/^(tags:.*)$/m, `${line}\n$1`);
	};
	addIfMissing('时间', `时间: "${time}"`);
	addIfMissing('地点', `地点: "${place}"`);
	addIfMissing('参与人', `参与人: "${attendees}"`);
	// 正文标题
	out = out.replace(/^#\s+.*$/m, `# ${title}`);
	// 安排信息 callout
	out = out.replace(/^> \*\*时间\*\*：.*$/m, `> **时间**：${date}${time ? ` ${time}` : '（未定）'}`);
	out = out.replace(/^> \*\*地点\*\*：.*$/m, `> **地点**：${place}`);
	out = out.replace(/^> \*\*参与人\*\*：.*$/m, `> **参与人**：${attendees}`);
	return out;
}

function dateFromFilename(path) {
	const base = String(path).split('/').pop() || '';
	const m = /^(\d{4}-\d{2}-\d{2})/.exec(base);
	return m ? m[1] : null;
}

function isInMonth(dateStr, ref) {
	return typeof dateStr === 'string' && dateStr.slice(0, 7) === monthKey(ref);
}

/** 日期是否落在 [start, end] 闭区间内（均为 YYYY-MM-DD 字符串） */
function inDateRange(dateStr, start, end) {
	if (!dateStr || !start || !end) return false;
	return dateStr >= start && dateStr <= end;
}

function firstDayOfMonth(d) {
	return formatDate(new Date(d.getFullYear(), d.getMonth(), 1));
}

/** 扫描缓存的键：范围/搜索/时间区间变化都需要重新扫描（状态筛选不进键，重绘即可） */
function viewCacheKey(state) {
	if (!state) return '';
	return `${state.scope || ''}|${state.search || ''}|${state.rangeStart || ''}|${state.rangeEnd || ''}`;
}

function folderOf(path) {
	const idx = path.lastIndexOf('/');
	return idx === -1 ? '' : path.slice(0, idx);
}

function isUnder(path, folder) {
	const f = folder.replace(/\/+$/, '');
	return path === f || path.startsWith(`${f}/`);
}

/**
 * 实际生效的排除清单 = 用户显式配置的 `excludeFolders` + 由其它设置推导出的项。
 *
 * 推导是**只读、不落盘**的：这样用户改了「会议纪要模版」的位置后，旧位置的排除
 * 会立刻失效，不会残留成僵尸配置（如果把推导结果写回设置，就会出现「改过的地方
 * 永远被排除」的怪现象）。
 *
 * 这里只排除模版**文件本身**，不排除它所在的目录——模版可能就放在会议目录里，
 * 排除整个目录会把真会议一起干掉。
 */
function resolveExcludeFolders(settings) {
	const s = settings || {};
	const out = (s.excludeFolders || []).filter(Boolean).slice();
	const tpl = String(s.calendarMeetingTemplate || '').trim().replace(/^\/+/, '');
	if (tpl && !out.includes(tpl)) out.push(tpl);
	return out;
}

/**
 * 扫描来源的排除规则（三类目录共用，必须一致——曾因 planFolders 漏用此规则
 * 导致计划目录下的 AGENTS.md 被当成文档计数）：
 * 排除目录、assets 附件目录、AGENTS/README/说明/索引 之类非正文文件。
 */
function isExcludedSourcePath(path, excludeFolders) {
	if ((excludeFolders || []).some((f) => f && isUnder(path, f))) return true;
	if (path.includes('/assets/') || path.startsWith('assets/')) return true;
	const base = path.split('/').pop() || '';
	// 精确匹配，避免误伤「说明会记录.md」这类正常笔记
	if (/^(AGENTS|README)([\s._]|$)/i.test(base)) return true;
	if (/^(说明|索引)\.md$/i.test(base)) return true;
	return false;
}

/**
 * 某路径在该范围下是否要扫描。
 * 所有范围都先过 `isExcludedSourcePath`——曾经漏掉这一步，
 * 导致「全库」档把 AGENTS.md 里的语法示例（`#action 待办任务 📅 …`）当成真任务收进看板。
 */
function isSourcePathForScope(path, scope, settings) {
	const s = settings || {};
	if (isExcludedSourcePath(path, resolveExcludeFolders(s))) return false;
	if (scope === 'all') return true;
	const inFolders = (list) => (list || []).some((f) => f && isUnder(path, f));
	return (
		inFolders(s.meetingFolders) || inFolders(s.extraFolders) || inFolders(s.planFolders)
	);
}

/** 比较修改前后的行，找出「刚被勾选完成」的任务 */
function findNewlyDoneChanges(oldLines, newLines, taskTag) {
	const out = [];
	if (!Array.isArray(oldLines) || oldLines.length === 0) return out;
	const oldByIndex = new Map();
	const oldByDesc = new Map();
	oldLines.forEach((l, i) => {
		const t = parseTaskLine(l, i, taskTag);
		if (!t) return;
		oldByIndex.set(i, t);
		if (!oldByDesc.has(t.description)) oldByDesc.set(t.description, t.status);
	});
	newLines.forEach((l, i) => {
		const t = parseTaskLine(l, i, taskTag);
		if (!t || t.status !== STATUS.DONE) return;
		const prev = oldByIndex.get(i);
		let wasDone = null;
		if (prev) wasDone = prev.status;
		else if (oldByDesc.has(t.description)) wasDone = oldByDesc.get(t.description);
		if (wasDone === null || wasDone === STATUS.DONE) return;
		if (hasCompletionNoteBelow(newLines, i)) return;
		// 带上原始行与原始状态：用户在确认框点「取消」时要精确还原，不能留下半完成状态。
		// 行号错位（同一次保存里上方行数变化）时拿不到原始行，用 prevStatus 重建。
		t.prevLine = prev ? prev.rawLine : null;
		t.prevStatus = wasDone;
		t.prevStart = prev ? prev.start : null;
		out.push(t);
	});
	return out;
}

/* ------------------------------------------------------------------ */
/* 完成情况弹窗                                                        */
/* ------------------------------------------------------------------ */

class CompletionModal extends Modal {
	constructor(app, opts) {
		super(app);
		this.opts = opts || {};
		this.result = null;
		this.settled = false;
		this._resolve = null;
	}

	openAndWait() {
		return new Promise((resolve) => {
			this._resolve = resolve;
			this.open();
		});
	}

	_settle(value) {
		if (this.settled) return;
		this.settled = true;
		this.result = value;
		if (this._resolve) this._resolve(value);
		this.close();
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wb-modal');

		contentEl.createEl('h2', { text: '确认完成任务' });
		contentEl.createEl('div', {
			cls: 'wb-modal-task',
			text: this.opts.description || '',
		});

		const meta = contentEl.createDiv({ cls: 'wb-modal-meta' });
		meta.createSpan({ text: `完成时间：${this.opts.when || ''}` });
		if (this.opts.source) meta.createSpan({ text: `来源：${this.opts.source}` });

		const presets = this.opts.presets || [];
		if (presets.length) {
			const chips = contentEl.createDiv({ cls: 'wb-modal-chips' });
			presets.forEach((p) => {
				const chip = chips.createEl('button', { cls: 'wb-chip', text: p });
				chip.addEventListener('click', () => {
					const cur = this.textarea.value.trim();
					this.textarea.value = cur ? `${cur}；${p}` : p;
					this.textarea.focus();
				});
			});
		}

		this.textarea = contentEl.createEl('textarea', {
			cls: 'wb-modal-input',
			attr: { rows: '4', placeholder: '例如：已完成并交付，客户确认无问题；下次会议复盘' },
		});

		const hint = contentEl.createDiv({ cls: 'wb-modal-hint' });
		hint.setText(
			'点「确认完成」才会真的完成任务：写入 ✅ 完成日期，填写内容会写成任务下方的子行；' +
				'留空则只记录时间。点「取消」任务保持原样，不会改动笔记。',
		);

		const btns = contentEl.createDiv({ cls: 'wb-modal-buttons' });
		const cancel = btns.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this._settle(null));

		const save = btns.createEl('button', { text: '确认完成', cls: 'mod-cta' });
		save.addEventListener('click', () => this._settle(this.textarea.value));

		const onKey = (e) => {
			if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				this._settle(this.textarea.value);
			}
		};
		this.textarea.addEventListener('keydown', onKey);
		setTimeout(() => this.textarea.focus(), 30);
	}

	onClose() {
		this.contentEl.empty();
		if (!this.settled) this._settle(null);
	}
}

/* ------------------------------------------------------------------ */
/* 新增工作安排弹窗                                                     */
/* ------------------------------------------------------------------ */

class ArrangementModal extends Modal {
	constructor(app, opts) {
		super(app);
		this.opts = opts || {};
		this.onSubmit = this.opts.onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wb-modal');

		const editing = Boolean(this.opts.initial);
		const init = this.opts.initial || {};
		contentEl.createEl('h2', { text: editing ? '修改工作安排' : '新增工作安排' });
		contentEl.createEl('div', {
			cls: 'wb-modal-hint',
			text: editing
				? '改日期/时间/地点/参与人，正文里的待办原样保留'
				: `会写成 ${this.opts.folder || DEFAULT_PLAN_FOLDER}/YYYY-MM-DD-事件.md`,
		});

		const form = contentEl.createDiv({ cls: 'wb-form' });
		const d = new Date();
		const field = (label, type, value, placeholder) => {
			const row = form.createDiv({ cls: 'wb-form-row' });
			row.createEl('label', { cls: 'wb-form-label', text: label });
			const input = row.createEl('input', { type, cls: 'wb-form-input' });
			input.value = value || '';
			if (placeholder) input.placeholder = placeholder;
			return input;
		};

		this.titleInput = field('事件名称 *', 'text', init.title || '', '例：与银联开会');
		this.dateInput = field('日期 *', 'date', init.date || formatDate(d));
		this.timeInput = field('时间', 'time', normalizeTime(init.time) || '');

		const row = form.createDiv({ cls: 'wb-form-row wb-form-row-2' });
		const l1 = row.createDiv({ cls: 'wb-form-cell' });
		l1.createEl('label', { cls: 'wb-form-label', text: '地点' });
		this.placeInput = l1.createEl('input', { type: 'text', cls: 'wb-form-input' });
		this.placeInput.value = init.place || '';
		const l2 = row.createDiv({ cls: 'wb-form-cell' });
		l2.createEl('label', { cls: 'wb-form-label', text: '参与人' });
		this.peopleInput = l2.createEl('input', { type: 'text', cls: 'wb-form-input' });
		this.peopleInput.value = init.attendees || '';
		this.peopleInput.placeholder = '例：张三、李四';

		if (!editing) {
			const noteRow = form.createDiv({ cls: 'wb-form-row' });
			noteRow.createEl('label', { cls: 'wb-form-label', text: '要点 / 准备事项' });
			this.noteInput = noteRow.createEl('textarea', { cls: 'wb-form-input' });
			this.noteInput.rows = 3;
		}

		const quick = form.createDiv({ cls: 'wb-form-row wb-form-quick' });
		quick.createSpan({ cls: 'wb-form-label', text: '快捷日期' });
		[
			['今天', 0],
			['明天', 1],
			['后天', 2],
			['下周一', null],
		].forEach(([label, off]) => {
			const b = quick.createEl('button', { cls: 'wb-btn wb-btn-mini', text: label, attr: { type: 'button' } });
			b.addEventListener('click', () => {
				const base = new Date();
				if (off === null) {
					const dow = (base.getDay() + 6) % 7;
					base.setDate(base.getDate() + (7 - dow));
				} else {
					base.setDate(base.getDate() + off);
				}
				this.dateInput.value = formatDate(base);
			});
		});

		const btns = contentEl.createDiv({ cls: 'wb-modal-buttons' });
		const cancel = btns.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.close());
		const save = btns.createEl('button', { text: editing ? '保存修改' : '创建安排', cls: 'mod-cta' });
		save.addEventListener('click', () => this.submit());

		this.titleInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.submit();
		});
		setTimeout(() => this.titleInput.focus(), 30);
	}

	submit() {
		const title = this.titleInput.value.trim();
		if (!title) {
			new Notice('请填写事件名称');
			this.titleInput.focus();
			return;
		}
		if (!this.dateInput.value) {
			new Notice('请选择日期');
			return;
		}
		const payload = {
			title,
			date: this.dateInput.value,
			time: this.timeInput.value,
			place: this.placeInput.value,
			attendees: this.peopleInput.value,
			note: this.noteInput ? this.noteInput.value : '',
		};
		this.close();
		if (this.onSubmit) this.onSubmit(payload);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* 工作台视图                                                          */
/* ------------------------------------------------------------------ */

class WorkbenchView extends ItemView {
	constructor(leaf, plugin) {
		super(leaf);
		this.plugin = plugin;
		this.state = {
			scope: plugin.settings.defaultScope || 'meetings',
			search: '',
			statusFilter: null,
			// 会议行里点的那个状态小标签：只留这一场会议。与 statusFilter 叠加使用，
			// 两者都不进扫描缓存键——只重绘 DOM，不重扫仓库。
			meetingFilter: null,
			onlyMine: false,
			// 「已逾期」透视：从全量任务池里把未完成且 📅 早于今天的拉出来。
			// 与 statusFilter 一样不进扫描缓存键——只重绘 DOM，不重扫仓库。
			overdueFilter: false,
			rangeStart: null,
			rangeEnd: null,
			tab: 'overview',
			showCancelled: false,
			planCollapsed: false,
			upcomingCollapsed: false,
		};
	}

	getViewType() {
		return VIEW_TYPE_WORKBENCH;
	}

	getDisplayText() {
		return '工作台';
	}

	getIcon() {
		return 'layout-dashboard';
	}

	async onOpen() {
		this.containerEl.addClass('wb-container');
		await this.plugin.ensureData(true);
		this.render();
	}

	async onClose() {
		this.contentEl.empty();
	}

	render() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wb-root');

		// 首次安装引导：还没配任何目录时先让用户选一种配置方式，避免开局一片空白
		if (this.plugin.needsOnboarding()) {
			this.renderOnboarding(contentEl);
			return;
		}

		const snapshot = this.plugin.getSnapshot(this.state);
		if (!snapshot) {
			contentEl.createDiv({ cls: 'wb-loading', text: '正在扫描仓库……' });
			this.plugin.ensureData(false).then(() => this.render());
			return;
		}

		this.renderTabs(contentEl, snapshot);
		if (this.state.tab === 'overview') {
			this.renderOverview(contentEl, snapshot);
			return;
		}
		if (this.state.tab === 'plan') {
			this.renderPlan(contentEl, snapshot);
			return;
		}
		// 回顾页：逾期透视 → 会议行收窄 → 只看我的，逐层叠加
		const view = this.applyMine(this.applyMeeting(this.applyOverdue(snapshot)));
		this.renderHeader(contentEl, view);
		this.renderToolbar(contentEl, view);
		this.renderMeetings(contentEl, view);
		this.renderBoard(contentEl, view);
	}

	/**
	 * 首次安装引导。三种预设，点任意一个都会把 onboardingDismissed 置 true。
	 * 推荐结构会在库根创建 会议/ 项目/ 计划/ 三个目录——这是用户显式点击的结果，
	 * 不会在别处偷偷建目录。
	 */
	renderOnboarding(root) {
		const wrap = root.createDiv({ cls: 'wb-onboard' });
		wrap.createEl('h2', { text: '欢迎使用工作台' });
		wrap.createEl('p', {
			cls: 'wb-onboard-lead',
			text: '工作台需要知道「会议记录放在哪」，才能统计本月会议次数、汇总行动项。先选一种方式开始：',
		});

		const presets = [
			{
				title: '创建推荐目录结构',
				desc: '在库根新建 会议/、项目/、计划/ 三个目录并自动配好。适合从零开始，或先试一下。',
				action: '创建并开始',
			},
			{
				title: '使用我已有的目录',
				desc: '我库里的会议纪要已有固定位置。跳过引导，直接到设置里填路径。',
				action: '去设置',
			},
			{
				title: '稍后再说',
				desc: '暂时不配置。随时可以在 设置 → 工作台 里补上。',
				action: '跳过',
			},
		];

		presets.forEach((preset, i) => {
			const card = wrap.createDiv({ cls: 'wb-onboard-card' });
			const left = card.createDiv({ cls: 'wb-onboard-card-main' });
			left.createDiv({ cls: 'wb-onboard-card-title', text: preset.title });
			left.createDiv({ cls: 'wb-onboard-card-desc', text: preset.desc });
			const btn = card.createEl('button', { cls: 'wb-btn', text: preset.action, attr: { type: 'button' } });
			if (i === 0) btn.addClass('wb-btn-done');
			btn.addEventListener('click', () => this.applyOnboardingPreset(i));
		});

		wrap.createDiv({
			cls: 'wb-onboard-foot',
			text: '任务格式：- [ ] #action 内容 👤执行人 📅 截止日期 ➕ 创建日期。工作台兼容 Tasks 插件的 emoji 格式。',
		});
	}

	/** 应用引导预设。0=推荐结构 1=已有目录 2=跳过 */
	async applyOnboardingPreset(index) {
		const s = this.plugin.settings;
		try {
			if (index === 0) {
				for (const folder of ['会议', '项目', '计划']) {
					if (!this.app.vault.getAbstractFileByPath(folder)) {
						await this.app.vault.createFolder(folder).catch(() => {});
					}
				}
				s.meetingFolders = ['会议'];
				s.extraFolders = ['项目'];
				s.planFolders = ['计划'];
				s.calendarMeetingFolder = '会议';
			}
			s.onboardingDismissed = true;
			await this.plugin.saveSettings();
			if (index === 1) {
				this.plugin.activateSettings();
				new Notice('请在工作台设置里填写会议目录');
			}
			this.render();
		} catch (e) {
			new Notice(`引导设置失败：${e.message}`);
		}
	}

	/**
	 * 「已逾期」透视（不进扫描缓存键）：把全量池里未完成且过截止期的任务
	 * 拉进看板，不受当前「范围」限制——逾期的活儿往往挂在过去的会议里。
	 */
	applyOverdue(snapshot) {
		return filterOverdue(snapshot, this.state.onlyMine, new Date());
	}

	/**
	 * 按「只看我的」开关收窄快照（只影响回顾页）。
	 * 不改原对象，返回浅拷贝，避免污染扫描缓存。
	 * 本月会议 / 本月行动项两张卡也一并收窄，否则数字会和下方看板打架。
	 */
	applyMine(snapshot) {
		if (!this.state.onlyMine || !snapshot || !snapshot.hasSelf) return snapshot;
		const tasks = snapshot.tasks.filter((t) => t.mine);
		const out = Object.assign({}, snapshot, {
			tasks,
			counts: countByStatus(tasks, formatDate(new Date())),
			meetings: (snapshot.meetings || []).filter((m) => (m.tasks || []).some((t) => t.mine)),
		});
		// 已锁定某场会议时，applyMeeting 已按「我的」算好两张本月卡，别再覆盖；
		// 否则用快照里预计算的「我的」本月数量。
		if (!this.state.meetingFilter) {
			out.monthTaskCount = snapshot.mineMonthTaskCount;
			out.monthMeetingCount = snapshot.mineMonthMeetingCount;
		}
		return out;
	}

	/**
	 * 会议行里点了状态小标签：把看板收窄到「这一场会议」。
	 * 必须先按会议收窄再交给其它筛选，否则点「进行中 7」会把库里的
	 * 全部进行中任务都拉出来，而不是这一场的 7 项。
	 * 会议筛选不进扫描缓存键：只重绘 DOM，不重扫仓库。
	 */
	applyMeeting(snapshot) {
		return filterByMeeting(snapshot, this.state.meetingFilter, this.state.onlyMine, new Date());
	}

	/** 页签：回顾（会议行动项） / 计划（未来工作安排） */
	renderTabs(root, snapshot) {
		const bar = root.createDiv({ cls: 'wb-tabs' });
		[
			['overview', '总览', '今天要做什么：安排与到期待办合在一起'],
			['plan', '计划', '未来的工作安排'],
			['review', '回顾', '会议与项目的行动项'],
		].forEach(([key, label, tip]) => {
			const b = bar.createEl('button', {
				cls: `wb-tab${this.state.tab === key ? ' is-active' : ''}`,
				text: label,
				attr: { type: 'button', title: tip },
			});
			b.addEventListener('click', () => {
				if (this.state.tab === key) return;
				this.state.tab = key;
				this.render();
			});
		});
		const spacer = bar.createDiv({ cls: 'wb-tabs-spacer' });
		spacer.setText(
			this.state.tab === 'plan'
				? `${(snapshot.arrangements || []).length} 条安排`
				: this.state.tab === 'overview'
					? `本月 ${snapshot.monthMeetingCount} 会 · ${snapshot.monthTaskCount} 项`
					: '',
		);
		const add = bar.createEl('button', { cls: 'wb-btn wb-btn-add', text: '＋ 新增安排', attr: { type: 'button' } });
		add.addEventListener('click', () => this.openArrangementForm());
	}

	openArrangementForm(item) {
		const folder = firstFolder(this.plugin.settings.planFolders, DEFAULT_PLAN_FOLDER);
		if (item && item.file) {
			new ArrangementModal(this.app, {
				folder,
				initial: {
					title: item.title,
					date: item.date || '',
					time: item.time || '',
					place: item.place || '',
					attendees: item.attendees || '',
				},
				onSubmit: (payload) => this.plugin.updateArrangement(item, payload),
			}).open();
			return;
		}
		new ArrangementModal(this.app, {
			folder,
			onSubmit: (payload) => this.plugin.createArrangement(payload),
		}).open();
	}

	openTaskForm(task) {
		new TaskEditModal(this.app, {
			task,
			onSubmit: (payload) => this.plugin.updateTask(task, payload),
		}).open();
	}

	/** 计划页：未来工作安排——与下方「会议/项目待办」同一套样式（日期色条 + 扁平行） */
	renderPlan(root, snapshot) {
		const now = new Date();
		const today = formatDate(now);
		const list = (snapshot.arrangements || []).slice();
		const future = list.filter((a) => a.date && a.date >= today);
		const past = list.filter((a) => a.date && a.date < today);
		const undated = list.filter((a) => !a.date);

		const panel = root.createDiv({ cls: 'wb-panel wb-plan-panel' });
		const head = panel.createDiv({ cls: 'wb-panel-head' });
		// 标题与目录提示放左侧一组，右侧留给按钮（head 是 space-between）
		const headLeft = head.createDiv({ cls: 'wb-head-left' });
		headLeft.createSpan({ text: `未来工作安排（${future.length + undated.length} 条）` });
		const hint = headLeft.createSpan({ cls: 'wb-plan-hint' });
		hint.setText(`目录：${(this.plugin.settings.planFolders || []).join('、')}`);
		// 与「会议/项目里排到未来的待办」一致的展开/收起
		const planToggle = head.createEl('button', {
			cls: 'wb-btn wb-btn-plain',
			text: this.state.planCollapsed ? '展开' : '收起',
			attr: { type: 'button' },
		});

		const body = panel.createDiv({ cls: 'wb-plan-body' });
		if (this.state.planCollapsed) body.style.display = 'none';
		planToggle.addEventListener('click', () => {
			this.state.planCollapsed = !this.state.planCollapsed;
			body.style.display = this.state.planCollapsed ? 'none' : '';
			planToggle.setText(this.state.planCollapsed ? '展开' : '收起');
		});
		if (!future.length && !undated.length) {
			body.createDiv({
				cls: 'wb-empty',
				text: `还没有未来安排。点右上角「＋ 新增安排」录入，会写成 ${firstFolder(this.plugin.settings.planFolders, DEFAULT_PLAN_FOLDER)}/YYYY-MM-DD-事件.md`,
			});
		} else {
			this.renderPlanRows(body, future, now, false);
			if (undated.length) {
				const band = body.createDiv({ cls: 'wb-plan-subhead wb-sub-undated' });
				band.createSpan({ cls: 'wb-sub-date', text: '未排期' });
				band.createSpan({ cls: 'wb-sub-badge', text: '需补日期' });
				undated.forEach((a) => this.renderPlanRow(body, a, now, false));
			}
		}

		// 已过去但仍未处理的安排，折叠展示
		if (past.length) {
			const box = panel.createDiv({ cls: 'wb-plan-past' });
			if (this.state.planCollapsed) box.style.display = 'none';
			const t = box.createEl('button', {
				cls: 'wb-btn wb-btn-plain',
				text: `已过去（${past.length}）`,
				attr: { type: 'button' },
			});
			const wrap = box.createDiv({ cls: 'wb-plan-body' });
			wrap.style.display = 'none';
			this.renderPlanRows(wrap, past.slice().reverse(), now, true);
			t.addEventListener('click', () => {
				const open = wrap.style.display !== 'none';
				wrap.style.display = open ? 'none' : '';
				t.setText(`${open ? '展开' : '收起'} 已过去（${past.length}）`);
			});
		}

		this.renderUpcomingTasks(root, snapshot, now);
	}

	/** 按日期分组建行：每个日期一条醒目的日期色条，下面挂当天安排 */
	renderPlanRows(parent, items, now, isPast) {
		const byDate = new Map();
		items.forEach((a) => {
			if (!byDate.has(a.date)) byDate.set(a.date, []);
			byDate.get(a.date).push(a);
		});
		[...byDate.keys()].sort().forEach((date) => {
			this.renderDateBand(parent, date, now);
			byDate
				.get(date)
				.slice()
				.sort((x, y) => (x.time || '99:99').localeCompare(y.time || '99:99'))
				.forEach((a) => this.renderPlanRow(parent, a, now, isPast));
		});
	}

	/** 单条安排：时间 + 标题（+安排标签），下方一行地点/参与人/待办进度 */
	renderPlanRow(parent, item, now, isPast) {
		const row = parent.createDiv({ cls: `wb-upcoming-row wb-plan-row${isPast ? ' is-past' : ''}` });
		const main = row.createDiv({ cls: 'wb-plan-row-main' });

		const line = main.createDiv({ cls: 'wb-ov-line' });
		line.createSpan({ cls: 'wb-ov-time', text: item.time || '全天' });
		const title = line.createSpan({ cls: 'wb-ov-title', text: item.title });
		title.addEventListener('click', () => this.plugin.openFile(item.file));
		line.createSpan({ cls: 'wb-ov-tag wb-ov-tag-arr', text: '安排' });

		const meta = main.createDiv({ cls: 'wb-upcoming-meta' });
		if (item.place) meta.createSpan({ text: `📍 ${item.place}` });
		if (item.attendees) meta.createSpan({ text: `👤 ${item.attendees}` });
		if (item.taskCount) {
			meta.createSpan({ text: `待办 ${item.taskCount - item.doneCount}/${item.taskCount}` });
		}
		if (item.date && !isPast) {
			const days = Math.round(
				(new Date(`${item.date}T00:00:00`) - new Date(`${formatDate(now)}T00:00:00`)) / 86400000,
			);
			// 今天 / 明天用红色（最近要处理），其余近期待办用强调色
			if (days === 0) meta.createSpan({ cls: 'wb-plan-near is-urgent', text: '就是今天' });
			else if (days === 1) meta.createSpan({ cls: 'wb-plan-near is-urgent', text: '明天' });
			else if (days > 1 && days <= 3) meta.createSpan({ cls: 'wb-plan-near', text: `${days} 天后` });
		}

		const actions = row.createDiv({ cls: 'wb-plan-actions' });
		const edit = actions.createEl('button', {
			cls: 'wb-btn wb-btn-mini',
			text: '修改',
			attr: { type: 'button', title: '修改这条安排的日期/时间/地点/参与人' },
		});
		edit.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.openArrangementForm(item);
		});
		const open = actions.createEl('button', { cls: 'wb-btn wb-btn-mini', text: '打开', attr: { type: 'button' } });
		open.addEventListener('click', () => this.plugin.openFile(item.file));
		const later = actions.createEl('button', {
			cls: 'wb-btn wb-btn-mini',
			text: '＋1天',
			attr: { type: 'button', title: '把安排顺延一天（改文件名日期与 frontmatter）' },
		});
		later.addEventListener('click', async () => {
			later.disabled = true;
			await this.plugin.shiftArrangement(item, 1);
			later.disabled = false;
		});
	}

	/* ---------------- 总览页 ---------------- */

	/** 总览：今天要做什么——把「安排」与「到期待办」合在一起 */
	renderOverview(root, snapshot) {
		const now = new Date();
		const today = formatDate(now);
		const tomorrow = addDays(today, 1);
		const allTasks = snapshot.allTasks || snapshot.tasks || [];
		const arrangements = snapshot.arrangements || [];

		const futureArrs = arrangements.filter((a) => a.date && a.date >= today);
		const overdueTasks = allTasks.filter((t) => isOverdueTask(t, today));
		const pastArrs = arrangements.filter((a) => a.date && a.date < today);

		// 指标卡：点一下跳到对应页签/筛选
		const header = root.createDiv({ cls: 'wb-header' });
		const cards = [
			{
				label: '本月会议',
				value: snapshot.monthMeetingCount,
				unit: '次',
				cls: 'wb-accent',
				tip: '跳到「回顾」看本月会议',
				go: () => this.goTab('review', { scope: 'month', statusFilter: null }),
			},
			{
				label: '未来安排',
				value: futureArrs.length,
				unit: '条',
				cls: '',
				tip: '跳到「计划」看未来工作安排',
				go: () => this.goTab('plan'),
			},
			{
				label: '进行中',
				value: snapshot.counts.doing,
				unit: '项',
				cls: 'wb-doing',
				tip: '跳到「回顾」只看进行中的任务',
				go: () => this.goTab('review', { scope: 'month', statusFilter: STATUS.DOING }),
			},
			{
				label: '已逾期',
				value: overdueTasks.length,
				unit: '项',
				cls: 'wb-overdue',
				tip: '跨范围：未完成且已过截止日期的任务（含过去会议里排的）。点开直接看逾期清单',
				go: () =>
					this.goTab('review', { overdueFilter: true, statusFilter: null, meetingFilter: null }),
			},
			{
				label: '已完成',
				value: snapshot.counts.done,
				unit: '项',
				cls: 'wb-done',
				tip: '跳到「回顾」只看已完成的任务',
				go: () => this.goTab('review', { scope: 'month', statusFilter: STATUS.DONE }),
			},
		];
		cards.forEach((c) => {
			const card = header.createEl('button', {
				cls: `wb-stat wb-stat-clickable ${c.cls}`,
				attr: { type: 'button', title: c.tip },
			});
			card.createDiv({ cls: 'wb-stat-label', text: c.label });
			const v = card.createDiv({ cls: 'wb-stat-value' });
			v.createSpan({ text: String(c.value) });
			v.createSpan({ cls: 'wb-stat-unit', text: c.unit });
			card.addEventListener('click', () => c.go());
		});

		const cap = root.createDiv({ cls: 'wb-scope-note' });
		cap.setText(`今天 ${today}（${weekdayCN(today)}）　·　点上方卡片可跳转到对应页签`);

		// 今天 / 明天：安排 + 到期待办合并成一条时间线
		const items = [];
		arrangements
			.filter((a) => a.date === today || a.date === tomorrow)
			.forEach((a) =>
				items.push({
					kind: 'arr',
					date: a.date,
					time: a.time || '99:99',
					title: a.title,
					meta: [a.place ? `📍${a.place}` : '', a.attendees ? `👤${a.attendees}` : ''].filter(Boolean),
					open: () => this.plugin.openFile(a.file),
				}),
			);
		allTasks
			.filter(
				(t) =>
					t.status !== STATUS.DONE &&
					t.status !== STATUS.CANCELLED &&
					(t.due === today || t.due === tomorrow),
			)
			.forEach((t) =>
				items.push({
					kind: 'task',
					date: t.due,
					time: t.time || '99:99',
					title: t.description,
					meta: [t.file.basename, t.assignees.length ? `👤${t.assignees.join('、')}` : ''].filter(Boolean),
					open: () => this.plugin.openFile(t.file, t.lineNumber),
				}),
			);
		items.sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));

		const panel = root.createDiv({ cls: 'wb-panel' });
		const ph = panel.createDiv({ cls: 'wb-panel-head' });
		ph.createSpan({ text: `今天 · 明天（${items.length}）` });
		const body = panel.createDiv({ cls: 'wb-plan-body' });
		if (!items.length) {
			body.createDiv({ cls: 'wb-empty', text: '今天和明天都没有安排与到期待办' });
		} else {
			let lastDate = null;
			items.forEach((it) => {
				if (it.date !== lastDate) {
					lastDate = it.date;
					this.renderDateBand(body, it.date, now);
				}
				const row = body.createDiv({ cls: `wb-upcoming-row wb-ov-${it.kind}` });
				const line = row.createDiv({ cls: 'wb-ov-line' });
				line.createSpan({ cls: 'wb-ov-time', text: it.time === '99:99' ? '全天' : it.time });
				const txt = line.createSpan({ cls: 'wb-ov-title', text: it.title });
				txt.addEventListener('click', it.open);
				if (it.kind === 'arr') line.createSpan({ cls: 'wb-ov-tag wb-ov-tag-arr', text: '安排' });
				const m = row.createDiv({ cls: 'wb-upcoming-meta' });
				it.meta.forEach((x) => m.createSpan({ text: x }));
			});
		}

		// 本周剩余安排（后天起，至本周末）
		const dow = (now.getDay() + 6) % 7;
		const weekEnd = addDays(today, 6 - dow);
		const thisWeekArrs = arrangements
			.filter((a) => a.date && a.date > tomorrow && a.date <= weekEnd)
			.sort((a, b) => `${a.date} ${a.time || '99:99'}`.localeCompare(`${b.date} ${b.time || '99:99'}`));
		const wp = root.createDiv({ cls: 'wb-panel' });
		const wh = wp.createDiv({ cls: 'wb-panel-head' });
		wh.createSpan({ text: `本周剩余安排（${thisWeekArrs.length}）` });
		const wb = wp.createDiv({ cls: 'wb-plan-body' });
		if (!thisWeekArrs.length) {
			wb.createDiv({ cls: 'wb-empty', text: `本周（至 ${weekEnd}）没有更多安排` });
		} else {
			let lastD = null;
			thisWeekArrs.forEach((a) => {
				if (a.date !== lastD) {
					lastD = a.date;
					this.renderDateBand(wb, a.date, now);
				}
				const row = wb.createDiv({ cls: 'wb-upcoming-row wb-ov-arr' });
				const line = row.createDiv({ cls: 'wb-ov-line' });
				line.createSpan({ cls: 'wb-ov-time', text: a.time || '全天' });
				const txt = line.createSpan({ cls: 'wb-ov-title', text: a.title });
				txt.addEventListener('click', () => this.plugin.openFile(a.file));
			});
		}

		// 积压提醒（一行，不占地方）
		if (overdueTasks.length || pastArrs.length) {
			const tip = root.createDiv({ cls: 'wb-ov-overdue' });
			tip.createSpan({
				text: `另有 ${overdueTasks.length} 项待办已过截止日期${pastArrs.length ? `、${pastArrs.length} 条安排已过去` : ''}`,
			});
			const b = tip.createEl('button', {
				cls: 'wb-btn wb-btn-mini',
				text: '查看逾期清单',
				attr: { type: 'button', title: '到「回顾」页看全部已过截止日期的待办（跨范围）' },
			});
			b.addEventListener('click', () =>
				this.goTab('review', { overdueFilter: true, statusFilter: null, meetingFilter: null }),
			);
		}
	}

	/** 会议/项目里排到未来的待办，便于一并查看未来的工作量 */
	renderUpcomingTasks(root, snapshot, now) {
		const today = formatDate(now);
		const upcoming = (snapshot.allTasks || snapshot.tasks)
			.filter((t) => t.status !== STATUS.DONE && t.status !== STATUS.CANCELLED && t.due && t.due >= today)
			.sort((a, b) => `${a.due} ${a.description}`.localeCompare(`${b.due} ${b.description}`));

		const panel = root.createDiv({ cls: 'wb-panel' });
		const head = panel.createDiv({ cls: 'wb-panel-head' });
		const headLeft = head.createDiv({ cls: 'wb-head-left' });
		headLeft.createSpan({ text: `会议/项目里排到未来的待办（${upcoming.length}）` });
		const list = panel.createDiv({ cls: 'wb-plan-body' });
		if (this.state.upcomingCollapsed) list.style.display = 'none';
		const toggle = head.createEl('button', {
			cls: 'wb-btn wb-btn-plain',
			text: this.state.upcomingCollapsed ? '展开' : '收起',
			attr: { type: 'button' },
		});
		toggle.addEventListener('click', () => {
			this.state.upcomingCollapsed = !this.state.upcomingCollapsed;
			list.style.display = this.state.upcomingCollapsed ? 'none' : '';
			toggle.setText(this.state.upcomingCollapsed ? '展开' : '收起');
		});

		if (!upcoming.length) {
			list.createDiv({ cls: 'wb-empty', text: '暂无排到未来的待办' });
			return;
		}
		let lastDate = null;
		upcoming.forEach((t) => {
			if (t.due !== lastDate) {
				lastDate = t.due;
				this.renderDateBand(list, t.due, now);
			}
			const row = list.createDiv({ cls: 'wb-upcoming-row' });
			const txt = row.createDiv({ cls: 'wb-upcoming-title', text: t.description });
			txt.addEventListener('click', () => this.plugin.openFile(t.file, t.lineNumber));
			const m = row.createDiv({ cls: 'wb-upcoming-meta' });
			m.createSpan({ text: t.file.basename });
			if (t.assignees.length) m.createSpan({ text: `👤 ${t.assignees.join('、')}` });
			if (t.time) m.createSpan({ cls: 'wb-plan-time', text: t.time });
		});
	}

	renderHeader(root, snapshot) {
		const now = new Date();
		const header = root.createDiv({ cls: 'wb-header' });
		const sf = this.state.statusFilter;
		const od = this.state.overdueFilter;
		const monthScope = this.state.scope === 'month';

		const cards = [
			{
				label: '本月会议',
				value: `${snapshot.monthMeetingCount}`,
				unit: '次',
				cls: 'wb-accent',
				tip: `只看本月会议（${monthKey(now)}）：会议清单与看板都限本月`,
				active: monthScope && !od,
				patch: { scope: 'month', statusFilter: null, meetingFilter: null, overdueFilter: null },
			},
			{
				label: '本月行动项',
				value: `${snapshot.monthTaskCount}`,
				unit: '项',
				cls: '',
				tip: '本月全部行动项：清除状态筛选',
				active: monthScope && !sf && !od,
				patch: { scope: 'month', statusFilter: null, meetingFilter: null, overdueFilter: null },
			},
			{
				label: '未开始',
				value: `${snapshot.counts.todo}`,
				unit: '项',
				cls: 'wb-todo',
				tip: '未开始 = 开始日期 🛫 尚未到；没有开始日期的任务算进行中。再点一次取消筛选',
				active: sf === STATUS.TODO,
				patch: { statusFilter: sf === STATUS.TODO ? null : STATUS.TODO, meetingFilter: null },
			},
			{
				label: '进行中',
				value: `${snapshot.counts.doing}`,
				unit: '项',
				cls: 'wb-doing',
				tip: '进行中 = 已到开始日期、或未填写开始日期的未完成任务。再点一次取消筛选',
				active: sf === STATUS.DOING,
				patch: { statusFilter: sf === STATUS.DOING ? null : STATUS.DOING, meetingFilter: null },
			},
			{
				label: '已完成',
				value: `${snapshot.counts.done}`,
				unit: '项',
				cls: 'wb-done',
				tip: '只看已完成的任务（再点一次取消）',
				active: sf === STATUS.DONE,
				patch: { statusFilter: sf === STATUS.DONE ? null : STATUS.DONE, meetingFilter: null },
			},
			{
				label: '已逾期',
				value: `${snapshot.counts.overdue}`,
				unit: '项',
				cls: 'wb-overdue',
				tip: '跨范围汇总：未完成且 📅 截止日期早于今天的任务（来自过去会议的也算）。可与状态卡叠加。再点一次取消',
				active: od,
				patch: { overdueFilter: !od, meetingFilter: null },
			},
		];

		cards.forEach((c) => {
			const card = header.createEl('button', {
				cls: `wb-stat wb-stat-clickable ${c.cls}${c.active ? ' is-active' : ''}`,
				attr: { type: 'button', title: c.tip, 'aria-pressed': c.active ? 'true' : 'false' },
			});
			card.createDiv({ cls: 'wb-stat-label', text: c.label });
			const v = card.createDiv({ cls: 'wb-stat-value' });
			v.createSpan({ text: c.value });
			v.createSpan({ cls: 'wb-stat-unit', text: c.unit });
			card.addEventListener('click', () => this.applyFilter(c.patch));
		});

		// 说明三张状态卡的数字口径：随「范围」变化，而本月两张卡固定按本月计
		const scopeLabel =
			{
				month: `本月会议（${monthKey(new Date())}）`,
				range: `${snapshot.rangeStart} ~ ${snapshot.rangeEnd}`,
				meetings: '全部会议纪要',
				all: '全库',
			}[this.state.scope] || this.state.scope;
		const cap = root.createDiv({ cls: 'wb-scope-note' });
		cap.setText(
			`统计范围：${scopeLabel}${sf ? ` · 已筛选：${STATUS_LABEL[sf]}` : ''}` +
				(od ? ' · 已逾期透视（跨范围，含过去会议里的任务）' : '') +
				(this.state.onlyMine && snapshot.hasSelf
					? ` · 只看我的（${(this.plugin.settings.selfNames || []).filter(Boolean).join('、')}）`
					: '') +
				'　（点上方卡片可筛选下方内容）',
		);
	}

	/** 点统计卡即改筛选：只改视图状态，必要时才重新扫描 */
	async applyFilter(patch) {
		Object.assign(this.state, patch);
		await this.plugin.ensureData(false);
		this.render();
	}

	/** 切页签（可同时改筛选），总览里的卡片用它跳转 */
	async goTab(tab, patch) {
		this.state.tab = tab;
		if (patch) Object.assign(this.state, patch);
		await this.plugin.ensureData(false);
		this.render();
	}

	/** 日期分组标题：本区块的视觉主体（总览与计划页共用） */
	renderDateBand(parent, dateStr, now) {
		const b = timeBucket(dateStr, now);
		const head = parent.createDiv({ cls: `wb-plan-subhead wb-sub-${b}` });
		head.createSpan({ cls: 'wb-sub-date', text: dateStr });
		const wd = weekdayCN(dateStr);
		if (wd) head.createSpan({ cls: 'wb-sub-weekday', text: wd });
		const bl = TIME_BUCKET_LABEL[b];
		if (bl) head.createSpan({ cls: 'wb-sub-badge', text: bl });
		if (b === 'past') head.createSpan({ cls: 'wb-sub-badge wb-sub-overdue', text: '已逾期' });
		return head;
	}

	renderToolbar(root, snapshot) {
		const bar = root.createDiv({ cls: 'wb-toolbar' });

		const scopeWrap = bar.createDiv({ cls: 'wb-field' });
		scopeWrap.createSpan({ cls: 'wb-field-label', text: '范围' });
		const select = scopeWrap.createEl('select', { cls: 'dropdown' });
		[
			['month', '本月'],
			['range', '自定义时间范围'],
			['meetings', '全部（会议·商机·项目）'],
			['all', '全库（含 #action）'],
		].forEach(([val, label]) => {
			const opt = select.createEl('option', { text: label, value: val });
			if (this.state.scope === val) opt.selected = true;
		});
		select.addEventListener('change', () => {
			const patch = { scope: select.value, meetingFilter: null };
			if (select.value === 'range' && (!this.state.rangeStart || !this.state.rangeEnd)) {
				const d = new Date();
				patch.rangeStart = this.state.rangeStart || firstDayOfMonth(d);
				patch.rangeEnd = this.state.rangeEnd || formatDate(d);
			}
			this.applyFilter(patch);
		});

		if (this.state.scope === 'range') this.renderRangeControls(bar, snapshot);

		const searchWrap = bar.createDiv({ cls: 'wb-field wb-grow' });
		searchWrap.createSpan({ cls: 'wb-field-label', text: '搜索' });
		const input = searchWrap.createEl('input', {
			type: 'text',
			cls: 'wb-search',
			attr: { placeholder: '任务内容 / 执行人 / 文件名' },
		});
		input.value = this.state.search;
		let timer = null;
		input.addEventListener('input', () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				this.state.search = input.value.trim();
				this.plugin.refreshViews();
			}, 250);
		});

		const refresh = bar.createEl('button', { text: '刷新', cls: 'wb-btn' });
		refresh.addEventListener('click', async () => {
			await this.plugin.ensureData(true);
			this.plugin.refreshViews();
			new Notice('工作台已刷新');
		});

		// 「只看我的」：设置里没填「我是谁」时禁用，并说明去哪里填
		const mineCount = snapshot.mineTaskCount || 0;
		const mine = bar.createEl('button', {
			cls: `wb-btn wb-btn-mine${this.state.onlyMine ? ' is-active' : ''}`,
			attr: {
				type: 'button',
				'aria-pressed': this.state.onlyMine ? 'true' : 'false',
				title: snapshot.hasSelf
					? `只显示与我相关（👤 执行人含我，或参会人员含我）的任务：${mineCount} 项。再点一次取消`
					: '还没设置「我是谁」——请到 设置 → 工作台 → 我是谁 里填写',
			},
		});
		mine.createSpan({ text: snapshot.hasSelf ? `只看我的 ${mineCount}` : '只看我的' });
		if (!snapshot.hasSelf) mine.disabled = true;
		mine.addEventListener('click', () => {
			if (!snapshot.hasSelf) return;
			this.applyFilter({ onlyMine: !this.state.onlyMine });
		});

		if (this.state.statusFilter) {
			const chip = bar.createDiv({ cls: 'wb-filter-chip' });
			chip.createSpan({ text: `状态：${STATUS_LABEL[this.state.statusFilter]}` });
			const x = chip.createEl('button', { cls: 'wb-chip-x', text: '×', attr: { title: '清除状态筛选' } });
			x.addEventListener('click', () => this.applyFilter({ statusFilter: null }));
		}

		if (this.state.meetingFilter) {
			const locked = (snapshot.allMeetings || []).find((m) => m.path === this.state.meetingFilter);
			const chip = bar.createDiv({ cls: 'wb-filter-chip' });
			chip.createSpan({ text: `会议：${locked ? locked.name : '已锁定'}` });
			const x = chip.createEl('button', { cls: 'wb-chip-x', text: '×', attr: { title: '取消会议锁定' } });
			x.addEventListener('click', () => this.applyFilter({ meetingFilter: null }));
		}

		if (this.state.overdueFilter) {
			const chip = bar.createDiv({ cls: 'wb-filter-chip wb-chip-overdue' });
			chip.createSpan({ text: '已逾期' });
			const x = chip.createEl('button', {
				cls: 'wb-chip-x',
				text: '×',
				attr: { title: '清除「已逾期」透视' },
			});
			x.addEventListener('click', () => this.applyFilter({ overdueFilter: false }));
		}

		if (this.state.onlyMine && snapshot.hasSelf) {
			const who = (this.plugin.settings.selfNames || []).filter(Boolean).join('、');
			const chip = bar.createDiv({ cls: 'wb-filter-chip' });
			chip.createSpan({ text: `只看：${who}` });
			const x = chip.createEl('button', { cls: 'wb-chip-x', text: '×', attr: { title: '清除「只看我的」' } });
			x.addEventListener('click', () => this.applyFilter({ onlyMine: false }));
		}

		const note = bar.createDiv({ cls: 'wb-toolbar-note' });
		// 全库档会跳过不含 #action 的文件，不能按「会议/文档」拆分统计
		note.setText(
			this.state.overdueFilter
				? `已逾期透视：全量池里 ${snapshot.tasks.length} 项未完成且已过截止日期（不受上方范围限制）`
				: this.state.scope === 'all'
					? `扫描 ${snapshot.fileCount} 篇文件（其中含 #action 的收进看板）/ ${snapshot.tasks.length} 项行动`
					: `扫描 ${snapshot.allMeetings.length} 篇会议` +
						(snapshot.docCount ? ` + ${snapshot.docCount} 篇文档` : '') +
						(snapshot.arrangements && snapshot.arrangements.length
							? ` + ${snapshot.arrangements.length} 条安排`
							: '') +
						` / ${snapshot.tasks.length} 项行动`,
		);
	}

	/** 自选时间范围：起止日期 + 常用区间快选 */
	renderRangeControls(bar, snapshot) {
		const wrap = bar.createDiv({ cls: 'wb-field wb-range-field' });
		wrap.createSpan({ cls: 'wb-field-label', text: '时间' });

		const start = wrap.createEl('input', { type: 'date', cls: 'wb-date' });
		start.value = snapshot.rangeStart || '';
		const end = wrap.createEl('input', { type: 'date', cls: 'wb-date' });
		end.value = snapshot.rangeEnd || '';

		const commit = () => {
			let a = start.value;
			let b = end.value;
			if (!a || !b) return;
			if (a > b) {
				const t = a;
				a = b;
				b = t;
			}
			this.applyFilter({ scope: 'range', rangeStart: a, rangeEnd: b });
		};
		start.addEventListener('change', commit);
		end.addEventListener('change', commit);

		const presets = wrap.createDiv({ cls: 'wb-range-presets' });
		const now = new Date();
		const firstOfThis = firstDayOfMonth(now);
		const lastOfPrev = formatDate(new Date(now.getFullYear(), now.getMonth(), 0));
		const firstOfPrev = formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1));
		const firstOfLast3 = formatDate(new Date(now.getFullYear(), now.getMonth() - 2, 1));
		const firstOfYear = `${now.getFullYear()}-01-01`;
		[
			['本月', firstOfThis, formatDate(now)],
			['上月', firstOfPrev, lastOfPrev],
			['近3个月', firstOfLast3, formatDate(now)],
			['今年', firstOfYear, formatDate(now)],
		].forEach(([label, a, b]) => {
			const active = snapshot.rangeStart === a && snapshot.rangeEnd === b;
			const btn = presets.createEl('button', {
				cls: `wb-btn wb-btn-mini${active ? ' is-active' : ''}`,
				text: label,
				attr: { type: 'button' },
			});
			btn.addEventListener('click', () => this.applyFilter({ scope: 'range', rangeStart: a, rangeEnd: b }));
		});
	}

	renderMeetings(root, snapshot) {
		const now = new Date();
		const sf = this.state.statusFilter;
		const scope = this.state.scope;
		const od = this.state.overdueFilter;
		const today = formatDate(now);

		let shown;
		let baseLabel;
		// 每场会议在「当前透视」下应显示的计数：普通模式用全量计数，
		// 逾期透视只数这场里逾期（且叠加状态筛选）的任务
		let countsOf = (m) => m.counts;
		if (od) {
			// 逾期透视：跨范围列出「有逾期任务」的会议（含过去的会议）
			const isOd = (t) => isOverdueTask(t, today);
			shown = (snapshot.allMeetings || []).filter((m) => (m.tasks || []).some(isOd));
			baseLabel = '含逾期任务的会议';
			countsOf = (m) => {
				const odTasks = (m.tasks || []).filter(isOd);
				return countByStatus(odTasks, today);
			};
		} else if (scope === 'range') {
			shown = snapshot.meetings.slice(); // scan 已按区间过滤
			baseLabel = `${snapshot.rangeStart} ~ ${snapshot.rangeEnd}`;
		} else if (scope === 'month') {
			shown = snapshot.meetings.filter((m) => isInMonth(m.date, now));
			baseLabel = '本月会议';
		} else if (scope === 'meetings') {
			shown = snapshot.allMeetings.filter((m) => isInMonth(m.date, now));
			baseLabel = '本月会议';
		} else {
			return; // 全库范围不展示会议清单
		}

		shown = shown.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
		if (sf) {
			// 选了状态筛选时，会议清单只保留该状态下有任务的会议
			shown = shown.filter((m) => countsOf(m)[sf] > 0);
		}
		// 点了某场会议的状态标签：清单只留这一场，方便对照
		const mf = this.state.meetingFilter;
		if (mf) shown = shown.filter((m) => m.path === mf);

		const box = root.createDiv({ cls: 'wb-panel wb-meetings' });
		const head = box.createDiv({ cls: 'wb-panel-head' });
		const headText = sf
			? `${baseLabel} · 含「${STATUS_LABEL[sf]}」任务（${shown.length} 次）`
			: `${baseLabel}（${shown.length} 次）`;
		head.createSpan({ text: mf ? '已锁定 1 场会议' : headText });
		if (mf) {
			const un = head.createEl('button', { cls: 'wb-btn wb-btn-plain', text: '显示全部会议' });
			un.addEventListener('click', () => this.applyFilter({ meetingFilter: null }));
		}
		const toggle = head.createEl('button', { cls: 'wb-btn wb-btn-plain', text: '收起' });
		const list = box.createDiv({ cls: 'wb-meeting-list' });
		let collapsed = false;
		toggle.addEventListener('click', () => {
			collapsed = !collapsed;
			list.style.display = collapsed ? 'none' : '';
			toggle.setText(collapsed ? '展开' : '收起');
		});

		if (!shown.length) {
			list.createDiv({ cls: 'wb-empty', text: '该范围内暂无可显示的会议' });
			return;
		}

		shown.forEach((m) => {
			const locked = mf === m.path;
			const row = list.createDiv({ cls: `wb-meeting-row${locked ? ' is-locked' : ''}` });
			const link = row.createEl('a', { cls: 'wb-link', text: `${m.date} ${m.name}` });
			link.addEventListener('click', (e) => {
				e.preventDefault();
				this.plugin.openFile(m.file);
			});
			const counts = row.createDiv({ cls: 'wb-meeting-counts' });
			const mc = countsOf(m);
			[
				['todo', 'wb-dot-todo'],
				['doing', 'wb-dot-doing'],
				['done', 'wb-dot-done'],
			].forEach(([key, cls]) => {
				const active = locked && sf === key;
				const chip = counts.createSpan({
					cls: `wb-dot ${cls}${active ? ' is-active' : ''}`,
					text: `${STATUS_LABEL[key]} ${mc[key]}`,
					attr: {
						title: `只看这场会议里「${STATUS_LABEL[key]}」的 ${mc[key]} 项任务（再点一次取消）`,
					},
				});
				chip.addEventListener('click', (e) => {
					e.preventDefault();
					e.stopPropagation();
					// 关键：同时锁定「这一场会议」和「这个状态」，
					// 否则只会把库里该状态的任务都拉出来，而不是这一场的。
					if (active) {
						this.applyFilter({ meetingFilter: null, statusFilter: null });
					} else {
						this.applyFilter({ meetingFilter: m.path, statusFilter: key });
					}
				});
			});
		});
	}

	renderBoard(root, snapshot) {
		const sf = this.state.statusFilter;
		const od = this.state.overdueFilter;
		const sortedBy = (items) =>
			items.slice().sort((a, b) => {
				const da = a.due || '9999-99-99';
				const db = b.due || '9999-99-99';
				if (da !== db) return da.localeCompare(db);
				return String(b.sourceDate || '').localeCompare(String(a.sourceDate || ''));
			});

		// 逾期透视（未叠状态筛选）：单独一栏「已逾期」占满整宽，按截止日期升序——越早过期的排越前
		if (od && !sf) {
			const board = root.createDiv({ cls: 'wb-board wb-board-single' });
			const items = sortedBy(snapshot.tasks);
			const colEl = board.createDiv({ cls: 'wb-column wb-col-doing' });
			const head = colEl.createDiv({ cls: 'wb-column-head' });
			const lockedM = this.state.meetingFilter
				? (snapshot.allMeetings || []).find((m) => m.path === this.state.meetingFilter)
				: null;
			head.createSpan({
				cls: 'wb-column-title',
				text: lockedM ? `${lockedM.name} · 已逾期` : '已逾期的任务',
			});
			head.createSpan({ cls: 'wb-column-count', text: String(items.length) });
			const clear = head.createEl('button', { cls: 'wb-btn wb-btn-plain', text: '显示全部' });
			clear.addEventListener('click', () =>
				this.applyFilter({ overdueFilter: false, meetingFilter: null }),
			);

			const body = colEl.createDiv({ cls: 'wb-column-body wb-column-body-wide' });
			if (!items.length) {
				body.createDiv({ cls: 'wb-empty', text: '没有已过截止日期的未完成任务' });
			} else {
				items.forEach((task) => this.renderCard(body, task));
			}
			return;
		}

		if (sf) {
			// 选中某个状态：只显示该栏，占满整宽
			const board = root.createDiv({ cls: 'wb-board wb-board-single' });
			const items = sortedBy(snapshot.tasks.filter((t) => t.status === sf));
			const colEl = board.createDiv({ cls: `wb-column ${COL_CLASS[sf]}` });
			const head = colEl.createDiv({ cls: 'wb-column-head' });
			const lockedM = this.state.meetingFilter
				? (snapshot.allMeetings || []).find((m) => m.path === this.state.meetingFilter)
				: null;
			head.createSpan({
				cls: 'wb-column-title',
				text: lockedM
					? `${lockedM.name} · ${STATUS_LABEL[sf]}`
					: `${STATUS_LABEL[sf]}${od ? ' · 已逾期' : ''}的任务`,
			});
			head.createSpan({ cls: 'wb-column-count', text: String(items.length) });
			const clear = head.createEl('button', { cls: 'wb-btn wb-btn-plain', text: '显示全部' });
			clear.addEventListener('click', () =>
				this.applyFilter(
					od
						? { overdueFilter: false, statusFilter: null, meetingFilter: null }
						: { statusFilter: null, meetingFilter: null },
				),
			);

			const body = colEl.createDiv({ cls: 'wb-column-body wb-column-body-wide' });
			if (!items.length) {
				body.createDiv({ cls: 'wb-empty', text: '该状态下暂无任务' });
			} else {
				items.forEach((task) => this.renderCard(body, task));
			}
			return;
		}

		const board = root.createDiv({ cls: 'wb-board' });
		[STATUS.TODO, STATUS.DOING, STATUS.DONE].forEach((key) => {
			const colEl = board.createDiv({ cls: `wb-column ${COL_CLASS[key]}` });
			const items = sortedBy(snapshot.tasks.filter((t) => t.status === key));
			const head = colEl.createDiv({ cls: 'wb-column-head' });
			const title = head.createSpan({ cls: 'wb-column-title', text: STATUS_LABEL[key] });
			title.setAttribute('title', `点击只看「${STATUS_LABEL[key]}」`);
			title.addEventListener('click', () => this.applyFilter({ statusFilter: key }));
			head.createSpan({ cls: 'wb-column-count', text: String(items.length) });

			const body = colEl.createDiv({ cls: 'wb-column-body' });
			if (!items.length) {
				body.createDiv({
					cls: 'wb-empty',
					text:
						key === STATUS.TODO
							? '暂无未开始任务（给任务加 🛫 未来日期即会出现在这里）'
							: '暂无任务',
				});
				return;
			}
			items.forEach((task) => this.renderCard(body, task));
		});
	}

	renderCard(parent, task) {
		const card = parent.createDiv({ cls: 'wb-card' });

		// 勾选框：与笔记里的 - [ ] 一致，勾上即完成（走完成时间 + 完成情况询问），取消勾选即撤销完成
		const head = card.createDiv({ cls: 'wb-card-head' });
		const isDone = task.status === STATUS.DONE;
		const cb = head.createEl('input', {
			type: 'checkbox',
			cls: 'wb-card-check',
			attr: {
				title: isDone
					? '取消完成（会清除 ✅ 与完成情况子行）'
					: '勾选完成（写入完成日期与时间，并询问完成情况）',
			},
		});
		cb.checked = isDone;
		cb.addEventListener('click', async (e) => {
			e.preventDefault();
			e.stopPropagation();
			cb.disabled = true;
			try {
				await this.plugin.setTaskStatus(task, isDone ? STATUS.DOING : STATUS.DONE);
			} finally {
				cb.disabled = false;
			}
		});

		const title = head.createDiv({ cls: 'wb-card-title', text: task.description });
		title.addEventListener('click', () => this.plugin.openFile(task.file, task.lineNumber));

		const meta = card.createDiv({ cls: 'wb-card-meta' });

		const src = meta.createEl('a', { cls: 'wb-src', text: task.file.basename });
		src.addEventListener('click', (e) => {
			e.preventDefault();
			this.plugin.openFile(task.file, task.lineNumber);
		});

		if (task.assignees.length) {
			meta.createSpan({ cls: 'wb-assignee', text: `👤 ${task.assignees.join('、')}` });
		}

		if (task.due) {
			const overdue = task.status !== STATUS.DONE && task.due < formatDate(new Date());
			meta.createSpan({
				cls: `wb-due${overdue ? ' wb-overdue' : ''}`,
				text: `📅 ${task.due}${overdue ? '（逾期）' : ''}`,
			});
		}
		if (task.doneDate) {
			meta.createSpan({ cls: 'wb-donedate', text: `✅ ${task.doneDate}` });
		}
		if (task.priority) {
			meta.createSpan({ cls: 'wb-priority', text: task.priority });
		}

		const actions = card.createDiv({ cls: 'wb-card-actions' });
		const editBtn = actions.createEl('button', {
			cls: 'wb-btn wb-btn-edit',
			text: '修改',
			attr: { type: 'button', title: '修改任务描述/执行人/截止日期/优先级' },
		});
		editBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			this.openTaskForm(task);
		});
		const mk = (label, next, cls, tip) => {
			const b = actions.createEl('button', {
				cls: `wb-btn ${cls || ''}`,
				text: label,
				attr: tip ? { title: tip } : undefined,
			});
			b.addEventListener('click', async (e) => {
				e.preventDefault();
				e.stopPropagation();
				b.disabled = true;
				try {
					await this.plugin.setTaskStatus(task, next);
				} finally {
					b.disabled = false;
				}
			});
		};

		if (task.status === STATUS.TODO) {
			mk('开始', STATUS.DOING);
			mk('完成', STATUS.DONE, 'wb-btn-done');
		} else if (task.status === STATUS.DOING) {
			mk('完成', STATUS.DONE, 'wb-btn-done');
			mk('转为未开始', STATUS.TODO, '', '从明天起算未开始（会写入 🛫 明天）');
		} else if (task.status === STATUS.DONE) {
			mk('撤销完成', STATUS.DOING);
		}
	}
}

/* ------------------------------------------------------------------ */
/* 修改任务弹窗                                                         */
/* ------------------------------------------------------------------ */

class TaskEditModal extends Modal {
	constructor(app, opts) {
		super(app);
		this.opts = opts || {};
		this.task = this.opts.task;
		this.onSubmit = this.opts.onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('wb-modal');
		const t = this.task;

		contentEl.createEl('h2', { text: '修改任务' });
		contentEl.createDiv({ cls: 'wb-modal-hint', text: `来自：${t.file.basename}` });

		const form = contentEl.createDiv({ cls: 'wb-form' });
		const field = (label, type, value, placeholder) => {
			const row = form.createDiv({ cls: 'wb-form-row' });
			row.createEl('label', { cls: 'wb-form-label', text: label });
			const input = row.createEl('input', { type, cls: 'wb-form-input' });
			input.value = value || '';
			if (placeholder) input.placeholder = placeholder;
			return input;
		};

		this.descInput = field('任务内容 *', 'text', t.description || '', '例：提供报价与渠道政策');
		const row = form.createDiv({ cls: 'wb-form-row wb-form-row-2' });
		const c1 = row.createDiv({ cls: 'wb-form-cell' });
		c1.createEl('label', { cls: 'wb-form-label', text: '截止日期' });
		this.dueInput = c1.createEl('input', { type: 'date', cls: 'wb-form-input' });
		this.dueInput.value = t.due || '';
		const c2 = row.createDiv({ cls: 'wb-form-cell' });
		c2.createEl('label', { cls: 'wb-form-label', text: '执行人' });
		this.whoInput = c2.createEl('input', { type: 'text', cls: 'wb-form-input' });
		this.whoInput.value = (t.assignees || []).join('、');
		this.whoInput.placeholder = '例：张三 或 [[张三]]';

		const pRow = form.createDiv({ cls: 'wb-form-row' });
		pRow.createEl('label', { cls: 'wb-form-label', text: '优先级' });
		this.prioSelect = pRow.createEl('select', { cls: 'wb-form-input' });
		[
			['', '无'],
			['🔺', '🔺 最高'],
			['⏫', '⏫ 高'],
			['🔼', '🔼 中'],
			['🔽', '🔽 低'],
		].forEach(([v, label]) => {
			const o = this.prioSelect.createEl('option', { text: label });
			o.value = v;
		});
		this.prioSelect.value = t.priority || '';

		const clearRow = form.createDiv({ cls: 'wb-form-row' });
		const clearBtn = clearRow.createEl('button', {
			cls: 'wb-btn wb-btn-mini',
			text: '清空截止日期',
			attr: { type: 'button' },
		});
		clearBtn.addEventListener('click', () => {
			this.dueInput.value = '';
		});

		contentEl.createDiv({
			cls: 'wb-modal-hint',
			text: '只改上面四项（内容 / 截止 / 执行人 / 优先级）；任务状态、开始日期、完成日期与完成情况子行都保持不变。',
		});

		const btns = contentEl.createDiv({ cls: 'wb-modal-buttons' });
		const cancel = btns.createEl('button', { text: '取消' });
		cancel.addEventListener('click', () => this.close());
		const save = btns.createEl('button', { text: '保存修改', cls: 'mod-cta' });
		save.addEventListener('click', () => this.submit());

		this.descInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') this.submit();
		});
		setTimeout(() => this.descInput.focus(), 30);
	}

	submit() {
		const description = this.descInput.value.trim();
		if (!description) {
			new Notice('任务内容不能为空');
			this.descInput.focus();
			return;
		}
		const payload = {
			description,
			due: this.dueInput.value || null,
			assignees: this.whoInput.value.trim(),
			priority: this.prioSelect.value || null,
		};
		this.close();
		if (this.onSubmit) this.onSubmit(payload);
	}

	onClose() {
		this.contentEl.empty();
	}
}

/* ------------------------------------------------------------------ */
/* 插件主体                                                            */
/* ------------------------------------------------------------------ */

class WorkbenchPlugin extends Plugin {
	async onload() {
		await this.loadSettings();

		this.snapshots = new Map();
		this.internalWrite = false;
		this.cache = null;
		this.cacheKey = null;
		// Calendar 落位：记录本插件正在处理中的创建路径，避免重复处理
		this.dailyRoutingBusy = new Set();

		this.registerView(VIEW_TYPE_WORKBENCH, (leaf) => new WorkbenchView(leaf, this));

		this.addRibbonIcon('layout-dashboard', '打开工作台', () => this.activateView());

		this.addCommand({
			id: 'open-workbench',
			name: '打开工作台',
			callback: () => this.activateView(),
		});

		this.addCommand({
			id: 'refresh-workbench',
			name: '刷新工作台数据',
			callback: async () => {
				await this.ensureData(true);
				this.refreshViews();
				new Notice('工作台数据已刷新');
			},
		});

		this.addSettingTab(new WorkbenchSettingTab(this.app, this));

		this.registerEvent(
			this.app.workspace.on('file-open', (file) => {
				if (file && this.isTracked(file)) this.snapshotFile(file);
			}),
		);

		this.registerEvent(
			this.app.workspace.on('editor-change', (editor, info) => {
				const file = info && info.file;
				if (file) this.snapshots.set(file.path, editor.getValue().split('\n'));
			}),
		);

		const onModify = debounce((file) => this.handleModify(file), 350, true);
		this.registerEvent(
			this.app.vault.on('modify', (file) => {
				if (file instanceof TFile && this.isTracked(file)) onModify(file);
			}),
		);

		// 外部新增/删除/改名同样要重算并重绘：只 invalidateCache 不刷新的话，
		// 手动往工作安排目录丢一个文件进去，看板要等下次交互才更新。
		const onStructureChange = debounce(() => this.refreshViews(), 250, true);
		this.registerEvent(
			this.app.vault.on('create', (file) => {
				if (!(file instanceof TFile)) return;
				if (!file.path.endsWith('.md')) return;
				// Calendar 落位优先于快照/刷新：改名后旧路径的 snapshot 没有意义
				const routed = this.handleDailyNoteCreated(file);
				routed
					.catch(() => {})
					.finally(() => {
						this.snapshotFile(file);
						onStructureChange();
					});
			}),
		);
		this.registerEvent(
			this.app.vault.on('delete', (file) => {
				if (file instanceof TFile) this.snapshots.delete(file.path);
				onStructureChange();
			}),
		);
		this.registerEvent(
			this.app.vault.on('rename', (file, oldPath) => {
				this.snapshots.delete(oldPath);
				onStructureChange();
			}),
		);

		this.app.workspace.onLayoutReady(async () => {
			await this.primeSnapshots();
		});
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_WORKBENCH);
	}

	/* --------------------------- 设置 --------------------------- */

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!Array.isArray(this.settings.meetingFolders)) {
			this.settings.meetingFolders = DEFAULT_SETTINGS.meetingFolders.slice();
		}
		if (!Array.isArray(this.settings.extraFolders)) {
			this.settings.extraFolders = DEFAULT_SETTINGS.extraFolders.slice();
		}
		if (!Array.isArray(this.settings.planFolders)) {
			this.settings.planFolders = DEFAULT_SETTINGS.planFolders.slice();
		}
		if (!Array.isArray(this.settings.selfNames)) {
			this.settings.selfNames = DEFAULT_SETTINGS.selfNames.slice();
		}
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.invalidateCache();
		this.refreshViews();
	}

	/**
	 * 是否需要显示首次安装引导。
	 * 判据只看「会议目录」是否为空——`planFolders` 有兜底默认值（`计划`），
	 * 不能拿它当判据，否则引导永远不出现。用户点过「跳过」就不再打扰。
	 */
	needsOnboarding() {
		const s = this.settings || {};
		if (s.onboardingDismissed) return false;
		return !(s.meetingFolders || []).some((f) => f && String(f).trim());
	}

	/** 打开工作台设置页（引导里「去设置」用） */
	activateSettings() {
		const setting = this.app.setting;
		if (setting && typeof setting.open === 'function') {
			setting.open();
			if (typeof setting.openTabById === 'function') setting.openTabById(this.manifest.id);
		}
	}

	/* ------------------- Calendar 自动落位 ------------------- */

	/**
	 * Calendar 只会往 Daily notes 配置的目录写 `YYYY-MM-DD-工作安排.md`。
	 * 用户要求按日期分流：日期 < 今天 → 会议目录（`YYYY-MM-DD-会议.md`），
	 * 日期 >= 今天 → 工作安排目录（就地填成一条普通计划笔记，进计划页）。
	 * Calendar 插件本身只有一个目录、没有分支能力，所以由本插件在 create 事件里接手。
	 */
	async handleDailyNoteCreated(file) {
		if (!this.settings.calendarDailyRouting) return;
		if (!(file instanceof TFile) || file.extension !== 'md') return;
		const date = parseDailyFileName(file.name);
		if (!date) return;
		const planFolders = this.settings.planFolders || [];
		const planRoot = firstFolder(planFolders, DEFAULT_PLAN_FOLDER).replace(/\/+$/, '');
		if (!planRoot || !isUnder(file.path, planRoot)) return;
		// 注意：renameFile 会**原地改写** TFile.path，所以 busy 键必须在改名**之前**
		// 就取出来存好，且在 finally 里用这个原始键删除——曾因此在 finally 里
		// `delete(file.path)` 删掉的是新路径，旧键永久泄漏，导致同名文件后续创建事件
		// 全部被静默吞掉（表现为「重复点击过去日期不再生成 -2」）。
		const busyKey = file.path;
		if (this.dailyRoutingBusy.has(busyKey)) return;
		this.dailyRoutingBusy.add(busyKey);
		try {
			const today = formatDate(new Date());
			const target = dailyNoteTargetPath(
				{
					date,
					today,
					currentPath: busyKey,
					planFolder: planRoot,
					meetingFolder: this.settings.calendarMeetingFolder,
				},
				(p) => Boolean(this.app.vault.getAbstractFileByPath(p)),
			);
			if (!target) return;
			this.internalWrite = true;
			let body;
			if (target.kind === 'plan') {
				// 今天及以后：Calendar 建的是空文件，直接填成一条普通工作安排
				const existing = await this.app.vault.read(file);
				if (!existing.trim()) {
					await this.app.vault.modify(file, buildDailyNote({ date }));
				}
				if (file.path !== target.path) {
					await this.app.fileManager.renameFile(file, target.path);
				}
				body = file;
				new Notice(`已生成工作安排：${target.path}`);
			} else {
				// 过去的日期：改成会议纪要，并移到会议目录
				const tpl = await this.readMeetingTemplate();
				const content = tpl
					? renderMeetingTemplate(tpl, { date })
					: buildMeetingDayNote({ date });
				await this.app.vault.modify(file, content);
				await this.app.fileManager.renameFile(file, target.path);
				body = this.app.vault.getAbstractFileByPath(target.path);
				new Notice(`已按会议记录归档：${target.path}`);
			}
			if (body) await this.snapshotFile(body);
			this.invalidateCache();
			this.refreshViews();
		} catch (e) {
			console.error('[workbench] Calendar 落位失败', e);
			new Notice('Calendar 落位失败，请查看控制台');
		} finally {
			this.dailyRoutingBusy.delete(busyKey);
			this.internalWrite = false;
		}
	}

	/** 读取配置的会议纪要模版；读不到返回 null（由内置结构兜底） */
	async readMeetingTemplate() {
		const path = this.settings.calendarMeetingTemplate;
		if (!path) return null;
		const f = this.app.vault.getAbstractFileByPath(path);
		if (!(f instanceof TFile)) return null;
		try {
			return await this.app.vault.cachedRead(f);
		} catch (e) {
			return null;
		}
	}

	/* ------------------------ 文件与范围 ------------------------ */

	/** 排除规则：排除目录、assets 附件目录、AGENTS/README 之类索引文件 */
	isExcludedPath(path) {
		return isExcludedSourcePath(path, resolveExcludeFolders(this.settings));
	}

	/** 是否在「会议目录」下（这些目录里的文件默认都算会议） */
	isInMeetingFolders(file) {
		const path = file.path;
		if (this.isExcludedPath(path)) return false;
		return (this.settings.meetingFolders || []).some((f) => f && isUnder(path, f));
	}

	/** 是否在「附加目录」下（商机/项目等：贡献任务，但只有带会议类别才算会议） */
	isInExtraFolders(file) {
		const path = file.path;
		if (this.isExcludedPath(path)) return false;
		return (this.settings.extraFolders || []).some((f) => f && isUnder(path, f));
	}

	/** 是否在「未来工作安排」目录下 */
	isInPlanFolders(file) {
		const path = file.path;
		if (this.isExcludedPath(path)) return false;
		return (this.settings.planFolders || []).some((f) => f && isUnder(path, f));
	}

	/** 是否属于工作台扫描来源（不含「全库」档） */
	isSourceFile(file) {
		if (!file || !file.path || !file.path.endsWith('.md')) return false;
		return isSourcePathForScope(file.path, 'folders', this.settings);
	}

	isTracked(file) {
		if (!file || !file.path || !file.path.endsWith('.md')) return false;
		if (this.isExcludedPath(file.path)) return false;
		if (this.currentScope() === 'all') return true;
		return this.isSourceFile(file);
	}

	currentScope() {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
		if (leaf && leaf.view && leaf.view.state) return leaf.view.state.scope;
		return this.settings.defaultScope || 'meetings';
	}

	invalidateCache() {
		this.cache = null;
		this.cacheKey = null;
	}

	getSnapshot(state) {
		const key = viewCacheKey(state);
		if (!this.cache || this.cacheKey !== key) return null;
		return this.cache;
	}

	async ensureData(force) {
		const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH)[0];
		const state =
			leaf && leaf.view && leaf.view.state
				? leaf.view.state
				: { scope: this.settings.defaultScope, search: '' };
		const key = viewCacheKey(state);
		if (!force && this.cache && this.cacheKey === key) return this.cache;
		this.cache = await this.scan(state);
		this.cacheKey = key;
		return this.cache;
	}

	refreshViews() {
		this.invalidateCache();
		this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH).forEach((leaf) => {
			if (leaf.view instanceof WorkbenchView) leaf.view.render();
		});
	}

	async scan(state) {
		const scope = state.scope || 'meetings';
		const now = new Date();
		// 自定义时间范围：没给日期时默认「本月至今」
		let rangeStart = state.rangeStart || null;
		let rangeEnd = state.rangeEnd || null;
		if (scope === 'range' && (!rangeStart || !rangeEnd)) {
			rangeStart = firstDayOfMonth(now);
			rangeEnd = formatDate(now);
		}
		if (rangeStart && rangeEnd && rangeStart > rangeEnd) {
			const t = rangeStart;
			rangeStart = rangeEnd;
			rangeEnd = t;
		}

		const files = this.app.vault.getMarkdownFiles().filter((f) => isSourcePathForScope(f.path, scope, this.settings));

		const meetings = [];
		const tasks = [];
		const arrangements = [];
		let docCount = 0;

		const chunk = 40;
		for (let i = 0; i < files.length; i += chunk) {
			const slice = files.slice(i, i + chunk);
			const contents = await Promise.all(
				slice.map((f) => this.app.vault.cachedRead(f).catch(() => '')),
			);
			slice.forEach((file, idx) => {
				const content = contents[idx];
				if (!content) return;
				if (scope === 'all' && !content.includes(this.settings.taskTag)) return;

				const lines = content.split('\n');
				// 只有能从 frontmatter / 文件名取到日期，才算得上一场可计数的会议；
				// 取不到日期的（如资料摘录）保留在列表中，但日期记为空。
				const date = parseFrontmatterDate(content) || dateFromFilename(file.path);
				// 会议的参会人员：任务没写 👤 时，「只看我的」靠它兜底判定。
				// 库里有两个字段名——会议纪要用「参会人员」，工作安排用「参与人」，两个都收。
				const attendees = parsePersonList(
					[
						...parseFrontmatterList(content, '参会人员'),
						...parseFrontmatterList(content, '参与人'),
					].join('、'),
				);
				const fileTasks = [];
				lines.forEach((line, li) => {
					const t = parseTaskLine(line, li, this.settings.taskTag);
					if (!t) return;
					t.file = file;
					t.sourceDate = date;
					t.sourceName = file.basename;
					t.sourceAttendees = attendees;
					t.hasCompletionNote = hasCompletionNoteBelow(lines, li);
					fileTasks.push(t);
				});
				tasks.push(...fileTasks);

				// 未来工作安排：`YYYY-MM-DD-事件.md`，一个安排一个笔记
				if (this.isInPlanFolders(file) && isPlanFile(content, file.name, true)) {
					const info = parseArrangement(content, file.name);
					arrangements.push(Object.assign({}, info, {
						file,
						path: file.path,
						fileName: file.name,
						taskCount: fileTasks.length,
						doneCount: fileTasks.filter((t) => t.status === STATUS.DONE).length,
					}));
					return;
				}

				// 附加目录里的方案/素材/入口文档不算会议，避免把「本月会议数」撑大，
				// 但它们的 #action 仍然进看板（上面已收集）。
				const isMeeting = isMeetingRecord(content, this.isInMeetingFolders(file));
				if (!isMeeting) {
					docCount += 1;
					return;
				}

				const counts = { todo: 0, doing: 0, done: 0, cancelled: 0 };
				fileTasks.forEach((t) => {
					counts[t.status] += 1;
				});

				meetings.push({
					file,
					path: file.path,
					name: file.basename,
					date,
					counts,
					tasks: fileTasks,
				});
			});
		}

		const isMeetingScope = scope !== 'all';

		// 会议清单只列「真会议」；任务则按来源文件的日期圈定，
		// 这样附加目录里方案/入口文档的 #action 也能进本月看板。
		let visibleMeetings = meetings;
		let visibleTasks = tasks;
		if (scope === 'month') {
			visibleMeetings = meetings.filter((m) => isInMonth(m.date, now));
			visibleTasks = tasks.filter((t) => isInMonth(t.sourceDate, now));
		} else if (scope === 'range') {
			visibleMeetings = meetings.filter((m) => inDateRange(m.date, rangeStart, rangeEnd));
			visibleTasks = tasks.filter((t) => inDateRange(t.sourceDate, rangeStart, rangeEnd));
		}
		if (!isMeetingScope) visibleMeetings = [];

		if (state.search) {
			const q = state.search.toLowerCase();
			visibleTasks = visibleTasks.filter((t) => {
				const hay = `${t.description} ${t.assignees.join(' ')} ${t.file.basename}`.toLowerCase();
				return hay.includes(q);
			});
		}

		// 「只看我的」与状态筛选一样**不进缓存键**：在扫描时给每条任务打好 `mine` 标记，
		// 视图按开关取用，切换开关只重绘、不重扫。selfNames 变化会经 saveSettings 让缓存失效。
		const selfNames = (this.settings.selfNames || []).filter(Boolean);
		tasks.forEach((t) => {
			t.mine = taskInvolvesMe(t, selfNames);
		});
		const mineTaskCount = visibleTasks.filter((t) => t.mine).length;
		const mineMeetingCount = visibleMeetings.filter((m) => (m.tasks || []).some((t) => t.mine)).length;

		const monthMeetings = meetings.filter((m) => isInMonth(m.date, now));
		const monthTasks = tasks.filter((t) => isInMonth(t.sourceDate, now));
		const monthTaskCount = monthTasks.length;
		// 本月口径下「我的」数量：开了只看我的时，统计卡也要同步收窄，否则数字与看板打架
		const mineMonthTaskCount = monthTasks.filter((t) => t.mine).length;
		const mineMonthMeetingCount = monthMeetings.filter((m) =>
			(m.tasks || []).some((t) => t.mine),
		).length;

		return {
			scope,
			rangeStart,
			rangeEnd,
			fileCount: files.length,
			meetings: visibleMeetings,
			allMeetings: meetings,
			tasks: visibleTasks,
			allTasks: tasks,
			counts: countByStatus(visibleTasks, formatDate(now)),
			hasSelf: selfNames.length > 0,
			mineTaskCount,
			mineMeetingCount,
			docCount,
			arrangements: arrangements.sort((a, b) =>
				String(a.date || '9999').localeCompare(String(b.date || '9999')),
			),
			monthMeetingCount: monthMeetings.length,
			monthMeetings,
			monthTaskCount,
			mineMonthTaskCount,
			mineMonthMeetingCount,
		};
	}

	/* --------------------------- 快照 --------------------------- */

	async snapshotFile(file) {
		try {
			const content = await this.app.vault.cachedRead(file);
			this.snapshots.set(file.path, content.split('\n'));
		} catch (e) {
			/* ignore */
		}
	}

	async primeSnapshots() {
		const files = this.app.vault.getMarkdownFiles().filter((f) => this.isSourceFile(f));
		const chunk = 40;
		for (let i = 0; i < files.length; i += chunk) {
			await Promise.all(files.slice(i, i + chunk).map((f) => this.snapshotFile(f)));
		}
	}

	/* ------------------------ 勾选检测 ------------------------ */

	async handleModify(file) {
		if (this.internalWrite) return;
		const oldLines = this.snapshots.get(file.path);
		let content;
		try {
			content = await this.app.vault.read(file);
		} catch (e) {
			return;
		}
		const newLines = content.split('\n');
		this.snapshots.set(file.path, newLines);
		if (!oldLines || !oldLines.length) {
			this.invalidateCache();
			this.refreshViews();
			return;
		}
		if (!content.includes(this.settings.taskTag) || !this.settings.promptInEditor) {
			this.invalidateCache();
			this.refreshViews();
			return;
		}

		const changed = findNewlyDoneChanges(oldLines, newLines, this.settings.taskTag);
		if (changed.length) {
			await this.handleEditorCompletion(file, changed[0], newLines);
		}
		this.invalidateCache();
		this.refreshViews();
	}

	async handleEditorCompletion(file, task, newLines) {
		const note = await this.askCompletion(task, file.basename);

		// 在笔记里勾选后点「取消」：还原成勾选前的原始行，不留下半完成状态
		if (note === null) {
			if (!task.prevLine && !task.prevStatus) return;
			this.internalWrite = true;
			try {
				await this.processFile(file, (content) => {
					const lines = content.split('\n');
					let idx = lines.indexOf(task.rawLine);
					if (idx === -1) idx = lines.findIndex((l, i) => i === task.lineNumber && TASK_LINE_RE.test(l));
					if (idx === -1) throw new Error('未找到任务行');
					lines[idx] =
						task.prevLine ||
						applyStatusChange(lines[idx], task.prevStatus || STATUS.DOING, {
							startDate:
								task.prevStatus === STATUS.TODO
									? task.prevStart || tomorrowOf(new Date())
									: task.prevStart || null,
						});
					return lines.join('\n');
				});
				await this.snapshotFile(file);
				new Notice('已取消，勾选已还原');
			} catch (e) {
				new Notice(`还原失败：${e.message}`);
			} finally {
				this.internalWrite = false;
			}
			return;
		}
		const when = formatDateTime(new Date());
		const line = buildCompletionNote(task.indent, when, note, this.settings.completionLabel);
		this.internalWrite = true;
		try {
			await this.processFile(file, (content) => {
				const lines = content.split('\n');
				let idx = lines.indexOf(task.rawLine);
				if (idx === -1) idx = lines.findIndex((l, i) => i === task.lineNumber && TASK_LINE_RE.test(l));
				if (idx === -1) throw new Error('未找到任务行');
				return insertAfterTaskBlock(lines, idx, line).join('\n');
			});
			await this.snapshotFile(file);
			new Notice('已记录完成情况');
		} catch (e) {
			new Notice(`记录完成情况失败：${e.message}`);
		} finally {
			this.internalWrite = false;
		}
	}

	async askCompletion(task, source) {
		const modal = new CompletionModal(this.app, {
			description: task.description,
			when: formatDateTime(new Date()),
			source: source || (task.file ? task.file.basename : ''),
			presets: this.settings.promptPresets,
		});
		return modal.openAndWait();
	}

	/* --------------------------- 写回 --------------------------- */

	async processFile(file, fn) {
		if (typeof this.app.vault.process === 'function') {
			return this.app.vault.process(file, fn);
		}
		const content = await this.app.vault.read(file);
		const updated = fn(content);
		await this.app.vault.modify(file, updated);
		return updated;
	}

	async setTaskStatus(task, nextStatus) {
		const file = task.file;
		const now = new Date();

		// 先确认、后落盘：点「取消」时笔记一个字都不动
		let note = null;
		if (nextStatus === STATUS.DONE && this.settings.promptInView) {
			note = await this.askCompletion(task, file.basename);
			if (note === null) {
				new Notice('已取消，任务未完成');
				this.refreshViews();
				return;
			}
		}

		this.internalWrite = true;
		let newLine = null;
		try {
			await this.processFile(file, (content) => {
				const lines = content.split('\n');
				let idx = -1;
				if (task.lineNumber >= 0 && lines[task.lineNumber] === task.rawLine) idx = task.lineNumber;
				if (idx === -1) idx = lines.indexOf(task.rawLine);
				if (idx === -1) idx = lines.findIndex((l) => parseTaskLine(l, 0, this.settings.taskTag) && parseTaskLine(l, 0, this.settings.taskTag).description === task.description);
				if (idx === -1) throw new Error('未找到任务行，文件可能已被改动');
				newLine = applyStatusChange(lines[idx], nextStatus, {
					doneDate: formatDate(now),
					// 「未开始」= 开始日期在未来，因此转未开始时必须写一个未来日期（明天）
					// 「进行中」按设置决定是否记录今天的开始日期
					startDate:
						nextStatus === STATUS.TODO
							? tomorrowOf(now)
							: nextStatus === STATUS.DOING && this.settings.writeStartDate
								? formatDate(now)
								: null,
				});
				lines[idx] = newLine;
				const finalLines = nextStatus === STATUS.DONE ? lines : removeCompletionNotes(lines, idx);
				return finalLines.join('\n');
			});
			await this.snapshotFile(file);

			if (nextStatus === STATUS.DONE && this.settings.promptInView) {
				if (note) {
					const when = formatDateTime(now);
					const line = buildCompletionNote(task.indent, when, note, this.settings.completionLabel);
					await this.processFile(file, (content) => {
						const lines = content.split('\n');
						let idx = lines.indexOf(newLine);
						if (idx === -1) idx = lines.findIndex((l) => parseTaskLine(l, 0, this.settings.taskTag) && parseTaskLine(l, 0, this.settings.taskTag).description === task.description);
						if (idx === -1) throw new Error('未找到任务行');
						return insertAfterTaskBlock(lines, idx, line).join('\n');
					});
					await this.snapshotFile(file);
					new Notice('任务已完成，并记录了完成情况');
				} else {
					new Notice('任务已完成');
				}
			} else {
				new Notice(
					nextStatus === STATUS.DOING
						? '任务已开始'
						: nextStatus === STATUS.TODO
							? '任务已转为未开始（开始日期设为明天）'
							: '任务状态已更新',
				);
			}
		} catch (e) {
			new Notice(`更新任务失败：${e.message}`);
		} finally {
			this.internalWrite = false;
		}
		this.invalidateCache();
		this.refreshViews();
	}

	/* --------------------------- 其他 --------------------------- */

	/** 新建一条工作安排：<工作安排目录>/YYYY-MM-DD-事件.md */
	async createArrangement(input) {
		const folder = firstFolder(this.settings.planFolders, DEFAULT_PLAN_FOLDER).replace(/\/+$/, '');
		const date = input.date;
		const base = `${date}-${sanitizeFileName(input.title)}`;
		let path = `${folder}/${base}.md`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = `${folder}/${base}-${n}.md`;
			n += 1;
		}
		try {
			const content = buildArrangementNote(input);
			const file = await this.app.vault.create(path, content);
			await this.snapshotFile(file);
			this.invalidateCache();
			this.refreshViews();
			new Notice(`已创建安排：${file.path}`);
			this.app.workspace.getLeaf(false).openFile(file);
		} catch (e) {
			new Notice(`创建安排失败：${e.message}`);
		}
	}

	/** 修改一条已有安排：原地改写 frontmatter 与正文信息，保留待办 */
	async updateArrangement(item, input) {
		if (!item || !item.file) return;
		const oldPath = item.file.path;
		// 日期或事件名称变了 → 文件名跟着变，保持 `YYYY-MM-DD-事件.md` 一致
		const newPath = nextPlanPath(item, input, (p) => Boolean(this.app.vault.getAbstractFileByPath(p)));
		this.internalWrite = true;
		try {
			await this.processFile(item.file, (content) => rewriteArrangementNote(content, input));
			if (newPath !== oldPath) {
				await this.app.fileManager.renameFile(item.file, newPath);
				this.snapshots.delete(oldPath);
			}
			await this.snapshotFile(this.app.vault.getAbstractFileByPath(newPath) || item.file);
			new Notice('已保存修改');
		} catch (e) {
			new Notice(`修改失败：${e.message}`);
		} finally {
			this.internalWrite = false;
		}
		this.invalidateCache();
		this.refreshViews();
	}

	/** 修改一条任务的描述/执行人/截止/优先级（不动状态与完成信息） */
	async updateTask(task, edits) {
		if (!task || !task.file) return;
		this.internalWrite = true;
		let ok = false;
		try {
			await this.processFile(task.file, (content) => {
				const lines = content.split('\n');
				let idx = -1;
				if (task.lineNumber >= 0 && lines[task.lineNumber] === task.rawLine) idx = task.lineNumber;
				if (idx === -1) idx = lines.indexOf(task.rawLine);
				if (idx === -1) {
					idx = lines.findIndex((l) => {
						const p = parseTaskLine(l, 0, this.settings.taskTag);
						return p && p.description === task.description;
					});
				}
				if (idx === -1) throw new Error('未找到任务行，文件可能已被改动');
				const next = applyTaskEdits(lines[idx], edits, this.settings.taskTag);
				if (next === lines[idx]) return content;
				lines[idx] = next;
				return lines.join('\n');
			});
			await this.snapshotFile(task.file);
			ok = true;
			new Notice('已保存修改');
		} catch (e) {
			new Notice(`修改失败：${e.message}`);
		} finally {
			this.internalWrite = false;
		}
		this.invalidateCache();
		this.refreshViews();
		return ok;
	}

	/** 顺延安排：改文件名日期 + frontmatter date + 正文时间行 */
	async shiftArrangement(item, days) {
		if (!item || !item.file || !item.date) return;
		const next = addDays(item.date, days);
		const folder = item.path.slice(0, item.path.lastIndexOf('/') + 1);
		const base = parsePlanFileName(item.fileName) || { title: item.title };
		let newPath = `${folder}${next}-${base.title}.md`;
		let n = 2;
		while (this.app.vault.getAbstractFileByPath(newPath) && newPath !== item.path) {
			newPath = `${folder}${next}-${base.title}-${n}.md`;
			n += 1;
		}
		this.internalWrite = true;
		try {
			await this.processFile(item.file, (content) =>
				content
					.replace(/^date:\s*\d{4}-\d{2}-\d{2}/m, `date: ${next}`)
					.replace(/^modified:\s*.*$/m, `modified: ${formatDateTime(new Date()).replace(' ', 'T')}:00+08:00`)
					.replace(new RegExp(`(\\*\\*时间\\*\\*：)${item.date}`), `$1${next}`),
			);
			if (newPath !== item.path) {
				await this.app.fileManager.renameFile(item.file, newPath);
			}
			this.snapshots.delete(item.path);
			this.invalidateCache();
			this.refreshViews();
			new Notice(`已顺延到 ${next}`);
		} catch (e) {
			new Notice(`顺延失败：${e.message}`);
		} finally {
			this.internalWrite = false;
		}
	}

	async activateView() {
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_WORKBENCH);
		if (existing.length) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}
		const leaf = this.app.workspace.getRightLeaf(false);
		await leaf.setViewState({ type: VIEW_TYPE_WORKBENCH, active: true });
		this.app.workspace.revealLeaf(leaf);
	}

	openFile(file, line) {
		const leaf = this.app.workspace.getLeaf(false);
		leaf.openFile(file, line != null ? { eState: { line, scroll: line } } : undefined);
	}
}

/* ------------------------------------------------------------------ */
/* 设置页                                                              */
/* ------------------------------------------------------------------ */

class WorkbenchSettingTab extends PluginSettingTab {
	constructor(app, plugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: '工作台设置' });

		new Setting(containerEl)
			.setName('我是谁')
			.setDesc(
				'回顾页「只看我的」按钮据此判断。可填多个姓名/别名，用顿号或换行分隔。' +
					'规则：任务写了 👤 执行人 → 只看执行人是否含我；任务没写执行人 → 看我是否在它所在会议的「参会人员」里。',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 2;
				t.setValue((this.plugin.settings.selfNames || []).join('、'));
				t.onChange(async (v) => {
					this.plugin.settings.selfNames = v
						.split(/[\n、,，;；]+/)
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('会议目录')
			.setDesc('每行一个仓库相对路径；这些目录里的 .md 一律算会议。首次安装为空，请填成你自己的会议目录。')
			.addTextArea((t) => {
				t.inputEl.rows = 4;
				t.setValue((this.plugin.settings.meetingFolders || []).join('\n'));
				t.onChange(async (v) => {
					this.plugin.settings.meetingFolders = v
						.split('\n')
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('附加目录')
			.setDesc(
				'每行一个仓库相对路径（如商机、项目）。这些目录里的 #action 同样进看板；' +
					'但**只有 frontmatter 带「会议类别」的文件才计入会议数**，方案/素材/项目入口等文档不会撑大「本月会议」。',
			)
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.setValue((this.plugin.settings.extraFolders || []).join('\n'));
				t.onChange(async (v) => {
					this.plugin.settings.extraFolders = v
						.split('\n')
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('工作安排目录')
			.setDesc('未来工作安排的存放目录（取第一个）。新增安排会写成 `YYYY-MM-DD-事件.md`。')
			.addTextArea((t) => {
				t.inputEl.rows = 2;
				t.setValue((this.plugin.settings.planFolders || []).join('\n'));
				t.onChange(async (v) => {
					this.plugin.settings.planFolders = v
						.split('\n')
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('Calendar 自动落位')
			.setDesc(
				'开启后，Calendar 点出来的 `YYYY-MM-DD-工作安排.md` 会按日期自动分流：' +
					'日期早于今天 → 改成会议纪要并移入下面的「会议目录」；今天及以后 → 就地填成一条普通工作安排，留在工作安排目录。' +
					'（Calendar 自身只有一个目录、没有按日期分支的能力，所以由本插件接手。）',
			)
			.addToggle((t) =>
				t.setValue(this.plugin.settings.calendarDailyRouting !== false).onChange(async (v) => {
					this.plugin.settings.calendarDailyRouting = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('Calendar 过去日期落位目录')
			.setDesc('日期早于今天时，把它改名成 `YYYY-MM-DD-会议.md` 放这里。留空则该分支不生效。')
			.addText((t) =>
				t.setValue(this.plugin.settings.calendarMeetingFolder || '').onChange(async (v) => {
					this.plugin.settings.calendarMeetingFolder = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('会议纪要模版')
			.setDesc('过去日期落位时用它生成会议笔记（会替换其中的 Templater 日期语法）。留空则用内置结构。')
			.addText((t) =>
				t.setValue(this.plugin.settings.calendarMeetingTemplate || '').onChange(async (v) => {
					this.plugin.settings.calendarMeetingTemplate = v.trim();
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('排除目录')
			.setDesc('每行一个；这些目录下的文件不参与扫描。')
			.addTextArea((t) => {
				t.inputEl.rows = 3;
				t.setValue((this.plugin.settings.excludeFolders || []).join('\n'));
				t.onChange(async (v) => {
					this.plugin.settings.excludeFolders = v
						.split('\n')
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				});
			});

		new Setting(containerEl)
			.setName('任务标签')
			.setDesc('只收集包含该标签的复选框行，默认 #action。')
			.addText((t) =>
				t.setValue(this.plugin.settings.taskTag).onChange(async (v) => {
					this.plugin.settings.taskTag = v.trim() || '#action';
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('开始任务时写入开始日期')
			.setDesc('点「开始」把任务改为 [/] 并追加 🛫 YYYY-MM-DD（今天）。转「未开始」时无论如何都会写入 🛫 明天，否则任务不算未开始。')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.writeStartDate).onChange(async (v) => {
					this.plugin.settings.writeStartDate = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('看板中完成后询问完成情况')
			.setDesc('在工作台里勾选或点「完成」时，先弹出确认框；点「取消」不改动笔记，任务保持原状。')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.promptInView).onChange(async (v) => {
					this.plugin.settings.promptInView = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('笔记中勾选后询问完成情况')
			.setDesc('直接在会议纪要里勾选（含 Tasks 插件勾选）时也会弹确认框；点「取消」会把勾选还原成未完成。')
			.addToggle((t) =>
				t.setValue(this.plugin.settings.promptInEditor).onChange(async (v) => {
					this.plugin.settings.promptInEditor = v;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('完成情况标签')
			.setDesc('写为子行时的前缀，默认「完成情况」。')
			.addText((t) =>
				t.setValue(this.plugin.settings.completionLabel).onChange(async (v) => {
					this.plugin.settings.completionLabel = v.trim() || '完成情况';
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('快捷选项')
			.setDesc('询问框里的快捷按钮，用英文逗号分隔。')
			.addText((t) =>
				t.setValue((this.plugin.settings.promptPresets || []).join(',')).onChange(async (v) => {
					this.plugin.settings.promptPresets = v
						.split(',')
						.map((s) => s.trim())
						.filter(Boolean);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName('默认范围')
			.addDropdown((d) => {
				d.addOption('month', '本月');
				d.addOption('range', '自定义时间范围');
				d.addOption('meetings', '全部（会议·商机·项目）');
				d.addOption('all', '全库（含 #action）');
				d.setValue(this.plugin.settings.defaultScope);
				d.onChange(async (v) => {
					this.plugin.settings.defaultScope = v;
					await this.plugin.saveSettings();
				});
			});
	}
}

module.exports = WorkbenchPlugin;

/* 便于 Node 环境单测：把纯函数挂在导出类上 */
module.exports.parseTaskLine = parseTaskLine;
module.exports.cleanDescription = cleanDescription;
module.exports.applyStatusChange = applyStatusChange;
module.exports.findChildBlockEnd = findChildBlockEnd;
module.exports.insertAfterTaskBlock = insertAfterTaskBlock;
module.exports.removeCompletionNotes = removeCompletionNotes;
module.exports.buildCompletionNote = buildCompletionNote;
module.exports.hasCompletionNoteBelow = hasCompletionNoteBelow;
module.exports.findNewlyDoneChanges = findNewlyDoneChanges;
module.exports.parseFrontmatterDate = parseFrontmatterDate;
module.exports.frontmatterHasField = frontmatterHasField;
module.exports.frontmatterValue = frontmatterValue;
module.exports.isMeetingRecord = isMeetingRecord;
module.exports.normalizeTime = normalizeTime;
module.exports.parseTimeMarker = parseTimeMarker;
module.exports.addDays = addDays;
module.exports.timeBucket = timeBucket;
module.exports.TIME_BUCKET_ORDER = TIME_BUCKET_ORDER;
module.exports.TIME_BUCKET_LABEL = TIME_BUCKET_LABEL;
module.exports.weekdayCN = weekdayCN;
module.exports.sanitizeFileName = sanitizeFileName;
module.exports.nextPlanPath = nextPlanPath;
module.exports.parsePlanFileName = parsePlanFileName;
module.exports.parseDailyFileName = parseDailyFileName;
module.exports.dailyFileBase = dailyFileBase;
module.exports.isPastDate = isPastDate;
module.exports.dailyNoteTargetPath = dailyNoteTargetPath;
module.exports.renderMeetingTemplate = renderMeetingTemplate;
module.exports.buildDailyNote = buildDailyNote;
module.exports.buildMeetingDayNote = buildMeetingDayNote;
module.exports.isPlanFile = isPlanFile;
module.exports.isExcludedSourcePath = isExcludedSourcePath;
module.exports.resolveExcludeFolders = resolveExcludeFolders;
module.exports.firstFolder = firstFolder;
module.exports.isSourcePathForScope = isSourcePathForScope;
module.exports.parseArrangement = parseArrangement;
module.exports.buildArrangementNote = buildArrangementNote;
module.exports.rewriteArrangementNote = rewriteArrangementNote;
module.exports.applyTaskEdits = applyTaskEdits;
module.exports.dateFromFilename = dateFromFilename;
module.exports.formatDate = formatDate;
module.exports.formatDateTime = formatDateTime;
module.exports.monthKey = monthKey;
module.exports.isInMonth = isInMonth;
module.exports.inDateRange = inDateRange;
module.exports.firstDayOfMonth = firstDayOfMonth;
module.exports.viewCacheKey = viewCacheKey;
module.exports.statusFromSymbol = statusFromSymbol;
module.exports.deriveStatus = deriveStatus;
module.exports.tomorrowOf = tomorrowOf;
module.exports.structDepth = structDepth;
module.exports.leadingWidth = leadingWidth;
module.exports.isBlankish = isBlankish;
module.exports.parseFrontmatterList = parseFrontmatterList;
module.exports.parsePersonList = parsePersonList;
module.exports.nameMatchesSelf = nameMatchesSelf;
module.exports.taskInvolvesMe = taskInvolvesMe;
module.exports.countByStatus = countByStatus;
module.exports.isOverdueTask = isOverdueTask;
module.exports.filterByMeeting = filterByMeeting;
module.exports.filterOverdue = filterOverdue;
module.exports.STATUS = STATUS;
module.exports.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
module.exports.TASK_LINE_RE = TASK_LINE_RE;
