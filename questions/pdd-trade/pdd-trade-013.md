---
id: pdd-trade-013
difficulty: L3
category: pdd-trade
subcategory: JVM
tags:
- 拼多多
- 交易
- JVM
- GC
- G1
feynman:
  essence: JVM GC 分代回收（新生代复制/老年代标记整理）+ G1（Region 化可预测停顿），交易大促 GC 调优是稳定性关键。
  analogy: GC 像仓库定期清滞销品——新品（Eden）频繁清，长销品（Old）定期大清，G1 按价值分区清。
  first_principle: 弱分代假说让分代成本最优；G1 Region 化让停顿可控。
  key_points:
  - 分代：新生代复制、老年代标记整理
  - G1：Region + MaxGCPauseMillis + Mixed GC
  - 调优：减少 Full GC、控停顿
  - JDK 9+ 默认 G1
first_principle:
  problem: 海量对象分配回收如何停顿可控？
  axioms:
  - 多数对象朝生夕灭
  - STW 是延迟瓶颈
  rebuild: 分代 + G1 Region 可预测停顿。
follow_up:
- 交易用什么 GC？——G1（低延迟）
- Full GC 频繁怎么排查？——jstat + jmap + MAT
- 大对象怎么处理？——G1 Humongous Region
memory_points:
- 分代：新生代复制/老年代标记整理
- G1：Region + 可预测停顿 + Mixed GC
- JDK 9+ 默认 G1
- 调优目标：减少 Full GC
---

# 【拼多多交易】JVM GC 怎么调优？

> JD 依据："JVM 调优经验"。

## 一、分代与算法

```
新生代（Eden:S0:S1=8:1:1）→ 复制算法
老年代 → 标记整理
对象：Eden → Minor GC → Survivor(年龄+1) → 15 岁 → Old
```

## 二、G1（交易主流）

```
堆切 2048 Region（1-32MB）
  ├─ Eden/Survivor/Old/Humongous Region
Garbage First：优先回收价值最高 Region
Mixed GC：Young + 部分 Old，避免 Full GC
可预测停顿：-XX:MaxGCPauseMillis=100
```

## 三、交易大促 GC 调优

```bash
-Xms16g -Xmx16g
-XX:+UseG1GC
-XX:MaxGCPauseMillis=100
-XX:G1HeapRegionSize=16m
-XX:InitiatingHeapOccupancyPercent=35
```

排查 Full GC：
```bash
jstat -gcutil <pid> 1000   # 看 O/FGC
jmap -histo:live <pid>     # 看大对象 Top
# MAT 分析 dump
```

## 四、底层本质

分代假说让 GC 成本从 O(全堆) → O(有效区域)；G1 Region 化把 Full GC 拆增量 Mixed GC，停顿可控。

## 常见考点
1. **G1 和 CMS 区别**？——G1 Region+可预测停顿+Mixed；CMS 标记清除有碎片。
2. **对象一定在堆吗**？——逃逸分析可栈上分配。
3. **可达性分析**？——GC Roots 引用链，不可达回收。

## 苏格拉底式面试追问

> 这组追问不背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：交易服务你选 G1 而不是 ZGC（ZGC 停顿更低 <10ms），做这个决策的依据是什么？**

交易服务的 GC 目标是"P99 延迟可控 + 吞吐够用"。G1 的 `MaxGCPauseMillis=100` 能把停顿控制在 100ms 以内，满足交易 P99 <200ms 的 SLA。ZGC 停顿确实更低（<10ms），但它的吞吐代价是 10-15%（并发标记和读屏障开销），意味着同样 QPS 要多 15% 机器。交易服务堆 16G，G1 足够；ZGC 的优势在超大堆（>32G）或极致低延迟（金融交易 <10ms）。决策依据是看 SLA（P99 要求）、堆规模、吞吐代价——不是"谁更先进"，是"够用且划算"。如果交易服务堆涨到 64G 或 SLA 收到 50ms，再换 ZGC。

### 第二层：证据与定位

**Q：交易大促期间 P99 突然飙到 2 秒，你怎么确认是 GC 导致的，而不是下游服务慢？**

先排除下游，再聚焦 GC。三步：
1. `jstat -gcutil <pid> 1000` 连续采样——如果 P99 飙高时段 FGC（Full GC 次数）在涨、FGCT（Full GC 总耗时）和 P99 飙高时间吻合，初步锁定 GC。如果 FGC 没变但 P99 飙，是下游问题，看 APM 的 RPC 耗时。
2. 看 GC 日志（`-Xlog:gc*:file=gc.log:time`）——找 P99 飙高时段的 GC 事件，看是 Young GC 还是 Mixed GC 还是 Full GC，停顿时间多少。如果单次 GC 停顿就 2 秒，说明 GC 严重（可能是 Full GC 或疏散失败 Evacuation Failure）。
3. 看 APM 的"应用自身处理时长"——如果 P99 飙高期间 RPC/DB 耗时正常，但应用自身处理时长变长，且这段时间有长 GC 停顿，确认是 GC。关键是把 GC 事件和 P99 飙高做时间对齐，而不是各自猜测。

### 第三层：根因深挖

**Q：你确认是大促期间频繁 Full GC（每 2 分钟一次，停顿 1.5 秒），根因是什么？光是把 IHOP（触发并发标记阈值）调低就行吗？**

调 IHOP 是治标。根因要看 Full GC 的触发原因。`jstat -gccause` 显示的 `cause` 字段：
1. 如果是 `Allocation Failure`——老年代放不下新晋升对象。`jmap -histo:live <pid>` 看老年代大对象 Top，再用 `jmap -dump:format=b,file=heap.hprof` + MAT 分析 Dominator Tree。拼多多交易常见是大促期间缓存（如商品详情、库存快照）未设上限，对象堆积晋升老年代。根因是业务缓存无上限，不是 GC 参数。
2. 如果是 `Humongous Allocation`——大对象（>Region 一半）直接进 Humongous Region，G1 处理 Humongous 易触发 Full GC。查代码是不是有大数组/大字符串（如把整个订单列表序列化成 JSON）。
3. 如果是 `Metadata GC Threshold`——Metaspace 不够（动态生成 Class，如反射/CGLIB），调大 `-XX:MaxMetaspaceSize`。根因定位要靠 GC 原因字段 + dump 分析，不是拍脑袋调参数。

**Q：那为什么不直接把堆调到 64G，老年代大了不就不 Full GC 了？**

调大堆只是延缓。如果根因是缓存无上限，16G 堆 2 分钟一次 Full GC，64G 堆 8 分钟一次——早晚还是爆，且 64G 堆一旦 Full GC 停顿更久（G1 在超大堆 Full GC 是灾难）。治本是从源头控制对象数量（缓存设 `maximumSize` + TTL）。另一个问题是 64G 堆的 G1 Mixed GC 停顿会更长（要扫更多 Region），可能违反 `MaxGCPauseMillis`。调堆适合"对象数量稳定但确实多"的场景，不适合"对象无界增长"的泄漏场景。先治泄漏再谈调堆，顺序反了就是浪费机器。

### 第四层：方案权衡

**Q：你给缓存设了 `maximumSize=100000` 解决了 Full GC，但业务说缓存命中率降了，大促期间 DB 压力上升，你怎么权衡"GC 稳定"和"缓存命中"？**

权衡方案是"分层缓存 + 智能淘汰"：
1. 量化影响——命中率从多少降到多少？DB QPS 从多少升到多少？如果命中率降 5%、DB QPS 还在容量内，可接受。如果 DB 撑不住，要补缓存。
2. 多级缓存——本地缓存（Caffeine，小而快，挡热点）+ Redis（大而慢，兜底）。本地缓存设小上限（如 1 万，堆可控），命中率不够的由 Redis 补。这样既控堆内存又保命中率。
3. 智能淘汰策略——Caffeine 用 W-TinyLFU 算法（比 LRU 命中率高），在相同内存下命中率更高。或按"大促热销商品"预加载，把有限的缓存空间用在热点上。本质是"用更聪明的缓存策略在有限内存下最大化命中"，而不是"无限堆内存换命中"。

**Q：为什么不直接换 ZGC，Full GC 问题不就消失了？**

ZGC 没有 Full GC，但问题依然在——内存泄漏会导致 ZGC 的并发标记开销增大（要标记更多对象），虽然不停顿但吞吐下降。且 ZGC 的 Humongous 对象处理也有代价。换 ZGC 是"把停顿问题换成吞吐问题"，根因（对象无界增长）没解决。只有当缓存治理后（对象数量可控），堆确实需要很大或延迟要求极低时，才考虑 ZGC。当前 16G 堆 + G1 + 缓存治理已满足 SLA，换 ZGC 是过度工程，多花 15% 机器钱解决一个不存在的问题。

### 第五层：验证与沉淀

**Q：你怎么证明 GC 调优真的有效，而不是"那天大促流量恰好低"？**

上线前采基线，上线后做归一化对比：
1. 基线——上线前采 1 周的 GC 数据（FGC 频率、FGCT、Young GC 停顿 P99）和业务数据（P99、下单成功率、QPS）。
2. 归一化对比——上线后同流量时段对比 FGC 频率。为了消除流量波动，用 `FGC/QPS`（单位流量的 Full GC 次数）对比，如果上线后 FGC/QPS 显著下降且 P99 稳定，证明是调优效果。单纯看 FGC 次数下降可能只是流量低了。
3. 大促复盘——大促后对比"调优前大促"vs"调优后大促"的 GC 数据（同流量级别），这是最有说服力的证据。拼多多的大促是周期性的，有历史数据可对比。

**Q：GC 调优的经验怎么沉淀，让团队不重复踩坑（如缓存无上限导致 Full GC）？**

沉淀成 JVM 规范 + 监控告警 + 故障库：
1. JVM 参数模板——按服务类型分模板（交易/网关/计算），包含 GC 参数、堆大小、GC 日志配置。新服务用模板，不自己配。
2. GC 监控告警——FGC 频率（如 >1 次/小时告警）、GC 停顿 P99（>200ms 告警）、堆使用率（>80% 告警）。接入 Prometheus + Grafana，自动发现异常。
3. 缓存强制上限——Code Review 检查项：所有 Guava/Caffeine 缓存必须设 `maximumSize`，否则 review 不过。CI 静态扫描兜底。
4. 故障库——每次 GC 问题的根因（如"缓存无上限""大对象序列化""Metaspace 泄漏"）归档，新人入职学习。拼多多这种规模，靠个人经验传承不可靠，必须靠机制。

## 结构化回答

**30 秒电梯演讲：** 海量对象分配回收如何停顿可控？简单说就是——JVM GC 分代回收（新生代复制/老年代标记整理）+ G1（Region 化可预测停顿），交易大促 GC 调优是稳定性关键。

**展开框架：**
1. **分代** — 分代：新生代复制、老年代标记整理
2. **G1** — G1：Region + MaxGCPauseMillis + Mixed GC
3. **调优** — 调优：减少 Full GC、控停顿

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：JVM GC 怎么调优？ | 今天聊「JVM GC 怎么调优？」。一句话：JVM GC 分代回收（新生代复制/老年代标记整理）+ G1（Region 化可预测停顿），交易大促 GC 调优是稳定… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：分代：新生代复制、老年代标记整理 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：G1：Region + MaxGCPauseMillis + Mixed GC | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：调优：减少 Full GC、控停顿 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
