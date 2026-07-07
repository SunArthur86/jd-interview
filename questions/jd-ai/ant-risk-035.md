---
id: ant-risk-035
difficulty: L3
category: jd-ai
subcategory: Agent 工程化
tags:
- 蚂蚁
- 风控
- AI 编程
- Cursor
- Claude Code
- Copilot
- 研发效率
feynman:
  essence: AI 代码助手（Cursor/Claude Code/Copilot）把"写代码"从手敲变成对话——补全、Agent 多文件修改、终端执行，开发效率提升 30-50%，是工程师 AI 转型的最佳切入点。
  analogy: 传统编程像用纸笔写稿（一字字敲），AI 代码助手像有秘书——你说意图，它写代码，你 review。Cursor 像 IDE 原生集成，Claude Code 像终端 Agent 能执行能调试。
  first_principle: 写代码的本质是"把意图转化为代码"，主要时间花在重复模式（CRUD）、查文档、调试。AI 擅长这些重复活，让人聚焦在"想清楚做什么"。
  key_points:
  - 工具分类：IDE 集成（Cursor）/ 终端 Agent（Claude Code）/ 补全（Copilot）
  - 使用场景：补全、多文件重构、调试、文档生成、测试编写
  - 关键技巧：精准描述、上下文管理、code review
  - 提效 30-50%，但必须 review（AI 会改错）
first_principle:
  problem: 软件开发 70% 时间花在重复模式（CRUD、查文档、调试），如何用 AI 把这部分自动化，让人聚焦设计？
  axioms:
  - 大量代码是模式化（CRUD、模板）
  - 查文档、调试耗时但低创造性
  - AI 擅长模式匹配和检索
  rebuild: AI 代码助手承担模式化工作（补全、生成、调试），工程师聚焦架构、业务、review，开发效率整体提升。
follow_up:
- Cursor 和 Claude Code 怎么选？——日常开发用 Cursor（IDE），自动化流水线用 Claude Code（终端 Agent）
- AI 写的代码要不要 review？——必选！AI 会改错、遗漏、引入 bug，人工 review 必选
- 风控系统用 AI 编程有什么坑？——敏感代码泄露、改了关联文件、误删配置
memory_points:
- Cursor（IDE 补全/Agent）+ Claude Code（终端执行）+ Copilot（补全）三件套
- 场景：补全/重构/调试/文档/测试
- 提效 30-50%，但必须人工 review
- 风控场景注意：敏感代码、关联文件、配置误删
---

# 【蚂蚁风控】怎么用 AI 代码助手改造研发流程？提效多少？

> JD 依据：JD 提到"AI 编程"。这是 AI 转型的"内功"，工程师人人必会。

## 一、AI 代码助手的三类工具

| 工具 | 类型 | 特点 | 适用场景 |
|------|------|------|---------|
| **Cursor** | IDE 集成 | 上下文感知、Agent 多文件、Tab 补全 | 日常开发、重构 |
| **Claude Code** | 终端 Agent | 可执行命令、读写文件、运行测试 | 自动化、CI/CD、批量操作 |
| **GitHub Copilot** | 插件 | 实时补全、Chat | 代码补全 |
| **Windsurf** | IDE 集成 | Cascade 多步推理 | 复杂功能开发 |
| **ChatGPT/Claude Web** | 网页 | 通用问答、无代码库感知 | 学习、方案设计 |

**风控工程师推荐组合**：
- **Cursor**（日常开发主力，IDE 集成好）
- **Claude Code**（自动化任务，终端 Agent）
- **Copilot**（轻量补全）

## 二、AI 代码助手的能力边界

**擅长**：
- 模式化代码（CRUD、模板）
- 跨文件重构（统一改名）
- 调试（看错误、定位）
- 文档生成（注释、API 文档）
- 测试编写（单元测试、集成测试）
- 代码解释（理解遗留代码）

**不擅长**：
- 复杂业务逻辑（领域知识不够）
- 性能优化（需要深度理解）
- 架构决策（需要权衡）
- 边缘 case（容易遗漏）

## 三、典型使用场景（风控实战）

### 场景 1：补全小修改（Cursor Tab）
```
输入: "private final RiskRule rule;"
Cursor 自动补全 getter/setter、equals/hashCode
```

### 场景 2：多文件重构（Cursor Agent）
```
Prompt: "@codebase 把项目里所有 SimpleDateFormat 替换为 DateTimeFormatter，
        注意 1. 只改 service 包 2. 保持 pattern 3. 加 import 4. mvn compile 验证"
Cursor 自动遍历文件，逐个修改，运行编译验证
```

### 场景 3：调试（Claude Code 终端）
```
$ claude-code
> 编译报错了，看下错误然后修复
Claude Code:
  1. 读 error log
  2. 定位报错文件
  3. 修复
  4. 重新编译验证
```

### 场景 4：批量改规则（Claude Code）
```
> 把 questions/jd-core/*.md 里所有 difficulty 字段从 L2 改为 L3
Claude Code: 自动遍历、修改、提交
```

### 场景 5：写测试
```
Prompt: "@RiskDecisionService.decide 写单元测试，覆盖正常/异常/边界 case"
Cursor 生成测试代码，包含 mock、断言
```

### 场景 6：代码解释
```
Prompt: "解释下这个 10 年前写的 LegacyRiskEngine 类的逻辑"
Cursor: 总结逻辑、标注复杂点、建议优化
```

## 四、AI 编程的"最佳实践"

### 1. 精准 Prompt
```
❌ 模糊: "优化这个代码"
✅ 精准: "把这个方法的 SQL 查询改成走 idx_uid_status 索引，
        当前 EXPLAIN type=ALL，目标 type=ref"
```

### 2. 上下文管理
```
@codebase          整个代码库
@file:xx.java      单文件
@symbol:method     单方法
@web               联网查
```
精准控制 AI 看什么。

### 3. 增量验证
- 不要一次让 AI 改 100 个文件
- 分批改、改完编译、改完测试
- 出问题容易回滚

### 4. 严格 Review
```
AI 改的代码必看:
  - 逻辑对不对
  - 有没有遗漏（关联文件、配置）
  - 是否符合规范
  - 是否引入新 bug
```

## 五、风控场景的特殊坑

**1. 敏感代码泄露**
```
风控规则、模型权重、密钥不能让 AI 上传云端
→ 用企业版（私有部署）
→ 或本地小模型
```

**2. 关联文件遗漏**
```
AI 升级 Spring Boot 版本:
  ✓ 改 pom.xml
  ✗ 没改 application.yml 废弃配置
  → 启动报错
```
**教训**：AI 改完必须人工 review + 编译验证。

**3. 配置误删**
```
AI 删"看起来没用"的代码 → 可能是降级开关
```
**教训**：关键配置加注释说明用途。

**4. 风控规则理解错**
```
AI 不懂业务规则（"这个阈值为什么是 80"），可能改错
→ 规则变更必须人工 review
→ 关键场景不让 AI 自动改
```

## 六、研发流程改造（团队级）

**传统流程**：
```
需求 → 设计 → 编码（70%时间）→ 测试 → 上线
```

**AI 加持流程**：
```
需求 → 设计 → AI 编码（30%时间）→ 人工 Review → AI 测试 → 上线
            ↑                            ↑
         模式化 AI 写               人把关质量
```

**效率提升**：
- 编码时间从 70% → 30%
- 测试编写时间大幅减少
- 文档时间几乎为零
- 整体效率 +30-50%

## 七、研发效率量化

**度量指标**：
- 单需求开发周期（Lead Time）
- 代码行/人天（不直接用，参考）
- Bug 率（不能升）
- Code Review 时长

**蚂蚁的实践数据**（公开）：
- AI 加持后单需求周期降 30-40%
- 单测覆盖率提升（AI 写测试）
- 但 Bug 率需要严格 review 控制

## 八、学习路径（Java 工程师转 AI 编程）

**Stage 1：补全用户**
- 用 Copilot 做日常补全
- 习惯"少打字"
- 1-2 周熟练

**Stage 2：对话开发者**
- 用 Cursor 做多文件修改
- 学会写精准 prompt
- 1 个月熟练

**Stage 3：Agent 编排者**
- 用 Claude Code 做自动化任务
- 学会工具链集成
- 2-3 个月熟练

**Stage 4：AI 工程师**
- 能改造研发流程
- 用 AI 优化 AI（如自动 review）
- 持续迭代

## 九、AI 编程的"反模式"

**反模式 1：盲目接受 AI 代码**
```
❌ AI 生成 100 行直接提交
✅ AI 生成 → 逐行 review → 测试 → 提交
```

**反模式 2：过度依赖**
```
❌ 不理解 AI 写的代码就上线
✅ 必须能解释每一行
```

**反模式 3：忽视上下文**
```
❌ "改这个方法" 不给上下文
✅ @codebase + 明确范围 + 验证条件
```

**反模式 4：让 AI 做架构决策**
```
❌ "用什么架构设计这个系统"
✅ 人定架构，AI 实现细节
```

## 十、底层本质：编程的"意图-代码"翻译自动化

**编程的本质**：
```
意图（人脑中的想法）
   ↓ 翻译
代码（机器能执行的指令）
```

**AI 编程的作用**：自动化"翻译"过程的模式化部分。

**类比**：
- 编译器：把高级语言翻译成机器码（AI 编程的"前传"）
- IDE：辅助人写代码（语法高亮、跳转）
- AI 代码助手：理解意图直接生成代码

**这是软件工程的层次化抽象**：
- 1950s：机器码
- 1970s：汇编 → 高级语言（C/Java）
- 2000s：高级语言 + IDE
- 2020s：自然语言 → 代码（AI 编程）

每一层抽象都让程序员"想更高的层次"。AI 编程让人聚焦"想做什么"，而非"怎么敲"。

## 十一、就业形势（AI 转型关键）

**市场趋势**：
- "会用 AI 的工程师" 取代 "不会用的"
- 纯编码岗位被 AI 替代风险高
- "AI 工程师"（懂 AI + 懂工程）需求大

**风控工程师的转型**：
- **保持**：业务理解、架构设计、问题分析
- **学习**：AI 工具使用、Prompt 工程、Agent 编排
- **升级**：从"写代码"到"指挥 AI 写代码"

**面试加分项**：
- 熟练用 Cursor/Claude Code
- 能讲出 AI 提效的实际案例
- 理解 AI 编程的边界（什么场景适合、什么不适合）

## 常见考点
1. **AI 代码助手能替代程序员吗**？——不会完全替代，但会用 AI 的取代不会用的。AI 擅长模式化代码，人擅长设计和决策。
2. **AI 写的代码最大的问题**？——理解不深（可能改关联文件遗漏）、业务规则不懂、边缘 case 遗漏，必须严格 review。
3. **风控敏感代码怎么用 AI**？——企业版私有部署、关键规则人工写、敏感数据脱敏。

**代码示例**（Cursor Agent 的多文件重构 prompt）：
```
@codebase 请把项目里所有的 SimpleDateFormat 替换为 Java 8 的 DateTimeFormatter。
要求：
1. 只修改 com.ant.risk.service 包下的文件
2. 保持原有的日期格式 pattern 不变
3. 添加必要的 import 语句
4. 处理可能的异常（DateTimeException）
5. 运行 mvn compile 验证编译通过
6. 报告修改了哪些文件、每个文件改了几处
```
