---
id: boss-ai-029
difficulty: L3
category: boss-ai
subcategory: AI Coding
tags:
- 巨剧核
- AI 陪伴
- AI Coding
- Cursor
- Claude Code
- Codex
- Copilot
- 提效度量
feynman:
  essence: "AI Coding 是把'人写代码、AI 辅助'升级为'AI 写代码、人审核'的协作新范式——用 Cursor/Claude Code/Codex 把工程效率从 1x 提升到 3-10x，但要配套规范、度量、风控。"
  analogy: "像从'手工作坊'升级为'AI 工程师团队'——你不再亲手敲每行代码，而是像技术总监管理一群 AI 工程师（Cursor/Claude Code），分配任务、审核产出、定规范，效率指数级提升但要管得住。"
  first_principle: "代码生成模型已具备处理中等复杂度任务的能力，人工逐行写是资源浪费。但 AI 会出错、会写不安全代码、会乱改架构。必须建立规范、Code Review、提效度量，把'AI 辅助'升级为'AI 主写 + 人审核'的受控协作。"
  key_points:
  - "工具栈：Cursor（IDE）/ Claude Code（终端）/ Codex / Copilot 各有侧重"
  - "规范：CLAUDE.md/AGENTS.md 工程约定 + Code Review + 测试门禁"
  - "协作模式：人主导设计 + AI 实现 + 人审核"
  - "提效度量：PR 速度 / bug 率 / 单测覆盖 / 主观效率"
  - "风险：代码质量/安全/依赖AI无深度思考/知识断层"
  socratic:
  - "AI 写的代码能直接合入主干吗？为什么必须 Code Review？"
  - "怎么让 AI 写出符合团队规范的代码？AI 不知道你们的约定怎么办？"
  - "用了 AI 后效率真的提升了吗？怎么证明？看什么指标？"
  - "新人用 AI 写代码，会不会让他学不到真本事？长期是好事吗？"
  - "AI 把代码写完了，但没人懂细节，出问题怎么维护？"
first_principle:
  problem: "如何把 AI 代码生成能力，转化为团队可受控、可度量、可持续的工程效率提升？"
  axioms:
  - "AI 已能写中等复杂度代码，人工逐行写是浪费"
  - "AI 会出错/写不安全代码/乱改架构，必须受控"
  - "提效不靠工具本身，靠配套规范+度量+文化"
  rebuild: "建立 AI Coding 协作体系：选合适工具栈 + 写工程约定（AI 能读懂的规范）+ 严格 Code Review + 测试门禁 + 提效度量 + 知识沉淀，把'个人用 AI'升级为'团队级 AI 工程协作'。"
follow_up:
- "CLAUDE.md/AGENTS.md 写什么？——项目架构、编码规范、禁用 API、测试要求、目录结构、提交规范；让 AI 像新人一样读懂团队约定。"
- "怎么防 AI 写出安全漏洞？——Code Review + 静态扫描（SAST）+ 依赖扫描 + 安全测试 + AI 输出审计；不盲信 AI。"
- "团队怎么推广 AI Coding？——先小范围试点 + 度量效果 + 沉淀 best practice + 培训 + 激励；强推会反弹。"
memory_points:
- "工具栈：Cursor/Claude Code/Codex/Copilot"
- "规范：AGENTS.md + Review + 测试门禁"
- "协作：人设计+AI 实现+人审核"
- "度量：PR 速度/bug 率/单测/主观效率"
---

# 【巨剧核 AI 陪伴】AI Coding 团队规范怎么落地？

> JD 依据："熟悉 AI Coding（Cursor/Claude Code/Codex/Copilot）；团队规范、提效度量。"

## 一、AI Coding 的范式转变

```
传统：人写代码，工具辅助（语法补全）
  效率：1x

AI Coding 早期：人主导，AI 补全片段
  效率：1.5-2x

AI Coding 当前：人设计，AI 实现，人审核
  效率：3-5x（中复杂度任务）

AI Coding 未来：AI 自主完成，人监督
  效率：5-10x+
```

模型能力到了"能写中等复杂度代码"的临界点，人工逐行写就是浪费。

## 二、工具栈对比

| 工具 | 形态 | 强项 | 适用 |
|---|---|---|---|
| Cursor | IDE（VSCode fork） | 全文件编辑、多文件改、Agent 模式 | 主流首选 |
| Claude Code | CLI（终端） | 长任务、脚本化、CI 集成 | 后端/DevOps |
| Codex（OpenAI） | CLI/Web | OpenAI 生态 | 已弃用/演变 |
| GitHub Copilot | IDE 插件 | 补全、Chat | 起步/补全 |
| Cody/Continue | IDE 插件 | 多模型选择 | 灵活 |

实战：Cursor 做主开发，Claude Code 做自动化（CI/批处理/复杂任务）。

## 三、工程约定（AI 能读懂的规范）

```
CLAUDE.md / AGENTS.md（AI 启动时读）：

# 项目架构
  这是一个 AI 陪伴产品，用 Node.js + TypeScript...
  模块结构：src/{user,role,story,message,memory}

# 编码规范
  - 用 TypeScript strict 模式
  - 函数 < 50 行
  - 必写 JSDoc
  - 禁用 any

# 禁用
  - 不要用 eval
  - 不要直接操作 DOM
  - 不要引入新依赖（先讨论）

# 测试要求
  - 每个公共函数要单测
  - 测试覆盖 > 80%
  - 改动必须跑 npm test

# 提交规范
  - Conventional Commits
  - 一个 PR 一个功能
  - 必须过 CI

# 业务约定
  - 角色记忆按 (user_id, role_id) 隔离
  - LLM 调用必经 LLMGateway
  - ...
```

AI 读了约定后产出符合规范的代码，减少 Review 反复。

## 四、协作模式

```
人主导模式（适合设计/架构/复杂决策）：
  人写设计文档 → AI 实现 → 人 Review → 迭代

AI 主导模式（适合实现/CRUD/测试）：
  人描述需求 → AI 自主完成 → 人审核

Agent 模式（适合长任务）：
  人下达任务 → AI 规划+执行+测试+提交 PR → 人审核

混合：
  简单任务 AI 全自动
  复杂任务人介入
```

## 五、Code Review（不能省）

```
AI 写的代码必须 Review：
  - 架构合理性（不要乱改架构）
  - 边界条件（AI 容易漏）
  - 安全（注入/越权/敏感信息）
  - 性能（N+1 查询/死循环）
  - 可维护性（命名/注释/复杂度）
  - 测试（单测是否真覆盖）

原则：
  AI 是初级工程师，写的代码要按初级标准审
  不盲信 AI（会一本正经胡说八道）
```

## 六、测试门禁

```
强制门禁：
  - 单测通过率 100%
  - 覆盖率 > 80%
  - Lint 通过
  - 类型检查通过
  - E2E 关键路径通过

CI 集成：
  AI 提 PR → 自动跑测试 → 不过自动 comment
  Claude Code 可在 CI 里自动修测试失败
```

## 七、提效度量

```
定量指标：
  - PR 速度（从开 Issue 到合并时长）
  - 吞吐（人均 PR 数/代码行）
  - 单测覆盖率
  - bug 率（线上 bug/千行代码）
  - Code Review 反复次数

定性指标：
  - 工程师主观效率（问卷）
  - 任务完成满意度
  - 重复劳动减少程度

ROI：
  工具成本 vs 工程师时间节省
  （Cursor $20/人/月，省 30% 时间，对 30w 年薪 = ROI 6x+）
```

## 八、风险与应对

```
[1] 代码质量参差
    应对：Review + 测试 + 静态扫描

[2] 安全漏洞
    应对：SAST 扫描 + 依赖扫描 + 安全培训

[3] 架构腐化（AI 看局部最优，全局次优）
    应对：架构 Review + 设计文档先

[4] 知识断层（人不懂 AI 写的代码）
    应对：Review 时要求 AI/作者解释关键设计
         维护文档

[5] 过度依赖（人不会写了）
    应对：核心模块要求人主导
         保持技术深度

[6] 数据泄露（敏感代码上传 AI）
    应对：私有部署 / 企业版 / 数据分级

[7] 新人成长问题
    应对：新人先手写后用 AI
         Code Review 即学习
```

## 九、典型落地流程

```
阶段 1（试点）：
  1-2 个团队试用 Cursor
  度量 1 个月效果
  沉淀 best practice

阶段 2（规范）：
  写 AGENTS.md / CLAUDE.md
  定 Code Review 标准
  接入 CI 门禁

阶段 3（推广）：
  全员培训
  分享 best practice
  持续度量

阶段 4（深化）：
  复杂任务 Agent 化
  CI/CD 集成 Claude Code 自动化
  内部知识库 + RAG 增强 AI
```

## 十、底层本质

AI Coding 的本质是**"把'人写代码'升级为'人机协作写代码'，效率指数级提升但要受控"**：

- 工具 = 能力放大器
- 规范 = 一致性保证
- Review = 质量护栏
- 度量 = 持续优化
- 文化 = 长期成功

这是软件工程的又一次范式转变——从'手工艺'到'AI 辅助工业'。但**工具不产生效率，配套规范和文化才产生**。盲目推工具不如先建规范。

## 常见考点

1. **AI 写代码会取代工程师吗？**——短期不会，长期会改变角色（从'写代码'到'审代码+设计+AI 管理'）；低端 CRUD 危险，高端架构/业务理解更值钱。
2. **怎么让 AI 写出符合业务约定的代码？**——AGENTS.md 写清楚业务规则 + 给 AI 上下文（相关代码/文档）+ Review 时纠正 + 沉淀到约定里。
3. **AI Coding 提效怎么证明给老板？**——AB 对比（用 AI 前后的 PR 速度/bug 率）+ 工程师主观问卷 + ROI 计算（工具成本 vs 时间价值）+ 案例展示。


## 结构化回答

**30 秒电梯演讲：** 聊到AI Coding 团队规范怎么落地，我的理解是——AI Coding 是把'人写代码、AI 辅助'升级为'AI 写代码、人审核'的协作新范式——用 Cursor/Claude Code/Codex 把工程效率从 1x 提升到 3-10x，但要配套规范、度量、风控。打个比方，像从'手工作坊'升级为'AI 工程师团队'——你不再亲手敲每行代码，而是像技术总监管理一群 AI 工程师（Cursor/Claude Code），分配任务、审核产出、定规范，效率指数级提升但要管得住。

**展开框架：**
1. **工具栈** — Cursor（IDE）/ Claude Code（终端）/ Codex / Copilot 各有侧重
2. **规范** — CLAUDE.md/AGENTS.md 工程约定 + Code Review + 测试门禁
3. **协作模式** — 人主导设计 + AI 实现 + 人审核

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：CLAUDE.md/AGENTS.md 写什么？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "AI Coding 团队规范怎么落地——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 概念结构示意图 | 先说核心：AI Coding 是把'人写代码、AI 辅助'升级为'AI 写代码、人审核'的协作新范式——用 Cursor/Claude Code/Codex 把工程效率从 1x 提升到 。 | 核心定义 |
| 0:40 | 流程图 | CLAUDE.md/AGENTS.md 工程约定 + Code Review + 测试门禁。 | 规范 |
| 1:05 | 代码示例截图 | 人主导设计 + AI 实现 + 人审核。 | 协作模式 |
| 2:30 | 总结卡 | 一句话记忆：工具栈：Cursor/Claude Code/Codex/Copilot。 下期可以接着聊：CLAUDE.md/AGENTS.md 写什么。 | 收尾总结 |
