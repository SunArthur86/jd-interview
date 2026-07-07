---
id: ant-risk-001
difficulty: L3
category: jd-core
subcategory: JVM
tags:
- 蚂蚁
- 风控
- JVM
- GC
- 内存模型
feynman:
  essence: JVM 把内存分成几块各司其职的区域，GC 按对象存活周期分代回收，调优本质是让对象尽快在新生代被回收、避免晋升老年代。
  analogy: JVM 像一个有"前台（栈）""仓库（堆）""档案室（方法区）"的公司。新员工（对象）先进仓库的临时区（Eden），熬过几次盘点晋升到老库（Old），最终只有长期重要的才长期占用老库。
  first_principle: 内存为什么要分代？因为绝大多数对象"朝生夕灭"，按存活周期分而治之能让 GC 只扫描该扫的区域，把全堆扫描的 O(全堆) 降到 O(某一代)。
  key_points:
  - 堆分新生代（Eden+S0+S1）和老年代，比例默认 1:2
  - 对象先分配 Eden，Minor GC 后存活进 Survivor，默认 15 岁进 Old
  - 大对象直接进 Old（避免在新生代复制开销）
  - GC 算法：复制（新生代）、标记-清除/标记-整理（老年代）
  - 调优核心：减少 Full GC，让对象在 Minor GC 被清理
first_principle:
  problem: 如何让海量短生命周期对象不污染长期对象所在区域、且 GC 停顿可控？
  axioms:
  - 弱分代假说：绝大多数对象都是朝生夕灭的
  - 熬过越多次 GC 的对象越可能继续存活
  - STW（Stop The World）时间是 GC 优化的北极星指标
  rebuild: 基于弱分代假说，把堆切成新生代/老年代，新生代用复制算法（适合存活少）、老年代用标记-整理（避免碎片）；再给不同吞吐/延迟场景配不同收集器（Parallel 重吞吐、CMS/G1 重延迟、ZGC 极低延迟）。
follow_up:
- 你们风控系统用的什么 GC？为什么选它？——G1，因为风控是低延迟交易链路，需要可控停顿（<200ms）
- 如何定位线上频繁 Full GC？——jstat 看 FGCT/Frequency，jmap dump 分析大对象，用 MAT 找支配树
- 一次 GC 调优的真实案例？——把 -XX:MaxGCPauseMillis 从 200 调到 100，新生代调大，Full GC 频率从 10min/次降到 2h/次
memory_points:
- 分代假说是 GC 一切设计的根基：新生代复制算法、老年代标记整理
- 对象晋升老年代的三条路径：年龄达标(15)、大对象直接进、动态年龄判断
- 选 GC 收集器：吞吐优先 Parallel、延迟优先 G1、超低延迟 ZGC/Shenandoah
- 调优不是调参数，是先定位（jstat/jmap/MAT）再对症下药
---

# 【蚂蚁风控】讲一下 JVM 内存模型与 GC 机制，你在风控系统里是如何做 GC 调优的？

> JD 依据："基础功底扎实"。风控是高频交易链路，一次 Full GC 导致的几秒停顿可能让一笔风险交易漏判，所以 JVM 内存与 GC 是 P7 必考。

## 一、表面层：JVM 内存区域划分

JVM 在运行时把内存划分为以下几个区域（JDK 8+）：

| 区域 | 线程共享 | 存储内容 | OOM 类型 |
|------|---------|---------|---------|
| **堆（Heap）** | 共享 | 对象实例、数组 | `java.lang.OutOfMemoryError: Java heap space` |
| **方法区（Metaspace）** | 共享 | 类元信息、常量池、静态变量 | `OutOfMemoryError: Metaspace` |
| **虚拟机栈** | 私有 | 栈帧（局部变量表、操作数栈） | `StackOverflowError` / OOM |
| **本地方法栈** | 私有 | Native 方法调用 | 同上 |
| **程序计数器** | 私有 | 当前线程执行的字节码行号 | 不会 OOM |
| **直接内存** | 共享 | NIO 的 DirectByteBuffer | `OutOfMemoryError: Direct buffer memory` |

**堆的分代结构**（GC 的主战场）：
```
┌────────────────────────── 堆 (Heap) ──────────────────────────┐
│           新生代 (Young) = 1/3 堆              │   老年代 (Old) = 2/3 堆   │
│ ┌──Eden──┬──Survivor0──┬──Survivor1──┐  │                          │
│ │  8/10  │    1/10     │    1/10     │  │   长期存活的对象、大对象  │
│ └────────┴─────────────┴─────────────┘  │                          │
└───────────────────────────────────────────┴────────────────────────────┘
```
- **Eden : S0 : S1 = 8 : 1 : 1**（默认 `-XX:SurvivorRatio=8`）
- 新生代 : 老年代 = **1 : 2**（默认 `-XX:NewRatio=2`）

## 二、机制层：对象如何分配与晋升

**对象分配的完整链路**（这是面试官最爱层层追问的地方）：

1. **TLAB 优先**：新对象先尝试在 Thread Local Allocation Buffer 分配（线程私有，无竞争）
2. **Eden 分配**：TLAB 放不下就在 Eden 区分配（CAS 保证线程安全）
3. **Minor GC**：Eden 满了触发 Minor GC（也叫 Young GC）
   - Eden + 当前使用的 Survivor（假设 S0）一起被回收
   - 存活对象复制到另一个 Survivor（S1），年龄 +1
   - 清空 Eden 和 S0，下一轮用 S1 作为 From
4. **晋升老年代**，三条路径：
   - **年龄阈值**：默认 15（`-XX:MaxTenuringThreshold`），熬过 15 次 Minor GC 晋升
   - **大对象直接进**：`-XX:PretenureSizeThreshold`（只对 Serial/ParNew 有效），超阈值的大对象直接进老年代，避免在新生代来回复制
   - **动态年龄判断**：Survivor 中相同年龄所有对象大小总和 > Survivor 空间的 50%，年龄 ≥ 该年龄的对象直接晋升

## 三、算法层：四大 GC 算法

| 算法 | 适用区域 | 原理 | 优缺点 |
|------|---------|------|--------|
| **标记-清除** | CMS Old | 标记存活、清除死亡 | 快但有碎片 |
| **复制** | Young | 存活对象复制到另一半 | 无碎片但要浪费一半空间（新生代 8:1:1 优化） |
| **标记-整理** | Parallel Old | 标记后所有存活对象向一端移动 | 无碎片但慢 |
| **分代收集** | 全堆 | 新生代复制 + 老年代标记整理 | 综合最优 |

## 四、收集器层：选型与场景

```
吞吐优先                          延迟优先
  │                                 │
  ▼                                 ▼
Parallel Scavenge + Parallel Old   G1（JDK 9+ 默认）──▶ ZGC / Shenandoah
                                    │
                          低延迟交易链路（风控、支付）

（CMS 已在 JDK 14 移除，仅作历史背景；新项目不再选）
```

**风控系统为什么选 G1**：
- G1 把堆切成 2048 个 Region（每个 1-32MB），独立回收价值最高的 Region（Garbage First）
- 可预测停顿：`-XX:MaxGCPauseMillis=200` 软目标
- 混合回收（Mixed GC）：既回收新生代 Region 也回收老年代 Region，避免 Full GC

## 五、调优实战（蚂蚁风控真实场景）

**问题**：风控决策服务在日均亿级请求下，每隔 8-10 分钟一次 Full GC，停顿 3-5 秒，导致请求超时、风险漏判。

**排查链路**：
```bash
# 1. 看 GC 频率与耗时
jstat -gcutil <pid> 1000
#  输出关注: FGC(Full GC次数) FGCT(Full GC总耗时) YGC(Minor GC次数)

# 2. dump 堆分析大对象
jmap -dump:format=b,file=heap.hprof <pid>
# 用 MAT 打开，看 Dominator Tree 找占内存最大的对象

# 3. 发现是缓存未设上限：Guava Cache 存了近 4G 的用户风险画像
```

**调优动作**：
1. **业务层**：给缓存设上限（`maximumSize=100000`）+ TTL（`expireAfterWrite=10min`）
2. **JVM 层**：
   ```bash
   -Xms8g -Xmx8g                          # 堆固定 8G，避免动态扩缩引起 GC 抖动
   -XX:+UseG1GC
   -XX:MaxGCPauseMillis=100               # 停顿目标降到 100ms
   -XX:G1HeapRegionSize=16m               # Region 调大，减少 Region 数
   -XX:InitiatingHeapOccupancyPercent=35  # 触发并发标记的阈值（默认45，调低提前标记）
   -XX:G1ReservePercent=15                # 保留空间防疏散失败
   ```
3. **效果**：Full GC 从 8min/次降到几乎不发生，Young GC 平均停顿 40ms，P99 延迟从 800ms 降到 120ms。

## 六、底层本质：为什么这套设计成立？

回到**弱分代假说**：90%+ 的对象都是临时对象（方法内的局部变量、临时计算结果）。把这个规律抽象出来后，分代就成了一道"成本过滤器"：
- 新生代 GC 频繁但每次只扫少量区域（Eden+S0），成本低
- 老年代 GC 罕见但扫全区域，成本高但触发频次低
- 两者相乘：**总成本 = 高频×低成本 + 低频×高成本 ≪ 不分代的全堆扫描成本**

这就是 JVM GC 设计的"第一性原理"——用"对象生命周期"这个统计规律，把 GC 成本从 O(全堆) 降到 O(有效扫描区域)。

## 常见考点
1. **对象一定在堆上吗？**——不一定。JIT 的逃逸分析（`-XX:+DoEscapeAnalysis`）可让未逃逸的对象在栈上分配（标量替换），方法结束即销毁，根本不进堆。
2. **Metaspace 和永久代区别？**——永久代（JDK 7 之前）在堆里，固定大小易 OOM；Metaspace（JDK 8+）用本地内存，自动扩容，不易 OOM 但要防内存泄漏（动态生成 Class 的框架如 CGLIB）。
3. **为什么 Survivor 区有两个？**——复制算法需要"From/To"两个区交替使用，保证总有一个 Survivor 空着做复制目标。

**代码示例**（逃逸分析的标量替换）：
```java
// 这个对象不会逃逸出 foo()，JIT 会做标量替换，不真正分配在堆上
public void foo() {
    Point p = new Point(1, 2);  // 可能被拆成 int x=1, int y=2 直接放栈
    System.out.println(p.x + p.y);
}
```
