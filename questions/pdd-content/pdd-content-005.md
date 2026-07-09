---
id: pdd-content-005
difficulty: L3
category: pdd-content
subcategory: JVM
tags:
- 拼多多
- 内容
- JVM
- OOM
- 内存泄漏
feynman:
  essence: OOM 是"某内存区域用尽"的报错；内容场景常见堆溢出（评价缓存无界）、Metaspace 溢出（CGLIB 动态代理）、Direct 溢出（NIO），需定位+扩容+根治。
  analogy: OOM 像房间塞满——堆是卧室（对象）、Metaspace 是书房（类信息）、Direct 是仓库（堆外），哪间满了都报。
  first_principle: 每个内存区域有上限，无界增长或不释放会导致耗尽。
  key_points:
  - 堆溢出：对象多/泄漏（评价缓存）
  - Metaspace：类元数据（CGLIB 生成类）
  - Direct：NIO 堆外内存
  - 排查：jmap dump + MAT 分析
first_principle:
  problem: 各内存区域有上限，无界增长/不释放会耗尽，如何定位+根治？
  axioms:
  - 内存区域有上限
  - 对象/类需可回收
  - 现场最珍贵（dump）
  rebuild: 监控预警 + dump 现场 + MAT 定位 + 扩容/修复。
follow_up:
  - 怎么定位内存泄漏？——jmap dump + MAT 看 GC Root 引用链
  - OOM 之前能预防吗？——JVM 参数堆+预警（75% 报警）+软引用缓存
  - Direct OOM 怎么排？——看 -XX:MaxDirectMemorySize 和 NIO 客户端配置
memory_points:
  - "堆：java.lang.OutOfMemoryError: Java heap space"
  - Metaspace：Metaspace（CGLIB）
  - Direct：Direct buffer memory（NIO）
  - 排查：jmap dump + MAT
---

# 【拼多多内容】OOM 类型与排查（内容服务实战）？

> JD 依据："稳定性建设"、"监控"。

## 一、常见 OOM 类型

| 报错 | 区域 | 内容场景原因 |
|------|------|--------------|
| Java heap space | 堆 | 评价/Feed 缓存无界、大 List 一次加载 |
| GC overhead | 堆 | GC 跑但回收 <1%，反复 Full GC |
| Metaspace | 元空间 | CGLIB 动态代理类爆炸（AOP/Bean 大量生成） |
| Direct buffer memory | 堆外 | NIO Netty DirectByteBuf 不释放 |
| unable to create new native thread | 进程 | 线程数超限（线程池泄漏） |
| StackOverflow | 栈 | 递归过深（评论树自循环） |

## 二、堆 OOM 排查（评价缓存场景）

**触发**：评价服务堆 OOM
```
java.lang.OutOfMemoryError: Java heap space
```

**步骤**：
```bash
# 1. 加参数（出问题自动 dump）
-XX:+HeapDumpOnOutOfMemoryError
-XX:HeapDumpPath=/data/dump/review.hprof

# 2. 手动 dump（运行中）
jmap -dump:format=b,file=review.hprof <pid>

# 3. MAT 分析
打开 hprof → Histogram（看对象数量 Top）
         → Dominator Tree（看占用最大的引用链）
         → Leak Suspects（自动报告嫌疑）
```

**常见根因**：
- 评价缓存 `Map<Long, Review>` 无淘汰策略 → 换 Caffeine 设 maxSize/expireAfterWrite
- 全量加载评论列表 `reviewDao.findAll()` → 改分页
- ThreadLocal 不 remove → finally 清理

## 三、Metaspace OOM（Spring AOP）

**触发**：每次请求动态生成代理类
```
java.lang.OutOfMemoryError: Metaspace
```

**排查**：`arthas dashboard` 看 Metaspace 增长曲线；`jad` 查生成的代理类。

**常见根因**：
- CGLIB 每次创建代理类（如循环里 `Enhancer.create()`）→ 复用代理
- Groovy 动态脚本编译 → 限制 + 缓存编译结果

**调优**：
```bash
-XX:MetaspaceSize=256m
-XX:MaxMetaspaceSize=512m
```

## 四、Direct OOM（直播网关 NIO）

```
java.lang.OutOfMemoryError: Direct buffer memory
```

**原因**：Netty DirectByteBuf 用完未 release（引用计数泄漏）。

**排查**：
```bash
-XX:MaxDirectMemorySize=1g   # 限制
# Netty 内存泄漏检测
-Dio.netty.leakDetection.level=PARANOID
```

**修复**：检查 ByteBuf release；用 `SimpleLeakAwareByteBuf` 定位泄漏点。

## 五、预防与监控

```java
// 缓存用 Caffeine（带淘汰）
Cache<Long, Review> cache = Caffeine.newBuilder()
    .maximumSize(100_000)
    .expireAfterWrite(10, MINUTES)
    .recordStats()
    .build();

// 监控（暴露到 Prometheus）
MemoryMXBean m = ManagementFactory.getMemoryMXBean();
m.getHeapMemoryUsage().getUsed();   // 实时堆使用
```

**报警**：堆使用 >75% 预警，>85% 严重。

## 六、底层本质

OOM 本质是**"某内存区域无界增长耗尽"**——预防靠淘汰策略+监控，定位靠 dump 现场，根治靠找 GC Root 引用链。

## 常见考点
1. **内存泄漏 vs 内存溢出**？——泄漏是对象不释放（堆慢慢长），溢出是瞬间撑爆。
2. **WeakReference/SoftReference 区别**？——Weak 下次 GC 必回收，Soft 内存不足才回收（适合缓存）。
3. **怎么在线排查**？——arthas（dashboard/heapdump/jad）或 jmap + MAT。
