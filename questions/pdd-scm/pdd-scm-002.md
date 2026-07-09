---
id: pdd-scm-002
difficulty: L3
category: pdd-scm
subcategory: JVM
tags:
- 拼多多
- 供应链
- JVM
- OOM
- 内存泄漏
feynman:
  essence: JVM 内存分堆/非堆/直接内存，OOM 按区域分 5 类；排查靠"分类型→dump→MAT 支配树→GC Root 引用链→代码"五步，供应链最常见的 OOM 是大批量商品数据一次性加载。
  analogy: JVM 内存像仓库分区——堆是主仓库（货物/对象），元空间是档案室（类信息），直接内存是装卸区（NIO），线程是叉车。某个区爆仓就是对应 OOM。
  first_principle: 内存是有限资源，OOM = 申请超容量；根因要么瞬时需求大（流量洪峰），要么慢性泄漏（只进不出）。
  key_points:
  - OOM 五类型：heap / Metaspace / GC overhead / Direct buffer / thread
  - 必配：-XX:+HeapDumpOnOutOfMemoryError
  - MAT 三件套：Dominator Tree、Histogram、Leak Suspects
  - 在线诊断：arthas、jmap -histo:live
first_principle:
  problem: 线上 JVM 突然 OOM，如何在不中断服务的情况下定位是哪类 OOM、哪个对象、哪段代码？
  axioms:
  - OOM 必有支配对象（占用最大）
  - dump 是现场快照
  - 泄漏的特征是"对象只增不减"
  rebuild: 分类型 → dump → MAT 找支配树根 → 看 GC Root 引用链 → 定位代码（静态集合/ThreadLocal/未关资源）→ 修复。
follow_up:
- 供应链系统常见 OOM 根因？——批量导出商品 Excel（百万行加载内存）、订单全量同步、缓存无上限
- 怎么在线看大对象？——arthas dashboard + heapdump；jmap -histo:live 看 Top
- 怎么预防？——缓存必须有 LRU/TTL、批量必须有分页、返回集合必须有上限
memory_points:
- OOM 五类型：heap / Metaspace / GC overhead / Direct buffer / thread
- HeapDumpOnOutOfMemoryError 必配
- MAT Dominator Tree 找最大支配对象
- 供应链最大坑：批量导出/同步一次性加载全量数据
---

# 【拼多多供应链】线上 OOM 怎么排查？供应链系统最常见的 OOM 场景？

> JD 依据："JVM 原理和调优经验" + "线上系统稳定性和维护经验"。

## 一、OOM 五类型

| OOM 信息 | 含义 | 典型根因 |
|---------|------|---------|
| `Java heap space` | 堆满 | 大对象/泄漏/批量加载 |
| `GC overhead limit exceeded` | GC 占 98% 时间回收 2% | 泄漏（无法释放） |
| `Metaspace` | 元空间满 | CGLIB/反射动态生成 Class |
| `Direct buffer memory` | 直接内存满 | NIO ByteBuffer 泄漏 |
| `unable to create new native thread` | 线程过多 | 线程池无界/每次 new Thread |

## 二、排查五步法

```
1. 保留现场：-XX:+HeapDumpOnOutOfMemoryError（必配）
2. 在线诊断：jstat -gcutil / arthas dashboard / jmap -histo:live
3. dump + MAT 分析：Dominator Tree 找最大支配对象
4. 看 GC Root 引用链：为什么没被回收（static 字段/ThreadLocal/未关资源）
5. 定位代码修复
```

## 三、供应链典型 OOM 场景

**场景 1：商品批量导出**
```java
// ❌ 一次性把百万商品加载到内存
List<Product> all = productDao.findAll();  // OOM!
writeExcel(all);

// ✅ 流式 + 分页
int page = 0;
while (true) {
    List<Product> batch = productDao.findPage(page++, 1000);
    if (batch.isEmpty()) break;
    writeExcelRow(batch);  // 用 EasyExcel 的 SXSSF 流式写
}
```

**场景 2：订单全量同步**
```java
// ❌ 全量加载订单同步到下游
List<Order> orders = orderDao.findByDateRange(year);  // 千万级 → OOM

// ✅ 游标分页（避免 OFFSET 深分页性能问题）
long lastId = 0;
while (true) {
    List<Order> batch = orderDao.findByIdGreaterThan(lastId, 1000);
    if (batch.isEmpty()) break;
    syncToDownstream(batch);
    lastId = batch.get(batch.size() - 1).getId();
}
```

**场景 3：商品缓存无上限**
```java
// ❌ 静态 HashMap 缓存商品（永不淘汰）
private static final Map<Long, Product> CACHE = new HashMap<>();
// 拼多多千万级 SKU → 几个 GB → OOM

// ✅ Caffeine 带上限和 TTL
private static final Cache<Long, Product> CACHE = Caffeine.newBuilder()
    .maximumSize(500_000)
    .expireAfterWrite(10, MINUTES)
    .build();
```

## 四、MAT 分析实战

**Leak Suspects 报告**会直接指出嫌疑：
```
800MB 由 com.pdd.scm.ProductCache 占用（堆的 80%）
引用链: ProductCache.map (static) → HashMap$Node[] → ...
```

**Dominator Tree** 看 Retained Heap（支配大小）排序，最大的是罪魁。

**Path To GC Roots**（排除 weak/soft 引用）看为什么没回收——static 字段是最常见的 GC Root。

## 五、预防机制（拼多多经验）

1. **所有缓存必须有上限和 TTL**
2. **所有批量接口必须分页**（单页 ≤ 1000）
3. **所有返回集合必须有 size 上限**（防止下游传超大条件）
4. **监控告警**：堆使用率 > 80% 告警，Full GC 频率 > 1/10min 告警
5. **压测验证**：大促前压测找出内存瓶颈

## 六、底层本质：内存的"申请-释放"契约

OOM = 申请 > 可用。根因两类：
- **瞬时需求大**：扩容/限流/降级
- **慢性泄漏**：找泄漏点修复

Java 自动 GC 不代表不泄漏——**"引用没解除"就是泄漏**。供应链的高频大查询最容易触发，必须有系统性的上限保护。

## 常见考点
1. **怎么区分 OOM 和 Full GC 频繁**？——OOM 是申请失败抛异常；Full GC 频繁是 GC 拼命回收但还没失败。
2. **StackOverflowError 和 OOM 区别**？——栈溢出（递归太深）vs 堆/元空间溢出。
3. **`-XX:+HeapDumpOnOutOfMemoryError` 会停服吗**？——会触发 Full GC dump（停顿几秒到几十秒），生产建议只在 OOM 时触发。
