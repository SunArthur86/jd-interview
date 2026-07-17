---
id: pdd-content-004
difficulty: L3
category: pdd-content
subcategory: JVM
tags:
- 拼多多
- 内容
- JVM
- GC
- G1
feynman:
  essence: GC 用"分代+可达性分析+回收算法"自动管理内存；G1 是分区化收集器，适合大堆低延迟，内容社区服务（评价/直播网关）多用 G1。
  analogy: GC 像城市环卫——新生代是快餐盒（朝生夕灭，频繁扫）、老年代是建筑（长期驻留，少扫），G1 把城市划成块（Region）按收益回收。
  first_principle: 内存有限，对象有生死，需自动识别死对象回收空间，且不能长时间停业务。
  key_points:
  - 分代：新生代（Eden+S0/S1）/老年代
  - 算法：标记-清除/标记-复制/标记-整理
  - 可达性分析：GC Roots 找活对象
  - G1：Region 化 + 可预测停顿 + 并发标记
first_principle:
  problem: 内存有限+对象有生死，如何自动回收且不长时间停业务？
  axioms:
  - 多数对象朝生夕灭
  - 跨代引用少
  - STW 影响用户体验
  rebuild: 分代回收 + 可达性分析 + 并发标记（G1/ZGC）降 STW。
follow_up:
  - G1 和 CMS 区别？——G1 分 Region 可预测停顿，CMS 用标记清除有碎片
  - 怎么选 GC？——堆 <8G 用 Parallel，8-32G 用 G1，>32G 用 ZGC
  - Full GC 怎么排查？——看老年代占用/Survivor 太小晋升快/Metaspace 溢出
memory_points:
  - 分代：新生代（Eden+S0/S1）/老年代
  - 算法：复制（新）/标记清除/整理（老）
  - G1：Region + 可预测停顿
  - GC Roots：栈/静态/常量/JNI
---

# 【拼多多内容】GC 原理与 G1 调优（评价/直播服务）？

> JD 依据："稳定性建设"、"系统架构优化"。

## 一、GC 分代模型

```
堆内存
├── 新生代（1/3）
│   ├── Eden（8/10）
│   ├── Survivor0（1/10）
│   └── Survivor1（1/10）
└── 老年代（2/3）

对象流转：Eden → Minor GC（存活进 S0）→ S0/S1 反复 → 15 岁 → 老年代
```

** Minor GC **：新生代回收（频繁、快）。
** Major/Full GC **：老年代/全堆（少、慢）。

## 二、回收算法

| 算法 | 过程 | 适用 |
|------|------|------|
| 标记-清除 | 标活→清死 | 简单但有碎片 |
| 标记-复制 | 活对象复制到另一半 | 新生代（Survivor） |
| 标记-整理 | 标活→整理到一端 | 老年代（无碎片） |

**可达性分析**：从 GC Roots（栈变量/静态字段/常量/JNI）遍历，不可达即死。

## 三、G1（Garbage First）

```
堆划分成 ~2048 个 Region（每个 1-32MB）
  [E][E][S][O][O][H][H][O][O]...   E=Eden S=Survivor O=Old H=Humongous
```

**核心特点**：
1. **Region 化**：不再物理分代，逻辑分代
2. **可预测停顿**：`-XX:MaxGCPauseMillis=200`，按收益（垃圾最多）优先回收 Region
3. **并发标记**：CMS 思路，标记阶段不 STW
4. **混合回收**：CSet 包含所有新生代 + 部分老年代 Region

**G1 回收流程**：
```
1. 初始标记（STW，搭 Young GC 顺风车）
2. 根区域扫描（并发，扫描 S 区指向老年代的引用）
3. 并发标记（并发，标记活对象）
4. 重新标记（STW，处理 SATB）
5. 筛选回收（STW，按收益排序回收 CSet）
```

## 四、内容场景调优

**评价服务**（对象多、有缓存）：
```bash
-Xms8g -Xmx8g                            # 堆固定（避免扩容抖动）
-XX:+UseG1GC
-XX:MaxGCPauseMillis=200                 # 目标停顿 200ms
-XX:G1HeapRegionSize=16m                 # 大对象多时调大 Region
-XX:InitiatingHeapOccupancyPercent=45    # 老年代 45% 触发并发标记
-XX:G1ReservePercent=20                  # 保留空间防疏散失败
```

**直播网关**（要求低延迟）：
```bash
-XX:MaxGCPauseMillis=100                 # 更激进
-XX:G1NewSizePercent=30                  # 新生代下限（防频繁 Minor）
-XX:G1MaxNewSizePercent=50
```

## 五、Full GC 排查

```
Full GC 厸因：
1. 老年代撑满（缓存无界/Memory Leak）
2. Metaspace 溢出（动态生成类多）
3. System.gc() 被显式调用（设 -XX:+DisableExplicitGC）
4. CMS 疏散失败（晋升太快，Survivor 太小）
排查：
  jstat -gcutil <pid> 1s  看 OG/M 占用变化
  jmap -histo:live | head 找大对象
  MAT/jvisualvm 分析 dump
```

## 六、底层本质

GC 本质是**"用分代+算法+并发把死对象自动回收且 STW 最小"**——分代利用"朝生夕灭"特性，并发标记降停顿，Region 化让回收可控。

## 常见考点
1. **对象什么时候进老年代**？——大对象直接进、年龄到阈值（默认 15）、动态年龄计算、Survivor 装不下。
2. **CMS 和 G1 怎么选**？——CMS 已废弃（JDK 14），G1 是 JDK 9+ 默认。
3. **怎么避免 GC 抖动**？——堆固定 + 合理 Region + 监控晋升速率。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：评价服务和直播网关都用 G1，但参数不同（评价 MaxGCPauseMillis=200，直播网关=100），为什么不统一？统一管理不是更省事吗？**

两个服务的 SLA 和对象特征完全不同。直播网关是低延迟实时链路——弹幕推流 P99 要求 <50ms，一次 200ms 的 GC 停顿会让百万级观众同时卡顿，所以停顿目标必须压到 100ms 以下，代价是更频繁的 Minor GC（吞吐略降）。评价服务是"准实时"——用户提交评价后即使 200ms 停顿也只是个别请求超时重试，不影响业务，所以可以放宽停顿到 200ms 换更高吞吐。统一参数意味着要么直播网关抖动（统一到 200ms），要么评价服务白白牺牲吞吐（统一到 100ms）。GC 参数本质是"为每个服务的 SLA 量身定制"，不存在一刀切。

### 第二层：证据与定位

**Q：直播网关 P99 抖动到 800ms，你怎么确认是 GC 导致的，而不是 Netty EventLoop 阻塞或 Redis 慢？**

三组证据交叉验证：
1. `jstat -gcutil <pid> 1000` 连续采样——如果 GCT 列在 P99 抖动时刻有突增（如某秒 GCT 涨 150ms），且时间点和用户感知的卡顿吻合，初步锁定 GC。
2. GC 日志（`-Xlog:gc*:file=/log/gc.log:time,uptime`）——grep "Pause" 找停顿 >100ms 的事件，看是 Young GC 还是 Mixed GC，停顿时间分布。
3. Netty 侧——`io.netty.eventloop.blockingTaskTime` 监控，如果 EventLoop 没有阻塞（业务线程池隔离），但 P99 仍抖，排除业务阻塞，指向 GC。

### 第三层：根因深挖

**Q：G1 GC 日志显示频繁 Mixed GC 且单次停顿 150ms（目标 100ms），你查下来发现是 Humongous 对象多。这和 Region 大小什么关系？**

G1 的 Humongous 对象是指超过 Region 大小 50% 的对象，它们直接分配在连续的 Humongous Region，不进新生代，回收要等 Mixed GC（频率低）。直播网关的 Humongous 来源常见是：弹幕批量聚合的大 List（一次攒 1000 条弹幕）、Netty 的 DirectByteBuf 池、以及 protobuf 序列化的大消息体。如果 Region 是默认的 1MB（小堆时），稍微大点的 List 就成 Humongous，导致 Mixed GC 频繁且停顿长。解决是把 `G1HeapRegionSize` 从 1m 调到 16m（堆 8G 时 G1 本就倾向 16m），让大部分对象不再是 Humongous；同时业务层控制批量大小，弹幕攒包从 1000 条降到 200 条。

### 第四层：方案权衡

**Q：直播网关停顿要求从 100ms 压到 50ms 以下，你考虑换 ZGC。什么情况下值得换，什么情况下不值得？**

换 ZGC 的门槛很高，先算账：
1. ZGC 在 JDK 17+ 才生产可用（JDK 11/15 是实验态），停顿能压到 <10ms，但吞吐降 10-15%——同样 QPS 要多 15% 机器。
2. 当前 G1 + MaxGCPauseMillis=100 如果实际停顿 P99 已经在 80ms，只有偶发 150ms，那不值得换——换 ZGC 的收益（50ms→10ms）用户感知极弱，但机器成本涨 15%。
3. 只有当堆 >32G（G1 的 Mixed GC 停顿会显著拉长）或 SLA 明确要求停顿 <20ms（如金融撮合）才换。
直播网关的替代方案：先优化 G1——`MaxGCPauseMillis=50` + `G1HeapRegionSize=32m` + `G1NewSizePercent=40`（防新生代过小频繁 Young GC），如果优化后 P99 停顿能到 60ms，就不换 ZGC。

### 第五层：验证与沉淀

**Q：你调了 G1 参数（Region 16m + IHOP 35%），怎么证明调优有效，而不是当天流量刚好低？**

上线前采 1 周基线（GC 日志的停顿分位 P50/P90/P99、Mixed GC 频率、Young GC 频率、业务 P99），上线后采 1 周。关键对比指标：
1. 停顿分位——按相同流量分桶（如 QPS 5k/10k/20k）对比 P99 停顿，消除流量因素。
2. Mixed GC 频率归一化——`Mixed GC 次数 / GCT 总时长`，看单位时间的回收效率是否提升。
3. Humongous 分配量——GC 日志里 `Humongous regions` 数量是否显著下降（这是 Region 调大的直接证据）。
沉淀：所有服务上线必带 GC 日志（`-Xlog:gc*`）+ Prometheus 采 GC 指标（FGC 频率、停顿分位）；停顿 P99 > SLA 的 50%（如 SLA 200ms 则停顿 >100ms 告警）；GC 参数按服务类型分模板（网关类/写入类/计算类），新服务从模板起。

## 结构化回答

**30 秒电梯演讲：** 内存有限+对象有生死，如何自动回收且不长时间停业务？简单说就是——GC 用"分代+可达性分析+回收算法"自动管理内存；G1 是分区化收集器，适合大堆低延迟，内容社区服务（评价/直播网关）多用 G1。算法：复制（新）/标记清除/整理（老）；G1：Region + 可预测停顿。

**展开框架：**
1. **分代** — 分代：新生代（Eden+S0/S1）/老年代
2. **算法** — 算法：复制（新）/标记清除/整理（老）
3. **G1** — G1：Region + 可预测停顿

**收尾：** 您想继续往深里聊吗——比如「G1 和 CMS 区别？」

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：GC 原理与 G1 调优（评价/直播服务）？ | 今天聊「GC 原理与 G1 调优（评价/直播服务）？」。一句话：GC 用"分代+可达性分析+回收算法"自动管理内存；G1 是分区化收集器，适合大堆低延迟 | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：分代：新生代（Eden+S0/S1）/老年代 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：算法：复制（新）/标记清除/整理（老） | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：G1：Region + 可预测停顿 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——G1 和 CMS 区别？。 | 收尾 |
