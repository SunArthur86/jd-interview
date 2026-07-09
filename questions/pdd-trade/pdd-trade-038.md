---
id: pdd-trade-038
difficulty: L4
category: pdd-trade
subcategory: Agent 架构
tags:
- 拼多多
- 交易
- 智能中台
- Agent 架构
- 决策引擎
feynman:
  essence: 智能交易中台是"把 AI 能力沉淀成可复用的平台能力"——商品/订单/营销/风控/客服统一接入 AI（推荐/搜索/风控/对话），上层业务按需调用，避免每个团队重复造轮子。
  analogy: 智能中台像"集团中央厨房"——各门店（业务）不用自己建厨房（AI 团队），中央统一做好（模型/特征/数据）配送，门店只管摆盘（业务定制）。
  first_principle: AI 能力（模型/特征/数据/工程）建设成本高，多业务线有共性，沉淀中台复用。
  key_points:
  - 中台分层：数据/特征/模型/服务/应用
  - 能力服务化：推荐/搜索/风控/对话 API
  - 业务接入：低代码配置+SDK
  - 治理：模型版本/AB 实验/效果归因
first_principle:
  problem: 多业务线都需 AI 能力，如何避免重复建设、统一标准？
  axioms:
  - AI 建设成本高（数据/模型/工程）
  - 业务有共性（推荐/搜索/风控）
  - 需统一标准和治理
  rebuild: 分层中台（数据→特征→模型→服务→应用）+ 能力服务化 + 低代码接入。
follow_up:
  - 中台和业务边界？——中台提供通用能力，业务做定制（prompt/规则/数据）
  - 怎么避免"中台不中"（变成瓶颈）？——开放+自治+SLA+可绕过
  - AB 实验平台怎么搭？——流量分桶+指标统计+显著检验
memory_points:
  - 分层：数据/特征/模型/服务/应用
  - 能力：推荐/搜索/风控/对话 API
  - 接入：低代码+SDK
  - 治理：版本/AB/归因
---

# 【拼多多交易】智能交易中台怎么搭？

> JD 依据："智能交易中台"。

## 一、中台分层

```
应用层：商品/订单/营销/风控/客服（业务定制）
   ↑
服务层：推荐/搜索/风控/对话/画像（API 化能力）
   ↑
模型层：召回/排序/GBDT/深度学习/LLM（版本化）
   ↑
特征层：实时（Flink）+离线（Spark）特征仓库
   ↑
数据层：埋点/订单/行为/商品（数据中台）
```

## 二、能力服务化

```java
// 推荐服务（中台 API）
public interface RecommendService {
    List<Item> recommend(long uid, String scene, int n);
}

// 业务调用（场景定制）
@RestController
public class ProductPage {
    @GetMapping("/you-may-like")
    public List<Item> youMayLike(long uid) {
        return recommendSvc.recommend(uid, "product_detail_sidebar", 10);
    }
}
```

**能力清单**：
```
推荐：商品/类目/关联
搜索：召回/排序/相关推荐
风控：反作弊/限购/风险评分
对话：客服 LLM/导购 Agent
画像：用户/商品/商户标签
```

## 三、特征平台

```
实时（Flink）：当前会话浏览/点击/下单 → Redis（毫秒级）
离线（Spark）：历史购买/偏好 → HBase（T+1）
特征服务：统一 API，模型按需取
```

```java
public class FeatureService {
    public Features get(long uid, List<String> names) {
        Features f = new Features();
        for (String name : names) {
            f.put(name, featureStore.get(uid, name));  // 路由到 Redis/HBase
        }
        return f;
    }
}
```

## 四、AB 实验平台

```
流量分桶：UID hash 分 100 桶
实验配置：对照组 50 桶 / 实验组 50 桶
指标统计：点击率/转化率/客单价
显著检验：t-test，p<0.05 显著
决策：实验组显著优 → 全量
```

```java
@ABExperiment(name = "new_rank_model", defaultBucket = "control")
public List<Item> rank(List<Item> items, long uid) {
    String bucket = abRouter.route(uid, "new_rank_model");
    return "exp".equals(bucket) ? newRanker.rank(items) : oldRanker.rank(items);
}
```

## 五、业务接入

```
低代码：
  - 选能力（推荐/搜索）
  - 配场景（页面/位置）
  - 选模型（默认/定制）
  - 上线 + AB 实验
SDK：
  - Java/Go/Python SDK
  - 自动埋点+实验
  - 降级兜底（中台挂走默认）
```

## 六、治理

```
模型治理：版本化+灰度+回滚+评测
效果归因：哪个模型贡献多少 GMV
成本归因：各业务用了多少 GPU/特征
SLA：中台 RT < 50ms，可用性 99.99%
```

## 七、拼多多实战

- **商品中台**：千万级商品统一打标/画像，喂推荐/搜索
- **用户中台**：亿级用户画像，千人千面
- **营销中台**：券/补贴/拼团统一规则引擎
- **AI 中台**：推荐/搜索/风控/对话模型统一管理，AB 实验每日千个

## 八、底层本质

智能交易中台本质是**"把 AI 能力从项目沉淀为平台"**——数据/特征/模型/服务分层，业务低代码接入，AB 实验驱动迭代。中台成功的关键是"开放+标准+SLA"，避免成为瓶颈。

## 常见考点
1. **中台怎么避免变重**？——能力下沉通用部分，业务定制留给上层；严控接入 SLA。
2. **特征平台怎么保证实时**？——Flink 流算 + Redis 缓存 + 预聚合。
3. **AB 实验怎么防互扰**？——正交流量分桶（每个实验独立维度），互不影响。
