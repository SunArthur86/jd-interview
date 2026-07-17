---
id: java-architect-012
difficulty: L3
category: java-architect
subcategory: Spring Boot
tags:
- 事务
- AOP
- 一致性
feynman:
  essence: Spring 事务的本质是"AOP 代理 + ThreadLocal 绑定 Connection"——通过动态代理在方法前后加 begin/commit/rollback，用 ThreadLocal 让同一事务的多条 SQL 共用一个 Connection。失效场景都源于"绕过了代理"或"异常被吞"。
  analogy: 像快递公司的"保价通道"：@Transactional 是给包裹贴保价标签，AOP 代理是快递员（必须经过它才能享受保价），ThreadLocal 是每个快递员自己的保价单（线程隔离）。你跳过快递员自己送（this 调用）、保价单写错类型（异常被吞）、或换快递员送（多线程），保价就失效。
  first_principle: 为什么要用 AOP 而不是手动 begin/commit？因为事务边界要声明式（注解）而非编程式（手动），让业务代码干净。AOP 代理拦截方法调用实现自动开关事务，ThreadLocal 保证同一事务的 SQL 走同一 Connection（否则 commit 不了）。
  key_points:
  - 7 种传播行为：REQUIRED/REQUIRES_NEW/NESTED/SUPPORTS/NOT_SUPPORTED/NEVER/MANDATORY
  - 4 种隔离级别：DEFAULT/READ_UNCOMMITTED/READ_COMMITTED/REPEATABLE_READ/SERIALIZABLE
  - 失效场景：self-invocation（this 调用）、非 public、异常被吞、异常类型不匹配、多线程、未托管 Bean
  - AOP 代理：JDK 动态代理（接口）或 CGLIB（类），代理对象替代原 Bean
  - ThreadLocal 绑定 Connection：TransactionSynchronizationManager 管理事务资源
first_principle:
  problem: 如何让事务边界声明式（注解）而非编程式（手动 begin/commit），同时保证跨方法的多条 SQL 走同一事务？
  axioms:
  - 事务边界要清晰（方法级）、业务代码要干净（无事务样板）
  - 同一事务的 SQL 必须共用 Connection，否则 commit/rollback 不一致
  - 多线程下 Connection 不能跨线程（数据库连接非线程安全）
  rebuild: 用 AOP 代理拦截 @Transactional 方法，方法前 begin + 绑定 Connection 到 ThreadLocal，方法后根据异常 commit/rollback。同一事务的后续方法调用从 ThreadLocal 取同一 Connection。传播行为决定"是加入现有事务还是新开"，解决方法调用链的事务边界组合问题。
follow_up:
  - 同类内部调用为什么事务失效？——this 调用绕过代理对象，AOP 拦截不生效。解法：注入自己（@Autowired self）、AopContext.currentProxy()、或拆到不同类
  - REQUIRES_NEW 和 NESTED 区别？——REQUIRES_NEW 挂起当前事务开新连接（独立提交/回滚）；NESTED 在当前事务内开 savepoint（部分回滚但外层失败内层也失败）
  - 多线程为什么事务失效？——ThreadLocal 线程隔离，子线程拿不到主线程的 Connection，新开连接不在事务内。解法：子线程内手动加 @Transactional 或编程式事务
  - rollbackFor 默认只回滚 RuntimeException，为什么？——Spring 默认假设检查异常是业务可恢复的（不该回滚），RuntimeException 是不可恢复的。要回滚所有异常加 rollbackFor = Exception.class
  - 长事务为什么有害？——事务持有 Connection 和锁，长事务导致连接池耗尽、锁竞争、死锁概率上升。要拆事务、异步化非核心操作
memory_points:
  - 事务 = AOP 代理拦截 + ThreadLocal 绑定 Connection
  - 7 传播：REQUIRED（默认加入）/REQUIRES_NEW（独立新事务）/NESTED（savepoint）
  - 5 失效：this 调用、非 public、异常吞、异常类型不匹配、多线程
  - rollbackFor 默认只回滚 RuntimeException，要回滚检查异常显式配置
  - AOP 代理生成在 BeanPostProcessor 后置（见 011 题）
---

# 【Java 后端架构师】Spring 事务传播、隔离级别与失效场景

> 适用场景：JD 核心技术。资金扣减 + 订单创建必须原子，库存超卖就是事故。但 @Transactional 用错就静默失效——账户扣了钱订单没生成，或异常了不回滚。架构师必须能从 AOP 代理 + ThreadLocal 推导每个失效场景，而不是背清单。

## 一、概念层：Spring 事务的 AOP 代理机制

**@Transactional 工作原理**（必画）：

```
调用方 ──► orderService.create()  （orderService 是代理对象）
              │
              ▼
     TransactionInterceptor.invoke()
              │
              ▼
     1. 获取事务管理器 PlatformTransactionManager
     2. 根据 propagation 决定：开新事务 / 加入现有 / 挂起当前
     3. 创建事务：connection.setAutoCommit(false)
     4. 绑定 Connection 到 ThreadLocal（TransactionSynchronizationManager）
              │
              ▼
     5. 调用真实方法 target.create()
              │
              ▼
     6. 方法内所有 SQL 从 ThreadLocal 拿同一 Connection
              │
         ┌────┴────┐
         ▼         ▼
      正常返回   抛异常
         │         │
         ▼         ▼
      commit    rollback（按 rollbackFor 判断）
```

**核心机制**：
- **AOP 代理**：Spring 在 BeanPostProcessor 后置阶段生成代理对象（JDK 动态代理或 CGLIB），代理对象拦截方法调用，在前后加事务逻辑。
- **ThreadLocal 绑定**：`TransactionSynchronizationManager` 把 Connection 绑定到当前线程，同一事务的后续方法从 ThreadLocal 取同一 Connection。

**代理对象 vs 原始对象**（失效场景的根因）：

```java
@Service
public class OrderService {
    @Transactional
    public void create() {
        // 这里 this 是原始对象，不是代理对象！
        this.audit();   // this 调用绕过代理 → audit 的 @Transactional 不生效
    }

    @Transactional(propagation = REQUIRES_NEW)
    public void audit() { ... }   // 本应开新事务，但被 this 调用绕过
}
```

## 二、机制层：7 种传播行为

| 传播行为 | 当前有事务 | 当前无事务 | 典型场景 |
|---------|-----------|-----------|---------|
| **REQUIRED**（默认） | 加入当前 | 新开 | 90% 场景，保证原子 |
| **REQUIRES_NEW** | 挂起当前，新开独立事务 | 新开 | 日志记录（主流程失败也要记日志） |
| **NESTED** | 在当前事务内开 savepoint | 新开 | 部分回滚（子失败不影响父） |
| **SUPPORTS** | 加入当前 | 无事务运行 | 查询方法（有事务就事务读，没有就普通读） |
| **NOT_SUPPORTED** | 挂起当前，无事务运行 | 无事务运行 | 耗时操作不占事务连接 |
| **NEVER** | 抛异常 | 无事务运行 | 明确不能在事务内运行 |
| **MANDATORY** | 加入当前 | 抛异常 | 必须被事务调用（强制约束） |

**REQUIRED vs REQUIRES_NEW vs NESTED**（最常考）：

```java
@Service
public class OrderService {
    @Autowired private LogService logService;

    @Transactional  // REQUIRED（默认）
    public void create() {
        orderDao.insert();       // 主操作
        logService.log("created");   // 日志
        throw new RuntimeException();  // 主操作失败
    }
}

// 场景 1：logService.log 用 REQUIRED
//   log 和 insert 同一事务，create 异常 → 全部回滚（日志也没了）

// 场景 2：logService.log 用 REQUIRES_NEW
//   log 开独立新事务，create 异常只回滚 insert，log 保留 ✓（日志独立记录）

// 场景 3：logService.log 用 NESTED
//   log 用 savepoint，create 异常 → log 也回滚（savepoint 在主事务内）
//   但如果 log 自己异常，只回滚到 savepoint，insert 不受影响
```

**REQUIRES_NEW 的代价**：挂起当前事务 + 新开 Connection（要 2 个数据库连接），高并发下连接池容易耗尽。

## 三、机制层：隔离级别与数据库对应

| 隔离级别 | 脏读 | 不可重复读 | 幻读 | MySQL 默认 |
|---------|------|-----------|------|-----------|
| READ_UNCOMMITTED | 可能 | 可能 | 可能 | |
| READ_COMMITTED | 避免 | 可能 | 可能 | Oracle/PG 默认 |
| REPEATABLE_READ | 避免 | 避免 | 可能（MySQL 用 MVCC 避免） | MySQL 默认 |
| SERIALIZABLE | 避免 | 避免 | 避免 | 性能差 |

**@Transactional 配置**：

```java
@Transactional(
    propagation = Propagation.REQUIRED,           // 传播
    isolation = Isolation.DEFAULT,                 // 隔离（用数据库默认）
    timeout = 30,                                   // 超时（秒）
    readOnly = false,                               // 只读事务（优化）
    rollbackFor = Exception.class,                  // 回滚异常类型（默认 RuntimeException）
    noRollbackFor = BusinessException.class         // 不回滚的异常
)
public void create() { ... }
```

## 四、实战层：5 大失效场景

**失效场景 1：self-invocation（this 调用）**——最常见

```java
@Service
public class OrderService {
    public void batch() {
        for (int i = 0; i < 10; i++) {
            this.create();   // this 调用绕过代理！create 的 @Transactional 失效
        }
    }
    @Transactional
    public void create() { ... }
}
// 解法 1：注入自己
@Autowired private OrderService self;   // 注入代理对象
self.create();   // 走代理
// 解法 2：AopContext.currentProxy()
((OrderService) AopContext.currentProxy()).create();   // 需要 exposeProxy = true
// 解法 3：拆到不同类（推荐，符合单一职责）
```

**失效场景 2：方法非 public**

```java
@Transactional
void create() { ... }   // 包级私有，CGLIB/JDK 代理默认只拦截 public 方法
// Spring 源码 AbstractFallbackTransactionAttributeSource.computeTransactionAttribute 显式判断 public
// 解法：改 public，或用 AspectJ 编译时织入（不推荐，复杂）
```

**失效场景 3：异常被吞**

```java
@Transactional
public void create() {
    try {
        orderDao.insert();
        riskyCall();   // 抛异常
    } catch (Exception e) {
        log.error("失败", e);   // 吞了异常，Spring 检测不到 → commit！
    }
}
// 解法：catch 后手动 TransactionAspectSupport.currentTransactionStatus().setRollbackOnly()
// 或重新抛出让 Spring 回滚
```

**失效场景 4：异常类型不匹配**

```java
@Transactional   // 默认只回滚 RuntimeException 和 Error
public void create() throws IOException {
    orderDao.insert();
    throw new IOException("文件错误");   // 检查异常，不回滚！insert 提交了
}
// 解法：@Transactional(rollbackFor = Exception.class)
```

**失效场景 5：多线程**

```java
@Transactional
public void create() {
    orderDao.insert();
    new Thread(() -> {
        auditDao.insert();   // 子线程，ThreadLocal 隔离，拿不到主线程 Connection
    }).start();
    // 子线程的 auditDao.insert 不在事务内，独立连接独立提交
}
// 解法：子线程内手动加 @Transactional，或用编程式事务 TransactionTemplate
```

## 五、实战层：长事务治理与监控

**长事务的危害**：
- 占用 Connection，连接池耗尽。
- 持有锁时间长，锁竞争和死锁概率上升。
- 主从延迟（大事务 binlog 同步慢）。

**长事务监控**：

```java
// 1. @Transactional 设 timeout
@Transactional(timeout = 5)   // 超过 5 秒抛 TransactionTimedOutException

// 2. AOP 拦截所有 @Transactional 方法记录耗时
@Around("@annotation(transactional)")
public Object track(ProceedingJoinPoint pjp, Transactional transactional) {
    long start = System.currentTimeMillis();
    try { return pjp.proceed(); }
    finally {
        long cost = System.currentTimeMillis() - start;
        if (cost > 500) metrics.timer("tx.slow").record(cost, MILLISECONDS);
    }
}

// 3. 数据库层查长事务（MySQL）
SELECT * FROM information_schema.innodb_trx
WHERE TIME_TO_SEC(TIMEDIFF(NOW(), trx_started)) > 5;   -- 超过 5 秒的事务
```

**长事务优化**：
- 把事务外的操作（RPC 调用、文件 IO）移出 @Transactional 方法。
- 非核心操作（日志、通知）用 REQUIRES_NEW 或异步。
- 批量操作分批提交，避免大事务。
- 只读查询用 @Transactional(readOnly = true) 优化。

## 六、底层本质：为什么用 AOP + ThreadLocal

回到第一性：**事务的两个根本需求——声明式边界 + 同事务共用 Connection**。

声明式边界：用注解标记事务范围，AOP 代理拦截方法调用自动开关事务。业务代码无事务样板（不用手动 begin/commit/rollback），Spring 通过 BeanPostProcessor 后置生成代理实现（见 011 题）。

同事务共用 Connection：数据库事务是 Connection 级别的，同一事务的多条 SQL 必须走同一 Connection 才能 commit/rollback 一致。Spring 用 ThreadLocal 把 Connection 绑定到线程，方法调用链上每个 DAO 从 ThreadLocal 取同一 Connection。

**失效场景的本质**：所有失效都源于绕过了这两个机制——this 调用绕过代理、多线程 ThreadLocal 隔离、异常被吞导致代理检测不到异常。理解了原理，失效场景就不是背清单而是自然推导。

**传播行为的本质**：方法调用链可能涉及多个 @Transactional 方法（A 调 B），传播行为回答"B 是加入 A 的事务还是新开"。这是"事务边界组合"的规则集，让多个方法的事务行为可预测。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 推理结果落库怎么用事务？**
   推理（秒级）不能放事务内（长事务占连接）；用推理服务返回结果后，单独事务方法落库。AI 批量推理结果用 batch insert + 单事务。

2. **让 AI 排查事务失效，AI 接管哪段？**
   AI 静态分析代码找失效模式：this 调用 @Transactional 方法、@Transactional 在非 public 方法、catch 吞异常未手动回滚、未配 rollbackFor 检查异常。输出风险点 + 修复建议，人工 review。

3. **AI Agent 多步骤操作怎么保证一致性？**
   短链路（单库）用 @Transactional REQUIRED；跨服务用 Saga 模式（每步补偿）；AI 决策的可逆操作用幂等 + 补偿事务。不要用分布式事务（XA）做 AI 链路（性能差）。

4. **AI 模型配置和业务数据怎么事务一致？**
   配置变更（配置中心）和业务数据（DB）是两个系统，无法用数据库事务。用"配置变更事件 + 业务订阅 + 幂等处理"实现最终一致；或配置表放 DB 内用同事务。

5. **怎么防 AI 生成的事务代码有坑？**
   静态分析（SonarQube/SpotBugs 规则）检测事务失效模式；Code Review checklist（this 调用、异常处理、rollbackFor）；集成测试覆盖异常回滚场景；线上长事务监控。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"AOP 代理 + ThreadLocal、7 传播、5 失效、rollbackFor、长事务监控"**。

- **AOP 代理**：BeanPostProcessor 后置生成代理拦截方法
- **ThreadLocal**：同事务共用 Connection（TransactionSynchronizationManager）
- **7 传播**：REQUIRED 默认 / REQUIRES_NEW 独立 / NESTED savepoint
- **5 失效**：this 调用、非 public、异常吞、异常类型不匹配、多线程
- **rollbackFor**：默认只回滚 RuntimeException，检查异常要显式配
- **长事务**：监控 innodb_trx，超时设 timeout，非核心操作移出事务

### 拟人化理解

把事务想成**快递保价通道**。@Transactional 是给包裹贴保价标签，AOP 代理是快递员（必须经过它才享保价），ThreadLocal 是每个快递员自己的保价单（线程隔离）。你跳过快递员自己送（this 调用）、保价单写错类型（异常被吞）、换快递员送（多线程）、保价单格式不对（非 public）——保价就失效。传播行为是"包裹转给另一快递员时，继续用原保价单（REQUIRED）还是开新单（REQUIRES_NEW）"。

### 面试现场 60 秒回答

> Spring 事务核心是 AOP 代理 + ThreadLocal 绑定 Connection。@Transactional 方法被代理拦截，方法前 begin 并把 Connection 绑定 ThreadLocal，方法后按异常 commit/rollback。7 种传播行为最常用 REQUIRED（默认加入）、REQUIRES_NEW（独立新事务）、NESTED（savepoint 部分回滚）。5 大失效场景：this 调用绕过代理、方法非 public、异常被 catch 吞掉、异常类型不匹配（默认只回滚 RuntimeException）、多线程 ThreadLocal 隔离。解法分别是注入自己、改 public、手动 setRollbackOnly 或重新抛、配 rollbackFor = Exception.class、子线程内独立事务。长事务要监控（MySQL innodb_trx）+ 设 timeout + 非核心操作移出事务。

### 反问面试官

> 贵司是单库业务（用 @Transactional 足够）还是跨服务链路（要 Saga/TCC）？资金类业务我重点查事务失效场景，跨服务我用本地消息表 + 最终一致。

## 九、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不手动 begin/commit，要用 @Transactional？ | 声明式让业务代码干净（无样板）、传播行为解决方法链组合、Spring 统一管理事务资源（Connection 复用）、AOP 可加超时/只读等优化 |
| 证据追问 | 你怎么知道事务失效了？ | 数据库层查 commit/rollback 日志；代码层断点看是否进 TransactionInterceptor；AopContext.currentProxy() 确认是否代理对象；线上对账差错率上升 |
| 边界追问 | @Transactional 能保证分布式一致吗？ | 不能。@Transactional 是单库事务，跨库/跨服务要分布式事务（XA 性能差、Saga 最终一致、TCC 业务侵入）。生产优先用本地消息表 + 幂等的最终一致 |
| 反例追问 | 什么时候不该用 @Transactional？ | 查询方法（不需要事务，用 @Transactional(readOnly=true) 优化即可）、纯 RPC 调用（没数据库操作）、长耗时操作（占连接）；批量操作考虑分批提交 |
| 风险追问 | 事务用错最大风险？ | 主动点出：静默失效（钱扣了订单没生成）、长事务耗尽连接池、REQUIRES_NEW 双连接高并发耗连接、rollbackFor 配错不回滚、传播用错导致部分提交不一致 |
| 验证追问 | 怎么证明事务配置正确？ | 单测覆盖正常 + 异常两条路径（异常后断言数据库未变更）；集成测试验证传播行为；线上监控 commit/rollback 次数比 + 长事务告警 + 对账差错率 |
| 沉淀追问 | 团队事务规范，沉淀什么？ | Code Review 检查 this 调用/异常处理/rollbackFor、@Transactional timeout 必设、REQUIRES_NEW 慎用（双连接）、长事务监控大盘、跨服务一致性用本地消息表 SOP |

### 现场对话示例

**面试官**：同类内部调用事务为什么失效？

**候选人**：因为 AOP 代理只拦截外部调用。@Transactional 方法被 Spring 生成代理对象，调用方通过代理对象调用才会进 TransactionInterceptor 开启事务。但类内部用 this.xxx() 调用时，this 是原始对象不是代理对象，直接调目标方法，绕过了拦截器，@Transactional 不生效。解法三个：注入自己（@Autowired OrderService self，调用 self.create()）、AopContext.currentProxy() 拿代理对象（需开启 exposeProxy）、拆到不同类（推荐，符合单一职责）。

**面试官**：REQUIRES_NEW 和 NESTED 区别？

**候选人**：REQUIRES_NEW 是挂起当前事务，新开一个独立事务（需要新的 Connection）。两个事务完全独立——外层失败不影响内层（内层已提交），内层失败也不影响外层（外层可 catch 继续）。典型场景是日志记录：主流程失败也要留下日志。NESTED 是在当前事务内开 savepoint，不挂起外层，用同一 Connection。子事务失败可以回滚到 savepoint，但外层失败会连带子事务一起回滚（savepoint 在外层事务内）。NESTED 适合"部分失败可重试"的场景。REQUIRES_NEW 的代价是要两个数据库连接，高并发容易耗尽连接池。

**面试官**：rollbackFor 为什么默认只回滚 RuntimeException？

**候选人**：Spring 的设计假设是——检查异常（Checked Exception）是业务可预期的、可恢复的（如 IOException 应该让上层处理而不是直接回滚），RuntimeException 是不可恢复的程序错误（如 NPE）应该回滚。这符合 Java 异常的设计哲学。但实际业务中很多检查异常也想回滚（如自定义 BusinessException extends Exception），所以要显式配 rollbackFor = Exception.class。这是面试常踩的坑——抛了检查异常没回滚导致脏数据。

## 常见考点

1. **@Transactional 自调用怎么修复？**——注入自己（@Autowired OrderService self，self.method()）、AopContext.currentProxy()（需 @EnableAspectJAutoProxy(exposeProxy = true)）、或拆到不同类。推荐拆类（符合单一职责，避免自注入的循环依赖问题）。
2. **事务隔离级别怎么选？**——默认用数据库隔离级别（MySQL RR、Oracle RC）。资金类高一致用 SERIALIZABLE（性能差，慎用）；高并发读多用 RC + 乐观锁；一般业务用默认 RR 足够。
3. **@Transactional(readOnly = true) 有什么用？**——提示数据库做读优化（如不记 undo log）、Hibernate FlushMode 设 MANUAL、语义清晰（代码可读性）。不强制只读，但能优化。
4. **跨服务事务怎么保证一致？**——@Transactional 管不了跨服务。方案：本地消息表（业务库写消息表，消息服务异步投递，消费方幂等）、Saga（长链路补偿）、TCC（Try-Confirm-Cancel 业务侵入）。生产优先本地消息表 + 幂等。


## 结构化回答

**30 秒电梯演讲：** 聊到Spring 事务传播、隔离级别与失效场景，我的理解是——Spring 事务的本质是"AOP 代理 + ThreadLocal 绑定 Connection"——通过动态代理在方法前后加 begin/commit/rollback，用 ThreadLocal 让同一事务的多条 SQL 共用一个 Connection。失效场景都源于"绕过了代理"或"异常被吞"。打个比方，像快递公司的"保价通道"：@Transactional 是给包裹贴保价标签，AOP 代理是快递员（必须经过它才能享受保价），ThreadLocal 是每个快递员自己的保价单（线程隔离）。你跳过快递员自己送（this 调用）、保价单写错类型（异常被吞）、或换快递员送（多线程），保价就失效。

**展开框架：**
1. **7 种传播行为** — REQUIRED/REQUIRES_NEW/NESTED/SUPPORTS/NOT_SUPPORTED/NEVER/MANDATORY
2. **4 种隔离级别** — DEFAULT/READ_UNCOMMITTED/READ_COMMITTED/REPEATABLE_READ/SERIALIZABLE
3. **失效场景** — self-invocation（this 调用）、非 public、异常被吞、异常类型不匹配、多线程、未托管 Bean

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：同类内部调用为什么事务失效？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "Spring 事务传播、隔离级别与失效场景——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 事务隔离级别对比表 | 先说核心：Spring 事务的本质是"AOP 代理 + ThreadLocal 绑定 Connection"——通过动态代理在方法前后加 begin/commit/rollback，用 。 | 核心定义 |
| 0:40 | Spring Bean 生命周期图 | DEFAULT/READ_UNCOMMITTED/READ_COMMITTED/REPEATABLE_READ/SERIALIZABLE。 | 4 种隔离级别 |
| 1:05 | AOP 动态代理原理图 | self-invocation（this 调用）、非 public、异常被吞、异常类型不匹配、多线程、未托管 Bean。 | 失效场景 |
| 2:30 | 总结卡 | 一句话记忆：事务 = AOP 代理拦截 + ThreadLocal 绑定 Connection。 下期可以接着聊：同类内部调用为什么事务失效。 | 收尾总结 |
