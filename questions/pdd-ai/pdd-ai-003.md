---
id: pdd-ai-003
difficulty: L3
category: pdd-ai
subcategory: JVM
tags:
- 拼多多
- AI 中台
- JVM
- GC
- G1
- ZGC
feynman:
  essence: JVM GC 是"自动回收不再引用的对象"，核心是"找活对象→清理死对象→整理碎片"；模型服务/中台对延迟敏感，要选低延迟收集器（G1/ZGC）并调参。
  analogy: 像小区垃圾分类车——先扫一遍找出"还有人用"（GC Root 可达）的，剩下的清掉，垃圾多了还要整理腾出大块空地（碎片整理）。
  first_principle: 内存有限且对象有生命周期，自动回收能避免手动管理 bug，但 STW（Stop The World）会卡业务，必须平衡吞吐/延迟/内存。
  key_points:
  - GC Root：栈变量/静态字段/JNI/活动线程，可达即活
  - 分代：新生代（Eden+S0+S1，复制算法）/老年代（标记整理）
  - CMS（弃用）/G1（默认，9+）/ZGC（亚毫秒 STW）
  - 调优：堆大小/新生代比/GC 暂停目标/对象预分配
first_principle:
  problem: 有限内存下如何高效回收对象且不影响业务？
  axioms:
  - 大部分对象朝生夕死（新生代）
  - 老对象可能长期存活（老年代）
  - 回收时要停业务线程（STW）才能保证一致
  rebuild: 分代回收（新生代频繁小回收 + 老年代偶尔大回收）+ 并发收集（减少 STW）。
follow_up:
  - G1 和 CMS 区别？——G1 基于Region可预测暂停，CMS 标记清除有碎片，JDK 9 后 G1 默认
  - 怎么排查 Full GC 频繁？——jstat/jmap dump → 找大对象/内存泄漏 → 调新生代比
  - ZGC 为什么这么快？——染色指针 + 读屏障 + 并发整理，STW < 10ms
memory_points:
  - GC Root：栈/静态/JNI/活动线程
  - 新生代复制算法，老年代标记整理
  - G1 默认（9+），ZGC 低延迟（<10ms STW）
  - 调优：堆/新生代比/暂停目标
---

# 【拼多多 AI 中台】JVM GC 原理与模型服务调优怎么做？

> JD 依据："Java + 微服务、模型服务、消费者服务策略算法中台"。

## 一、GC 基础：找活对象

**可达性分析**——从 GC Root 出发，可达即活：
```
GC Roots:
  - 虚拟机栈中的局部变量
  - 方法区的静态字段
  - 方法区的常量
  - 本地方法栈 JNI 引用
  - 活动线程
  - 同步锁持有的对象
```

## 二、分代模型

```
┌──────────────────────────────────────┐
│ 堆 Heap                              │
│  ┌──────────────────┐ ┌────────────┐ │
│  │ 新生代 (1/3)     │ │ 老年代 2/3 │ │
│  │ ┌────┬────┬────┐ │ │            │ │
│  │ │Eden│ S0 │ S1 │ │ │            │ │
│  │ │ 8  │ 1  │ 1  │ │ │            │ │
│  │ └────┴────┴────┘ │ │            │ │
│  └──────────────────┘ └────────────┘ │
└──────────────────────────────────────┘
```

- 新生代：复制算法（Eden 满 → 存活进 S，清空 Eden）
- 老年代：标记-清除/标记-整理（防碎片）

**晋升条件**：年龄 ≥ 阈值（默认 15）/ 大对象直接进老年代 / S 区放不下。

## 三、收集器演进

| 收集器 | 算法 | STW | 适用 |
|--------|------|-----|------|
| Serial | 复制/整理 | 全程 | 单核小应用 |
| Parallel | 复制/整理 | 全程（吞吐优） | 批处理 |
| CMS | 标记清除 | 初始/重新标记 | 老年代低延迟（已弃） |
| **G1** | 整堆 Region 化 | 可预测暂停（200ms） | **默认（9+），通用** |
| **ZGC** | 染色指针+并发整理 | <10ms | 大堆低延迟（11+） |
| Shenandoah | 读屏障并发整理 | <10ms | RedHat |

**G1 关键**：堆分 2048 个 Region（每个 1-32MB），优先回收"垃圾最多"的 Region（Garbage First）。

## 四、模型服务 GC 调优实战

**场景**：LLM 推理网关，请求大（prompt 几 KB），并发高，对 P99 敏感。

**JVM 参数**：
```bash
java -Xms8g -Xmx8g \                   # 堆固定（避免动态扩缩 GC 抖动）
     -XX:+UseG1GC \
     -XX:MaxGCPauseMillis=100 \         # 目标暂停 100ms
     -XX:G1HeapRegionSize=16m \
     -XX:InitiatingHeapOccupancyPercent=45 \  # 老年代占用 45% 触发并发标记
     -XX:G1NewSizePercent=30 \          # 新生代下限
     -XX:G1MaxNewSizePercent=50 \
     -XX:+ParallelRefProcEnabled \
     -XX:+HeapDumpOnOutOfMemoryError \
     -XX:HeapDumpPath=/data/dumps/ \
     -jar inference-gateway.jar
```

**调优思路**：
1. **堆固定 Xms=Xmx**：避免堆动态变化导致频繁 GC。
2. **大堆（>32G）用 ZGC**：G1 在大堆暂停会上升。
3. **新生代比例**：模型请求对象偏大，新生代要够（30-50%），否则快速晋升老年代触发 Full GC。
4. **大对象**：超 RegionSize/2 直接进老年代，监控避免大批大对象。

## 五、排查 Full GC 频繁

```
1. jstat -gcutil <pid> 1000  → 看 O(老年代) 是否持续上涨
2. jmap -histo:live <pid>    → 看对象 top
3. jmap -dump:format=b,file=heap.hprof <pid> → MAT 分析
4. 常见根因：
   - 内存泄漏（静态集合只增不减）
   - 大对象（缓存无上限、批次过大）
   - 新生代太小（频繁晋升）
   - System.gc() 被调用（加 -XX:+DisableExplicitGC）
```

## 六、底层本质

GC 本质是**"用 CPU 换内存安全 + 用 STW 换一致性"**——分代让回收频率匹配对象生命周期，并发收集把 STW 压到最小。模型服务对延迟敏感，要选 G1/ZGC + 堆固定 + 新生代足够大，避免大对象冲击。

## 常见考点

1. **对象什么时候进老年代**？——年龄达阈值/大对象/S 区放不下/动态年龄判断。
2. **CMS 为什么被替换**？——碎片严重 + 并发失败（Concurrent Mode Failure）退化 Full GC。
3. **怎么减少 GC**？——对象池化（避免建销）、缓存有上限、大对象预分配、Stream 懒求值。
