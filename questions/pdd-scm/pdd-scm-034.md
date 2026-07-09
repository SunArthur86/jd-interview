---
id: pdd-scm-034
difficulty: L3
category: pdd-scm
subcategory: Agent 工程化
tags:
- 拼多多
- 供应链
- AI 编程
- Cursor
- Claude Code
- 研发提效
feynman:
  essence: AI 代码助手（Cursor/Claude Code）把"写代码"变成"对话"——补全、多文件重构、调试、测试，供应链研发效率提升 30-50%，是工程师 AI 转型的最佳切入点。
  analogy: 传统编程像用纸笔写稿，AI 代码助手像有秘书——你说意图，它写代码，你 review。
  first_principle: 写代码 70% 时间花在模式化工作（CRUD/查文档/调试），AI 擅长这些，让人聚焦设计。
  key_points:
  - 工具：Cursor（IDE）/ Claude Code（终端 Agent）/ Copilot（补全）
  - 场景：补全、多文件重构、调试、测试、文档
  - 必须人工 review（AI 会改错/遗漏）
  - 提效 30-50%
first_principle:
  problem: 研发 70% 时间在重复模式化工作，如何用 AI 自动化，让人聚焦设计？
  axioms:
  - 大量代码模式化
  - 查文档调试耗时
  - AI 擅长模式匹配
  rebuild: AI 助手承担模式化工作，工程师聚焦架构/review。
follow_up:
- Cursor 和 Claude Code 怎么选？——日常开发 Cursor，自动化任务 Claude Code
- AI 代码必须 review？——必选，AI 会改错/遗漏关联文件
- 供应链用 AI 编程坑？——敏感规则代码、配置误删、关联文件遗漏
memory_points:
- Cursor（IDE）+ Claude Code（终端）+ Copilot（补全）
- 场景：补全/重构/调试/测试/文档
- 提效 30-50%，但必须 review
- 敏感代码用企业版/私有部署
---

# 【拼多多供应链】怎么用 AI 代码助手改造研发流程？

> JD 依据：JD 8"AI/LLM"标签，AI 编程是转型基础。

## 一、工具组合

| 工具 | 类型 | 适用 |
|------|------|------|
| Cursor | IDE 集成 | 日常开发（补全+Agent） |
| Claude Code | 终端 Agent | 自动化、批量改、CI/CD |
| Copilot | 插件 | 轻量补全 |

## 二、供应链实战场景

**1. 多文件重构**：
```
Prompt: "@codebase 把供应链项目里所有 Date 改成 LocalDateTime，
        保持格式，加 import，mvn compile 验证"
Cursor 自动遍历修改+编译验证
```

**2. 调试**：
```
Claude Code: 读 error log → 定位 → 修复 → 编译验证
```

**3. 测试**：
```
Prompt: "@StockService.deduct 写单元测试，覆盖正常/库存不足/并发场景"
```

**4. 遗留代码理解**：
```
Prompt: "解释这个 10 年前的库存引擎类逻辑"
Cursor: 总结+标注复杂点+建议优化
```

## 三、提效数据

- 编码时间 70% → 30%
- 单测编写大幅减少
- 文档几乎零成本
- 整体效率 +30-50%

## 四、必须人工 Review

AI 会：
- 改错关联文件（升级 Spring Boot 漏改配置）
- 误删"看起来没用"的代码（降级开关）
- 不懂业务规则改错阈值

**教训**：AI 改完必须逐行 review + 编译 + 测试。

## 五、供应链特殊坑

- 敏感规则/价格算法：用企业版（私有部署）
- 关联文件遗漏：必须编译验证
- 配置误删：关键配置加注释

## 六、底层本质

AI 编程是**"意图到代码翻译的自动化"**：
- 1950s：机器码
- 1970s：高级语言
- 2000s：IDE
- 2020s：自然语言→代码（AI）

让程序员聚焦"想什么"而非"怎么敲"。

## 常见考点
1. **AI 代码助手能替代程序员吗**？——不会，会用 AI 的取代不会用的。
2. **AI 代码最大问题**？——理解不深（关联遗漏）+ 业务不懂 + 边缘 case 遗漏。
3. **敏感代码怎么用 AI**？——企业版私有部署 + 关键逻辑人工写。
