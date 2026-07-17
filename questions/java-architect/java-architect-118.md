---
id: java-architect-118
difficulty: L2
category: java-architect
subcategory: 可观测性
tags:
- Java 架构师
- 线程泄漏
- 连接泄漏
- 资源排查
feynman:
  essence: "线程泄漏与连接泄漏是 Java 服务\"慢性死亡\"的两大元凶。线程泄漏：创建后不复用、不回收，线程数无限增长（最终 OOM: unable to create new native thread）。连接泄漏：借用后不归还，连接池耗尽（最终所有请求阻塞等待连接）。排查思路：① 告警（线程数/连接数超阈值）→ ② dump（jstack/连接池日志）→ ③ 定位泄漏点（栈追溯代码）→ ④ 修复（try-with-resources / 连接池配置）。"
  analogy: 像"图书馆借书不还"——线程/连接是图书，连接池是图书馆。借了书（borrow）不还（close），最终图书馆空了，新读者借不到书（请求阻塞）。排查就是查借书记录（dump），找谁借了不还。
  first_principle: 资源泄漏的本质是"借用-归还"契约被破坏。线程池/连接池本质是有界队列，borrow 减少空闲资源，return 归还。如果 borrow 后异常路径没 return，资源永久占用。排查靠"快照 + 栈追溯"——dump 当前状态，看哪个栈持有资源，定位代码。
  key_points:
  - "线程泄漏：线程数无限增长 → OOM: unable to create new native thread"
  - 连接泄漏：连接不归还 → 连接池耗尽 → 请求阻塞
  - 排查三步：告警 → dump（jstack/连接池日志）→ 栈追溯代码
  - jstack 看线程状态（RUNNABLE/BLOCKED/WAITING）
  - HikariCP 泄漏检测（leakDetectionThreshold）
  - 修复：try-with-resources / 连接池配置 / 线程池隔离
first_principle:
  problem: 服务运行几天后变慢或挂，重启就好，根因怎么找？
  axioms:
  - 资源（线程/连接）是有限的，泄漏会导致耗尽
  - 泄漏是"慢性病"——累积到阈值才暴露
  - dump 当前状态可定位泄漏栈
  rebuild: 线程泄漏表现为线程数无限增长（ Executors.newCachedThreadPool 无界 / new Thread 不复用 / ThreadLocal 配合线程池不清理）。连接泄漏表现为连接池 active 持续上涨（borrow 后异常没 close / 长事务不释放 / Statement 没 close）。排查：① 告警——线程数 > 500 / 连接池 active = max。② dump——jstack 看线程栈 / HikariCP 开 leakDetectionThreshold 看连接持有栈。③ 定位——栈追溯到代码行。④ 修复——try-with-resources 保证 close / 连接池配置 maxLifetime / 线程池有界 + 命名清晰。
follow_up:
  - 线程泄漏和内存泄漏区别？——线程泄漏是线程数增长（每个线程占 1MB 栈），内存泄漏是堆内对象不回收。两者都会 OOM，但原因不同
  - 为什么 newCachedThreadPool 危险？——它的线程数无上限（Integer.MAX_VALUE），高 QPS 时创建大量线程，每个线程 1MB 栈，最终 OOM
  - HikariCP 泄漏检测怎么用？——设 leakDetectionThreshold（如 60000ms），连接被借出超过 60 秒不归还，日志打印持有栈，定位泄漏代码
  - ThreadLocal 会泄漏吗？——会。ThreadLocal 的 value 被 Entry 弱引用持有，但 Entry 的 key 是弱引用（ThreadLocal 对象）。如果 ThreadLocal 对象被回收，key 变 null，value 永远访问不到 → 泄漏。线程池线程复用，泄漏累积
  - 生产怎么防？——① 线程池有界（newFixedThreadPool / 自定义 ThreadPoolExecutor）；② 连接池配置（maxLifetime / leakDetectionThreshold）；③ try-with-resources；④ 告警（线程数 / 连接池 active）
memory_points:
  - "线程泄漏：线程数无限增长 → OOM: unable to create new native thread"
  - 连接泄漏：连接不归还 → 连接池耗尽 → 请求阻塞
  - 排查三步：告警 → dump（jstack/HikariCP 日志）→ 栈追溯
  - newCachedThreadPool 危险：线程数无上限
  - HikariCP leakDetectionThreshold：连接泄漏检测（打印持有栈）
  - 修复：try-with-resources + 连接池配置 + 线程池有界
  - ThreadLocal 泄漏：线程池复用 + value 不可达
---

# 【Java 后端架构师】线上线程泄漏与连接泄漏如何排查

> 适用场景：JD 核心技术。订单服务运行 3 天后变慢，jstack 发现线程数从 200 涨到 5000，HikariCP 连接池 active = max（50），所有新请求阻塞。架构师必须排查泄漏点并修复。

## 一、概念层：泄漏的类型与症状

**资源泄漏是什么**：

```
线程泄漏                          连接泄漏
─────────                          ─────────
线程池（有界）                     连接池（HikariCP，max=50）
   │  new Thread()                    │  borrow()
   │  Executors.newCachedThreadPool   │  （忘了 close）
   ▼                                  ▼
线程数无限增长                     active 持续 = max
   │                                  │
   ▼                                  ▼
OOM: unable to create              新请求阻塞
new native thread                  wait for connection
（每线程 1MB 栈）                   （连接等待超时）
```

**泄漏类型对比**（这张表面试必问）：

| 类型 | 症状 | 根因 | 排查工具 |
|------|------|------|---------|
| **线程泄漏** | 线程数持续增长 | new Thread / 无界线程池 / ThreadLocal 不清理 | jstack / Arthas thread |
| **连接泄漏** | 连接池 active = max | JDBC/HTTP 连接不 close | HikariCP leakDetection / Arthas |
| **内存泄漏** | 堆内存持续增长 | 静态集合持有对象 / 缓存不淘汰 | jmap / MAT |
| **文件句柄泄漏** | lsof 句柄数增长 | FileInputStream 不 close | lsof / /proc/pid/fd |
| **ThreadLocal 泄漏** | 堆内存缓慢增长 | 线程池复用 + ThreadLocal 不 remove | heap dump + MAT |

**关键指标**（告警阈值）：

```yaml
# 线程数告警
jvm.threads.live: > 500（告警）/ > 1000（严重）
jvm.threads.states_threads{state="blocked"}: > 50（并发问题）

# 连接池告警
hikaricp_connections_active: = hikaricp_connections_max（耗尽）
hikaricp_connections_pending: > 0（请求排队）

# 文件句柄告警
process.open_fds: > 1000（接近 ulimit）
```

## 二、机制层：排查工具与命令

**1. 线程泄漏排查（jstack）**：

```bash
# 查看线程数（实时）
jstack <pid> | grep "java.lang.Thread.State" | wc -l

# 查看线程状态分布
jstack <pid> | grep "java.lang.Thread.State" | sort | uniq -c | sort -rn
# 输出：
# 4500 java.lang.Thread.State: WAITING (parking)    ← 大量等待（线程池队列）
# 300 java.lang.Thread.State: RUNNABLE
# 100 java.lang.Thread.State: BLOCKED

# 查看线程名（定位谁创建的）
jstack <pid> | grep "^\"" | awk '{print $1}' | sort | uniq -c | sort -rn | head -20
# 输出：
# 4000 "pool-42-thread-1" to "pool-42-thread-4000"  ← 泄漏！线程名递增
# 200 "http-nio-8080-exec-1" to "http-nio-8080-exec-200"
# 50 "HikariPool-1-connection-adder-1"

# 找泄漏线程的创建栈
jstack <pid> | grep -A 30 "pool-42-thread-4000"
# 看线程的栈，定位是哪里 new Thread() 或 Executors 用的
```

**Arthas 交互式排查**：

```bash
# 启动 Arthas
java -jar arthas-boot.jar <pid>

# 查看线程数和状态
thread -n 10
# 显示 CPU 占用最高的 10 个线程

# 查看 BLOCKED 线程（锁等待）
thread --state BLOCKED
# 显示所有阻塞线程和等待的锁

# 查看线程创建栈（需开启）
thread -b
# 查看阻塞其他线程的"罪魁祸首"线程

# 查看线程池
ognl '@java.util.concurrent.Executors@getThreadPoolExecutor()'
```

**2. 连接泄漏排查（HikariCP）**：

```yaml
# application.yml（开启泄漏检测）
spring:
  datasource:
    hikari:
      leak-detection-threshold: 60000   # 连接借出 60 秒不归还，打印持有栈
      maximum-pool-size: 50
      connection-timeout: 30000         # 借连接超时 30 秒
      max-lifetime: 1800000             # 连接最长生命周期 30 分钟（防 DB 端断开）
```

**HikariCP 泄漏日志**：

```
# 连接泄漏检测日志（连接借出 60 秒未归还）
2026-07-13 10:00:00 WARN  com.zaxxer.hikari.pool.ProxyLeakTask
  - Apparent connection leak detected. Connection {
    lockedAt=2026-07-13 09:58:30,
    heldFor=90000ms,
    stackTrace=
      com.jd.order.repository.OrderDao.findById(OrderDao.java:45)        ← 泄漏点！
      com.jd.order.service.OrderService.getOrder(OrderService.java:30)
      com.jd.order.controller.OrderController.get(OrderController.java:20)
      ...
}
```

**3. JDBC 连接泄漏（经典代码）**：

```java
// 泄漏代码（异常路径没 close）
public Order getOrder(String orderId) {
    Connection conn = dataSource.getConnection();   // borrow
    PreparedStatement ps = conn.prepareStatement(
        "SELECT * FROM orders WHERE id = ?");
    ps.setString(1, orderId);
    ResultSet rs = ps.executeQuery();
    if (rs.next()) {
        return map(rs);
    }
    return null;
    // 异常或正常返回都没 close！连接泄漏
}

// 正确：try-with-resources（自动 close）
public Order getOrder(String orderId) throws SQLException {
    String sql = "SELECT * FROM orders WHERE id = ?";
    try (Connection conn = dataSource.getConnection();      // 自动归还
         PreparedStatement ps = conn.prepareStatement(sql)) {
        ps.setString(1, orderId);
        try (ResultSet rs = ps.executeQuery()) {
            if (rs.next()) {
                return map(rs);
            }
        }
    }  // 自动 close（即使异常也执行）
    return null;
}

// 正确：Spring 事务管理（@Transactional）
@Transactional
public Order getOrder(String orderId) {
    // Spring 自动管理 Connection（方法结束归还）
    return orderDao.findById(orderId);
}
```

**4. HTTP 连接泄漏**：

```java
// 泄漏代码（HttpClient 响应不 close）
HttpResponse resp = httpClient.execute(request);
String body = EntityUtils.toString(resp.getEntity());
return body;
// 没关闭响应！连接不归还连接池

// 正确：try-with-resources
try (CloseableHttpResponse resp = httpClient.execute(request)) {
    return EntityUtils.toString(resp.getEntity());
}
```

## 三、实战层：真实排查案例

**案例 1：线程泄漏（newCachedThreadPool）**

```
症状：服务运行 3 天，线程数从 200 涨到 5000

排查：
1. jstack 看 5000 个线程的名称：
   "pool-42-thread-1" 到 "pool-42-thread-5000"
   → Executors.newCachedThreadPool() 创建（线程名递增）

2. 找到代码：
   ExecutorService executor = Executors.newCachedThreadPool();
   // 每次请求 new 一个任务，线程数无上限

3. 根因：newCachedThreadPool 的线程数 Integer.MAX_VALUE，
   高 QPS 时不断创建新线程，每个线程 1MB 栈，最终 OOM

4. 修复：
   ExecutorService executor = new ThreadPoolExecutor(
       50, 200, 60L, TimeUnit.SECONDS,
       new LinkedBlockingQueue<>(1000),
       new ThreadFactoryBuilder().setNameFormat("order-pool-%d").build(),
       new ThreadPoolExecutor.CallerRunsPolicy()  // 拒绝策略
   );
   // 有界 + 命名 + 拒绝策略

5. 验证：线程数稳定 200，服务稳定
```

**案例 2：连接泄漏（JDBC 忘 close）**

```
症状：服务高峰期所有请求超时，HikariCP active = 50（耗尽）

排查：
1. HikariCP 指标：hikaricp_connections_active = 50 = max
2. 开 leakDetectionThreshold=60000，等泄漏日志：
   "Apparent connection leak detected"
   栈：OrderDao.findById(OrderDao.java:45)
3. 看代码：
   Connection conn = dataSource.getConnection();
   // ... 没有 try-finally close
4. 根因：某异常路径 Connection 没 close，累积耗尽连接池

5. 修复：改 try-with-resources + 全代码 review 所有 JDBC 操作

6. 验证：连接池 active 稳定 10-30，不再耗尽
```

**案例 3：ThreadLocal 泄漏**

```
症状：服务运行一周，堆内存缓慢增长，Full GC 频繁

排查：
1. jmap dump：heap dump 分析
2. MAT 分析：发现 ThreadLocalMap.Entry 大量实例
   - key = null（ThreadLocal 对象已被回收）
   - value = 大对象（UserContext，含 List/Map）
3. 根因：
   - 用线程池（线程复用）
   - ThreadLocal.set(userContext) 没 remove
   - ThreadLocal 对象被 GC（key 变 null）
   - value 永久驻留（无法访问也无法回收）

4. 修复：
   try {
       userContextThreadLocal.set(userContext);
       // 业务逻辑
   } finally {
       userContextThreadLocal.remove();   // 必须 remove！
   }

5. 验证：堆内存稳定，Full GC 频率正常
```

**案例 4：文件句柄泄漏**

```
症状：服务运行 2 天，报 "Too many open files"

排查：
1. lsof -p <pid> | wc -l   →  65536（接近 ulimit -n 65536）
2. lsof -p <pid> | grep "log" | wc -l   →  60000（日志文件！）
3. 根因：每次请求创建新 FileWriter，没 close

4. 修复：
   - 用 logback/log4j2（连接池管理文件句柄）
   - 业务代码用 try-with-resources

5. 临时缓解：调大 ulimit -n（治标不治本）
```

## 四、底层本质：为什么会泄漏

回到第一性：**为什么 Java 有 GC 还会泄漏？**

- **GC 回收对象，但不回收资源**：线程、连接、文件句柄是"外部资源"，不是 Java 对象。GC 只回收堆内对象，线程/连接/句柄要手动 close。如果对象被回收前没 close，资源泄漏。
- **"借用-归还"契约**：连接池 borrow 出 Connection 对象，对象内部持有真实连接（socket）。borrow 减少空闲池，return 归还。如果 Connection 对象被 GC 但没归还，真实连接泄漏（DB 端连接也没释放）。
- **异常路径是泄漏主因**：正常路径 close，异常路径忘记 close。try-finally 或 try-with-resources 保证异常路径也 close。

**newCachedThreadPool 危险的本质**：
- 线程数 Integer.MAX_VALUE（无上限）。
- 每个 new Thread 占 1MB 栈（默认 -Xss1m）+ 内核资源（task_struct）。
- 高 QPS 时不断创建新线程（任务队列空时新建，满时也新建），累积到 OS 线程上限 → OOM: unable to create new native thread。

**HikariCP leakDetection 的本质**：
- 借出连接时记录时间戳和调用栈。
- 后台定时扫描，借出超过 leakDetectionThreshold（如 60s）的连接，打印持有栈。
- 不是"真的泄漏"——可能是长事务。但帮定位"谁借了 60 秒不还"。

**ThreadLocal 泄漏的本质**：
- ThreadLocalMap.Entry 的 key 是 WeakReference（ThreadLocal 对象）。
- ThreadLocal 对象被回收后，key 变 null，value 仍在。
- 线程池线程复用，ThreadLocalMap 跟着线程活——value 永久驻留。
- 解决：finally 里 remove()，主动清理。

**为什么 try-with-resources 是最佳实践**：
- 编译器生成 try-finally，保证 close。
- 即使异常也执行 close。
- 多资源按声明逆序 close（后开先关）。
- 代码简洁，不易遗漏。

## 五、AI 架构师加问：5 个

1. **AI 推理服务的线程/连接泄漏特点？**
   LLM 推理是长任务（单次几秒），容易触发连接泄漏（请求期间 HTTP 连接持有久）。GPU 推理用独立线程池，避免阻塞 IO 线程。AI Agent 多轮对话用虚拟线程（每个对话一个虚拟线程，轻量），避免平台线程耗尽。

2. **AI 能自动检测泄漏吗？**
   AI 学习资源使用的正常基线（线程数/连接数的合理范围），检测异常：① 线程数单调增长（泄漏特征）；② 连接池 active 持续 = max；③ 文件句柄数异常增长。AI 自动 dump + 栈分析，定位泄漏栈并告警 + 提供修复建议。

3. **大模型推理服务的连接池怎么配置？**
   LLM API 调用用独立 HTTP 连接池（不和 DB 共享），max 配大（LLM 响应慢，连接持有久）。超时配置长（LLM 推理 30 秒+，不能 30 秒超时）。leakDetectionThreshold 配长（如 5 分钟，LLM 长任务正常）。

4. **AI 怎么分析 thread dump 找泄漏？**
   AI 解析 jstack 输出，识别：① 线程名模式（pool-N-thread-M 的递增模式 = 泄漏）；② 线程状态分布（大量 BLOCKED = 锁问题）；③ 栈帧聚类（相同业务方法的线程数 = 该方法的并发度）。AI 输出："发现 pool-42-thread-* 线程 4000 个，创建栈在 OrderService.java:45 的 Executors.newCachedThreadPool"。

5. **AI Agent 的线程池怎么设计？**
   分层线程池：① IO 线程池（HTTP/DB 调用，平台线程，max 200）；② CPU 线程池（数据处理/编码，max = CPU 核数）；③ LLM 调用用虚拟线程（每个 LLM 调用一个虚拟线程，并发数高，每个阻塞不浪费 OS 线程）。隔离避免相互影响。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"两类泄漏、三步排查、四个修复"**。

- **两类泄漏**：线程泄漏（线程数无限增长 → OOM unable to create thread）/ 连接泄漏（连接不归还 → 连接池耗尽 → 请求阻塞）
- **三步排查**：① 告警（线程数 > 500 / 连接 active = max）→ ② dump（jstack 看线程 / HikariCP leakDetection 看连接持有栈）→ ③ 栈追溯代码（找泄漏点）
- **四个修复**：① try-with-resources（自动 close）；② 线程池有界（不用 newCachedThreadPool）；③ 连接池配置（leakDetectionThreshold/maxLifetime）；④ ThreadLocal 用完 remove
- **关键工具**：jstack（线程 dump）/ HikariCP leakDetectionThreshold / Arthas thread / MAT（heap dump）

### 拟人化理解

把资源泄漏想成**图书馆借书不还**。线程/连接是图书，线程池/连接池是图书馆。借了书（borrow）不还（close），最终图书馆空了，新读者借不到书（请求阻塞）。排查就是查借书记录（dump）——看谁借了不还（持有栈定位代码）。线程泄漏是"图书馆开新窗口"（不断创建新线程），最终窗口太多图书馆塞满。连接泄漏是"书被借光"（连接池耗尽），新读者排队等。治法是"借书押金"（try-with-resources 保证归还）+ "借书期限"（maxLifetime 强制归还）。

### 面试现场 60 秒回答

> 线程泄漏和连接泄漏是 Java 服务慢性死亡的两大元凶。线程泄漏：线程数无限增长（newCachedThreadPool 无界 / new Thread 不复用 / ThreadLocal 不 remove），最终 OOM: unable to create new native thread。连接泄漏：borrow 后异常路径没 close，连接池 active 持续 = max，新请求阻塞。排查三步：① 告警（线程数 > 500 / 连接 active = max）；② dump（jstack 看线程名和栈 / HikariCP leakDetectionThreshold=60000 打印连接持有栈）；③ 栈追溯代码定位泄漏点。修复：① try-with-resources（自动 close）；② 线程池有界（自定义 ThreadPoolExecutor + 拒绝策略，不用 newCachedThreadPool）；③ 连接池配置（leakDetectionThreshold/maxLifetime）；④ ThreadLocal 用完 finally remove。经典案例：JDBC 忘 close 连接、newCachedThreadPool 线程爆、ThreadLocal 线程池复用导致 value 泄漏。

### 反问面试官

> 贵司线程池规范是什么？有统一的 ThreadPoolExecutor 封装吗？连接池监控有告警吗？这决定我聊规范建设还是单次排查。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | GC 都有了，为什么还会资源泄漏？ | GC 回收堆内对象，不回收外部资源（线程/连接/句柄）。Connection 对象被 GC 但没 close，真实 socket 泄漏。资源要手动 close（try-with-resources） |
| 证据追问 | 怎么证明是泄漏不是正常负载？ | ① 单调增长（正常负载应该波动，泄漏是只增不减）；② 重启后恢复（泄漏是累积的）；③ dump 显示异常模式（线程名递增 / 连接持有栈集中在某方法） |
| 边界追问 | 所有"线程多"都是泄漏吗？ | 不是。高并发正常有大量线程（虚拟线程百万级）。泄漏特征是"单调增长不回收"+"线程名递增"（pool-N-thread-M 的 M 持续增大）。虚拟线程不算泄漏（轻量） |
| 反例追问 | 什么场景"看起来像泄漏其实不是"？ | ① 长事务（连接持有久但最终归还，HikariCP leakDetectionThreshold 配短会误报）；② 批处理（峰值线程多但任务结束回收）；③ 线程池预热（启动时创建 max 线程，正常） |
| 风险追问 | 排查泄漏最大风险？ | ① jstack 生产影响（STW，高频 dump 有风险）；② 修复改代码可能引入新 bug；③ 临时调大 ulimit / 连接池 max 是治标不治本。治法：低频 dump、灰度发布、根因修复 |
| 验证追问 | 怎么验证泄漏修复了？ | ① 线程数/连接数稳定（不再单调增长）；② 跑 7 天压测不复发；③ HikariCP 不再报 leak；④ 监控指标正常（active < max） |
| 沉淀追问 | 团队规范沉淀什么？ | ① 线程池规范（禁用 newCachedThreadPool / 统一 ThreadPoolExecutor 封装）；② 连接池配置模板（leakDetectionThreshold / maxLifetime）；③ try-with-resources 强制；④ 监控告警（线程数 / 连接池 active）；⑤ Code Review 清单 |

### 现场对话示例

**面试官**：怎么快速判断是线程泄漏还是连接泄漏？

**候选人**：看症状。如果"OOM: unable to create new native thread"或线程数异常高（jstack > 500），是线程泄漏。如果"Connection is not available, request timed out after 30000ms"或 HikariCP active = max，是连接泄漏。jstack 看线程名模式——递增的 pool-N-thread-M 是线程池泄漏；固定的业务线程名 + BLOCKED 状态可能是连接等待（连接耗尽导致业务线程阻塞）。

**面试官**：HikariCP leakDetectionThreshold 怎么用？

**候选人**：配置 leak-detection-threshold: 60000。连接被借出超过 60 秒不归还，HikariCP 后台线程检测到，打印持有栈（借出时的调用栈）。栈直接定位泄漏代码——看是哪个方法 borrow 了不归还。注意：阈值不要太短（长事务会误报），生产建议 60 秒。这是"被动检测"——只在泄漏已发生时报告，不能预防。

**面试官**：ThreadLocal 为什么会泄漏？

**候选人**：ThreadLocalMap 的 Entry 的 key 是 WeakReference（ThreadLocal 对象）。如果 ThreadLocal 对象被 GC（比如方法是局部变量），key 变 null，但 value 仍在 Entry 里。线程池线程复用，ThreadLocalMap 跟线程活着——value 永久驻留，无法访问也无法回收。治法：finally 里 remove()，主动清理 Entry（key 和 value 都清）。特别是线程池场景，必须 remove。

## 常见考点

1. **线程泄漏和连接泄漏区别？**——线程泄漏是线程数无限增长（OOM unable to create thread）；连接泄漏是连接不归还（连接池耗尽，请求阻塞）。
2. **newCachedThreadPool 为什么危险？**——线程数 Integer.MAX_VALUE 无上限，高 QPS 时无限创建，每线程 1MB 栈，最终 OOM。
3. **HikariCP 怎么检测连接泄漏？**——配置 leakDetectionThreshold，连接借出超时未归还，打印持有栈定位泄漏代码。
4. **ThreadLocal 泄漏原理？**——ThreadLocalMap.Entry 的 key 是弱引用，ThreadLocal 对象回收后 key=null，value 永久驻留（线程池复用累积）。
5. **怎么预防泄漏？**——try-with-resources（自动 close）+ 线程池有界（不用 newCachedThreadPool）+ ThreadLocal remove + 监控告警。

## 结构化回答

**30 秒电梯演讲：** 线程泄漏与连接泄漏是 Java 服务\慢性死亡\的两大元凶。线程泄漏：创建后不复用、不回收，线程数无限增长（最终 OOM: unable to create new native thread）。连接泄漏：借用后不归还，连接池耗尽（最终所有请求阻塞等待连接）。排查思路：① 告警（线程数/连接数超阈值）→ ② dump（jstack/连接池日志）→ ③ 定位泄漏点（栈追溯代码）→ ④ 修复（try-with-resources / 连接池配置）

**展开框架：**
1. **线程泄漏** — 线程数无限增长 → OOM: unable to create new native thread"
2. **连接泄漏** — 连接不归还 → 连接池耗尽 → 请求阻塞
3. **排查三步** — 告警 → dump（jstack/连接池日志）→ 栈追溯代码

**收尾：** 以上是我的整体思路。您想继续深入聊——线程泄漏和内存泄漏区别？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：线上线程泄漏与连接泄漏如何排查 | "这题一句话：线程泄漏与连接泄漏是 Java 服务\慢性死亡\的两大元凶。" | 开场钩子 |
| 0:15 | 线程泄漏示意/对比图 | "线程数无限增长 → OOM: unable to create new native thread" | 线程泄漏要点 |
| 0:40 | 连接泄漏示意/对比图 | "连接不归还 → 连接池耗尽 → 请求阻塞" | 连接泄漏要点 |
| 1:25 | 总结卡 | "记住：线程泄漏。下期见。" | 收尾 |
