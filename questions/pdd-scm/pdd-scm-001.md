---
id: pdd-scm-001
difficulty: L3
category: pdd-scm
subcategory: Java 并发
tags:
- 拼多多
- 供应链
- 并发
- synchronized
- 锁升级
- JMM
feynman:
  essence: synchronized 在 JDK 6 后有"偏向锁→轻量级锁→重量级锁"自适应升级，用 CAS 自旋应对低竞争、用 OS Mutex 应对高竞争，在供应链系统的高并发扣减场景里实现"无竞争零成本、有竞争优雅降级"。
  analogy: synchronized 像共享会议室的门锁——只有一个人用时不锁（偏向锁），两三个人偶尔撞见就先在门口等一下自旋（轻量级锁），抢的人多了就发号牌去休息区等 OS 叫号（重量级锁）。
  first_principle: 线程竞争强度是动态变化的，用单一策略（全自旋浪费 CPU、全阻塞浪费上下文切换）都不优；分级升级让锁成本匹配实际竞争强度。
  key_points:
  - 锁状态存对象头 Mark Word（54 bit）
  - 偏向锁：单线程复用，CAS 设线程 ID（JDK 15 默认禁用）
  - 轻量级锁：多线程交替，CAS 自旋
  - 重量级锁：高竞争，OS Mutex park/unpark
  - 升级不可逆（偏向→轻量→重量）
first_principle:
  problem: 多核 CPU 下共享资源如何用最低成本的同步机制保证线程安全？
  axioms:
  - 绝大多数锁在生命周期内竞争不激烈（单线程或交替）
  - CAS 自旋适合低竞争（用户态、不阻塞）
  - OS 阻塞适合高竞争（不浪费 CPU 但有切换成本）
  rebuild: 分级锁——低竞争用偏向（近乎零成本）、中竞争用 CAS 自旋（用户态乐观）、高竞争用 OS Mutex（悲观阻塞），自适应升级让成本匹配场景。
follow_up:
- 偏向锁为什么 JDK 15 后默认禁用？——维护成本高（撤销需 STW）、现代应用多线程化偏向收益小
- synchronized 和 ReentrantLock 选哪个？——可控性需求（超时/中断/多 Condition）选 ReentrantLock，简单互斥用 synchronized（JDK 6 后性能接近）
- 供应链里哪里用 synchronized？——单机库存扣减、本地状态机变更（跨机用 Redis/ZK 分布式锁）
memory_points:
- 锁升级三阶段：偏向（单线程）→ 轻量级（CAS 自旋）→ 重量级（OS Mutex）
- 锁状态存在对象头的 Mark Word（不是独立字段）
- 升级不可逆——偏向锁一旦撤销不会回到偏向
- JDK 15+ 偏向锁默认禁用（维护成本 > 收益）
---

# 【拼多多供应链】synchronized 的锁升级过程？JMM 怎么保证可见性？

> JD 依据："Java 基础扎实，理解并发"。供应链的库存扣减、订单状态机都需要并发控制。

## 一、synchronized 的锁升级（核心考点）

JDK 6 之前 synchronized 是"重量级锁"（直接 OS Mutex），JDK 6 引入锁升级：

```
无锁
  │ 首次有线程访问
  ▼
偏向锁（Biased Locking）
  │ 出现第二个线程竞争
  ▼
轻量级锁（Thin Lock / CAS 自旋）
  │ 自旋失败（默认 10 次或自适应）
  ▼
重量级锁（Fat Lock / OS Mutex）
```

### 1. 偏向锁
- **场景**：只有一个线程访问同步块
- **原理**：CAS 把线程 ID 写入对象头 Mark Word，下次同一线程进入只需比对 ID，无 CAS
- **代价**：近乎零（一次比对）
- **注意**：JDK 15 默认禁用（`-XX:-UseBiasedLocking`），因为现代应用多线程化，偏向收益小且撤销需 STW

### 2. 轻量级锁
- **场景**：多线程**交替**访问（非真并发）
- **原理**：栈帧Lock Record 用 CAS 指向对象头，成功获锁；失败则自旋
- **代价**：CAS 自旋（用户态，不阻塞，但占 CPU）

### 3. 重量级锁
- **场景**：高真并发竞争
- **原理**：CAS 失败到阈值，膨胀为重量级，通过 OS Mutex 的 `park`/`unpark` 阻塞
- **代价**：用户态→内核态切换（约 1-3μs）

## 二、Mark Word（锁状态存储）

Java 对象头 = Mark Word（64 bit）+ Klass Pointer（64 bit，压缩后 32 bit）。

Mark Word 在不同锁状态有不同布局：
```
无锁:     [hash(31)|age(4)|biased(1)|0(1)|unused(27)]
偏向锁:   [threadId(54)|epoch(2)|age(4)|biased(1)|1(1)]
轻量级锁: [ptr to Lock Record(62)|0(2)]
重量级锁: [ptr to ObjectMonitor(62)|1(0)]
```

## 三、JMM 与可见性

**synchronized 保证可见性**的两个动作：
1. **解锁前**：把工作内存刷回主存（StoreStore + StoreLoad 屏障）
2. **加锁时**：清空工作内存，从主存重新读（LoadLoad 屏障）

这对应 JMM 的 happens-before 规则：**unlock happens-before 后续 lock**。

## 四、供应链场景实战

**单机库存扣减**：
```java
// 场景：仓库 W1 的某商品库存，单机 JVM 内多线程扣减
public class StockService {
    private long stock = 1000;  // 本地库存计数

    // synchronized 保护单机并发（跨机用 Redis 分布式锁）
    public synchronized boolean deduct(long qty) {
        if (stock >= qty) {
            stock -= qty;
            return true;
        }
        return false;
    }
}
```

**锁升级过程**：
- 平时（单线程补货）：偏向锁，零成本
- 大促（多线程抢同一商品库存）：升级到轻量级甚至重量级
- **优化**：用 `AtomicLong`（CAS）替代 synchronized，避免升级开销

**更优解——CAS**：
```java
private final AtomicLong stock = new AtomicLong(1000);

public boolean deduct(long qty) {
    long cur;
    do {
        cur = stock.get();
        if (cur < qty) return false;
    } while (!stock.compareAndSet(cur, cur - qty));
    return true;
}
```

## 五、底层本质：锁成本的经济学

锁升级是**"成本随需求弹性匹配"**的工程哲学：
- 无竞争 → 无成本（偏向锁）
- 低竞争 → 低成本（CAS 自旋）
- 高竞争 → 高成本但保公平（OS Mutex）

**这是钱学森工程理论"经济上合理"的体现**——不追求理论最优（全 OS 锁），而追求在真实场景的成本最优。

## 常见考点
1. **synchronized 锁的是什么**？——实例方法锁 this，静态方法锁 Class 对象，代码块锁括号内对象。
2. **为什么 JDK 15 禁用偏向锁**？——现代应用多线程化，偏向收益小；撤销需 STW 影响性能；维护代码复杂。
3. **synchronized 和 volatile 区别**？——synchronized 保证原子性+可见性+有序性；volatile 只保证可见性+有序性，不保证原子性。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链的库存扣减场景，你为什么用 synchronized 而不是直接上 Redis 分布式锁？**

要分单机和跨机看。仓库 W1 的本地库存计数（`stock` 字段）只在本 JVM 内被多线程扣减，用 synchronized 保护就够了，代价是几次 CAS 自旋；如果都上 Redis 分布式锁，单次扣减多一次 Redis RTT（1-3ms），大促 QPS 上万时锁服务本身成瓶颈。跨机的全局库存（多仓共享）才用 Redis Lua 扣减。决策依据是"锁的竞争域"——竞争在同一 JVM 内就用 JVM 锁，跨 JVM 才上分布式锁。

### 第二层：证据与定位

**Q：大促时单机库存扣减接口 P99 从 5ms 飙到 200ms，你怎么确认是 synchronized 锁竞争导致的？**

三步证据链：
1. `arthas thread -n 5` 看占用 CPU/阻塞最高的线程——如果大量线程状态是 `BLOCKED`，且堆栈停在 `StockService.deduct`，锁定锁竞争。
2. `arthas thread -b` 直接找"阻塞最多线程的锁"——它会打印出哪个对象头是瓶颈锁（`-...- a java.lang.Object` 持有者 xxx）。
3. `jstack <pid>` 连续打 3 次，看 BLOCKED 线程数——如果从平时 0 涨到 50+，且都卡在 monitorenter，坐实是 synchronized 重量级锁膨胀。

### 第三层：根因深挖

**Q：你看到 jstack 里 50 个线程 BLOCKED 在 monitorenter，但为什么 synchronized 会膨胀成重量级锁？根因是什么？**

看 Mark Word 确认锁状态。`jol`（Java Object Layout）打印对象头，如果 mark word 末两位是 `10`，就是重量级锁。膨胀的根因是 CAS 自旋失败到阈值（默认自适应，约 10 次）。在库存场景，大促时同一商品（同一 `stock` 对象）被几十个线程同时扣减，自旋基本都失败，膨胀成 OS Mutex，线程 `park` 进 `ObjectMonitor` 的 `_EntryList`，每次唤醒要 user→kernel 切换（约 1-3μs），50 个线程排队就是毫秒级延迟。

**Q：那为什么不直接把 synchronized 换成 ReentrantLock 就能解决？**

换 ReentrantLock 不解决根本问题——竞争强度不变，ReentrantLock 底层还是 AQS（`state` CAS 失败进 CLH 队列 park），高竞争下一样阻塞。真正治本是降低锁粒度：把"一个 `stock` 对象一把锁"改成"分段锁"——按 skuId 哈希到 16 个 `striped lock`（Guava `Striped<Lock>`），不同 SKU 各扣各的互不阻塞；或者干脆用 `AtomicLong.compareAndSet` 把 synchronized 去掉，让扣减变成无锁 CAS。

### 第四层：方案权衡

**Q：你用了 AtomicLong 的 CAS 替代 synchronized，但大促时 CPU 飙到 90%，为什么？怎么办？**

CAS 在高竞争下会"活锁式自旋"——大量线程 `compareAndSet` 失败后空转重试，CPU 全烧在自旋上。解决办法是"消除竞争"而不是优化锁：
1. **库存预热分桶**：把 skuId=1001 的库存 1000 拆成 10 桶（`slot_0` 到 `slot_9` 各 100），扣减时按线程 ID 取模选桶，把单点竞争分散 10 倍。
2. **Redis Lua 原子扣减**：把热点 SKU 的扣减前移到 Redis（`EVAL` 一段 Lua 脚本判断+扣减原子），JVM 只做结果落库，彻底避开 JVM 锁。

**Q：为什么不直接用 LongAdder？它不是专门解决高并发计数的吗？**

LongAdder 解决的是"统计计数"（只增不减、最终一致），它的 `sum()` 不是强一致的（Cell 数组累加有窗口）。库存扣减要求"扣减后余量不能为负"的强一致判断，LongAdder 做不到——你 `sum()` 出来 100，两个线程同时判断 `>= 50` 都通过，扣完就超卖。所以库存场景必须用 AtomicLong 的 `compareAndSet`（带前置判断的 CAS），不能用 LongAdder。

### 第五层：验证与沉淀

**Q：你把 synchronized 改成分段锁 + CAS，怎么证明超卖真的没了、性能真的好了？**

两个指标交叉验证：
1. **超卖验证**：上线前埋点 `oversell_count`（扣减时 `stock < 0` 就 +1），上线后看这个计数器从日均 50+ 降到 0；同时跑压测脚本 100 并发各扣 10 次（总 1000），最终 `stock` 必须 = 0 而不是 -xx。
2. **性能验证**：看 APM 的 `stock_deduct_p99`，从 200ms 降到 20ms；`arthas monitor StockService deduct success` 看成功率，从 95%（竞争失败重试）到 99.9%。

**Q：怎么让团队以后不再误用 synchronized？**

沉淀成机制：
1. **SonarQube 规则**：对 `synchronized` 关键字加 code smell 告警，强制 review 时说明锁粒度和预估竞争强度。
2. **并发规范文档**：明确"单机并发计数用 AtomicXxx，单机临界区用 synchronized 且锁对象必须细粒度（按业务 key 分段），跨机用 Redis Lua"。
3. **压测准入**：涉及库存/扣减的接口，上线前必须过 500 并发压测，`arthas thread -b` 不能出现 BLOCKED 堆积。

## 结构化回答

**30 秒电梯演讲：** 多核 CPU 下共享资源如何用最低成本的同步机制保证线程安全？简单说就是——synchronized 在 JDK 6 后有"偏向锁→轻量级锁→重量级锁"自适应升级，用 CAS 自旋应对低竞争、用 OS Mutex 应对高竞争。

**展开框架：**
1. **锁状态存对象** — 锁状态存对象头 Mark Word（54 bit）
2. **偏向锁** — 偏向锁：单线程复用，CAS 设线程 ID（JDK 15 默认禁用）
3. **轻量级锁** — 轻量级锁：多线程交替，CAS 自旋

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：synchronized 的锁升级过程？JMM 怎么保证可见性？ | 今天聊「synchronized 的锁升级过程？JMM 怎么保证可见性？」。一句话：synchronized 在 JDK 6 后有"偏向锁→轻量级锁→重量级锁"自适应升级，用 CAS 自旋应对低竞争、用… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：锁状态存对象头 Mark Word（54 bit） | 核心概念 |
| 1:04 | 代码片段 + 关键行高亮 | 要点是：偏向锁：单线程复用，CAS 设线程 ID（JDK 15 默认禁用） | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：轻量级锁：多线程交替，CAS 自旋 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
