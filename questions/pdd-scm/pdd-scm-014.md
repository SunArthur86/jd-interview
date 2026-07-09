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
