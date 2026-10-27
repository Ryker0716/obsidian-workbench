'use strict';
/*
 * 合成测试库：在临时目录里造一组会议纪要 / 项目文档 / 工作安排，
 * 让测试不依赖任何真实个人库。所有内容都是虚构的。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const MEETING_A = `---
modified: 2026-09-10T10:00:00+08:00
date: 2026-09-10
一级分类: 业务
二级分类: 会议纪要
会议类别: 业务会议
参会人员:
  - 张三
  - 李四
状态: 已完成
tags: [主题/示例]
---

# 2026-09-10 示例会议 A

- [ ] #action 准备合作方案 👤[[张三]] 📅 2026-09-20 ➕ 2026-09-10
- [ ] #action 对接接口细节 👤[[李四]] 📅 2026-09-25 ➕ 2026-09-10 🛫 2099-01-01
- [x] #action 发送会议纪要 👤[[张三]] ➕ 2026-09-10 📅 2026-09-11 ✅ 2026-09-11
- [ ] #action 无执行人的事项 📅 2026-10-01 ➕ 2026-09-10
> - [ ] #action 引用块里的任务 👤[[张三]] 📅 2026-09-30
`;

const MEETING_B = `---
modified: 2026-10-02T15:00:00+08:00
date: 2026-10-02
一级分类: 业务
二级分类: 会议纪要
会议类别: 内部会议
参会人员:
  - 李四
状态: 已完成
tags: [主题/示例]
---

# 2026-10-02 示例会议 B

- [ ] #action 整理预算表 👤[[李四]] 📅 2026-10-15 ➕ 2026-10-02
`;

const PROJECT_DOC = `---
modified: 2026-10-03T09:00:00+08:00
date: 2026-10-03
一级分类: 业务
二级分类: 项目
状态: 进行中
tags: [主题/示例]
---

# 示例项目入口

- [ ] #action 项目文档里的待办 👤[[张三]] 📅 2026-10-20 ➕ 2026-10-03
`;

const PLAN_FILE = `---
modified: 2026-10-05T09:00:00+08:00
date: 2026-10-18
一级分类: 运营
二级分类: 工作安排
时间: "10:00"
地点: "线上"
参与人: "张三"
状态: 待处理
tags: [工作安排]
---

# 与示例客户开会

> **时间**：10:00
> **地点**：线上
> **参与人**：张三

## 会前准备

- [ ] #action 准备演示材料 👤[[张三]] 📅 2026-10-18
`;

/**
 * 把合成库写到临时目录，返回根路径。
 * 结构：
 *   会议/2026-09-10-示例会议A.md
 *   会议/2026-10-02-示例会议B.md
 *   会议/assets/聊天导出.md       （应被排除）
 *   项目/示例项目入口.md            （附加目录，无「会议类别」→ 算文档）
 *   项目/README.md                 （应被排除）
 *   计划/2026-10-18-与示例客户开会.md
 *   AGENTS.md                      （仓库根，含语法示例，应被排除）
 */
function build() {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workbench-fixture-'));
	const write = (rel, content) => {
		const abs = path.join(root, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, content, 'utf8');
	};
	write('会议/2026-09-10-示例会议A.md', MEETING_A);
	write('会议/2026-10-02-示例会议B.md', MEETING_B);
	write('会议/assets/聊天导出.md', '- [ ] #action 附件目录里的东西 📅 2026-09-20\n');
	write('项目/示例项目入口.md', PROJECT_DOC);
	write('项目/README.md', '- [ ] #action README 里的示例 📅 2026-03-15\n');
	write('计划/2026-10-18-与示例客户开会.md', PLAN_FILE);
	write('AGENTS.md', '# AGENTS\n\n- [ ] #action 待办任务 📅 2026-03-15 ➕ 2026-03-04\n');
	return root;
}

module.exports = { build, MEETING_A, MEETING_B, PROJECT_DOC, PLAN_FILE };
