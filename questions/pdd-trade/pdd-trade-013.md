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
