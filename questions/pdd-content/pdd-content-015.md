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
