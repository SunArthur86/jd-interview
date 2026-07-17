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

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：你用混合模式（普通用户推、大 V 拉），阈值设"粉丝 >10 万算大 V"。为什么不直接全部用拉模式？拉模式写成本最低。**

拉模式（读扩散）的写成本确实最低（只写自己发件箱），但读成本 ∝ 关注数。拼多多用户平均关注 100 人，拉模式每次读 Feed 要聚合 100 个发件箱（100 次 Redis 查询 + 内存合并排序），读 QPS 是写 QPS 的 20 倍以上（用户刷 Feed 远比发 Feed 频繁），拉模式把"写的便宜"变成"读的爆炸"。推模式（写扩散）相反——写时遍历粉丝写收件箱（贵），但读时只查自己的收件箱（O(1)）。混合模式的本质是"按用户类型选择成本更低的模式"：普通用户粉丝少（<1000），写扩散成本可控（写 1000 个 ZSet），读 O(1)；大 V 粉丝千万，写扩散会写爆（写千万个 ZSet），用拉模式让粉丝主动拉。10 万是经验阈值（写千万次 Redis vs 粉丝读时拉一次，成本反转点）。

### 第二层：证据与定位

**Q：用户反馈"关注的博主发了新内容，但我关注页没看到"，你怎么定位是推模式漏推还是收件箱被截断？**

推模式漏推的排查链路：
1. 看发件箱——`redis ZCARD feed:outbox:{bloggerUid}`，确认博主确实发了（发件箱有这条 Feed）。
2. 看收件箱——`redis ZSCORE feed:inbox:{userUid} {feedId}`，确认是否推到了。如果 ZSCORE 返回 nil，说明没推到。
3. 看推模式判断——该博主粉丝数是否 >10 万（被判定为大 V，走拉模式不推）。如果用户关注的是大 V，他读 Feed 时应该"拉大 V 发件箱补充"，看拉的逻辑是否生效（`getBigVFollows` 是否包含该博主）。
4. 看收件箱截断——推模式写了收件箱但 `removeRange(0, -1001)` 保留了最近 1000 条，如果用户关注多（活跃用户收件箱被刷得快），新 Feed 把旧 Feed 挤出了，但新 Feed 应该在的。看 `ZRANGE feed:inbox:{uid} 0 10` 确认。

### 第三层：根因深挖

**Q：大 V 发 Feed 走拉模式，但某个大 V 的千万粉丝同时上线刷 Feed，拉模式把大 V 发件箱的 ZSet 打爆了（热点 key）。怎么解？**

这是读扩散的热点问题——千万粉丝同时 `ZRANGE feed:outbox:{bigV}` 拉，单 key QPS 几十万，Redis 单分片扛不住。深挖解法：
1. **本地缓存**——大 V 发件箱在应用层用 Caffeine 缓存最近 20 条（TTL 30s），90% 的读命中本地缓存不打到 Redis。
2. **读扩散降级推扩散**——检测到热点（某大 V 发件箱 QPS >1 万）时，临时对该大 V 切推模式（异步推到活跃粉丝收件箱），把读热点转成写（分散到各粉丝的 ZSet key）。
3. **多级缓存**——大 V 发件箱拆 key（`feed:outbox:{bigV}:v1`, `:v2` 轮换），读时随机选一个，分摊 QPS。
4. **CDN/边缘**——大 V 的 Feed 走 CDN 边缘缓存，按地域分摊。

### 第四层：方案权衡

**Q：你用"只推活跃粉丝"优化写扩散，活跃定义为"7 天内登录"。但活跃标记本身怎么维护才准？标记过期会导致漏推。**

活跃标记的准确性 vs 维护成本是权衡点：
1. **方案 A：Redis BitMap**——`active:users:bitmap`，每个 uid 对应一个 bit，登录时 `SETBIT active:users {uid} 1`，每天定时把 7 天前的 bit 清 0。空间省（1 亿用户 ~12MB），但 BitMap 查询需要 uid 连续（稀疏 uid 浪费）。
2. **方案 B：Redis Set**——`active:users:7d` Set 存近 7 天活跃 uid，`SISMEMBER` 判断。查询 O(1)，但 Set 内存大（1 亿 uid ~1GB）。
3. **方案 C：近似（HyperLogLog/布隆过滤器）**——省内存但有假阳性（把不活跃的判为活跃，多推了，无害），不能有假阴性（漏推有害）。布隆过滤器的假阳性率设 1%，对推模式可接受（多推只是浪费，漏推才是 bug）。
拼多多选 BitMap + 每日滚动——1 亿用户 12MB 可接受，查询快，过期用"7 个 BitMap 按天滚动"（每天 SETBIT 当天，清 7 天前那天的）。

### 第五层：验证与沉淀

**Q：你怎么验证 Feed 流的"最终一致性"——用户看到的内容和实际发布的内容一致、不重不漏？**

Feed 流的正确性验证：
1. 端到端对账——抽样 1000 个用户，对比"用户收件箱内容"vs"其关注人发件箱的并集"，差异率应 <0.1%（允许时效窗口内的小差异）。
2. 不重检测——收件箱不应有重复 feedId。`ZSCORE` 检查 + 客户端 dedup by feedId。
3. 不漏检测——构造测试账号，关注一批测试博主，博主发 Feed 后验证测试账号收件箱是否都收到（推模式 + 拉模式都要测）。
4. 时效性——Feed 从发布到粉丝可见的 P99 延迟，推模式应 <5s（异步推送），拉模式应 <1s（实时拉）。
沉淀：大 V 阈值（粉丝数）接配置动态调；活跃度定义（7 天）和判断方式（BitMap）文档化；Feed 收件箱大小（1000 条）按内存预算调；推/拉模式的降级开关（热点时切推）接 Apollo。

## 结构化回答




**30 秒电梯演讲：** Feed 像快递——推模式是商家发到每个买家门口（写扩散），拉模式是买家来取（读扩散），混合是普通快递+大客户自提。

**展开框架：**
1. **推模式（写扩散）** — 发时推到粉丝收件箱
2. **拉模式（读扩散）** — 读时聚合关注人内容
3. **混合模式** — 普通推+大 V 拉

**收尾：** 大 V 发 Feed 怎么处理？




## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Feed 流推拉模式怎么选？ | 今天聊「Feed 流推拉模式怎么选？」。一句话：Feed 流是"用户主页/关注页"的内容流，核心是"推（写扩散）vs 拉（读扩散）"的取舍；普通用户用推模式、大 V … | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：推：写扩散（适合普通用户） | 核心概念 |
| 0:51 | 能力/参数拆解表 | 要点是：拉：读扩散（适合大 V） | 能力拆解 |
| 1:30 | 流程图：输入→处理→输出 | 要点是：混合：普通推+大 V 拉 | 关键机制 |
| 2:09 | 代码片段 + 注释高亮 | 要点是：存储：Redis ZSet 按 score=时间 | 实战要点 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——大 V 发 Feed 怎么处理？。 | 收尾 |
