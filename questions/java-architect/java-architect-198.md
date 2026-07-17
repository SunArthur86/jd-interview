---
id: java-architect-198
difficulty: L3
category: java-architect
subcategory: 架构设计
tags:
- Java 架构师
- Code Review
- 团队
- 质量
feynman:
  essence: 架构师带团队做 Code Review 不是"挑错"，而是"传递标准 + 知识共享 + 风险把关"。高质量 CR 的核心是：(1) 有一份团队共识的 PR checklist（不是 reviewer 个人偏好）；(2) 区分 must-fix（阻塞合并）和 nice-to-have（建议）；(3) review 评论要"对事不对人+给方案"（不是"这写得烂"，而是"这里用 Stream 更清晰，示例：xxx"）；(4) 自动化检查（Lint/单测/ArchUnit）能挡的不占用人脑。
  analogy: 像编辑改稿——好编辑不是标红所有"我觉得不好的地方"（那是个人偏好），而是对照"出版标准"（事实准确/逻辑清晰/语言规范）改，且给作者解释为什么改。Code Review 的 reviewer 就是代码的编辑。
  first_principle: Code Review 的第一性是"用集体视角降低单点失误 + 沉淀团队标准"。一个人写的代码有盲点（自己看不到的 bug/安全漏洞/性能坑），多人 review 提供视角互补。但 review 要有效，必须有"客观标准"（checklist/Lint/测试），否则变成 reviewer 主观审美争论。
  key_points:
  - PR checklist：团队共识的检查清单，不是 reviewer 个人偏好
  - must-fix vs nice-to-have：阻塞合并 vs 建议改进，分清优先级
  - 评论三要素：对事不对人 + 指出问题 + 给方案
  - 自动化优先：Lint/单测/ArchUnit 能挡的不占用人脑
  - review 时间盒：单 PR 不超 1 小时（疲劳后 review 质量下降）
first_principle:
  problem: 如何建立一套团队 Code Review 机制，既能把关代码质量，又不变成 reviewer 的负担或个人审美的争论？
  axioms:
  - 单人编码有盲点，多人 review 提供视角互补
  - 没有客观标准的 review = 个人审美争论（无意义的辩论）
  - 自动化能挡的（格式/命名/单测覆盖）不占用人脑
  - review 评论方式决定团队文化（攻击式 = 没人敢提交代码）
  rebuild: 三层防线。第一层自动化：CI 跑 Lint（Checkstyle/SpotBugs）、单测（覆盖率门禁）、ArchUnit（架构边界），这些挡掉 80% 机械问题。第二层 PR checklist：团队共识的检查清单（业务正确性/安全性/性能/异常处理），reviewer 按 checklist 而非个人偏好。第三层人工 review：聚焦自动化挡不了的（业务逻辑、设计权衡、边界场景），评论用"指出问题 + 给方案"格式，区分 must-fix 和 nice-to-have。
follow_up:
  - PR 多大合适？——单 PR < 400 行改动（研究显示超 400 行 review 缺陷率上升）。大改动拆小 PR
  - review 多久完成？——24 小时内首次响应，否则阻塞开发节奏。review 时间盒单 PR < 1 小时
  - must-fix 和 nice-to-have 怎么分？——must-fix：bug/安全/性能/破坏兼容；nice-to-have：命名/重构/优化。后者不阻塞合并
  - review 评论冲突怎么办？——技术分歧用数据/POC 解决，不在 PR 里辩论。升级到技术负责人决策
  - review 应该看什么？——(1) 业务正确性；(2) 安全性；(3) 性能；(4) 异常处理；(5) 测试覆盖。不看：格式（Lint 管）、个人风格
memory_points:
  - PR checklist：团队共识，非个人偏好
  - must-fix vs nice-to-have：阻塞 vs 建议
  - 评论三要素：对事不对人 + 指出问题 + 给方案
  - 自动化优先：Lint/单测/ArchUnit 挡 80% 机械问题
  - review 时间盒：单 PR < 1 小时，24 小时内响应
---

# 【Java 后端架构师】Java 架构师如何带团队做 Code Review

> 适用场景：JD 核心技术。Code Review 是团队代码质量的最后一道闸门，但很多团队的 CR 流于形式——秒批秒合、reviewer 只看格式不看逻辑、评论变成个人审美争论。架构师必须能用 PR checklist + 自动化门禁 + 评论规范，把 CR 从"走过场"变成"质量把关 + 知识共享"。

## 一、概念层：CR 的三层防线与评论规范

### 1.1 三层防线（自动化 + checklist + 人工）

```
代码提交
  │
  ▼
┌─────────────────────────────────────┐
│ 第一层：自动化（CI 挡 80% 机械问题） │
│ - Checkstyle/Spotless（格式）        │
│ - SpotBugs/SonarQube（静态检查）     │
│ - 单元测试（覆盖率门禁 > 80%）       │
│ - ArchUnit（架构边界）               │
│ - openapi-diff（API 兼容性）         │
└─────────────────┬───────────────────┘
                  │ 自动化通过
                  ▼
┌─────────────────────────────────────┐
│ 第二层：PR checklist（团队共识）     │
│ - 业务正确性（边界/并发/异常）       │
│ - 安全性（SQL 注入/XSS/敏感数据）    │
│ - 性能（N+1 查询/大对象/锁粒度）     │
│ - 设计（单一职责/依赖方向）          │
└─────────────────┬───────────────────┘
                  │ checklist 过
                  ▼
┌─────────────────────────────────────┐
│ 第三层：人工 review（深度判断）      │
│ - 业务逻辑是否符合需求               │
│ - 设计权衡是否合理                   │
│ - 边界场景是否覆盖                   │
│ - 可维护性（命名/注释/复杂度）       │
└─────────────────────────────────────┘
```

**核心原则**：自动化能挡的不占用人脑。格式、命名规范、单测覆盖这些机械检查让 CI 做，人工 review 聚焦业务逻辑、设计权衡、边界场景这些机器判断不了的。

### 1.2 评论三要素（决定团队文化）

```
❌ 糟糕的评论（攻击式）：
   "这代码写得太烂了，重写"
   "你是不是不懂 Java"
   "这种写法太低级"

✅ 好的评论（建设性）：
   "这里用 Stream.filter().map() 更清晰，
    示例：list.stream().filter(x -> x > 0).mapToInt(Int::intValue).sum()
    当前写法有 3 层嵌套 for 循环，可读性差"

评论三要素：
1. 对事不对人：说"这段代码"，不说"你"
2. 指出问题：具体说明哪里有问题（3 层嵌套、可读性差）
3. 给方案：提供改进示例（Stream 写法）
```

### 1.3 must-fix vs nice-to-have

| 类型 | 例子 | 处理 |
|------|------|------|
| **must-fix（阻塞合并）** | bug、安全漏洞、性能问题、破坏兼容性、无测试 | 必须改才能合并 |
| **nice-to-have（建议）** | 命名优化、重构、注释补充、风格改进 | 标记为 nit，不阻塞合并 |
| **question（讨论）** | 不确定的设计选择、可能的边界场景 | 提问讨论，达成共识 |

```markdown
# PR 评论示例

## Must-fix（阻塞）
🔴 [OrderService.java:45] 这里扣库存没有原子性，并发会超卖。
   建议用 UPDATE inventory SET stock = stock - ? WHERE sku_id = ? AND stock >= ?
   （乐观锁兜底）

🔴 [OrderController.java:28] 缺少单元测试，核心扣减逻辑必须有测试。

## Nice-to-have（建议，nit）
🟢 [OrderService.java:60] 这个方法 80 行，可以拆成 validate() + deduct() + record()。

🟢 [OrderEntity.java:15] 字段名 `amt` 不如 `amount` 清晰（nit）。

## Question（讨论）
❓ [OrderService.java:70] 这里为什么用 REQUIRES_NEW 事务传播？
   会不会导致事务嵌套性能问题？
```

## 二、机制层：PR checklist 与评审案例

### 2.1 Java 后端 PR Checklist（团队共识）

```markdown
# Java 后端 PR Review Checklist

## 业务正确性
- [ ] 边界条件处理（null/空集合/极值/负数）
- [ ] 并发安全（共享状态/锁/原子操作）
- [ ] 异常处理（catch 粒度/异常分类/不吞异常）
- [ ] 事务边界（@Transactional 范围/传播/回滚）
- [ ] 幂等性（重复请求不会重复执行）

## 安全性
- [ ] SQL 注入（用 PreparedStatement/MyBatis #{} 而非 ${}）
- [ ] XSS（输出转义/Content-Type 正确）
- [ ] 敏感数据（密码/身份证不记日志、传输加密）
- [ ] 权限校验（接口级 + 数据级）
- [ ] 依赖漏洞（第三方库 CVE 检查）

## 性能
- [ ] N+1 查询（循环里查 DB）
- [ ] 大对象（一次性加载全表/全列表）
- [ ] 锁粒度（悲观锁范围/乐观锁冲突）
- [ ] 缓存（热点数据是否缓存、TTL 合理）
- [ ] 批处理（循环调 RPC 改批量）

## 设计与可维护性
- [ ] 单一职责（方法/类只做一件事）
- [ ] 依赖方向（Controller → Service → Repository，不反向）
- [ ] 命名（变量/方法/类语义清晰）
- [ ] 复杂度（方法 < 50 行、圈复杂度 < 10）
- [ ] 注释（复杂逻辑有注释，公共 API 有 JavaDoc）

## 测试
- [ ] 单测覆盖核心逻辑（业务规则/边界/异常）
- [ ] 覆盖率 > 80%（行覆盖 + 分支覆盖）
- [ ] 测试可读性（Given-When-Then 结构）
- [ ] Mock 合理（不过度 Mock，集成测试补充）

## API 兼容性（如改了 API）
- [ ] 是否破坏性变更（删字段/改类型）
- [ ] openapi-diff 通过（CI 检查）
- [ ] 变更日志更新
```

### 2.2 评审案例：超卖 bug

```java
// ❌ 代码（有超卖 bug）
public class OrderService {
    public void createOrder(Long skuId, int quantity) {
        Inventory inv = inventoryRepo.findBySkuId(skuId);
        if (inv.getStock() >= quantity) {  // 检查
            inv.setStock(inv.getStock() - quantity);  // 扣减
            inventoryRepo.save(inv);  // 保存
        }
    }
    // 问题：check-then-act 非原子，并发超卖
}
```

**reviewer 的评论**：

```markdown
## 🔴 Must-fix：并发超卖

[OrderService.java:25] check-then-act 非原子，并发场景会超卖。

场景：库存 1 件，用户 A 和 B 同时下单。
- 线程 A：读到 stock=1，检查通过（1>=1）
- 线程 B：读到 stock=1，检查通过（1>=1）
- 线程 A：扣减 stock=0
- 线程 B：扣减 stock=-1  ← 超卖

### 修复方案（三选一）

方案 1: 数据库乐观锁（推荐）
```java
@Transactional
public void createOrder(Long skuId, int quantity) {
    int updated = inventoryRepo.deductStock(skuId, quantity);
    // UPDATE inventory SET stock = stock - ? 
    // WHERE sku_id = ? AND stock >= ?
    if (updated == 0) {
        throw new InsufficientStockException(skuId);
    }
}
```

方案 2: 分布式锁（适合复杂场景）
```java
@DistributedLock(key = "inventory:#{#skuId}")
public void createOrder(Long skuId, int quantity) {
    // 锁内 check-then-act 安全
}
```

方案 3: Redis 原子扣减（适合秒杀）
```java
Long remaining = redisTemplate.opsForValue()
    .increment("stock:" + skuId, -quantity);
if (remaining < 0) {
    redisTemplate.opsForValue().increment("stock:" + skuId, quantity);  // 回滚
    throw new InsufficientStockException();
}
```

请补充并发测试用例（多线程同时下单验证不超卖）。
```

**评论的要素**：
1. 指出具体问题（并发超卖）+ 复现场景（A/B 同时下单）
2. 给出多个方案（乐观锁/分布式锁/Redis 原子）+ 推荐
3. 给出代码示例（不只说"用乐观锁"，还写怎么写）
4. 要求补测试（机制化防护）

### 2.3 PR 大小与 review 时间盒

```
PR 大小与 review 质量（研究数据）：

代码行数      review 缺陷发现率
< 100 行      85%
100-200 行    75%
200-400 行    60%
400-1000 行   40%
> 1000 行     20%（基本无效）

规则：
- 单 PR < 400 行（超过拆分）
- review 时间盒 < 1 小时（疲劳后质量下降）
- 首次响应 < 24 小时（不阻塞开发节奏）

拆分大 PR 的方法：
- 按层拆：Controller/Service/Repository 分 PR
- 按功能拆：一个功能一个 PR
- 按阶段拆：先基础结构，后业务逻辑
```

## 三、实战层：CR 流程与团队规范

### 3.1 CR 流程（从提交到合并）

```
开发者提交 PR
  │
  ├── PR 描述模板（自动套用）：
  │   ## 变更说明
  │   ## 测试方式
  │   ## 关联 Issue
  │   ## Checklist（作者自检）
  │
  ▼
CI 自动化检查
  │
  ├── Lint（Checkstyle）     ─┐
  ├── 静态分析（SpotBugs）    │ 失败则阻断
  ├── 单元测试（覆盖率）      │
  ├── ArchUnit（架构边界）    ─┘
  │
  ▼
人工 Review（至少 1 人，核心改动 2 人）
  │
  ├── 24 小时内首次响应
  ├── 按 PR Checklist review
  ├── 评论区分 must-fix / nit / question
  │
  ▼
作者修改 + 再次 review（迭代直到 must-fix 清空）
  │
  ▼
合并（Squash Merge，保持提交历史清晰）
```

### 3.2 PR 描述模板

```markdown
# PR: 订单服务新增优惠券抵扣功能

## 变更说明
- 新增 OrderService.applyCoupon() 方法
- 订单创建时校验优惠券有效性并抵扣金额
- 优惠券状态从"未使用"改为"已使用"

## 测试方式
- [x] 单元测试：OrderServiceTest.applyCoupon_*（8 个用例）
- [x] 集成测试：下单 + 优惠券抵扣全链路
- [x] 边界测试：优惠券过期/已使用/金额超限

## 关联 Issue
Closes #1234

## Checklist（作者自检）
- [x] 边界条件处理（null 优惠券/金额为 0）
- [x] 并发安全（优惠券不被重复使用，乐观锁）
- [x] 异常处理（优惠券无效抛 InvalidCouponException）
- [x] 事务一致性（订单+优惠券原子更新）
- [x] 单测覆盖率 92%
- [x] API 兼容（新增字段可选，不破坏老版本）
```

### 3.3 团队 CR 规范（避免常见坑）

| 坑 | 描述 | 对策 |
|----|------|------|
| **秒批秒合** | reviewer 不看代码直接 LGTM | PR 描述必填"测试方式"，reviewer 必须确认测试通过 |
| **个人审美争论** | "我觉得应该用 var""我觉得应该用 String" | checklist 明确"命名风格不在 review 范围"，让 Lint 管 |
| **大 PR 无人看** | 1000 行 PR reviewer 望而生畏 | 强制 PR < 400 行，超过工具拦截 |
| **must-fix 不清** | 所有评论看起来都"必须改" | 评论必须标 🔴 must-fix / 🟢 nit / ❓ question |
| **review 拖延** | reviewer 不及时看，阻塞开发 | SLA：24 小时首次响应，超期升级 |
| **攻击式评论** | "这写得什么垃圾" | 评论规范：对事不对人 + 给方案，违规 warning |

## 四、底层本质：为什么 Code Review 是质量文化的核心

**Code Review 的本质是"集体视角 + 标准传递"**。一个人写代码有盲点——自己看不到的 bug（逻辑漏洞）、安全漏洞（SQL 注入）、性能坑（N+1 查询）。多人 review 提供视角互补（A 看业务逻辑、B 看安全、C 看性能）。但 review 要有效，必须有客观标准（checklist/Lint/测试），否则变成 reviewer 个人审美的争论（"我觉得应该用 var"——这是偏好不是问题）。

**为什么自动化优先**：人脑适合判断"业务逻辑是否正确""设计权衡是否合理"——这些机器做不了。但人脑不适合判断"格式对不对""命名规范不规范""单测覆盖率够不够"——这些机械检查让人疲劳且易错。自动化挡掉 80% 机械问题，人脑聚焦 20% 高价值判断。这是分工优化。

**为什么评论方式决定团队文化**：攻击式评论（"这写得烂"）会让开发者害怕提交代码——为了避免被骂，要么不提交（拖延），要么写"不出错但平庸"的代码（不敢创新）。建设性评论（"这里有超卖风险，方案是 X"）让开发者学到东西，下次自己也能发现这类问题。CR 是知识传递的渠道——好评论是教学，坏评论是打击。

**为什么 PR 大小影响 review 质量**：研究表明 review 缺陷发现率随 PR 行数递减——< 100 行发现 85%，> 1000 行发现 20%。原因是人脑注意力有限，大 PR 让 reviewer 疲劳，后期代码"扫一眼就过"。所以拆小 PR 不是"方便 review"，是"提高 review 有效性"。架构师要推动"小 PR 文化"——按层/按功能/按阶段拆分。

## 五、AI 架构师加问：5 个

1. **AI Code Review 工具（Copilot/Cursor）能替代人工 review 吗？**
   AI 能挡掉部分机械问题（命名/格式/常见 bug 模式），但不能替代人工——业务逻辑对不对、设计权衡合不合理、边界场景全不全，AI 判断不准。AI 是辅助（减少机械 review 负担），人是决策者。完全依赖 AI review = 质量失控。

2. **AI 怎么辅助 reviewer？**
   AI 在 PR 提交时自动生成"潜在问题清单"——识别常见 bug 模式（空指针/资源泄漏/SQL 注入）、安全问题、性能坑。reviewer 看 AI 清单 + 自己 review，效率高。但 AI 输出要标记置信度（高置信自动评论，低置信给人参考）。

3. **AI 能自动修复 review 评论的问题吗？**
   能修简单的（命名重构、加 final、补 null 检查）。复杂的（业务逻辑、设计重构）AI 给建议但人确认。GitHub Copilot Workspace 正在做这个。但要小心 AI 修复引入新 bug——修复后必须跑测试。

4. **LLM 改写代码后，Code Review 标准要变吗？**
   要加一条："AI 生成代码必须标注"。reviewer 要额外检查 AI 代码的常见问题——幻觉 API（不存在的库/方法）、看似正确但逻辑错（变量名对但语义错）、安全漏洞（AI 训练数据含漏洞代码）。AI 代码不是"免 review"，反而要更严。

5. **怎么防止 AI Code Review 引入"自动化走过场"？**
   AI review 容易变成"AI 说 OK 就 OK"的新秒批。对策：(1) AI 只做辅助建议不做决策；(2) 核心 PR（核心链路/安全相关）必须人工 review；(3) 定期抽样审计 AI review 准确率（与人工对比）；(4) AI review 评论也要人确认（不能自动 approve）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三层防线、checklist、评论三要素、must-fix/nice-to-have、小 PR"** 五个词。

- **三层防线**：自动化（CI 挡 80%）+ PR checklist（团队共识）+ 人工 review（深度判断）
- **checklist**：业务正确性/安全/性能/设计/测试，按 checklist 不按个人偏好
- **评论三要素**：对事不对人 + 指出问题 + 给方案
- **must-fix/nice-to-have**：阻塞 vs 建议，分清优先级
- **小 PR**：< 400 行（review 缺陷率 > 60%），> 1000 行基本无效

### 拟人化理解

把 Code Review 想成 **编辑改稿**。好编辑不是标红所有"我觉得不好的地方"（那是个人偏好），而是对照"出版标准"（事实准确/逻辑清晰/语言规范）改，且给作者解释为什么改（教学）。reviewer 是代码的编辑——用客观标准（checklist）把关，用建设性评论（指出问题+给方案）传递标准，不是用个人审美挑刺。

### 面试现场 60 秒回答

> 带团队做 CR 我用三层防线。第一层自动化——CI 跑 Checkstyle/SpotBugs/单测覆盖率门禁/ArchUnit 架构边界，挡掉 80% 机械问题（格式/命名/覆盖率）。第二层 PR checklist——团队共识的检查清单（业务正确性/安全/性能/设计/测试），reviewer 按 checklist 而非个人偏好。第三层人工 review——聚焦深度判断（业务逻辑/设计权衡/边界场景）。评论规范三要素：对事不对人、指出问题、给方案（不只说"这有问题"，还写怎么改）。评论区分 🔴 must-fix（阻塞合并：bug/安全/性能）和 🟢 nit（建议：命名/重构，不阻塞）。PR 大小 < 400 行（研究显示超 400 行 review 缺陷率骤降），超过拆分。SLA：24 小时内首次响应，单 PR review < 1 小时（疲劳后质量下降）。

### 反问面试官

> 贵司 CR 是必须流程还是建议？有自动化门禁（Lint/单测/ArchUnit）吗？review SLA 是什么？这决定我推 CR 规范的方式——没自动化先建自动化，有自动化但没 checklist 就推 checklist。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么必须 Code Review，开发者自测不行吗？ | 单人编码有盲点（自己看不到的 bug），多人 review 视角互补。研究显示 review 能发现 60%+ 缺陷。自测 = 没有 review（盲点还在）。CR 是集体质量保障，不是不信任开发者 |
| 证据追问 | 你说 CR 提升质量，证据？ | (1) review 后缺陷率（线上 bug 数下降）；(2) review 评论质量（must-fix 比例，发现真实问题）；(3) 团队知识共享（新人通过看 review 评论学习）。三者综合评估 |
| 边界追问 | CR 能保证代码不出 bug 吗？ | 不能。CR 降低缺陷率不消除缺陷（人 review 也会漏）。所以 CR + 自动化测试 + 灰度发布 + 监控告警，多道防线。CR 是其中一环，不是全部 |
| 反例追问 | 什么改动不需要 CR？ | 文档修改、注释补充、紧急 hotfix（事后补 review）。这些改动风险低，CR 反而拖延。但核心代码、API 变更、安全相关必须 CR |
| 风险追问 | CR 最大的风险？ | (1) 流于形式（秒批秒合）；(2) 个人审美争论（"应该用 var"）；(3) 攻击式评论（打击开发者）；(4) 大 PR 无效 review。对策：自动化门禁、checklist、评论规范、PR 大小限制 |
| 验证追问 | 怎么证明 CR 机制有效？ | (1) review 评论质量（must-fix 发现率，不只是 LGTM）；(2) 线上 bug 率（CR 后下降）；(3) PR 合并到上线周期（不因 CR 拖延）；(4) 团队满意度（CR 是学习不是负担）|
| 沉淀追问 | 团队 CR 规范沉淀什么？ | PR checklist 模板、PR 描述模板、评论规范、自动化 CI 配置、PR 大小限制、review SLA、新人 CR 培训手册、优秀 review 评论案例库 |

### 现场对话示例

**面试官**：reviewer 和作者在技术方案上分歧很大，怎么办？

**候选人**：不在 PR 评论里辩论——评论区适合具体问题讨论，不适合大方案分歧。三个步骤：(1) 转 1v1 沟通（线下/语音），避免文字辩论的情绪化；(2) 用数据/POC 说服——"你说用 A 方案，我做了一个 POC，A 方案在 X 场景下性能差 3 倍，数据在这"；(3) 仍达不成共识升级到技术负责人决策，但要记录分歧（"考虑过 A 方案，因 X 否决"）。核心是"对事不对人，用数据说话"，不用职级压、不在评论区吵架。如果团队经常出现这种分歧，说明前期设计评审缺失——大方案应该在 RFC/ADR 阶段对齐，不是在 PR 阶段吵。

**面试官**：新人 review 老人代码不敢评论，怎么办？

**候选人**：这是团队文化问题。三个机制改善：(1) 匿名 review 阶段——新人可以先匿名提评论（避免"被老人说不懂"），机制上鼓励发言；(2) 老人示范"接受新人评论"——我在团队里主动让新人 review 我的代码，且当众采纳新人的合理建议，让新人看到"评论被重视"；(3) review 评论规范——评论只看技术对错，不看资历。技术负责人定期抽查，发现"老人无视新人评论"要纠正。长期看，新人敢评论是团队心理安全的标志，需要时间培养。

**面试官**：CR 评论太多，作者改不完怎么办？

**候选人**：区分优先级。评论必须标 🔴 must-fix（阻塞）vs 🟢 nit（建议）vs ❓ question（讨论）。must-fix 必改，nit 可改可不改（作者决定，reviewer 不强求），question 讨论清楚就行。这个规则要求 reviewer 自律——不要把所有评论都标 must-fix（那是绑架作者）。如果 PR 有 20 个 must-fix，说明 PR 质量太差（作者没自测就提交），退回让作者先自检再 review。正常 PR 的 must-fix 应该 < 5 个，nit 可以多但不阻塞。

## 常见考点

1. **PR checklist 应该包括什么？**——业务正确性（边界/并发/异常/事务/幂等）、安全性（SQL 注入/XSS/敏感数据/权限）、性能（N+1/大对象/锁粒度/缓存）、设计（单一职责/依赖方向/复杂度）、测试（覆盖率/边界/可读性）。是团队共识，不是 reviewer 个人偏好。
2. **must-fix 和 nice-to-have 怎么分？**——must-fix 阻塞合并（bug/安全漏洞/性能问题/破坏兼容/无测试），nice-to-have 不阻塞（命名优化/重构/注释/风格，标记 nit）。所有评论必须标类型，避免"所有评论看起来都必改"绑架作者。
3. **review 评论怎么写？**——三要素：对事不对人（说"这段代码"不说"你"）、指出问题（具体说明哪里有问题）、给方案（提供改进示例，不只说"这有问题"）。建设性评论是教学，攻击式评论打击开发者。
4. **为什么 PR 要小？**——研究显示 review 缺陷发现率随 PR 行数递减：< 100 行发现 85%，> 1000 行发现 20%（基本无效）。人脑注意力有限，大 PR 让 reviewer 疲劳。规则：单 PR < 400 行，超过按层/功能/阶段拆分。
5. **自动化能挡什么？**——格式（Checkstyle/Spotless）、静态检查（SpotBugs/SonarQube 找空指针/资源泄漏）、单测覆盖率门禁、架构边界（ArchUnit）、API 兼容性（openapi-diff）。这些机械检查让 CI 做，人工 review 聚焦业务逻辑/设计权衡/边界场景。

## 结构化回答

**30 秒电梯演讲：** 架构师带团队做 Code Review 不是挑错，而是传递标准 + 知识共享 + 风险把关。高质量 CR 的核心是：(1) 有一份团队共识的 PR checklist（不是 reviewer 个人偏好）；(2) 区分 must-fix（阻塞合并）和 nice-to-have（建议）；(3) review 评论要对事不对人+给方案（不是这写得烂，而是这里用 Stream 更清晰，示例：xxx）；(4) 自动化检查（Lint/单测/ArchUnit）能挡的不占用人脑

**展开框架：**
1. **PR checklist** — 团队共识的检查清单，不是 reviewer 个人偏好
2. **must** — fix vs nice-to-have：阻塞合并 vs 建议改进，分清优先级
3. **评论三要素** — 对事不对人 + 指出问题 + 给方案

**收尾：** 以上是我的整体思路。您想继续深入聊——PR 多大合适？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Java 架构师如何带团队做 Code Revi | "这题一句话：架构师带团队做 Code Review 不是挑错，而是传递标准 + 知识共享 + 风险把关。" | 开场钩子 |
| 0:15 | 像编辑改稿——好编辑不是标红所有我觉得不好的地类比图 | "打个比方：像编辑改稿——好编辑不是标红所有我觉得不好的地。" | 核心类比 |
| 0:40 | PR checklist示意/对比图 | "团队共识的检查清单，不是 reviewer 个人偏好" | PR checklist要点 |
| 1:05 | must示意/对比图 | "fix vs nice-to-have：阻塞合并 vs 建议改进，分清优先级" | must要点 |
| 1:55 | 总结卡 | "记住：PR checklist。下期见。" | 收尾 |
