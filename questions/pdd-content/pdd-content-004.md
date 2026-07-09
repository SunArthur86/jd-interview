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
