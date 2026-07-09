---
id: pdd-trade-015
difficulty: L2
category: pdd-trade
subcategory: Java 集合
tags:
- 拼多多
- 交易
- HashMap
- 红黑树
feynman:
  essence: HashMap 是"数组+链表/红黑树"，扰动函数让高位参与桶分布，扩容翻倍用高位 bit 判定迁移，负载因子 0.75 是时空折中。
  analogy: HashMap 像分书架图书馆——书号哈希到书架（桶），同架排链表，链长改二叉（红黑树），架挤加架（扩容）。
  first_principle: 哈希表用空间换时间，O(1) 平均查找；B+ 树矮（IO 少）+ 链表/红黑树兜底冲突。
  key_points:
  - 数组+链表/红黑树（链≥8 且容量≥64 转树）
  - 扰动：(h^(h>>>16)) 让高位参与低位
  - 桶定位：(n-1)&hash（n 是 2 的幂）
  - 扩容翻倍，迁移用高位 bit 判定
first_principle:
  problem: 任意 key 平均 O(1) 查找如何实现？
  axioms:
  - 哈希均匀分散
  - 负载因子影响冲突
  rebuild: 数组桶 + 冲突链表/树 + 自动扩容。
follow_up:
- 为什么容量 2 的幂？——(n-1)&hash 等价取模但快
- JDK 7 并发死循环？——头插法成环，JDK 8 尾插解决但非线程安全
- 负载因子 0.75？——时空折中（泊松分布链长 ≈0.5）
memory_points:
- 数组+链表/红黑树（≥8 转树）
- 扰动函数 + (n-1)&hash
- 扩容翻倍、迁移高位 bit 判定
- 0.75 负载因子时空折中
---

# 【拼多多交易】HashMap 原理？扩容机制？

> JD 依据："JAVA 基础扎实"。

## 一、数据结构

```
table[] (Node 数组，2 的幂)
  ├─[i] → Node → Node → ... → TreeNode（≥8 转红黑树）
```

## 二、哈希与定位

```java
hash = (key.hashCode()) ^ (key.hashCode() >>> 16);  // 扰动
index = (n - 1) & hash;  // n 是 2 的幂，等价取模但快
```

## 三、扩容

触发：size > capacity × 0.75。
- newCap = oldCap << 1（翻倍）
- 迁移：看 hash 高一位 bit（0 原位 / 1 原位+oldCap）

## 四、线程安全

- JDK 7 头插法并发成环 → 死循环
- JDK 8 尾插解决成环但仍非线程安全
- 并发用 ConcurrentHashMap

## 五、底层本质

HashMap 是"空间换时间"经典——O(1) 平均，最坏 O(n)（冲突），红黑树兜底 O(logn)。

## 常见考点
1. **容量为什么 2 的幂**？——(n-1)&hash 等价取模更快。
2. **为什么 0.75**？——泊松分布下链长约 0.5，时空折中。
3. **自定义 key 要重写什么**？——hashCode 和 equals（契约一致）。
