---
id: pdd-scm-014
difficulty: L3
category: pdd-scm
subcategory: JVM
tags:
- 拼多多
- 供应链
- JVM
- GC
- G1
feynman:
  essence: JVM GC 用"分代回收（新生代复制、老年代标记整理）+ 不同收集器（G1 低延迟）"，调优目标是减少 Full GC、控制停顿时间，供应链大促 GC 调优是稳定性关键。
  analogy: GC 像仓库定期清滞销品——新品（Eden）频繁清（Minor GC），长销品（Old）定期大清（Full GC），G1 像按价值分区清（回收收益最高的 Region 优先）。
  first_principle: 弱分代假说（多数对象朝生夕灭）让分代回收成本最优；G1 用 Region 化把停顿可控。
  key_points:
  - 分代：新生代（Eden+S0+S1，复制）+ 老年代（标记整理）
  - G1：Region 化、可预测停顿（MaxGCPauseMillis）、Mixed GC
  - 调优核心：减少 Full GC，让对象在 Minor GC 被回收
  - 工具：jstat、jmap、arthas
first_principle:
  problem: 海量对象分配/回收如何让 GC 停顿可控？
  axioms:
  - 多数对象朝生夕灭（弱分代假说）
  - STW 是延迟瓶颈
  - 全堆扫描成本高
  rebuild: 分代（新生代复制算法、老年代标记整理）+ G1（Region 化、可预测停顿、Mixed GC）。
follow_up:
- 供应链服务用什么 GC？——G1（低延迟，JDK 9+ 默认）
- 怎么定位 Full GC 频繁？——jstat 看 FGCT/FGC，jmap dump 分析大对象
- 大对象怎么处理？——G1 自动放 Humongous Region，避免在新生代来回复制
memory_points:
- 分代：新生代复制、老年代标记整理
- G1：Region + 可预测停顿 + Mixed GC
- JDK 9+ 默认 G1；JDK 15+ 移除 CMS
- 调优目标：减少 Full GC、控停顿
---

# 【拼多多供应链】JVM GC 原理？G1 怎么调优？

> JD 依据："JVM 原理和调优经验"。

## 一、分代结构

```
新生代（Young）= 1/3 堆
  Eden : S0 : S1 = 8 : 1 : 1
老年代（Old）= 2/3 堆
```

对象分配：Eden → Minor GC 后存活进 Survivor（年龄+1）→ 15 岁进 Old。大对象直接进 Old。

## 二、GC 算法

| 算法 | 适用 | 原理 |
|------|------|------|
| 复制 | 新生代 | 存活对象复制到另一半 |
| 标记-清除 | CMS Old | 标记存活清除死亡，有碎片 |
| 标记-整理 | Parallel Old | 标记后向一端移动，无碎片 |

## 三、收集器演进

```
Parallel Scavenge + Parallel Old   （吞吐优先）
   ↓
ParNew + CMS                        （延迟优先，JDK 14 移除）
   ↓
G1（JDK 9+ 默认）                    （Region + 可预测停顿）
   ↓
ZGC / Shenandoah                    （亚毫秒停顿）
```

## 四、G1 详解（供应链主流选择）

```
堆切成 2048 个 Region（1-32MB 每个）
  ├─ Eden Region
  ├─ Survivor Region
  ├─ Old Region
  └─ Humongous Region（大对象）

Garbage First：优先回收价值最高（垃圾多）的 Region
Mixed GC：既回收 Young 也回收 Old（部分），避免 Full GC
可预测停顿：-XX:MaxGCPauseMillis=200（软目标）
```

## 五、供应链 GC 调优实战

**问题**：大促时供应链服务 Full GC 频繁，停顿 3-5 秒。

**排查**：
```bash
jstat -gcutil <pid> 1000
#  O(老年代) 98%, FGC(次数)频繁, FGCT(总耗时)长

jmap -dump:format=b,file=heap.hprof <pid>
# MAT 分析 → Guava Cache 无上限，存了 4G 商品数据
```

**调优**：
```bash
-Xms16g -Xmx16g                          # 堆固定避免抖动
-XX:+UseG1GC
-XX:MaxGCPauseMillis=100
-XX:G1HeapRegionSize=16m
-XX:InitiatingHeapOccupancyPercent=35    # 提前触发并发标记
-XX:G1ReservePercent=15
```

**业务层**：缓存加 `maximumSize=500000` + TTL。

**效果**：Full GC 消失，Young GC 平均 40ms，P99 从 800ms → 120ms。

## 六、底层本质

分代假说让 GC 成本从 O(全堆) 降到 O(有效扫描区域)；G1 的 Region 化让"回收价值最高区域"成为可能，把全堆 Full GC 拆成增量 Mixed GC，停顿可控。

## 常见考点
1. **G1 和 CMS 区别**？——G1 Region 化、可预测停顿、Mixed GC；CMS 标记清除有碎片、Concurrent Mode Failure 退化为 Serial Old。
2. **对象一定在堆上吗**？——不一定，逃逸分析可栈上分配（标量替换）。
3. **怎么判断对象可回收**？——可达性分析（GC Roots 引用链），不可达则回收。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：供应链服务大促前你把 GC 从 Parallel 换成 G1。Parallel 吞吐更高，为什么供应链不用？**

Parallel 的吞吐高（GC 停顿时间占总运行时间比例低），但停顿是"单次长停顿"——Full GC 时 STW 几秒，对吞吐型应用（如离线批处理）无所谓，但对供应链这种"低延迟交易链路"是灾难。下单扣库存如果卡 3 秒，用户超时重试，雪崩。G1 的优势是"可预测停顿"——`MaxGCPauseMillis=200` 让每次 GC 停顿软目标 200ms，用 Region 化 + Mixed GC 把全堆 Full GC 拆成增量回收，单次停顿可控。供应链选 G1 是牺牲一点吞吐换延迟稳定。

### 第二层：证据与定位

**Q：上线 G1 后，大促时服务 P99 抖动到 800ms，监控显示是 GC 停顿。你怎么确认是 Young GC 慢还是 Mixed GC 慢？**

看 GC 日志（`-Xlog:gc*`）和 jstat：
1. **GC 日志区分类型**——`[GC pause (G1 Evacuation Pause) (young)]` 是 Young GC，`[GC pause (G1 Evacuation Pause) (mixed)]` 是 Mixed GC。看每条的 `Pause Time`，如果 Young GC 都 200ms+，是新生代回收慢（Eden 太大或存活对象多）；如果 Mixed GC 慢，是老年代 Region 回收慢。
2. **jstat -gcutil**——`YGC`（Young GC 次数）和 `YGCT`（Young GC 总耗时），算 `YGCT/YGC` 是平均 Young GC 耗时；`FGC`（Full GC 次数），如果 FGC > 0，说明 Mixed GC 扛不住退化为 Full GC（最严重）。
3. **G1 日志的 Region 统计**——看 `[Eden: 1024M(256)->0M(0) Survivors: 32M->32M Heap: 12G(2048)->11G(2048)]`，如果回收后 Heap 还剩 11G（老年代占用高），说明对象晋升过快，Mixed GC 压力大。

### 第三层：根因深挖

**Q：GC 日志显示 Mixed GC 停顿 600ms（超 MaxGCPauseMillis=200 的软目标）。G1 为什么没遵守停顿目标？**

`MaxGCPauseMillis` 是"软目标"不是硬约束，G1 会根据历史数据预估"在目标停顿内能回收多少 Region"，但预估可能不准。根因有三：
1. **IHOP 阈值不合理**——`InitiatingHeapOccupancyPercent` 默认 45%，老年代占用 45% 才触发并发标记。如果调得太高（如 55%），老年代堆太满才开始 Mixed GC，单次要回收的 Region 多，停顿超目标。调低到 35% 提前标记。
2. **大对象（Humongous）多**——超过 Region 一半的对象是 Humongous，G1 单独分配 Region 存。如果 Humongous 多（如大数组、大 JSON），Mixed GC 要扫描这些 Region，停顿长。看 GC 日志的 `[Humongous regions]` 计数。
3. **记忆集（RSet）更新慢**——跨 Region 引用要维护 RSet，如果引用关系复杂（"跨代引用"多），Mixed GC 更新 RSet 耗时长。`-XX:G1SummarizeRSetStats` 能看 RSet 统计。
根因定位：调 IHOP + 优化大对象分配（拆分或避免）+ 看 RSet 大小。

**Q：那为什么不直接把 MaxGCPauseMillis 调到 50ms，让 G1 更激进地控制停顿？**

调小停顿目标会适得其反：
1. **GC 频率飙升**——G1 为了满足 50ms 停顿，每次只回收少量 Region，GC 次数翻几倍，总 GC 耗时（吞吐）反而上升。
2. **回收不充分**——每次回收太少，老年代涨得比回收快，最终触发 Full GC（退化为 Serial Old，停顿几秒），比 200ms 停顿惨得多。
3. **软目标本质**——G1 是"尽力而为"，设 50ms 不是硬保证。要真正亚毫秒停顿只能换 ZGC/Shenandoah（但吞吐代价 10-15%）。200ms 是 G1 的甜点，配合 IHOP 和 Region 大小调优，比硬调 MaxGCPauseMillis 有效。

### 第四层：方案权衡

**Q：你的供应链服务堆 16GB，大促时发现 Humongous 对象多（库存批量查询返回的大 List），Mixed GC 停顿长。怎么办？**

两个方向：
1. **减小 Humongous**——`G1HeapRegionSize=16m` 时，> 8MB 的对象算 Humongous。根因是 `SELECT * FROM stock WHERE category_id=?` 一次返回 10MB 数据。解法是分页查询（每次 1000 条，约 100KB），从源头消除大对象。
2. **调大 Region**——`G1HeapRegionSize=32m`，Humongous 阈值变 16MB，原来的 10MB List 不再是 Humongous。但 Region 调大意味着单 Region 回收停顿长（复制更多对象），要权衡。一般 Region 大小按堆规模的 1/2048 选（16GB 堆 → 8MB Region）。

**Q：为什么不直接换成 ZGC，亚毫秒停顿彻底解决 Mixed GC 慢的问题？**

ZGC 适合"超大堆 + 超低延迟"场景（堆 > 32GB、停顿 < 10ms），供应链 16GB 堆用 ZGC 不划算：
1. **吞吐代价**——ZGC 的并发标记/转移用染色指针和读屏障，CPU 开销比 G1 高 10-15%，同样 QPS 要多 15% 机器。
2. **成熟度**——ZGC 在 JDK 15 才 production-ready（JDK 21 才默认 generational），供应链线上跑 JDK 11/17，ZGC 还非默认。
3. **问题已治本**——Humongous 慢的根因是大对象（大 List），分页查询消除大对象后，G1 的 Mixed GC 就能稳在 200ms 内。换 ZGC 是过度设计。
只有当堆 > 32GB（如内存计算场景）或停顿 < 50ms（如实时竞价）且 G1 撑不住，才考虑 ZGC。

### 第五层：验证与沉淀

**Q：你怎么证明 G1 调优真的有效、大促时 GC 停顿可控？**

三组数据对比验证：
1. **GC 日志基线**——调优前后各跑 1 周大促压测，对比 `jstat -gcutil` 的 FGC 次数（应归零）、FGCT（应 = 0）、Young GC 平均停顿（应 < 100ms）。
2. **APM P99**——调优前 P99 800ms，调优后 P99 < 200ms，且 GC 停顿占总延迟比例从 60% 降到 10%（`gc_pause / total_latency`）。
3. **流量归一化**——`Full_GC_count / QPS` 调优后趋近 0，证明不是流量低导致 FGC 少，而是调优效果。

**Q：怎么让团队的 JVM 配置规范统一、不再各自调参？**

沉淀 JVM 规范：
1. **JVM 参数模板**——按服务类型分（网关/交易/计算），每类一套标准参数（堆大小、GC、IHOP、监控），新服务启动套模板，禁止手调。
2. **GC 日志强制开启**——所有线上服务必配 `-Xlog:gc*:file=/var/log/gc.log:time,level,tags`，接 ELK 分析，定期出 GC 报告。
3. **GC 告警**——Full GC > 0 立即告警（P0），Young GC 停顿 > 500ms 告警（P1），值班 must action。大促前跑 GC 压测，FGC 不为 0 不让上线。

## 结构化回答

**30 秒电梯演讲：** 海量对象分配/回收如何让 GC 停顿可控？简单说就是——JVM GC 用"分代回收（新生代复制、老年代标记整理）+ 不同收集器（G1 低延迟）"，调优目标是减少 Full GC、控制停顿时间，供应链大促 GC 调优是稳定性关键。

**展开框架：**
1. **分代** — 分代：新生代（Eden+S0+S1，复制）+ 老年代（标记整理）
2. **G1** — G1：Region 化、可预测停顿（MaxGCPauseMillis）、Mixed GC
3. **调优核心** — 调优核心：减少 Full GC，让对象在 Minor GC 被回收

**收尾：** 您看这块要不要再展开聊聊？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：JVM GC 原理？G1 怎么调优？ | 今天聊「JVM GC 原理？G1 怎么调优？」。一句话：JVM GC 用"分代回收（新生代复制、老年代标记整理）+ 不同收集器（G1 低延迟）"，调优目标是减少 Full G… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：分代：新生代（Eden+S0+S1，复制）+ 老年代（标记整理） | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：G1：Region 化、可预测停顿（MaxGCPauseMillis）、Mixed GC | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：调优核心：减少 Full GC，让对象在 Minor GC 被回收 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住核心要点就够了。下期见。 | 收尾 |
