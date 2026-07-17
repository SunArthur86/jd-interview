---
id: java-architect-066
difficulty: L3
category: java-architect
subcategory: Feed 流
tags:
- Java 架构师
- Feed 流
- 推拉模式
- 扩散策略
feynman:
  essence: Feed 流（朋友圈/微博/小红书）的核心是"我关注的人发了内容，怎么快速推给我"。架构矛盾是"写扩散（发帖时推给所有粉丝）vs 读扩散（读时拉关注人的内容）"。写扩散：发帖慢（要写给百万粉丝），读快（直接读自己的收件箱）。读扩散：发帖快（只写发件箱），读慢（要拉所有关注人的发件箱合并）。解法是"按粉丝量分级"——大 V（百万粉丝）用读扩散，普通用户（百粉丝）用写扩散，混合模式。
  analogy: 像班级通知。老师说"明天考试"——方案 A（写扩散）：老师给全班 50 个同学每人发一条通知（老师累，同学直接看自己消息）。方案 B（读扩散）：老师写黑板，50 个同学自己看黑板（老师轻松，同学要主动看）。如果老师粉丝多（校长给全校 1000 人讲话），写扩散太累（写 1000 份），用读扩散（写一份公告，大家自己看）。Feed 流一样——按粉丝量选策略。
  first_principle: 为什么不能统一用一种模式？写扩散在大 V 场景崩（千万粉丝发帖要写千万条，DB 写爆）；读扩散在关注多场景崩（关注 1000 人要拉 1000 个发件箱合并，读慢）。解法是混合——普通用户发帖用写扩散（推给几百粉丝，写量可控），大 V 发帖用读扩散（不推，粉丝读时主动拉）。判断阈值（如粉丝 > 10 万用读扩散）。
  key_points:
  - 写扩散（推模式/Fanout-on-write）：发帖时推到所有粉丝收件箱，读快写慢
  - 读扩散（拉模式/Fanout-on-read）：发帖只写发件箱，读时拉关注人合并，写快读慢
  - 混合模式：大 V 读扩散 + 普通用户写扩散，按粉丝量阈值切换
  - Timeline 服务：收件箱/发件箱按时间排序，支持分页（游标分页）
  - 存储选型：Redis ZSet（按时间戳排序）+ DB 持久化
first_principle:
  problem: 亿级用户，关注关系复杂（大 V 千万粉丝，普通用户百粉丝），Feed 流怎么保证发帖和读都快？
  axioms:
  - 写扩散写量 = 粉丝数（大 V 发帖写千万，DB 写爆）
  - 读扩散读量 = 关注数（关注千个，读时拉千个发件箱合并，读慢）
  - 大 V 和普通用户特征不同（粉丝量级差万倍）
  - Feed 流要求实时（发帖后秒级可见）
  rebuild: 混合模式 + 分级策略。普通用户（粉丝 < 10 万）发帖用写扩散——推到所有粉丝收件箱（Redis ZSet），写量可控。大 V（粉丝 > 10 万）用读扩散——发帖只写发件箱，粉丝读时主动拉大 V 发件箱合并到收件箱。存储用 Redis ZSet（按 timestamp 排序）+ DB 持久化（历史数据）。Timeline 分页用游标（last_id + timestamp）。
follow_up:
  - 收件箱数据怎么清理（无限增长）？——只保留最近 N 条（如 1000 条），旧的淘汰（冷数据归档 DB）。
  - 大 V 发帖，粉丝多久能看到？——读扩散有延迟（粉丝读时才拉），秒级（拉的时间）。
  - 关注/取关怎么更新 Feed？——关注：拉对方最近 N 条合并到自己收件箱；取关：标记（不删历史，新内容不再推）。
  - Feed 怎么排序（时间 vs 算法）？——时间线（按发布时间）或算法（按相关性/热度），小红书用算法（兴趣推荐）。
  - 怎么做"不感兴趣"（屏蔽某作者）？——读时过滤（用户黑名单），写扩散时跳过（不推给黑名单用户）。
memory_points:
  - 写扩散：发帖推粉丝，写慢读快（普通用户）
  - 读扩散：发帖只写自己，读时拉关注（大 V）
  - 混合：粉丝 > 10 万读扩散，否则写扩散
  - Redis ZSet：按 timestamp 排序，O(logN) 插入
  - 游标分页：last_id + timestamp，避免深分页
---

# 【Java 后端架构师】Feed 流推拉模式与扩散策略

> 适用场景：JD 内容生态（京东的内容社区/种草）。用户关注了博主，博主发帖后粉丝要看到——这就是 Feed 流。矛盾是"博主发帖要快（不能等）"和"粉丝读 Feed 要快（不能拉半天）"，但鱼和熊掌不可兼得。核心解法是"推拉混合模式"——按粉丝量分级，普通用户推（写扩散），大 V 拉（读扩散）。

## 一、概念层：三种扩散模式

**写扩散 vs 读扩散 vs 混合**（核心对比）：

```
模式 1：写扩散（Fanout-on-write，推模式）
  博主 A 发帖（粉丝 100 个）
       │
       ├─ 写 A 的发件箱（outbox:A）
       ├─ 写 粉丝1 的收件箱（inbox:粉丝1）
       ├─ 写 粉丝2 的收件箱（inbox:粉丝2）
       ├─ ...
       └─ 写 粉丝100 的收件箱（inbox:粉丝100）

  发帖：写 1 + 100 = 101 次（写量 = 粉丝数）
  读 Feed：读自己的 inbox（1 次，快）
  适用：粉丝少（普通用户）

模式 2：读扩散（Fanout-on-read，拉模式）
  大 V B 发帖（粉丝 1000 万）
       │
       └─ 只写 B 的发件箱（outbox:B）   ← 只写 1 次

  发帖：写 1 次（快）
  读 Feed：读自己的 inbox + 拉所有关注大 V 的 outbox 合并（1000 次合并，慢）
  适用：粉丝多（大 V）

模式 3：混合模式（分级策略）
  博主发帖：
    if 粉丝数 < 10万:
        写扩散（推到所有粉丝 inbox）
    else:
        读扩散（只写 outbox，粉丝读时拉）

  粉丝读 Feed：
    1. 读自己的 inbox（含写扩散推来的）
    2. 拉关注的大 V 的 outbox（读扩散的）
    3. 合并 + 按时间排序
    4. 返回 Feed 列表
```

**三种模式对比**：

| 维度 | 写扩散（推） | 读扩散（拉） | 混合 |
|------|-------------|-------------|------|
| 发帖延迟 | 高（写 N 份） | 低（写 1 份） | 分级 |
| 读延迟 | 低（读 inbox） | 高（合并多 outbox） | 低（inbox 为主） |
| 存储成本 | 高（每人 inbox 存副本） | 低（只存 outbox） | 中 |
| 大 V 友好 | 不友好（写爆） | 友好 | 友好 |
| 适用 | 普通用户（粉丝少） | 大 V（粉丝多） | 全场景 |

## 二、机制层：Timeline 存储设计

**Redis ZSet 存储**（核心）：

```
收件箱（Inbox）：每个用户的 Feed 列表
  Key: inbox:{userId}
  Type: ZSet
  Member: postId
  Score: timestamp（发布时间）
  说明：ZSet 按 score（时间）排序，O(logN) 插入，支持范围查询（分页）

发件箱（Outbox）：每个博主自己发的帖列表
  Key: outbox:{userId}
  Type: ZSet
  Member: postId
  Score: timestamp

示例：
  inbox:用户X → [(post1, 1700000001), (post2, 1700000002), ...]
  outbox:大V_Y → [(post100, 1700000003), (post101, 1700000004), ...]
```

**写扩散实现**：

```java
@Service
public class FeedWriteService {

    @Autowired private RedisTemplate redis;
    @Autowired private FollowService followService;

    private static final long BIG_V_THRESHOLD = 100_000;   // 大 V 阈值：10 万粉丝

    /**
     * 发帖：根据粉丝量选择扩散策略
     */
    public void publishPost(Post post) {
        Long authorId = post.getAuthorId();
        long timestamp = System.currentTimeMillis() / 1000;

        // 1. 写发件箱（所有模式都写）
        redis.opsForZSet().add("outbox:" + authorId,
            post.getId().toString(), timestamp);

        // 2. 查粉丝数，决定扩散策略
        long followerCount = followService.getFollowerCount(authorId);

        if (followerCount < BIG_V_THRESHOLD) {
            // 普通用户：写扩散（推到所有粉丝 inbox）
            writeFanout(post, timestamp);
        } else {
            // 大 V：读扩散（不推，粉丝读时拉）
            // 标记为大 V，读时特殊处理
            redis.opsForSet().add("big_v_set", authorId.toString());
            monitor.record("read_fanout_trigger", authorId);
        }

        monitor.record("post_published", authorId, followerCount);
    }

    /**
     * 写扩散：推到所有粉丝 inbox
     */
    private void writeFanout(Post post, long timestamp) {
        Long authorId = post.getAuthorId();
        String postId = post.getId().toString();

        // 分批查粉丝（避免一次拉太多）
        int pageSize = 1000;
        int page = 0;
        while (true) {
            List<Long> followers = followService.getFollowers(
                authorId, page, pageSize);
            if (followers.isEmpty()) break;

            // Pipeline 批量写（减少网络往返）
            redis.executePipelined((RedisCallback<Object>) connection -> {
                for (Long followerId : followers) {
                    connection.zAdd(
                        ("inbox:" + followerId).getBytes(),
                        timestamp,
                        postId.getBytes());
                    // 收件箱只保留最近 1000 条（淘汰旧的）
                    connection.zRemrangeByRank(
                        ("inbox:" + followerId).getBytes(),
                        0, -1001);
                }
                return null;
            });

            page++;
        }

        monitor.record("write_fanout_count", authorId, page * pageSize);
    }
}
```

**读 Feed（混合模式）**：

```java
@Service
public class FeedReadService {

    @Autowired private RedisTemplate redis;
    @Autowired private FollowService followService;

    /**
     * 读 Feed：inbox（写扩散推来的）+ 拉大 V outbox（读扩散）
     */
    public List<Post> readFeed(Long userId, long cursorTimestamp, int pageSize) {
        // 1. 读自己的 inbox（写扩散推来的）
        Set<ZSetOperations.TypedTuple<String>> inboxPosts = redis.opsForZSet()
            .reverseRangeByScoreWithScores("inbox:" + userId,
                0, cursorTimestamp, 0, pageSize);

        // 2. 查关注的大 V（读扩散的不在 inbox）
        List<Long> followingBigVs = followService.getFollowingBigVs(userId);

        // 3. 拉每个大 V 的 outbox（最近 pageSize 条）
        Set<ZSetOperations.TypedTuple<String>> bigVPosts = new TreeSet<>(
            Comparator.comparingDouble(t -> -t.getScore()));   // 按时间倒序

        for (Long bigVId : followingBigVs) {
            Set<ZSetOperations.TypedTuple<String>> posts = redis.opsForZSet()
                .reverseRangeByScoreWithScores("outbox:" + bigVId,
                    0, cursorTimestamp, 0, pageSize);
            bigVPosts.addAll(posts);
        }

        // 4. 合并 inbox + bigV outbox，按时间排序
        List<String> mergedPostIds = mergeAndSort(inboxPosts, bigVPosts, pageSize);

        // 5. 批量查帖子详情
        return postService.batchGet(mergedPostIds);
    }

    /**
     * 关注新用户：拉对方最近帖子到自己的 inbox
     */
    public void follow(Long userId, Long targetId) {
        // 拉对方最近 N 条到自己的 inbox
        Set<ZSetOperations.TypedTuple<String>> recentPosts = redis.opsForZSet()
            .reverseRangeWithScores("outbox:" + targetId, 0, 19);   // 最近 20 条

        if (!recentPosts.isEmpty()) {
            redis.executePipelined((RedisCallback<Object>) connection -> {
                for (ZSetOperations.TypedTuple<String> post : recentPosts) {
                    connection.zAdd(
                        ("inbox:" + userId).getBytes(),
                        post.getScore(),
                        post.getValue().getBytes());
                }
                return null;
            });
        }
    }
}
```

## 三、机制层：游标分页（避免深分页）

```java
@Service
public class FeedPaginationService {

    /**
     * 游标分页：基于 timestamp，避免 OFFSET 深分页性能问题
     */
    public FeedPage pageByCursor(Long userId, Long lastPostId, Long lastTimestamp,
                                  int pageSize) {
        // 游标：上一页最后一条的 timestamp（和时间靠前的条件查下一页）
        long cursor = (lastTimestamp != null) ? lastTimestamp : Long.MAX_VALUE;

        List<Post> posts = feedReadService.readFeed(userId, cursor, pageSize);

        // 下一页游标：当前页最后一条的 timestamp
        Long nextCursor = null;
        if (!posts.isEmpty() && posts.size() == pageSize) {
            Post last = posts.get(posts.size() - 1);
            nextCursor = last.getTimestamp();
        }

        return new FeedPage(posts, nextCursor);
    }
}
```

**API 调用示例**：

```
GET /feed?cursor=<timestamp>&size=20

第一次：cursor 为空（读最新 20 条）
返回：{ posts: [...], nextCursor: 1700000000 }

第二次：cursor=1700000000（读 timestamp < 1700000000 的 20 条）
返回：{ posts: [...], nextCursor: 1699999900 }
```

## 四、机制层：存储分层与冷热分离

```
热数据（最近 7 天）：Redis ZSet
  ├─ inbox:{userId}：收件箱，最近 1000 条
  └─ outbox:{userId}：发件箱，最近 100 条

冷数据（7 天前）：MySQL + ES
  ├─ t_post：帖子表（id/authorId/content/time）
  └─ ES：支持全文搜索（搜历史帖子）

冷热分离流程：
  Redis（热）→ 7 天后 → 归档到 MySQL（冷）
  读 Feed：先读 Redis，不够再查 MySQL
```

**归档任务**：

```java
@Scheduled(cron = "0 0 3 * * ?")   // 每日凌晨 3 点
public void archiveColdData() {
    // 把 Redis 中 7 天前的帖子归档到 MySQL
    long threshold = System.currentTimeMillis() / 1000 - 7 * 86400;

    // 扫描所有 outbox，归档旧数据
    // 实际用增量扫描（记录上次归档的位置）
    List<Long> activeUsers = userService.findActiveUsers();
    for (Long userId : activeUsers) {
        Set<String> oldPosts = redis.opsForZSet()
            .rangeByScore("outbox:" + userId, 0, threshold);
        if (oldPosts != null && !oldPosts.isEmpty()) {
            // 批量写 MySQL（已存在则跳过）
            postRepo.batchInsertIgnore(parsePosts(oldPosts));
            // 从 Redis 删除
            redis.opsForZSet().removeRangeByScore("outbox:" + userId, 0, threshold);
        }
    }
}
```

## 五、底层本质：Feed 流的本质是"写读成本的权衡"

回到第一性：**Feed 流的本质是"在写成本（发帖）和读成本（读 Feed）之间权衡"**。

- **写扩散是"预计算"**：发帖时把内容推到所有粉丝，相当于"提前算好每个粉丝的 Feed"。读时直接取（快），但写时要做 N 份工作（慢）。这是"空间换时间"——存 N 份副本，读快。
- **读扩散是"延迟计算"**：发帖只存一份，读时现合并关注人的内容。写快（1 份），读慢（合并 N 个）。这是"时间换空间"——只存 1 份，读时计算。
- **混合模式是"分级优化"**：按粉丝量选策略——普通用户写扩散（写量可控，读快），大 V 读扩散（避免写爆，读时拉）。这是"因地制宜"——不同场景不同策略。
- **大 V 是特殊存在**：大 V 粉丝百万，写扩散要写百万份（DB 写爆），必须读扩散。但大 V 数量少（全站几千个），粉丝读时拉大 V outbox 的成本可控（关注的大 V 通常 < 100 个）。这是"长尾分布"的利用——少数大 V 特殊处理，多数普通用户统一处理。

**Redis ZSet 的本质是"有序集合"**：Feed 流的核心操作是"按时间排序 + 范围查询（分页）"。ZSet 用跳表实现，插入 O(logN)，范围查询 O(logN + M)，完美匹配 Feed 场景。Score 存时间戳，Member 存 postId，自然按时间排序。

**游标分页的本质是"避免 OFFSET"**：传统分页 OFFSET 10000 LIMIT 20 要扫 10020 条（深分页慢）。游标分页用 WHERE timestamp < cursor LIMIT 20，直接定位（跳表查找 O(logN)），深分页也快。这是"用条件替代偏移"。

## 六、AI 架构师加问：5 个

1. **AI 做个性化 Feed 排序（非时间线），怎么做？**
   AI 预估每条帖子对用户的"兴趣分"（点击率/互动率），按兴趣分排序而非时间。特征：帖子内容/用户兴趣/交互历史。小红书/抖音用此方案（兴趣推荐）。但需平衡（全兴趣排序用户看不到关注的人，故混合"关注+推荐"）。

2. **AI 预测哪些用户会互动（定向推），怎么做？**
   发帖时 AI 预测"最可能互动的粉丝"（点赞/评论），优先推给这些人（提高互动率）。写扩散时按预测分排序推送。京东内容社区实践：定向推送互动率提升 50%。

3. **用图神经网络（GNN）优化关注推荐，怎么做？**
   GNN 分析用户关系图（关注/互动），推荐"你可能感兴趣的人"。关注关系是图结构，GNN 擅长图推理。推荐关注后更新 Feed（拉对方最近帖子）。

4. **AI 检测 Feed 流异常（刷量/水军），怎么做？**
   AI 监控帖子扩散速度——正常帖子扩散有规律（粉丝逐步看），水军帖子异常（瞬间万互动）。AI 用异常检测识别刷量，降权或屏蔽。京东内容治理：AI 拦截万级刷量帖/天。

5. **AI 做 Feed 流内容理解（标签/分类），怎么做？**
   AI（多模态模型）理解帖子内容（图片/文字），自动打标签（美妆/数码/美食）。标签用于推荐（兴趣匹配）和搜索。京东内容标签：AI 自动打标准确率 90%+。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"写扩散推粉丝、读扩散拉关注、混合分级大 V 拉、Redis ZSet 游标分页"**。

- **写扩散**：发帖推到所有粉丝 inbox，写慢读快（普通用户，粉丝 < 10 万）
- **读扩散**：发帖只写 outbox，读时拉关注合并，写快读慢（大 V，粉丝 > 10 万）
- **混合模式**：按粉丝量阈值切换，大 V 读扩散，普通用户写扩散
- **Redis ZSet**：Score 存 timestamp，O(logN) 插入，范围查询分页
- **游标分页**：WHERE timestamp < cursor，避免 OFFSET 深分页
- **冷热分离**：热数据 Redis（7 天），冷数据 MySQL（归档）

### 面试现场 60 秒回答

> Feed 流核心是写读成本权衡，三种模式。写扩散（推模式）——发帖时推到所有粉丝收件箱，写量=粉丝数，读快（直接读 inbox），适用普通用户（粉丝少）。读扩散（拉模式）——发帖只写发件箱，读时拉所有关注人的发件箱合并，写快读慢，适用大 V（粉丝多）。混合模式——按粉丝量分级，粉丝 < 10 万用写扩散（推到 inbox），> 10 万用读扩散（只写 outbox，粉丝读时拉），兼顾写读性能。存储用 Redis ZSet——inbox 和 outbox 都是 ZSet，Score 存 timestamp，Member 存 postId，O(logN) 插入，支持范围查询分页。写扩散时 Pipeline 批量写粉丝 inbox（减少网络往返），收件箱只保留最近 1000 条（淘汰旧的）。读 Feed 时——读 inbox（写扩散推来的）+ 拉关注的大 V outbox（读扩散的）合并排序。游标分页——WHERE timestamp < cursor LIMIT size，避免 OFFSET 深分页慢。冷热分离——热数据 Redis（7 天），冷数据归档 MySQL（定时任务），读 Feed 先 Redis 不够查 MySQL。关注新用户——拉对方最近 20 条到 inbox（立即能看到对方历史）。监控 feed_read_p99（读延迟，< 50ms）、fanout_count（写扩散量）、inbox_size（收件箱大小）。最关键的是"按粉丝量分级选策略"——大 V 和普通用户不同处理，这是 Feed 流工程的核心洞察。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不全用读扩散（发帖快，看似简单）？ | 读扩散在读时要拉所有关注人的 outbox 合并，关注 1000 人要 1000 次查询 + 合并排序，读慢（> 100ms）。写扩散预计算，读 O(1)。用 feed_read_p99（读延迟，写扩散 < 20ms vs 读扩散 > 100ms）和 fanout_write_count（写量）量化 |
| 证据追问 | 怎么证明 Feed 流架构扛得住？ | 压测（模拟千万用户读 Feed，验证 RT/QPS）+ 容量规划（Redis 内存/分片）+ 监控（fanout_count/feed_read_p99/inbox_size）。大 V 发帖监控 fanout_skip_count（读扩散跳过的写量） |
| 边界追问 | 混合模式能覆盖所有场景吗？ | 边界场景：超大 V（亿粉，如明星）读扩散也可能慢（outbox 巨大），需二级缓存（热门帖缓存）；关注很多人（关注 1 万）读时拉太多，需限制（只拉活跃关注）。这些用特殊优化 |
| 反例追问 | 什么场景不需要 Feed 流（直接查询）？ | 小规模社区（用户少，直接查 DB 按时间排序）；一对一私聊（不是 Feed，是会话）。Feed 流适用于"一对多广播"场景 |
| 风险追问 | Feed 流最大风险？ | 主动点出：Redis 故障（Feed 不可读，降级查 MySQL 慢）、写扩散积压（大 V 误判为普通用户，写爆 DB）、数据丢失（Redis 未持久化）、冷热分离断裂（归档失败数据丢）。靠 Redis 集群（高可用）+ 大 V 阈值动态调整 + 持久化 + 归档监控 |
| 验证追问 | 怎么验证写扩散正确（粉丝都收到了）？ | 对账——发帖后抽样粉丝，验证 inbox 有该帖；监控 fanout_success_rate（推送成功率，应 > 99.99%）；粉丝投诉率（没收到 Feed 的投诉，应趋近 0） |
| 沉淀追问 | Feed 流沉淀什么？ | 写扩散/读扩散框架、Timeline 服务（ZSet 封装）、冷热分离工具、Feed 监控大盘（读延迟/写扩散量/收件箱大小/归档成功率） |

### 现场对话示例

**面试官**：某明星（5000 万粉丝）发帖，用读扩散。但粉丝读 Feed 时要拉这个明星的 outbox，5000 万粉丝同时拉，outbox 成热点，怎么办？

**候选人**：大 V 的 outbox 是读热点（5000 万人读同一个 key）。三层优化。第一层，多级缓存——outbox 内容缓存到本地（Caffeine，每实例一份），大部分请求本地命中（不走 Redis）。TTL 短（1 分钟，保证新鲜度）。第二层，Redis 集群分片读——outbox 虽然是单 key，但 Redis 读可以走副本（读写分离，多副本分担读）。第三层，CDN/边缘缓存——大 V 帖子内容（图片/视频）走 CDN，Feed 列表只存 postId，详情按 postId 查 CDN。极端情况——大 V 发帖瞬间，读 QPS 暴增（粉丝刷新看新帖），用"发帖事件广播"——发帖时推通知（WebSocket/推送），粉丝收到通知才刷新，避免轮询压垮服务。京东明星发帖实践：本地缓存 + Redis 副本 + CDN，单 outbox 支撑 10 万 QPS 读。监控 hotkey_qps（热点 key QPS）和 cache_hit_rate（命中率，> 95%）。

**面试官**：用户关注了 1000 个人，其中 100 个是大 V（读扩散），读 Feed 要拉 100 个 outbox 合并，很慢，怎么办？

**候选人**：这是"关注太多大 V"场景。优化措施——第一，限制关注数（如最多关注 500 人，产品策略）；第二，大 V 分组——用户给大 V 分组（"数码博主"/"美食博主"），读 Feed 时只拉当前组的大 V（减少合并量）；第三，预合并——定时任务（每分钟）把用户关注的所有大 V outbox 预合并到 inbox（inbox 有大 V 的内容 + 写扩散推来的），读时只读 inbox（一次查询）。预合并是"后台异步扩散"——把读扩散的合并工作提前做，读时快。第四，增量合并——只拉上次读后新增的大 V 帖子（用 cursor），不全量拉。京东实践：预合并 + 增量，关注 1000 人读 Feed < 50ms。监控 feed_merge_rt（合并延迟）和 heavy_user_feed_rt（重度用户读延迟）。

**面试官**：Feed 流怎么支持"不感兴趣"（屏蔽某作者）？

**候选人**：两层处理。第一层，读时过滤——用户有"屏蔽黑名单"（user_block_list），读 Feed 时拿到帖子列表后过滤掉黑名单作者的帖子。简单但浪费（拉了再过滤）。第二层，写扩散时跳过——发帖时写扩散推粉丝，查粉丝列表后排除"屏蔽了作者的人"（反向查 block 关系）。但反向查代价高（要查每个粉丝是否屏蔽作者）。折中方案——写扩散正常推（不查 block，保证写性能），读时过滤（用户读时过滤黑名单）。block 关系存 Redis（Set，block:userId → {authorId1, authorId2}），读时 O(1) 查。如果过滤后帖子不够（屏蔽数多），补拉（读下一页）。京东实践：读时过滤 + 黑名单 Redis Set，屏蔽即时生效（加黑名单后新帖不推）。监控 block_filter_rate（过滤率，应 < 10%，太多说明关注质量差）。

## 常见考点

1. **Feed 流和推荐的区别？**——Feed 流是"关注关系驱动"（关注的人发的内容），推荐是"算法驱动"（系统推你可能感兴趣的）。Feed 流按关注/时间，推荐按兴趣/相关性。现代 App 混合（关注 Feed + 推荐 Feed）。
2. **朋友圈为什么用写扩散？**——微信朋友圈好友数有限（平均 < 200），写扩散写量可控（200 份），读快（直接读 inbox）。且朋友圈要求实时（发帖秒级可见），写扩散满足。
3. **微博为什么用混合？**——微博大 V（明星千万粉）和普通用户（百粉）并存，混合模式兼顾。大 V 读扩散，普通用户写扩散。
4. **怎么做 Feed 的"已读/未读"？**——用户读 Feed 时记录 last_read_timestamp，未读 = timestamp > last_read 的帖子。或帖子级别标记（每帖 is_read），但成本高（存 N 个标记）。

## 结构化回答


**30 秒电梯演讲：** 像班级通知。老师说"明天考试"——方案 A（写扩散）：老师给全班 50 个同学每人发一条通知（老师累，同学直接看自己消息）。方案 B（读扩散）：老师写黑板，50 个同学自己看黑板（老师轻松，同学要主动看）。如果老师粉丝多（校长给全校 ...

**展开框架：**
1. **写扩散** — 发帖时推到所有粉丝收件箱，读快写慢
2. **读扩散** — 发帖只写发件箱，读时拉关注人合并，写快读慢
3. **混合模式** — 大 V 读扩散 + 普通用户写扩散，按粉丝量阈值切换

**收尾：** 收件箱数据怎么清理（无限增长）？



## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：Feed 流推拉模式与扩散策略 | "这题一句话：Feed 流（朋友圈/微博/小红书）的核心是我关注的人发了内容，怎么快速推给我。" | 开场钩子 |
| 0:15 | 像班级通知。老师说明天考试——方案 A（类比图 | "打个比方：像班级通知。老师说明天考试——方案 A（。" | 核心类比 |
| 0:40 | 写扩散（推模式/Fanout示意/对比图 | "on-write）：发帖时推到所有粉丝收件箱，读快写慢" | 写扩散（推模式/Fanout要点 |
| 1:05 | 读扩散（拉模式/Fanout示意/对比图 | "on-read）：发帖只写发件箱，读时拉关注人合并，写快读慢" | 读扩散（拉模式/Fanout要点 |
| 1:55 | 总结卡 | "记住：写扩散。下期见。" | 收尾 |
