---
id: java-architect-120
difficulty: L4
category: java-architect
subcategory: 高可用
tags:
- Java 架构师
- 优雅停机
- 流量摘除
- SIGTERM
feynman:
  essence: 优雅停机是 Java 服务"无感下线"的核心——收到 SIGTERM 后，按"摘流量 → 等处理完 → 销毁资源"的顺序退出，保证在途请求不丢、消息不重复消费、连接不泄漏。Spring Boot 的 graceful shutdown + ApplicationListener<ContextClosedEvent> + K8s preStop hook 三层协作。坑点：SIGTERM 被吞（PID 1 问题）、preStop sleep 时间不够、线程池 shutdown 顺序错、消费者 offset 未提交。
  analogy: 像"餐厅关门"——粗暴关（kill -9）是直接赶走客人（请求中断），优雅关是"门口挂停业牌（摘流量）→ 等桌上的客人吃完（在途请求完成）→ 关灯锁门（释放资源）"。客人无感，餐厅不浪费。
  first_principle: 优雅停机的本质是"流量摘除"和"资源清理"的有序解耦。流量先摘（LB/注册中心剔除），新请求不再来，在途请求有时间完成。资源清理（线程池/连接池/消费者）在请求处理完后才执行。坑点在于"时序"——摘流量要时间传播（LB 轮询刷新），处理要时间完成（慢请求），资源清理要有序（先停消费者，再关连接池）。
  key_points:
  - 三层协作：Spring Boot graceful + ApplicationListener + K8s preStop
  - 摘流量：注册中心注销（Eureka/Nacos）+ LB 刷新 + 网关路由更新
  - SIGTERM 处理：Spring 监听 ContextClosedEvent，触发 graceful shutdown
  - 线程池有序关闭：shutdown() → awaitTermination() → shutdownNow()
  - 消费者：停止拉取 + 处理完在途 + 提交 offset
  - K8s：preStop sleep + terminationGracePeriodSeconds
first_principle:
  problem: 服务发布/扩缩容时，怎么保证在途请求不丢、消息不重复消费？
  axioms:
  - kill -9 会中断在途请求（用户报错）
  - 新请求还在来（LB/注册中心没剔除）
  - 资源未释放（连接泄漏、消费者 offset 未提交）
  rebuild: 优雅停机分三阶段。① 摘流量——K8s preStop 先执行（sleep 等 LB 刷新 + 主动调注册中心注销），新请求不再来。② 等处理完——Spring graceful shutdown 拒绝新请求（HTTP 503），等在途请求完成（timeout 30s）。③ 销毁资源——按顺序：停消费者（不拉新消息）→ 等在途消息处理完 + 提交 offset → 关线程池（shutdown → await）→ 关连接池 → 销毁 Bean。坑点：PID 1 问题（SIGTERM 没传给 JVM，要用 exec 或 spring-boot:run）、preStop sleep 不够（LB 还在转发）。
follow_up:
  - 为什么不能 kill -9？——SIGKILL 无法捕获，JVM 立即退出，在途请求中断、连接泄漏、消费者 offset 未提交（消息重复消费）
  - preStop 为什么要 sleep？——K8s 删 Pod 时，kube-proxy 更新 iptables 有延迟（1-2 秒），期间 LB 还会转发请求到已下线的 Pod。sleep 5-10 秒等 iptables 刷新
  - Spring graceful shutdown 原理？——ContextClosedEvent 触发，Tomcat 停止接受新请求，等在途请求完成（spring.lifecycle.timeout-per-shutdown-phase）
  - 消费者怎么优雅停？——container.stop() 停止拉取新消息，等当前批次处理完，提交 offset，再关闭
  - PID 1 问题？——容器 ENTRYPOINT 用 shell 启动（sh -c java ...），JVM 不是 PID 1，SIGTERM 发给 shell 没转发给 JVM。用 exec java 或 spring-boot:run 解决
memory_points:
  - 三层协作：Spring graceful + ApplicationListener + K8s preStop
  - 摘流量：注册中心注销 + LB 刷新 + preStop sleep
  - SIGTERM → ContextClosedEvent → graceful shutdown
  - 线程池：shutdown() → awaitTermination() → shutdownNow()
  - 消费者：停拉取 → 处理完 → 提交 offset
  - K8s：preStop sleep + terminationGracePeriodSeconds=60
  - PID 1 问题：用 exec java，不用 sh -c
---

# 【Java 后端架构师】Java 服务优雅停机与流量摘除

> 适用场景：JD 核心技术。订单服务每次发布，0.1% 请求报 500（连接重置），消费者消息重复消费。架构师必须设计完整的优雅停机流程，保证零请求丢失、零消息重复。

## 一、概念层：优雅停机的三阶段

**优雅停机是什么**：

```
K8s 删除 Pod
   │
   ├─ 1. 发送 SIGTERM（同时 preStop hook 执行）
   │     │
   │     ├─ preStop: sleep 10（等 LB iptables 刷新）
   │     └─ preStop: 调注册中心注销（主动摘流量）
   │
   ├─ 2. Spring Boot 收到 SIGTERM
   │     │
   │     ├─ ContextClosedEvent 触发
   │     ├─ WebServer 停止接受新请求（503）
   │     └─ 等在途请求完成（timeout 30s）
   │
   ├─ 3. 销毁资源（按 Bean 依赖逆序）
   │     │
   │     ├─ Kafka Consumer 停止（不拉新消息）
   │     ├─ 等在途消息处理完 + 提交 offset
   │     ├─ 线程池 shutdown（await 30s）
   │     ├─ 连接池关闭（HikariCP close）
   │     └─ Bean 销毁（@PreDestroy）
   │
   └─ 4. JVM 退出（exit code 0）
         │
         │  如果超时（terminationGracePeriodSeconds）
         ▼
       K8s 发 SIGKILL（强制杀）
```

**核心配置对比**（这张表面试必问）：

| 配置 | 作用 | 默认值 | 生产建议 |
|------|------|--------|---------|
| `terminationGracePeriodSeconds` | K8s 等优雅退出的最长时间 | 30s | 60s（含 preStop sleep） |
| `preStop` hook | 摘流量前的 hook | 无 | sleep 10 + 调注销 |
| `spring.lifecycle.timeout-per-shutdown-phase` | Spring 各阶段超时 | 30s | 30s |
| `server.shutdown` | Spring graceful 模式 | immediate | graceful |
| `spring.boot.graceful-timeout` | 等在途请求时间 | 30s | 30s |
| HikariCP `closing` | 连接池关闭等待 | 即时 | 等活动连接完成 |

## 二、机制层：完整配置示例

**1. K8s Deployment 配置**：

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
spec:
  template:
    spec:
      containers:
      - name: order-service
        image: registry.jd.com/order-service:latest
        lifecycle:
          preStop:                          # 摘流量 hook
            exec:
              command:
              - /bin/sh
              - -c
              - |
                # 1. 主动调注册中心注销（Nacos/Eureka）
                curl -X POST http://localhost:8080/actuator/service-registry?status=DOWN
                # 2. sleep 等 LB iptables 刷新（kube-proxy 异步更新）
                sleep 10
        ports:
        - containerPort: 8080
      terminationGracePeriodSeconds: 60     # K8s 等优雅退出最长时间
```

**2. Spring Boot 配置**：

```yaml
# application.yml
server:
  shutdown: graceful                        # 启用 graceful shutdown（默认 immediate）

spring:
  lifecycle:
    timeout-per-shutdown-phase: 30s         # 各阶段超时（含 Bean 销毁）

management:
  endpoint:
    health:
      probes:
        enabled: true                       # 启用 K8s 探针
  endpoints:
    web:
      exposure:
        include: health,info,service-registry,prometheus
```

**3. ApplicationListener 自定义停机逻辑**：

```java
@Component
public class GracefulShutdownListener implements ApplicationListener<ContextClosedEvent> {

    private static final Logger log = LoggerFactory.getLogger(GracefulShutdownListener.class);

    @Autowired
    private KafkaListenerEndpointRegistry kafkaRegistry;

    @Autowired
    @Qualifier("cpuExecutor")
    private ThreadPoolExecutor cpuExecutor;

    @Autowired
    private HikariDataSource dataSource;

    @Override
    public void onApplicationEvent(ContextClosedEvent event) {
        log.info("Graceful shutdown started");

        // 阶段 1：停止 Kafka 消费者（不拉新消息）
        log.info("Stopping Kafka consumers...");
        kafkaRegistry.getListenerContainers().forEach(container -> {
            container.pause();                          // 暂停拉取
            // 等当前批次处理完
            container.stop(() -> log.info("Consumer {} stopped", container));
        });

        // 阶段 2：等待在途消息处理完 + 提交 offset
        // （Spring Kafka 的 container.stop() 自动等待当前批次完成 + 提交 offset）

        // 阶段 3：关闭业务线程池
        log.info("Shutting down CPU executor...");
        cpuExecutor.shutdown();                         // 不接受新任务
        try {
            if (!cpuExecutor.awaitTermination(30, TimeUnit.SECONDS)) {
                log.warn("CPU executor did not terminate, forcing shutdown");
                cpuExecutor.shutdownNow();              // 中断剩余任务
            }
        } catch (InterruptedException e) {
            cpuExecutor.shutdownNow();
            Thread.currentThread().interrupt();
        }

        // 阶段 4：关闭连接池（HikariCP 自动等活动连接完成）
        // dataSource.close() 由 Spring 自动处理（Bean 销毁）

        log.info("Graceful shutdown completed");
    }
}
```

**4. 消费者优雅停（Spring Kafka）**：

```java
@Configuration
@EnableKafka
public class KafkaConsumerConfig {

    @Bean
    public ConcurrentKafkaListenerContainerFactory<String, OrderEvent> factory(
            ConsumerFactory<String, OrderEvent> cf) {
        ConcurrentKafkaListenerContainerFactory<String, OrderEvent> factory =
            new ConcurrentKafkaListenerContainerFactory<>();
        factory.setConsumerFactory(cf);

        // 关键：容器停止时的行为
        ContainerProperties props = factory.getContainerProperties();
        props.setAckMode(AckMode.MANUAL_IMMEDIATE);    // 手动提交 offset
        // 停止时：等待当前批次处理完 + 提交 offset
        props.setSyncCommits(true);                    // 同步提交（确保 offset 落库）
        props.setShutdownTimeout(30_000L);             // 停止超时 30 秒

        return factory;
    }
}

@Service
public class OrderConsumer {

    @KafkaListener(topics = "orders", groupId = "order-group")
    public void consume(List<OrderEvent> events, Acknowledgment ack) {
        try {
            orderService.batchCreate(events);          // 批量处理
            ack.acknowledge();                          // 处理成功才提交 offset
        } catch (Exception e) {
            log.error("Consume failed, will retry", e);
            // 不 ack，下次重启重新消费（at-least-once）
        }
    }
}
```

**5. PID 1 问题（Dockerfile）**：

```dockerfile
# 反例：JVM 不是 PID 1，SIGTERM 发给 shell 没转发
ENTRYPOINT ["sh", "-c", "java -jar app.jar"]
# shell（sh）是 PID 1，java 是子进程，SIGTERM 发给 shell 不转发

# 正确：exec 替换 shell，java 成为 PID 1
ENTRYPOINT ["java", "-jar", "app.jar"]
# 或
ENTRYPOINT ["sh", "-c", "exec java -jar app.jar"]
# exec 让 java 替换 shell 进程，成为 PID 1，直接收 SIGTERM
```

## 三、实战层：完整发布流程

**场景：订单服务滚动发布**

```
正常 Pod: order-service-5d4b6c7d8-x9z9a（运行中）

K8s 发布新版本（kubectl apply）：
1. 新 Pod 创建：order-service-5d4b6c7d8-a1b2c
2. 新 Pod Ready，加入 Service Endpoints
3. 旧 Pod 开始删除：
   ┌──────────────────────────────────────────────────────────┐
   │ 旧 Pod order-service-5d4b6c7d8-x9z9a 收到 SIGTERM        │
   ├──────────────────────────────────────────────────────────┤
   │ T+0s:   preStop hook 执行                                │
   │         - 调 /actuator/service-registry?status=DOWN       │
   │           （注册中心标记 DOWN，LB 慢慢剔除）              │
   │         - sleep 10（等 kube-proxy iptables 刷新）         │
   │                                                            │
   │ T+10s:  Spring 收到 SIGTERM（ContextClosedEvent）        │
   │         - Tomcat 拒绝新请求（503）                        │
   │         - 等在途 HTTP 请求完成（最长 30s）                 │
   │         - Kafka Consumer 停止拉取                         │
   │         - 等在途 Kafka 消息处理完 + 提交 offset           │
   │         - 线程池 shutdown（await 30s）                    │
   │         - 连接池关闭                                       │
   │         - Bean 销毁（@PreDestroy）                        │
   │                                                            │
   │ T+25s:  所有在途请求完成，JVM 退出（exit 0）             │
   └──────────────────────────────────────────────────────────┘

4. K8s 确认旧 Pod 终止，发布完成
5. 用户无感知（0 请求丢失，0 消息重复）
```

**常见坑点排查**：

```
坑 1：SIGTERM 被吞
症状：JVM 立即退出（没等在途请求）
原因：ENTRYPOINT ["sh", "-c", "java -jar"]，shell 是 PID 1 不转发 SIGTERM
修复：ENTRYPOINT ["java", "-jar"] 或 exec java

坑 2：preStop sleep 不够
症状：摘流量后仍有新请求（LB 还在转发）
原因：kube-proxy iptables 刷新慢（1-2 秒），LB 缓存未过期
修复：preStop sleep 加长（10-15 秒）+ 主动调注册中心注销

坑 3：消费者 offset 未提交
症状：消息重复消费
原因：消费者没等处理完就关闭，offset 没 ack
修复：container.stop() 自动等待 + 同步提交 offset

坑 4：线程池 shutdown 顺序错
症状：Bean 销毁时还有任务在跑（报错）
原因：先关连接池，后关线程池，任务用到连接报错
修复：先关消费者 → 再关线程池 → 最后关连接池（Spring Bean 依赖顺序）

坑 5：terminationGracePeriodSeconds 不够
症状：K8s 强杀（SIGKILL）
原因：优雅停机耗时超过 gracePeriod（默认 30s）
修复：调大到 60-90 秒
```

## 四、底层本质：为什么优雅停机难

回到第一性：**为什么不能直接 kill，要优雅停？**

- **在途请求不丢**：HTTP 请求处理到一半（已扣库存，未下订单），kill -9 中断，用户报错 + 数据不一致。优雅停等在途完成，请求正常返回。
- **消息不重复**：消费者拉了一批消息，处理到一半 kill，offset 未提交，重启后重新消费（重复）。优雅停等批次处理完 + 提交 offset，不重复。
- **资源不泄漏**：连接池 borrow 的连接没归还，kill 后 socket 泄漏（DB 端连接也不释放）。优雅停等连接归还 + 连接池关闭。
- **数据一致**：事务执行到一半 kill，事务回滚或不一致。优雅停等事务完成。

**摘流量为什么难**：
- **多层 LB**：请求经过 Ingress → Service → Pod，每层有缓存/刷新延迟。
- **kube-proxy iptables**：K8s 删 Pod 时，kube-proxy 异步更新 iptables 规则（1-2 秒延迟），期间仍有请求转发到已删 Pod。
- **注册中心延迟**：Nacos/Eureka 注销后，消费者缓存可能 30 秒才刷新。
- **解决**：① preStop sleep（等 iptables 刷新）；② 主动调注册中心注销（不等心跳超时）；③ 双保险。

**Spring graceful shutdown 原理**：
- `ContextClosedEvent` 触发时，Spring 发布事件，各组件监听。
- Tomcat 的 `WebServerGracefulShutdownLifecycle` 先执行——停止接受新连接，等在途请求完成。
- 然后按 Bean 依赖逆序销毁（@PreDestroy、DisposableBean）。
- 每阶段有 timeout（`timeout-per-shutdown-phase`），超时强制进入下一阶段。

**线程池 shutdown 的本质**：
- `shutdown()`：不再接受新任务，已提交任务继续执行。
- `awaitTermination(timeout)`：阻塞等待所有任务完成（或超时）。
- `shutdownNow()`：尝试中断正在执行的任务（Interrupt），返回未执行的任务列表。
- 正确顺序：shutdown → awaitTermination（给足时间）→ 必要时 shutdownNow（兜底）。

**Kafka 消费者优雅停的本质**：
- `container.stop()` 内部：停止拉取新消息 → 等当前批次处理完 → 提交 offset（同步）→ 关闭 consumer。
- 如果用 `enable.auto.commit=true`，offset 定期自动提交（可能丢失刚提交的，重启重复）。生产建议手动提交（处理完才 ack）。

## 五、AI 架构师加问：5 个

1. **AI 推理服务的优雅停机特点？**
   LLM 推理是长任务（单次几秒到几十秒），graceful timeout 要配长（60-120 秒）。模型加载慢，scale-to-zero 后冷启动久。GPU 资源释放要等推理完成（不能强杀，可能损坏模型状态）。建议：minReplicaCount=1 + 长 graceful timeout + 推理任务可中断检查点。

2. **AI 能预测最佳停机时机吗？**
   AI 学习服务的请求模式（QPS 周期、长尾请求耗时），预测"安全停机时机"——在途请求数 < 阈值 + 非高峰期。AI 输出："当前在途 5 请求，预计 10 秒完成，建议立即停机"。避免高峰期停机 + 减少等待时间。

3. **大模型推理的长任务优雅停？**
   ① 推理任务 checkpoint（中断后可恢复，不丢进度）；② graceful timeout 配 120 秒（LLM 推理 30 秒+）；③ 拒绝新请求后，等当前推理完成；④ GPU 资源释放确认（nvidia-smi 确认 GPU 空闲再退出）；⑤ 模型权重缓存（重启不用重新加载）。

4. **AI Agent 多轮对话的优雅停？**
   对话状态持久化（Redis/DB），Pod 停机前把进行中的对话状态保存。新请求路由到其他 Pod（通过 traceId 恢复上下文）。长对话（Agent 执行任务）支持中断 + 恢复（checkpoint）。用户无感（对话不丢失）。

5. **AI 怎么检测优雅停机问题？**
   AI 分析发布期间的指标：① 5xx 错误率（>0 说明请求中断）；② 消息重复消费率（>0 说明 offset 丢失）；③ 连接泄漏（DB 连接数不降）；④ 停机耗时（超过 gracePeriod 被 SIGKILL）。AI 告警 + 定位坑点（如 PID 1 问题、preStop 不够）。

## 六、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"三阶段、摘流量、SIGTERM、PID 1、gracePeriod"**。

- **三阶段**：① preStop 摘流量（sleep + 注销）；② Spring graceful 等在途；③ 销毁资源（消费者→线程池→连接池）
- **摘流量**：注册中心注销（主动）+ preStop sleep（等 iptables 刷新）
- **SIGTERM → ContextClosedEvent**：Spring 监听，触发 graceful shutdown
- **线程池**：shutdown() → awaitTermination() → shutdownNow()
- **消费者**：停拉取 → 等批次完成 → 提交 offset
- **PID 1 问题**：用 `exec java`，不用 `sh -c java`
- **gracePeriod**：terminationGracePeriodSeconds=60（含 preStop sleep）

### 拟人化理解

把优雅停机想成**餐厅关门的礼貌流程**。粗暴关（kill -9）是直接赶走客人（请求中断，客人不爽）。优雅关是：① 门口挂"停业牌"（摘流量，新客人不进）；② 等桌上的客人吃完（在途请求完成）；③ 服务员收拾（关线程池/连接池）；④ 关灯锁门（JVM 退出）。preStop sleep 是"等门口广告牌刷新"（LB 还在转发，睡 10 秒等刷新）。PID 1 问题是"经理没通知到服务员"（SIGTERM 发给 shell 没转发给 java）。

### 面试现场 60 秒回答

> 优雅停机是 Java 服务无感下线的核心，三阶段：① K8s preStop 摘流量——主动调注册中心注销（Nacos/Eureka 标记 DOWN）+ sleep 10 秒等 kube-proxy iptables 刷新（防止 LB 继续转发）；② Spring graceful shutdown——ContextClosedEvent 触发，Tomcat 拒绝新请求（503），等在途请求完成（timeout 30s）；③ 销毁资源按顺序：停 Kafka 消费者（不拉新消息，等当前批次处理完 + 提交 offset）→ 关线程池（shutdown → awaitTermination 30s → shutdownNow 兜底）→ 关连接池 → Bean 销毁。坑点：① PID 1 问题（ENTRYPOINT 用 exec java，不用 sh -c，否则 SIGTERM 不转发）；② preStop sleep 不够（LB 还在转发）；③ 线程池关闭顺序（先消费者再线程池最后连接池）；④ terminationGracePeriodSeconds 配 60 秒（含 preStop sleep）。消费者手动提交 offset（处理完才 ack），防止重启重复消费。K8s 超过 gracePeriod 发 SIGKILL 强杀。

### 反问面试官

> 贵司服务部署在 K8s 还是 VM？注册中心是 Nacos 还是 Eureka？这决定我聊 preStop hook 还是 VM 的脚本方案。

## 七、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么要优雅停机，kill 不行吗？ | kill -9 中断在途请求（用户报错）、消费者 offset 未提交（消息重复）、连接泄漏（DB 端不释放）、事务不一致。优雅停保证零请求丢失、零消息重复、资源释放 |
| 证据追问 | 怎么证明优雅停机生效？ | ① 发布期间 5xx 错误率 = 0（无请求中断）；② 消息重复消费率 = 0（offset 已提交）；③ DB 连接数正常波动（无泄漏）；④ 发布耗时在 gracePeriod 内（未被 SIGKILL） |
| 边界追问 | 优雅停机能解决所有发布问题吗？ | 不能。① 长事务（超过 gracePeriod 仍被杀）；② 有状态服务（内存状态丢失，需持久化）；③ 数据库 schema 变更（要兼容期）。优雅停主要解决"流量/资源"层 |
| 反例追问 | 什么场景优雅停机没用？ | ① OOM 崩溃（JVM 挂了，没机会 graceful）；② SIGKILL（无法捕获）；③ 死锁（线程卡住，awaitTermination 超时）；④ 容器被驱逐（kubelet eviction 直接 SIGTERM，时间短） |
| 风险追问 | 优雅停机最大风险？ | ① gracePeriod 不够（被 SIGKILL，前功尽弃）；② preStop 失败（hook 执行失败仍继续删 Pod）；③ 依赖服务先停（下游先下线，本服务请求失败）。治法：gracePeriod 60s+、preStop 健壮、有序发布 |
| 验证追问 | 怎么验证 preStop sleep 够不够？ | ① 发布期间监控本 Pod 的请求量（摘流量后应降到 0）；② 测 LB 到本 Pod 的连接（应无新连接）；③ 多次验证（不同流量场景） |
| 沉淀追问 | 团队规范沉淀什么？ | ① Dockerfile 规范（exec java）；② Deployment 模板（preStop + gracePeriod）；③ Spring graceful 配置；④ 消费者手动提交 offset；⑤ 发布监控（5xx/重复消费） |

### 现场对话示例

**面试官**：为什么 preStop 要 sleep 10 秒？

**候选人**：因为 kube-proxy 删 Pod 时更新 iptables 是异步的，有 1-2 秒延迟。这期间 LB（kube-proxy/客户端缓存）还会把新请求转发到已下线的 Pod。sleep 10 秒等 iptables 刷新完成，确保没有新请求进来。同时主动调注册中心注销（/actuator/service-registry?status=DOWN），让上游消费者尽快感知。双保险——preStop sleep + 主动注销。

**面试官**：PID 1 问题怎么解决？

**候选人**：容器 ENTRYPOINT 如果用 shell 启动（`sh -c "java -jar app.jar"`），shell 是 PID 1，java 是子进程。K8s 发 SIGTERM 给 PID 1（shell），shell 不会转发给 java 子进程，java 收不到 SIGTERM 直接被 SIGKILL。解决：① `ENTRYPOINT ["java", "-jar", "app.jar"]`（exec 形式，java 直接是 PID 1）；② 或 `ENTRYPOINT ["sh", "-c", "exec java -jar app.jar"]`（exec 替换 shell，java 成为 PID 1）。最佳实践用第一种。

**面试官**：消费者怎么保证不重复消费？

**候选人**：三步。① 关闭自动提交：`enable.auto.commit=false`，用手动提交。② 处理完才 ack：业务逻辑成功后调 `ack.acknowledge()`，失败不 ack。③ 优雅停时 container.stop() 等当前批次处理完 + 同步提交 offset。这样：处理完的消息 offset 已提交，重启不重复；未处理完的不提交，重启重新消费（at-least-once，配合幂等避免重复影响）。坑点：auto.commit=true 时 offset 定期提交，处理到一半 kill 可能刚提交 offset 但没处理完，重启丢失（实际是重复，因为 offset 提交了但业务没完成）。

## 常见考点

1. **优雅停机三阶段？**——① preStop 摘流量（sleep + 注销）；② Spring graceful 等在途；③ 销毁资源（消费者→线程池→连接池）。
2. **preStop 为什么要 sleep？**——kube-proxy iptables 异步刷新有延迟，sleep 等 LB 不再转发新请求。
3. **PID 1 问题？**——ENTRYPOINT 用 shell 启动，SIGTERM 发给 shell 不转发给 JVM。用 exec java 解决。
4. **消费者优雅停？**——停拉取 → 等批次处理完 → 手动提交 offset（处理完才 ack，防重复消费）。
5. **terminationGracePeriodSeconds？**——K8s 等优雅退出最长时间，超时发 SIGKILL。生产配 60 秒（含 preStop sleep）。

## 结构化回答

**30 秒电梯演讲：** 优雅停机是 Java 服务无感下线的核心——收到 SIGTERM 后，按摘流量 → 等处理完 → 销毁资源的顺序退出，保证在途请求不丢、消息不重复消费、连接不泄漏。Spring Boot 的 graceful shutdown + ApplicationListener<ContextClosedEvent> + K8s preStop hook 三层协作。坑点：SIGTERM 被吞（PID 1 问题）、preStop sleep 时间不够、线程池 shutdown 顺序错、消费者 offset 未提交

**展开框架：**
1. **三层协作** — Spring Boot graceful + ApplicationListener + K8s preStop
2. **摘流量** — 注册中心注销（Eureka/Nacos）+ LB 刷新 + 网关路由更新
3. **SIGTERM 处理** — Spring 监听 ContextClosedEvent，触发 graceful shutdown

**收尾：** 以上是我的整体思路。您想继续深入聊——为什么不能 kill -9？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Java 服务优雅停机与流量摘除 | "这题核心是——优雅停机是 Java 服务无感下线的核心——收到 SIGTERM 后，按摘流量 → 等处理完 ……" | 开场钩子 |
| 0:15 | 像餐厅关门——粗暴关（kill -9）是直接类比图 | "打个比方：像餐厅关门——粗暴关（kill -9）是直接。" | 核心类比 |
| 0:40 | 三层协作示意/对比图 | "Spring Boot graceful + ApplicationListener + K8s preStop" | 三层协作要点 |
| 1:05 | 摘流量示意/对比图 | "注册中心注销（Eureka/Nacos）+ LB 刷新 + 网关路由更新" | 摘流量要点 |
| 1:30 | SIGTERM 处理示意/对比图 | "Spring 监听 ContextClosedEvent，触发 graceful shutdown" | SIGTERM 处理要点 |
| 1:55 | 总结卡 | "记住：三层协作。下期见。" | 收尾 |
