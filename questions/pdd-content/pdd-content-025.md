---
id: pdd-content-025
difficulty: L4
category: pdd-content
subcategory: 中台架构
tags:
- 拼多多
- 内容
- 中台
- 架构
- DDD
- 能力复用
feynman:
  essence: 内容中台是"把内容生产/审核/存储/分发能力下沉为共享服务"的架构，避免各业务线重复造轮子；用 DDD 划域+能力开放+多租户。
  analogy: 内容中台像中央厨房——各门店（业务线）不必各雇大厨，中央统一做半成品（能力），门店按需取用。
  first_principle: 多业务线（评价/直播/Feed/短视频）有共性能力（生产/审核/存储/分发），下沉中台复用。
  key_points:
  - 能力分层：生产/审核/存储/分发/分析
  - DDD 划域：内容域/审核域/用户域/互动域
  - 多租户：业务线隔离+共享
  - 能力开放：API/SDK 给业务调用
first_principle:
  problem: 多业务线有共性内容能力，如何下沉复用避免重复造轮子？
  axioms:
  - 业务线多
  - 能力有共性
  - 又需定制
  rebuild: 中台（共性能力）+ 业务前台（定制）。
follow_up:
  - 中台和微服务区别？——中台是能力复用理念，微服务是落地形式
  - 怎么避免大泥球？——DDD 划域+能力开放+租户隔离
  - 中台失败常见原因？——脱离业务+过度抽象+没有 owner
memory_points:
  - 能力：生产/审核/存储/分发/分析
  - DDD：内容/审核/用户/互动域
  - 多租户：业务线隔离+共享
  - 开放：API/SDK
---

# 【拼多多内容】内容中台架构怎么设计？

> JD 依据："新媒体业务平台"、"系统架构优化"、"中台"。

## 一、为什么需要内容中台

```
无中台：
  评价组：自建生产/审核/存储
  直播组：自建生产/审核/存储
  短视频组：自建生产/审核/存储
  → 重复造轮子，审核规则不一致，数据孤岛

有中台：
  内容中台：统一生产/审核/存储/分发能力
  评价组/直播组/短视频组：调用中台 + 业务定制
  → 复用+一致+快速创新
```

## 二、能力分层

```
┌────────────── 业务前台（定制） ──────────────┐
│  评价业务 │ 直播业务 │ 短视频业务 │ 社区业务    │
└──────────────────┬──────────────────────────┘
                   │ 调用
┌──────────── 内容中台（共性能力） ────────────┐
│  生产能力 │ 审核能力 │ 存储能力 │ 分发能力 │ 分析 │
│  (UGC 编辑器)│(机审+人审)│(对象+索引)│(Feed/搜索)│(统计)│
└──────────────────┬──────────────────────────┘
                   │
┌──────────── 基础设施 ────────────────────────┐
│  MySQL │ Redis │ ES │ Kafka │ OSS │ Flink     │
└──────────────────────────────────────────────┘
```

## 三、五大核心能力

**1. 生产能力**：
- UGC 编辑器（富文本/图片/视频）
- 模板（评价/动态/短视频）
- 草稿/发布

**2. 审核能力**：
- 规则引擎+模型服务+人审台（详见 024）
- 多业务共享审核规则（敏感词/合规统一）
- 业务线定制规则（评价查重 vs 短视频查重）

**3. 存储能力**：
- 内容主数据（MySQL 分库分表）
- 文件存储（OSS/S3 + CDN）
- 搜索索引（ES）
- 缓存（Redis）

**4. 分发能力**：
- Feed 流（推/拉/混合）
- 搜索（ES）
- 推荐（召回+排序）
- 推送（消息/通知）

**5. 分析能力**：
- 内容统计（量/质/互动）
- 用户行为（点击/停留/转化）
- 实时大屏（Flink）

## 四、DDD 领域划分

```
内容域（Content）
  - 实体：Content（评价/视频/动态）
  - 值对象：Tag/Media
  - 聚合根：Content

审核域（Audit）
  - 实体：AuditTask/AuditRule
  - 领域服务：RuleEngine/ModelPredictor

用户域（User）
  - 实体：User/Author
  - 值对象：Profile/TrustScore

互动域（Interaction）
  - 实体：Like/Comment/Share
  - 领域事件：UserLikedEvent

分发域（Distribution）
  - 实体：Feed/SearchIndex
  - 领域服务：FeedPusher/Searcher
```

## 五、多租户（业务线隔离）

```java
@Entity
@Table(name = "content")
public class Content {
    @Id private Long id;
    private String tenantId;     // 业务线标识（review/live/short_video）
    private String bizType;      // 业务子类型
    private Long bizId;          // 业务 ID（评价 ID/直播 ID）
    ...
}
```

**租户隔离**：
- 数据：按 tenantId 分库/分表 或 行级隔离
- 配置：每个租户独立审核规则/分发策略
- 限流：按租户限流防互相影响
- 监控：按租户维度统计

## 六、能力开放

```
API（HTTP/gRPC）：
  POST /content/publish        发布内容
  GET  /content/{id}           查询
  POST /content/audit          触发审核
  POST /feed/push              推送到 Feed
  GET  /search                 搜索

SDK：
  Java SDK（业务线集成）
  JS SDK（前端编辑器）
```

**OpenAPI 网关**：
- 鉴权（业务线 token）
- 限流（按租户）
- 路由（灰度）
- 审计

## 七、内容主数据模型

```sql
CREATE TABLE content (
  id BIGINT PRIMARY KEY,
  tenant_id VARCHAR(32),        -- 业务线
  biz_type VARCHAR(32),         -- review/live/short_video
  biz_id BIGINT,
  author_uid BIGINT,
  title VARCHAR(200),
  content TEXT,
  media JSON,                   -- 图片/视频 URL
  tags JSON,
  status TINYINT,               -- 0待审 1通过 2人审 3下架
  create_time DATETIME,
  INDEX idx_tenant_biz(tenant_id, biz_type, biz_id),
  INDEX idx_author(author_uid, create_time)
);
```

## 八、事件驱动

```
内容生命周期事件：
  ContentPublished / ContentApproved / ContentRejected / ContentTakenDown
  
各业务订阅：
  - 评价组：监听 ContentPublished 同步商品评价列表
  - Feed 组：监听 ContentApproved 推送到粉丝收件箱
  - 搜索组：监听 ContentApproved 同步 ES
  - 推荐组：监听 ContentApproved 加入召回池
```

## 九、中台治理

```
- 能力 owner：每个能力有团队负责（开发/运维/迭代）
- SLA：能力有明确 SLA（可用性/延迟/QPS）
- 版本管理：API 版本化，兼容
- 文档：OpenAPI 文档 + 接入指南
- 监控：能力调用监控+业务反馈
```

## 十、底层本质

内容中台本质是**"把内容共性能力下沉为共享服务"**——通过 DDD 划域+多租户隔离+能力开放，让业务前台快速创新，避免重复造轮子。中台成功的关键是贴合业务+有 owner+不过度抽象。

## 常见考点
1. **中台和微服务关系**？——中台是能力复用理念，微服务是技术落地形式。
2. **怎么避免中台失败**？——贴合业务（不要先建中台再找业务）+有 owner+小步迭代。
3. **多租户怎么隔离**？——数据（库/表/行）+ 配置（规则）+ 限流 + 监控。
