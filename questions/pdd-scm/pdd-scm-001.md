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
