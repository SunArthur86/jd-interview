---
id: java-architect-104
difficulty: L2
category: java-architect
subcategory: Java 并发
tags:
- Java 架构师
- Scoped Values
- ThreadLocal
- 上下文传递
feynman:
  essence: ScopedValue（JEP 506，JDK 24 GA）是 ThreadLocal 在虚拟线程时代的替代品——不可变、自动清理、bounded lifetime。ThreadLocal 的"可变 + 永不清理 + 继承混乱"在百万虚拟线程下变成内存炸弹和上下文错乱，ScopedValue 用"作用域绑定 + 单次写入"重新设计上下文传递。
  analogy: ThreadLocal 是"每个工位的抽屉"——员工（线程）随手塞东西进去，离职（线程结束）时抽屉才清空，复用工位（线程池）时上一个员工的垃圾还在。ScopedValue 是"任务工牌"——开工时发，下班时收，不可改，发给谁就只有谁能看。
  first_principle: ThreadLocal 设计于平台线程时代（线程数少、生命周期长），虚拟线程时代变成百万线程 × ThreadLocal = 内存爆炸。ScopedValue 把"上下文"从"线程属性"改成"作用域属性"，让上下文随调用栈进出而自动生灭。
  key_points:
  - ScopedValue（JDK 24 GA）：不可变、bounded to scope、自动清理
  - ThreadLocal 的坑：百万虚拟线程下内存爆炸、继承在 carrier 切换时错乱、永不清理泄漏
  - ScopedValue.where(K, V).run(...) 设置 + ScopedValue.get() 读取
  - 与 StructuredTaskScope 天生搭配：子任务自动继承父的 ScopedValue
  - 不能完全替代 ThreadLocal：可变状态（如事务连接）还要用 ThreadLocal
first_principle:
  problem: 百万虚拟线程时代，怎么传递请求上下文（用户 ID、traceId、租户），既不让内存爆炸又不让上下文错乱？
  axioms:
  - ThreadLocal 是"每个线程一份"，百万 VT × 多个 TL = 内存 N 倍
  - InheritableThreadLocal 在虚拟线程 carrier 切换时透传不可靠（VT 不绑定 carrier）
  - 上下文应该是"调用栈属性"，不是"线程属性"
  rebuild: 引入 ScopedValue，把上下文绑定到调用栈的词法作用域（ScopedValue.where(K, V).run(...) 块）。run 块内可读不可改，run 结束自动清理。配合 StructuredTaskScope，子任务 fork 时自动继承父作用域的所有 ScopedValue（无需 InheritableThreadLocal 的复杂机制）。可变状态（如事务、Buffer）仍用 ThreadLocal，但要 try-finally remove。
follow_up:
  - ScopedValue 真的能替代所有 ThreadLocal 吗？——不能。可变状态（数据库连接、事务、Buffer）要 ThreadLocal。ScopedValue 是"不可变、bounded"的，适合请求上下文（userId、traceId、tenantId）
  - ScopedValue 跨虚拟线程怎么传递？——scope.fork 的子任务自动继承父的 ScopedValue（这是 StructuredTaskScope 的核心机制）。跨普通线程池要用 TransmittableThreadLocal（TTL）
  - ScopedValue 内存开销多大？——固定开销 + 按调用栈深度（不按线程数）。100 万 VT 共享同一作用域，ScopedValue 只存一份
  - ScopedValue 和 MDC（日志 traceId）怎么结合？——MDC 内部用 ThreadLocal，要改造成 ScopedValue 或者用 SLF4J 2.x 的 MDCAdapter 桥接
  - 什么时候还该用 ThreadLocal？——可变状态（事务、Buffer、连接）、第三方库强制 ThreadLocal（如 Spring 的 RequestContextHolder）、不涉及海量虚拟线程的纯计算场景
memory_points:
  - ScopedValue（JEP 506，JDK 24 GA）：不可变、bounded、自动清理
  - ThreadLocal 在百万 VT 下：内存爆炸、继承错乱、永不清理泄漏
  - ScopedValue.where(K, V).run(...) 设置 + ScopedValue.get() 读
  - 与 StructuredTaskScope 天生搭配：子任务自动继承
  - 不能完全替代 ThreadLocal：可变状态还要 ThreadLocal
  - MDC 兼容：用 SLF4J 2.x MDCAdapter 或手动桥接
---

# 【Java 后端架构师】Scoped Values 与 ThreadLocal 的取舍

> 适用场景：JD 核心技术。订单网关迁移到虚拟线程后，单实例 50 万 VT × 8 个 ThreadLocal（userId/traceId/tenantId/locale/...）= 内存涨到 4G，且偶发"用户 A 看到用户 B 的订单"（InheritableThreadLocal 在 carrier 切换时透传错乱）。ScopedValue 是 JDK 24 的根治方案。

## 一、概念层：ThreadLocal 在虚拟线程时代的三大坑

**ThreadLocal 设计前提**（平台线程时代）：

```
平台线程数 = 几百到几千
每个线程生命周期 = 几分钟到几小时
ThreadLocal 数量 × 线程数 = 内存可控（万级）
```

**虚拟线程时代被打破**：

```
虚拟线程数 = 百万级
每个 VT 生命周期 = 几毫秒（一次请求）
ThreadLocal 数量 × VT 数 = 内存爆炸（百万 × N）
```

**三大坑详解**（这张表面试必问）：

| 坑 | 表现 | 后果 |
|----|------|------|
| **内存爆炸** | 每个 VT 都有一份 ThreadLocal，100 万 VT × 8 TL × 1KB = 8GB | OOMKilled |
| **继承错乱** | InheritableThreadLocal 在 carrier 切换时透传父 carrier 的值 | 用户 A 看到用户 B 的数据 |
| **永不清理泄漏** | 线程池复用 + ThreadLocal 没 remove → 上一请求残留 | 数据错乱、内存泄漏 |

**InheritableThreadLocal 在虚拟线程下的灾难**：

```java
// 反例：carrier 持有的 InheritableThreadLocal 会被错误透传
private static InheritableThreadLocal<UserContext> CTX = new InheritableThreadLocal<>();

// 线程 A（carrier-1）设置 CTX = userA
CTX.set(new UserContext("userA"));

// 创建虚拟线程 VT-X，VT-X mount 到 carrier-1，继承 userA（正确）
// VT-X unmount，VT-Y mount 到 carrier-1，VT-Y 也"继承"了 userA（错误！）
// 实际 VT-Y 应该是另一个用户的请求，但拿到了 userA 的上下文
```

## 二、机制层：ScopedValue 的核心 API

**ScopedValue 基本用法**：

```java
// 1. 定义 ScopedValue（全局常量）
private static final ScopedValue<UserContext> USER_CTX = ScopedValue.newInstance();
private static final ScopedValue<String> TRACE_ID = ScopedValue.newInstance();

// 2. 设置 + 使用（where + run）
public Order handleRequest(Request req) {
    String traceId = generateTraceId();
    UserContext userCtx = authenticate(req);

    return ScopedValue.where(USER_CTX, userCtx)
                      .where(TRACE_ID, traceId)
                      .run(() -> {
                          // run 块内：可读不可改
                          business();
                          return createOrder();
                      });
    // run 结束：USER_CTX 和 TRACE_ID 自动清理（无需 remove）
}

// 3. 在子调用里读取
public void business() {
    UserContext ctx = USER_CTX.get();     // 读
    String tid = TRACE_ID.get();          // 读
    // USER_CTX.set(...) 编译错误：不可变
    log.info("traceId={} userId={}", tid, ctx.getUserId());
}
```

**与 StructuredTaskScope 配合（自动继承）**：

```java
public Order createOrder(OrderDTO dto) throws Exception {
    return ScopedValue.where(USER_CTX, ctx).call(() -> {
        try (var scope = new StructuredTaskScope.ShutdownOnFailure()) {
            // 子任务自动继承 USER_CTX（无需 InheritableThreadLocal）
            var stockTask  = scope.fork(() -> {
                // 这里 USER_CTX.get() 拿到的是父作用域的值
                UserContext c = USER_CTX.get();
                return stockService.deduct(dto, c.getUserId());
            });
            var orderTask  = scope.fork(() -> orderRepo.create(dto));
            scope.join();
            scope.throwIfFailed();
            return Order.combine(stockTask.get(), orderTask.get());
        }
    });
}
```

**对比 ThreadLocal 的 4 个优势**：

| 维度 | ThreadLocal | ScopedValue |
|------|-------------|-------------|
| 可变性 | 可任意 set/remove | 一次 where 写入，不可改 |
| 生命周期 | 跟线程（需手动 remove） | 跟 run 块（自动清理） |
| 继承 | InheritableThreadLocal（carrier 错乱） | StructuredTaskScope.fork 自动继承（正确） |
| 内存开销 | 线程数 × TL 数（百万 VT 爆炸） | 作用域数 × TL 数（一请求一份） |

## 三、实战层：从 ThreadLocal 迁移到 ScopedValue

**典型场景 1：请求上下文（userId / traceId / tenantId）**

```java
// 重构前：ThreadLocal
public class RequestContext {
    private static final ThreadLocal<UserContext> CTX = new ThreadLocal<>();

    public static void set(UserContext ctx) { CTX.set(ctx); }
    public static UserContext get() { return CTX.get(); }
    public static void clear() { CTX.remove(); }   // 必须显式调
}

// 使用（容易忘 clear）
public Order handle(Request req) {
    try {
        RequestContext.set(authenticate(req));
        return createOrder();
    } finally {
        RequestContext.clear();   // 忘了就泄漏
    }
}

// 重构后：ScopedValue
public class RequestContext {
    public static final ScopedValue<UserContext> CTX = ScopedValue.newInstance();
}

// 使用（自动清理）
public Order handle(Request req) {
    return ScopedValue.where(RequestContext.CTX, authenticate(req))
                      .run(() -> createOrder());
}
```

**典型场景 2：MDC / 日志 traceId**

```java
// 反例：MDC 内部用 ThreadLocal
// logback-spring.xml 配置 %X{traceId}，MDC.put("traceId", tid) 内部是 ThreadLocal

// 重构：用 SLF4J 2.x 的 MDCAdapter 桥接 ScopedValue（如果可用）
// 或手动注入（最简单）
public class ScopedMdcFilter implements Filter {
    @Override
    public void doFilter(ServletRequest req, ServletResponse res, FilterChain chain)
            throws IOException, ServletException {
        String traceId = ((HttpServletRequest) req).getHeader("traceparent");
        ScopedValue.where(TRACE_ID, traceId).run(() -> {
            // 同时写 MDC（兼容老日志）
            MDC.put("traceId", traceId);
            try {
                chain.doFilter(req, res);
            } finally {
                MDC.remove("traceId");
            }
        });
    }
}
```

**典型场景 3：必须用 ThreadLocal 的场景（事务/Buffer）**

```java
// 数据库连接（可变状态）→ 仍用 ThreadLocal，但要 try-finally remove
public class TransactionManager {
    private static final ThreadLocal<Connection> CONN = new ThreadLocal<>();

    public Connection getConn() {
        Connection c = CONN.get();
        if (c == null) {
            c = dataSource.getConnection();
            CONN.set(c);
        }
        return c;
    }

    public void cleanup() {
        Connection c = CONN.get();
        if (c != null) {
            try { c.close(); } catch (Exception ignored) {}
            CONN.remove();   // 必须 remove，否则线程池复用时泄漏
        }
    }
}
```

**迁移决策矩阵**：

| 场景 | 选择 | 原因 |
|------|------|------|
| 请求上下文（userId/traceId/tenant） | ScopedValue | 不可变、bounded、百万 VT 友好 |
| 配置（locale/timezone） | ScopedValue | 请求级别不变 |
| 安全主体（Principal） | ScopedValue | 请求级别不变 |
| 数据库连接 / 事务 | ThreadLocal | 可变状态、需要 commit/rollback |
| Buffer / 缓存对象 | ThreadLocal | 可变状态、需要复用 |
| 第三方库强制 ThreadLocal（Spring RequestContextHolder） | ThreadLocal | 兼容性 |

## 四、底层本质：为什么 ScopedValue 不泄漏

回到第一性：**为什么 ScopedValue 在百万虚拟线程下不爆炸，ThreadLocal 会爆炸？**

- **ThreadLocal 的存储结构**：每个 Thread 对象有一个 `ThreadLocalMap`，存所有 ThreadLocal 的值。虚拟线程也是 Thread，每个 VT 都有自己的 ThreadLocalMap。100 万 VT × 8 个 TL × 平均 100 字节 = 800MB+（还没算 Map 的 Entry 开销）。
- **ScopedValue 的存储结构**：ScopedValue 的值存在调用栈的 `ScopedValueBindings`（continuation 的一部分），不存 Thread 对象。同一个 ScopedValue 在同一个作用域只有一份值，跟 VT 数量无关。100 万 VT 同时跑同一作用域的代码，ScopedValue 只存一份（作用域是栈帧属性）。
- **清理机制**：ThreadLocal 的 remove 必须显式调用（容易忘），虚拟线程用完即弃时 GC 回收 Thread 对象才清 ThreadLocalMap（但堆压力大）。ScopedValue 的清理绑在 run/call 块退出时（编译期保证），无遗忘风险。

**InheritableThreadLocal 为什么在虚拟线程下错乱**：

```
平台线程时代：
  父线程 set → 子线程创建时复制（InheritableThreadLocal 的 childValue）
  父子关系清晰（Thread.start 时一次性复制）

虚拟线程时代：
  父 VT set → VT.fork 子 VT（实际是 mount 到 carrier）
  carrier 持有的 InheritableThreadLocal 会被 fork 的子 VT"继承"
  但 carrier 是共享的，多个 VT 复用同一 carrier
  VT-A 的上下文通过 carrier 的 InheritableThreadLocal 被 VT-B 看到 = 错乱
```

ScopedValue 不依赖 carrier，作用域是栈帧属性，子任务通过 StructuredTaskScope 的语义继承父作用域（编译期绑定），不存在 carrier 共享导致的错乱。

## 五、AI 架构师加问：5 个

1. **AI 推理服务的上下文（userId / modelVersion / tokenCount）用 ScopedValue 还是 ThreadLocal？**
   不可变的（userId、modelVersion、prompt 长度）用 ScopedValue（百万并发请求友好）；可变的（tokenCount 累加、streaming buffer）用 ThreadLocal + try-finally remove。如果是 JDK 24+ 用 ScopedValue + 长整型 Atomic 配合（外部可变状态用原子变量，不用 ThreadLocal）。

2. **AI Agent 的 tool_call 怎么用 ScopedValue 传递会话上下文？**
   一个 Agent 会话起一个虚拟线程，ScopedValue 注入 SessionContext（含 userId、对话历史 ID、权限范围）。scope.fork 的每个 tool_call 子任务自动继承 SessionContext，无需手动透传。tool_call 内部读 ScopedValue.get() 拿到 userId 去查数据库，权限边界清晰。

3. **怎么用 AI 自动检测 ThreadLocal 在虚拟线程下的内存风险？**
   静态分析：扫描 ThreadLocal 声明 + 使用频率 + 是否 remove。结合运行时数据：JFR 看 ThreadLocalMap 的内存占用、heap dump 找 ThreadLocal 实例数。AI 输出"高风险 ThreadLocal 列表 + 是否可改 ScopedValue 建议"。可改的标准：是否可变、是否请求级别、是否被继承。

4. **AI Copilot 帮业务从 ThreadLocal 迁移到 ScopedValue，最容易翻车在哪？**
   三个点：① 可变状态误判（数据库连接 / 事务 / Buffer 不能改 ScopedValue）；② 第三方库强制 ThreadLocal（Spring RequestContextHolder、HikariCP 连接池）要保留兼容层；③ MDC 桥接（日志框架内部用 ThreadLocal，要么用 SLF4J 2.x MDCAdapter 要么手动注入）。AI 要能识别"这段 ThreadLocal 是可变状态"并保留。

5. **大模型推理中 RAG 的检索上下文（query、embedding、retrievedDocs）怎么传？**
   检索阶段：query 用 ScopedValue（不可变），embedding 结果用 ScopedValue.where 注入下一阶段；retrievedDocs 是 List 不可变集合，也可以用 ScopedValue。生成阶段：LLM streaming 的 token buffer 是可变状态用 ThreadLocal 或外部 Flux/Mono。整个 RAG 流程通过 StructuredTaskScope 编排，每个阶段 fork 子任务自动继承上一阶段的 ScopedValue。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"不可变、bounded、自动清理、和 STS 搭配"**。

- **不可变**：一次 where 写入，不能 set
- **bounded**：生命周期跟 run 块（不是跟线程）
- **自动清理**：run 结束自动清理（无需 remove）
- **STS 搭配**：StructuredTaskScope.fork 子任务自动继承
- **ThreadLocal 仍要**：可变状态（连接、事务、Buffer）
- **版本**：JDK 24（JEP 506）GA，JDK 21/22/23 预览

### 拟人化理解

把 ScopedValue 想成**任务工牌**。ThreadLocal 是"工位的抽屉"——员工（线程）随手塞东西进去，离职时才清空，复用工位时上一个员工的垃圾还在。ScopedValue 是"任务工牌"——开工时发，下班时收，不可改，发给谁就只有谁能看。100 万虚拟线程同时上班，工牌系统只管"当前在工位的工牌"（栈帧属性），不管历史员工数。InheritableThreadLocal 在 carrier 切换时像"工牌被下个员工顺手带走"（错乱），ScopedValue 不存在这个问题。

### 面试现场 60 秒回答

> ThreadLocal 在虚拟线程时代有三大坑：百万 VT 下内存爆炸、InheritableThreadLocal 在 carrier 切换时透传错乱、永不清理泄漏。ScopedValue（JDK 24 JEP 506 GA）是替代——不可变、生命周期绑定到 where.run 块、自动清理、和 StructuredTaskScope 天生搭配（fork 子任务自动继承）。用法：ScopedValue.newInstance() 定义、ScopedValue.where(K, V).run(...) 设置、K.get() 读取。适合请求上下文（userId/traceId/tenantId）。但 ScopedValue 不能完全替代 ThreadLocal——可变状态（数据库连接、事务、Buffer）还要 ThreadLocal + try-finally remove。落地优先级：先改 InheritableThreadLocal（事故源）、再改高频 ThreadLocal（内存源）、可变状态保留。

### 反问面试官

> 贵司 JDK 版本是 21 还是 24+？InheritableThreadLocal 用得多吗（很多老框架如 Spring 5.x 内部依赖）？虚拟线程数量级多大？这决定我聊 ScopedValue 替代方案还是先用 TransmittableThreadLocal 兜底（JDK 21 过渡）。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接给 ThreadLocal 加 remove 规范，要换 ScopedValue？ | 内存爆炸和继承错乱 remove 解决不了。100 万 VT × ThreadLocal 还是百万份；InheritableThreadLocal 在 carrier 切换时不是"忘了 remove"而是机制本身错乱。ScopedValue 从设计上根除（作用域而非线程属性） |
| 证据追问 | 怎么证明 ThreadLocal 在虚拟线程下真的有问题？ | heap dump 看 ThreadLocal 实例数（百万 VT 应百万级 ThreadLocalMap entry）、JFR 看 InheritableThreadLocal 的内存占用、业务侧偶发"用户 A 看到 B 的订单"（carrier 错乱证据）。ScopedValue 迁移后内存降 80%、错乱消失 |
| 边界追问 | ScopedValue 能完全替代 ThreadLocal 吗？ | 不能。可变状态（连接、事务、Buffer）要 ThreadLocal；第三方库强制 ThreadLocal（Spring RequestContextHolder）要兼容。ScopedValue 只适合"不可变、bounded"的请求上下文 |
| 反例追问 | 什么场景不该用 ScopedValue？ | 可变状态（连接池、事务、计数器）、第三方库强制 ThreadLocal、纯 CPU 计算无虚拟线程（Platform 线程 + ThreadLocal 没问题）、JDK 21 预览期生产不敢用 |
| 风险追问 | 迁移到 ScopedValue 最大风险？ | ① JDK 版本（21 是预览需 --enable-preview）；② 第三方库强依赖 ThreadLocal（Spring 5.x 的 RequestContextHolder）要兼容层；③ MDC / 日志框架内部用 ThreadLocal，桥接麻烦。治法：先评估 JDK 24 GA、做兼容层、灰度切流 |
| 验证追问 | 怎么证明迁移后没引入新问题？ | 单元测试覆盖：ScopedValue 设置/读取/作用域边界；压测：百万 VT 下内存稳定（不增长）；线上灰度：10% 流量跑 3 天看 P99、错误率、内存 |
| 沉淀追问 | 团队推广 ScopedValue 沉淀什么？ | ThreadLocal 使用规范（什么场景该用哪个）、迁移 checklist（先改 InheritableThreadLocal）、ScopedValue + STS 的代码模板、第三方库兼容清单（Spring/Hibernate/HikariCP） |

### 现场对话示例

**面试官**：ThreadLocal 用了这么多年了，为什么 JDK 24 又搞个 ScopedValue？

**候选人**：因为虚拟线程。平台线程时代 ThreadLocal 没问题——线程数几千，每个线程一份 ThreadLocal，内存可控。但虚拟线程时代百万 VT，每个 VT 都有自己的 ThreadLocalMap，100 万 VT × 8 个 ThreadLocal = 800MB+ 内存，光存上下文就 OOM。更严重的是 InheritableThreadLocal——carrier 是共享的，VT-A mount 到 carrier-1，VT-B 也 mount 到 carrier-1，VT-A 的 InheritableThreadLocal 通过 carrier 错乱传给 VT-B，业务侧就是"用户 A 看到用户 B 的订单"。ScopedValue 从设计上根除：上下文存调用栈（continuation）而非 Thread 对象，跟 VT 数量无关；子任务通过 StructuredTaskScope 语义继承，不依赖 carrier。

**面试官**：ScopedValue 那不就是 final 变量吗？为什么不直接传参？

**候选人**：传参有几个问题。第一，调用栈深时要透传每一层（service → dao → helper → util），代码侵入大。第二，第三方库（如 Spring Security）内部读上下文，没法改它的方法签名。第三，跨 scope.fork 的子任务要手动透传。ScopedValue 的价值是"隐式上下文 + 编译期清理 + STS 自动继承"——像 ThreadLocal 一样方便（任何层都能读），但没有 ThreadLocal 的内存和错乱问题。

**面试官**：那 MDC / 日志 traceId 怎么办？logback 内部用 ThreadLocal。

**候选人**：三种方案。第一，用 SLF4J 2.x 的 MDCAdapter 桥接 ScopedValue（如果版本支持）。第二，手动桥接——filter 里同时 set MDC 和 ScopedValue，退出时清 MDC（MDC 还是 ThreadLocal 但作用域小）。第三，等日志框架原生支持 ScopedValue（logback 后续版本）。短期用方案 2，长期等生态跟进。生产建议：ScopedValue 是源，MDC 是兼容层，业务代码读 ScopedValue，日志输出层桥接。

## 常见考点

1. **ScopedValue 是什么？**——JDK 24（JEP 506）GA 的不可变、bounded 上下文传递机制。ScopedValue.where(K, V).run(...) 设置 + K.get() 读取，自动清理。
2. **ThreadLocal 在虚拟线程下有什么坑？**——三大坑：百万 VT 内存爆炸、InheritableThreadLocal 在 carrier 切换时透传错乱、永不清理泄漏。
3. **ScopedValue 能完全替代 ThreadLocal 吗？**——不能。可变状态（数据库连接、事务、Buffer）仍要 ThreadLocal + try-finally remove。ScopedValue 只适合不可变的请求上下文。
4. **ScopedValue 和 StructuredTaskScope 怎么配合？**——scope.fork 的子任务自动继承父作用域的 ScopedValue（无需 InheritableThreadLocal 的复杂机制）。
5. **怎么迁移 ThreadLocal 到 ScopedValue？**——按场景：不可变请求上下文（userId/traceId）改 ScopedValue；可变状态（连接/事务/Buffer）保留 ThreadLocal；MDC 用桥接兼容。先改 InheritableThreadLocal（事故源）。

## 结构化回答

**30 秒电梯演讲：** ScopedValue（JEP 506，JDK 24 GA）是 ThreadLocal 在虚拟线程时代的替代品——不可变、自动清理、bounded lifetime。ThreadLocal 的可变 + 永不清理 + 继承混乱在百万虚拟线程下变成内存炸弹和上下文错乱，ScopedValue 用作用域绑定 + 单次写入重新设计上下文传递

**展开框架：**
1. **ScopedValue（JDK 24 GA）** — 不可变、bounded to scope、自动清理
2. **ThreadLocal 的坑** — 百万虚拟线程下内存爆炸、继承在 carrier 切换时错乱、永不清理泄漏
3. **与 Structured** — 与 StructuredTaskScope 天生搭配：子任务自动继承父的 ScopedValue

**收尾：** 以上是我的整体思路。您想继续深入聊——ScopedValue 真的能替代所有 ThreadLocal 吗？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Scoped Values 与 ThreadLo | "这题核心是——ScopedValue（JEP 506，JDK 24 GA）是 ThreadLocal 在虚拟线程时……" | 开场钩子 |
| 0:15 | ScopedValue（JDK 示意/对比图 | "不可变、bounded to scope、自动清理" | ScopedValue（JDK 要点 |
| 0:40 | ThreadLocal 的坑示意/对比图 | "百万虚拟线程下内存爆炸、继承在 carrier 切换时错乱、永不清理泄漏" | ThreadLocal 的坑要点 |
| 1:25 | 总结卡 | "记住：ScopedValue。下期见。" | 收尾 |
