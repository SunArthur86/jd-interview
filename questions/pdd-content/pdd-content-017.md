---
id: pdd-content-017
difficulty: L4
category: pdd-content
subcategory: Feed 流
tags:
- 拼多多
- 内容
- Feed 流
- 推拉模式
- Redis
feynman:
  essence: Feed 流是"用户主页/关注页"的内容流，核心是"推（写扩散）vs 拉（读扩散）"的取舍；普通用户用推模式、大 V 用拉模式、混合是工业方案。
  analogy: Feed 像快递——推模式是商家发到每个买家门口（写扩散），拉模式是买家来取（读扩散），混合是普通快递+大客户自提。
  first_principle: 内容分发给粉丝需在"写时扩散"和"读时聚合"间权衡，看关注数和活跃度。
  key_points:
  - 推模式（写扩散）：发时推到粉丝收件箱
  - 拉模式（读扩散）：读时聚合关注人内容
  - 混合模式：普通推+大 V 拉
  - 存储：Redis ZSet（按时间）+DB 兜底
first_principle:
  problem: 关注关系下，如何高效分发内容到粉丝？
  axioms:
  - 关注数差异大（普通 100 / 大 V 千万）
  - 写扩散成本 = 粉丝数
  - 读扩散成本 = 关注数
  rebuild: 推/拉/混合按用户类型动态选择。
follow_up:
  - 大 V 发 Feed 怎么处理？——不扩散，粉丝读时拉大 V 内容合并
  - 收件箱大小有限怎么办？——固定窗口（如最近 1000 条），超出的不活跃用户丢
  - 怎么避免活跃用户漏内容？——活跃标记+推，非活跃拉
memory_points:
  - 推：写扩散（适合普通用户）
  - 拉：读扩散（适合大 V）
  - 混合：普通推+大 V 拉
  - 存储：Redis ZSet 按 score=时间
---

# 【拼多多内容】Feed 流推拉模式怎么选？

> JD 依据："直播短视频"、"高并发大流量大数据量"、"Feed 流"。

## 一、推/拉模式对比

| 模式 | 写时 | 读时 | 适用 | 缺点 |
|------|------|------|------|------|
| 推（写扩散） | 发时遍历粉丝，写每个粉丝收件箱 | 直接读自己收件箱 | 粉丝少（<1000） | 大 V 写爆炸 |
| 拉（读扩散） | 只写自己发件箱 | 读时聚合关注人发件箱 | 大 V | 读爆炸（关注多） |
| 混合 | 普通推+大 V 不推 | 普通读+大 V 粉丝额外拉 | 工业主流 | 复杂 |

## 二、推模式实现

**收件箱（Redis ZSet）**：
```
key = feed:inbox:{uid}
score = createTime（毫秒）
member = feedId
```

```java
// 发 Feed
public void publish(Feed feed) {
    feedDao.insert(feed);   // 落 DB

    // 推到所有粉丝收件箱（异步）
    List<Long> fans = followService.getFans(feed.getUid());
    long ts = feed.getCreateTime().getTime();
    for (Long fanId : fans) {
        redis.opsForZSet().add("feed:inbox:" + fanId, feed.getId(), ts);
        // 限制收件箱大小（保留最近 1000 条）
        redis.opsForZSet().removeRange("feed:inbox:" + fanId, 0, -1001);
    }
}
```

**优点**：读简单，O(log N) 取 Top。
**缺点**：大 V（千万粉丝）写扩散太重。

## 三、拉模式实现

**发件箱（DB/Redis ZSet）**：
```java
// 发 Feed（只写自己）
public void publish(Feed feed) {
    feedDao.insert(feed);
    redis.opsForZSet().add("feed:outbox:" + feed.getUid(), feed.getId(), ts);
}

// 读（聚合关注人）
public List<Feed> timeline(Long uid, long maxTime) {
    List<Long> follows = followService.getFollows(uid);
    Set<DefaultTuple> tuples = new HashSet<>();
    for (Long f : follows) {
        // 每人发件箱取最近 N 条
        Set<ZSetOperations.TypedTuple<Object>> top = redis.opsForZSet()
            .reverseRangeByScoreWithScores("feed:outbox:" + f, 0, maxTime, 0, 20);
        tuples.addAll(top);
    }
    // 合并+排序+分页
    return tuples.stream()
        .sorted(Comparator.comparing(TypedTuple::getScore).reversed())
        .limit(20)
        .map(t -> feedDao.getById((Long) t.getValue()))
        .collect(toList());
}
```

**优点**：大 V 写轻；**缺点**：关注多读重。

## 四、混合模式（工业方案）

```
发 Feed：
  if 用户粉丝 < 10w（普通用户）：推模式
  else（大 V）：不推，只写发件箱（拉模式）

读 Feed：
  1. 取自己收件箱（推模式写的）
  2. 取关注的大 V 发件箱（拉模式补）
  3. 合并+排序+分页
```

```java
public List<Feed> timeline(Long uid, long maxTime) {
    // 1. 收件箱（普通用户的 Feed）
    Set<Object> inboxIds = redis.opsForZSet()
        .reverseRangeByScore("feed:inbox:" + uid, 0, maxTime, 0, 20);

    // 2. 关注的大 V 发件箱
    List<Long> bigVs = followService.getBigVFollows(uid);   // 大 V 列表
    Set<Object> outboxIds = new HashSet<>();
    for (Long bv : bigVs) {
        outboxIds.addAll(redis.opsForZSet()
            .reverseRangeByScore("feed:outbox:" + bv, 0, maxTime, 0, 20));
    }

    // 3. 合并排序
    return Stream.concat(inboxIds.stream(), outboxIds.stream())
        .distinct()
        .map(id -> feedDao.getById((Long) id))
        .sorted(Comparator.comparing(Feed::getCreateTime).reversed())
        .limit(20)
        .collect(toList());
}
```

## 五、活跃用户优化

**写扩散可只推活跃粉丝**：
```java
List<Long> activeFans = fans.stream()
    .filter(f -> userService.isActive(f, 7))  // 7 天内活跃
    .collect(toList());
// 只推活跃粉丝，非活跃用拉模式兜底
```

## 六、Feed 排序

```
纯时间序：score = createTime（最简单）
加权排序：score = f(时间, 热度, 亲密度, 推荐分)
  - 直播/视频流往往加权（推荐流）
  - 关注 Feed 多用纯时间序
```

## 七、底层本质

Feed 流本质是**"在写扩散（成本∝粉丝数）和读扩散（成本∝关注数）间权衡"**——混合模式按用户类型动态选择，活跃度进一步优化写扩散。

## 常见考点
1. **怎么处理删 Feed**？——发件箱删；推模式需广播删粉丝收件箱（异步+ tombstone）。
2. **Feed 缓存怎么设计**？——发件箱 ZSet（活跃）+DB 兜底（历史）。
3. **怎么解决大 V 一次发千万人**？——异步+分批+队列削峰；活跃度过滤。
