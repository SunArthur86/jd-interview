---
id: pdd-content-015
difficulty: L3
category: pdd-content
subcategory: 评价
tags:
- 拼多多
- 内容
- 评价
- 业务
- 行家社区
feynman:
  essence: 评价系统是"用户评价+商家回复+平台审核+评分聚合+行家社区"的内容闭环；技术关键是审核流（机审+人审）、防刷、评分聚合一致性。
  analogy: 评价系统像餐厅大众点评——客户写评价（UGC）、商家回（互动）、平台审（合规）、汇总成评分（决策）。
  first_principle: 评价是 C 端购买决策的关键 UGC，需可信+合规+实时。
  key_points:
  - 评价生命周期：提交→机审→人审→上架/下架
  - 评分聚合：实时增量更新（防不一致）
  - 防刷：内容/行为双维反作弊
  - 行家社区：垂直 KOL 评价加权
first_principle:
  problem: 评价是购买决策核心 UGC，如何保证可信+合规+实时？
  axioms:
  - 评价影响 GMV（决策依据）
  - UGC 必须合规（合规风险）
  - 评分需准确（不能被刷分污染）
  rebuild: 审核流 + 评分聚合 + 反作弊 + 行家加权。
follow_up:
  - 怎么防止刷好评？——设备/账号/行为多维度反作弊 + IP 频控 + 内容相似度
  - 评分怎么聚合？——增量计算（+评价/减评价）+ 定时校准（防漂移）
  - 行家评价怎么加权？——领域权威度评分 + 标签体系
memory_points:
  - 生命周期：提交→机审→人审→上架
  - 评分：增量+定时校准
  - 防刷：内容+行为双维
  - 行家：垂直权威度加权
---

# 【拼多多内容】评价业务怎么设计（含行家社区）？

> JD 依据："评价和行家社区"、"和算法同学挖掘业务问题"。

## 一、评价生命周期

```
用户写评价
    ↓
提交（status=0 待审）
    ↓
机审（敏感词/广告/涉政/图片违规）→ 通过 → status=1 上架
    ↓                       ↓
    ↓                  命中规则 → status=2 进人审
    ↓                                  ↓
    ↓                          人工复审 → 通过/拒绝
    ↓
用户/商家/管理员操作
    - 用户编辑 → 重新机审
    - 商家回复 → 走同样审核
    - 管理员下架 → status=3
```

## 二、评价表设计

```sql
CREATE TABLE review (
  id BIGINT PRIMARY KEY,
  product_id BIGINT,
  uid BIGINT,
  order_id BIGINT,
  score TINYINT,                -- 1-5 星
  content TEXT,
  images JSON,                  -- 图片
  video_url VARCHAR(500),
  is_anonymous TINYINT,
  tags JSON,                    -- 标签（物流快/质量好/性价比）
  is_expert TINYINT,            -- 行家标记
  status TINYINT,               -- 0待审 1通过 2人审 3下架
  audit_reason VARCHAR(200),
  create_time DATETIME,
  update_time DATETIME,
  INDEX idx_pid_time(product_id, create_time),
  INDEX idx_uid(uid),
  INDEX idx_status(status)
);
```

## 三、评分聚合

**痛点**：商品评分要实时，但每次查 count+avg 太慢。

**方案：增量计算**：
```java
// 评价上架时
@Transactional
public void publish(Long reviewId) {
    Review r = reviewDao.getById(reviewId);
    r.setStatus(PUBLISHED);
    reviewDao.update(r);

    // 增量更新商品评分缓存（Redis Hash）
    String key = "product:rating:" + r.getProductId();
    redis.opsForHash().increment(key, "count", 1);
    redis.opsForHash().increment(key, "total_score", r.getScore());
    // avg = total_score / count
}

// 评价下架/删除 → 反向减
```

**定时校准**（防漂移）：
```java
// 每天凌晨全量重算
@Scheduled(cron = "0 0 3 * * ?")
public void reconcile() {
    productDao.findAll().forEach(p -> {
        int[] stat = reviewDao.statByProduct(p.getId());  // count, sum
        redis.hset("product:rating:" + p.getId(), "count", stat[0]);
        redis.hset("product:rating:" + p.getId(), "total_score", stat[1]);
    });
}
```

## 四、反作弊

**内容维度**：
- 敏感词/广告（机审）
- 文本相似度（防复制模板，SimHash/MinHash）
- 图片识别（涉黄/水印）

**行为维度**：
- 新账号/低信誉账号评价过滤
- 同 IP/设备多账号刷分检测
- 评价时间集中（突发）预警
- 短时间高频评价限流

```java
public boolean isSuspicious(Review r) {
    if (userService.getTrustScore(r.getUid()) < 50) return true;   // 低信誉
    if (antiCheatService.deviceMultiAccounts(r.getUid())) return true;
    if (contentSimilarityService.tooSimilar(r.getContent())) return true;
    return false;
}
```

## 五、行家社区（垂直 KOL）

**行家体系**：
- 行家认证（领域：母婴/3C/服饰等）+ 权威度评分
- 行家评价排序加权（出现在前列）+ 标签
- 行家画像（粉丝数/历史评价质量）

```java
public List<Review> listReviews(Long productId) {
    List<Review> reviews = reviewDao.findByProductId(productId);
    // 行家优先排序，权重 = 行家权威度
    reviews.sort(Comparator.comparing(
        r -> r.getIsExpert() == 1 ? expertWeight(r) : normalWeight(r),
        Comparator.reverseOrder()));
    return reviews;
}
```

**行家内容**：
- 深度评测（图文/视频）
- 与算法同学合作：召回 → 排序 → 个性化推送

## 六、技术架构

```
评价服务
  ├─ 写入：MySQL（主）+ ES（搜索）+ Redis（聚合缓存）
  ├─ 审核：Kafka 事件 → 机审服务（NLP/视觉）+ 人审台
  ├─ 评分聚合：实时（Redis）+ 定时校准
  └─ 防作弊：内容（NLP）+ 行为（特征工程）
```

## 七、底层本质

评价系统本质是**"UGC 闭环：产出→合规审核→评分聚合→反作弊保障可信"**——评价是购买决策的 UGC，技术难点在审核流的实时+准确、评分的增量一致性、反作弊的多维识别。

## 常见考点
1. **机审和人工审核怎么协同**？——机审先过滤（90%），剩下疑难进人工；规则定期更新。
2. **评价搜索怎么排序**？——相关性 + 时效 + 行家权重 + 商家回复 + 互动数。
3. **评价图片怎么存储**？——对象存储（OSS/S3）+ CDN 加速，DB 只存 URL。

## 苏格拉底式面试追问

> 这组追问不是背答案，而是模拟面试官层层逼近本质。每一问先回答"为什么"，再回答"怎么做"，最后回答"如何证明"。

### 第一层：目标与动机

**Q：评价机审和人审的分流你设了"机审置信度 0.5-0.95 进人审"，为什么不直接用 0.5 做一刀切（>0.5 通过，<0.5 拒绝）？这样不是省人力吗？**

一刀切的代价是误判率失控。NLP 模型在置信度 0.5 附近的判断最不可靠——0.51 和 0.49 只差 0.02，但决策是"通过 vs 拒绝"的天壤之别。如果把 0.5-0.95 的内容强制判，误判率（把正常评价判违规 + 把违规放过）会飙升。拼多多评价日均几百万条，即使误判率从 1% 涨到 3%，每天就是几万条误判，用户投诉 + 申诉成本远高于人审成本。0.5-0.95 进人审是"用少量人力消化模型不确定的长尾"，把机审的准确率要求从"全量 99%"降到"高置信区间 99.9%"，模型训练成本和人审成本综合最优。

### 第二层：证据与定位

**Q：商家投诉"我的商品评分突然从 4.8 掉到 4.2"，你怎么定位是评分聚合 bug 还是真有大量差评？**

评分聚合是增量计算，漂移的可能根因：
1. 对账增量 vs 全量——先 `SELECT AVG(score), COUNT(*) FROM review WHERE product_id=? AND status=1` 全量算，对比 Redis 里的 `total_score / count`。如果全量是 4.8 而 Redis 是 4.2，是聚合 bug（增量没算对）。
2. 看增量日志——最近 24 小时该商品的评价事件（上架/下架/删除），每个事件的 `increment(total_score, score)` 是否正确。常见 bug：下架评价时 `increment(total_score, -score)` 漏了负号，或 `count` 减了但 `total_score` 没减。
3. 看是否有刷差评——反作弊命中日志，如果近 24 小时新增大量低信誉账号的 1 星评价，是真有差评（可能被竞争对手恶意刷），不是 bug。

### 第三层：根因深挖

**Q：评分聚合你用 Redis Hash 的 increment（原子），但仍然出现 count 和 total_score 对不上。根因可能是什么？**

Redis 的 hincrby 本身原子，但"业务操作 + Redis 更新"不是原子的。根因：
1. **并发更新未加锁**——评价上架时 `updateReviewStatus + hincrby` 两步，如果两个审核员同时审同一条评价（并发），可能出现 count 加了 2（两次 hincrby）但实际只上架 1 条。
2. **Redis 与 DB 不一致**——如果用了缓存删重建（而非 increment），并发读重建时可能读到中间态。
3. **hincrby 的值算错**——`r.getScore()` 如果是 Integer 自动拆箱为 null（数据库 score 字段为 null），`hincrby total_score null` 抛异常，count 加了但 total_score 没加。
4. **Redis 主从延迟**——hincrby 写主库，但读从库，读到旧值。聚合场景应读写都走主库。
根治：评分聚合用 Lua 脚本保证 count 和 total_score 原子更新（`eval "redis.call('hincrby', k, 'count', 1); redis.call('hincrby', k, 'total_score', s)"`）+ 定时全量校准兜底。

### 第四层：方案权衡

**Q：行家评价加权排序你设权重=权威度评分，但普通用户抱怨"行家评价永远排前面，我的高质量评价没人看"。你怎么权衡公平性和专业性？**

纯权重排序会导致"行家垄断头部，普通用户被埋没"。权衡方案：
1. 分层展示——不是全局加权排序，而是"行家专区 + 普通评价区"分开展示。Top 3 固定给行家（体现专业性），第 4 名起按"点赞数 + 时效"纯质量排序（普通用户有机会）。
2. 动态权重——权重不是固定的权威度，而是 `weight = authority * recency_factor`，行家评价随时间衰减权重，老评价会被新的高质量普通评价顶上来。
3. 质量门槛——普通评价如果"点赞数 > 阈值"（如 100 赞），视为高质量，权重等同于行家，进入头部竞争。
本质是"用结构化展示（分区）+ 动态衰减"替代"纯权重排序"，兼顾专业性和普通用户的曝光机会。

### 第五层：验证与沉淀

**Q：你怎么验证机审模型的准确率没退化（模型上线后随着对抗变体出现，准确率会降）？**

模型效果监控是审核系统的生命线：
1. 在线指标——抽样 1% 的机审"通过"结果进人审复核，统计误放率（违规被放过）；监控人审拒绝率（机审通过后人审又拒的比例），如果从 2% 涨到 10%，说明模型在退化。
2. 申诉率监控——用户申诉"评价被误删"的比例，申诉成功率高说明误判多。
3. 对抗样本追踪——统计敏感词命中类型分布，如果"谐音/拆字"类命中占比上升，说明对抗变体增多，规则词典需更新。
4. 离线评测——每周用固定测试集（标注好的人工评测集）跑模型，对比 F1 score，下降 >2% 触发模型重训。
沉淀：机审置信度阈值接 Apollo 动态调；人审结果每日回流标注库；模型每月增量训练（用近 1 个月新标注数据）；审核准确率（误判率/漏判率）纳入 SLO（误判率 <1%，漏判率 <0.5%）。

## 结构化回答


**30 秒电梯演讲：** 评价系统像餐厅大众点评——客户写评价（UGC）、商家回（互动）、平台审（合规）、汇总成评分（决策）。

**展开框架：**
1. **评价生命周期** — 提交→机审→人审→上架/下架
2. **评分聚合** — 实时增量更新（防不一致）
3. **防刷：内容/** — 内容/行为双维反作弊

**收尾：** 怎么防止刷好评？


## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：评价业务怎么设计（含行家社区）？ | 今天聊「评价业务怎么设计（含行家社区）？」。一句话：评价系统是"用户评价+商家回复+平台审核+评分聚合+行家社区"的内容闭环；技术关键是审核流（机审+人审）、防刷、评分聚… | 开场钩子 |
| 0:12 | 核心概念图 + 关键词浮现 | 要点是：生命周期：提交→机审→人审→上架 | 核心概念 |
| 1:04 | 能力/参数拆解表 | 要点是：评分：增量+定时校准 | 能力拆解 |
| 1:56 | 流程图：输入→处理→输出 | 要点是：防刷：内容+行为双维 | 关键机制 |
| 3:00 | 总结卡 + 下期预告 | 记住这些核心点就够了。下期我们接着聊——怎么防止刷好评？。 | 收尾 |
