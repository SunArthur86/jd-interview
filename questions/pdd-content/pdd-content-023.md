---
id: pdd-content-023
difficulty: L4
category: pdd-content
subcategory: Feed 流
tags:
- 拼多多
- 内容
- Feed 流
- 架构
- 推荐
- 召回
- 排序
feynman:
  essence: Feed 推荐架构是"召回（多路）→ 粗排→精排→重排"漏斗，从亿级内容筛出几十条；与算法同学合作做特征工程+模型迭代。
  analogy: Feed 推荐像选品会——召回是初筛（多路找候选）、粗排是快速淘汰、精排是精挑、重排是最终摆货（多样性/广告）。
  first_principle: 内容过亿，用户只看几十条，需多级漏斗+模型预测点击率/停留。
  key_points:
  - 召回：多路（协同/标签/向量/热点）
  - 粗排：双塔模型快速过滤
  - 精排：DIN/DeepFM 预测 CTR
  - 重排：多样性/新颖性/广告插入
first_principle:
  problem: 海量内容如何为用户筛出最相关的几十条？
  axioms:
  - 内容过亿
  - 用户只看几十条
  - 个性化（千人千面）
  rebuild: 召回+排序多级漏斗+模型预测。
follow_up:
  - 冷启动怎么做？——新内容用内容特征+热度兜底；新用户用兴趣探测
  - 怎么解决信息茧房？——多样性重排+探索（EE 策略）
  - 实时性怎么保证？——特征实时化（Flink）+模型在线学习
memory_points:
  - 召回：多路（协同/向量/标签/热点）
  - 粗排：双塔快速过滤
  - 精排：DIN/DeepFM CTR
  - 重排：多样性/广告
---

# 【拼多多内容】Feed 推荐架构怎么设计？

> JD 依据："和算法同学挖掘业务问题"、"Feed 流"、"高并发大流量大数据量"。

## 一、推荐漏斗

```
                  亿级内容池
                       ↓
        ┌─────── 召回（多路）──────┐
        │ 协同过滤 / 向量 / 标签 / 热点 │  → 几千候选
        └──────────┬──────────────┘
                   ▼
            粗排（双塔模型）        → 几百
                   ▼
            精排（DIN/DeepFM）      → 一百（带 CTR 分）
                   ▼
            重排（多样性+广告）      → 几十（最终展示）
```

## 二、召回层（多路并行）

| 召回路 | 原理 | 用途 |
|--------|------|------|
| 协同过滤 | 相似用户看过的 | 经典 |
| Item2Vec | 内容向量相似 | 内容相关 |
| User-Vec | 用户兴趣向量 | 个性化 |
| 标签召回 | 用户标签匹配内容 | 简单稳 |
| 热点召回 | 全局热榜 | 兜底 |
| 向量召回 | ANN（Faiss/HNSW） | 大规模 |

```java
public List<Candidate> recall(User user) {
    List<Candidate> all = new ArrayList<>();
    all.addAll(cfRecall(user));         // 协同过滤
    all.addAll(vecRecall(user));        // 向量
    all.addAll(tagRecall(user));        // 标签
    all.addAll(hotRecall());            // 热点兜底
    return all;
}
```

**向量召回**（Faiss/HNSW）：
```
内容 Embedding（BERT/双塔）→ 向量库
用户 Embedding → ANN 查询 TopK 相似内容
```

## 三、粗排（快速过滤）

**双塔模型**：
```
用户塔：用户特征 → MLP → 用户向量
内容塔：内容特征 → MLP → 内容向量
              ↓ 内积
         相似度分数
```

特点：内容塔可离线预计算，在线只算用户塔+内积，速度快。

## 四、精排（CTR 预测）

**DIN（Deep Interest Network）**：
```
用户历史行为序列 → Attention（与候选 Item 相关性加权）→ 兴趣向量
+ 用户特征 + 内容特征 → MLP → CTR
```

**DeepFM**：
```
FM（一阶+二阶交叉） + DNN（高阶）→ CTR
```

```python
# 精排输入特征
features = {
    "user": {"age": ..., "gender": ..., "history": [...]},
    "item": {"category": ..., "tags": ..., "price": ...},
    "context": {"time": ..., "device": ...}
}
ctr = model.predict(features)
```

## 五、重排（业务策略）

```
1. 多样性：同 category 不连续（避免信息茧房）
2. 新颖性：插入未看过的新内容
3. 时效性：新闻/直播优先
4. 广告：按比例插入（第 3/7 位）
5. 业务规则：屏蔽已看过/黑名单
```

```java
public List<Feed> rerank(List<Feed> ranked) {
    // 多样性：滑窗保证相邻不同类
    List<Feed> result = slideWindow(ranked, 4);
    // 广告插入
    result = insertAds(result, adRatio);
    return result;
}
```

## 六、特征工程（与算法同学合作）

**特征类型**：
- 用户特征：基础（年龄/性别）+ 行为（点击/购买/停留）+ 兴趣标签
- 内容特征：基础（类目/价格）+ 质量（评分/热度）+ 标签
- 上下文：时间/地域/设备
- 交叉特征：用户×内容×上下文

**实时特征**（Flink）：
```
用户实时行为 → Flink → 实时特征库（Redis/HBase）
  例：最近 5 分钟点击的商品类目
```

## 七、冷启动

**新内容冷启动**：
- 用内容特征（类目/标签/Embedding）找相似用户
- 流量探索（EE 策略，给新内容曝光机会）
- 兜底用热度

**新用户冷启动**：
- 注册信息（性别/年龄/地域）→ 默认兴趣
- 引导选择兴趣标签
- 短期高频探索+快速建模

## 八、实时性

```
特征实时：Flink 流式聚合用户行为 → Redis（5min 窗口）
模型实时：在线学习（FTRL/PD）→ 小步快迭
召回实时：用户行为即时写入 ANN 库
```

## 九、架构组件

```
- 召回服务：Java/Python，Faiss/HNSW 向量库
- 排序服务：Python（TF/PyTorch），GPU 推理
- 特征平台：Hadoop/HBase（离线）+ Flink/Redis（实时）
- 模型平台：训练（TF/PyTorch）+ 推理（TF Serving/Triton）
- AB 实验：流量分桶+指标对比
```

## 十、底层本质

Feed 推荐本质是**"用多级漏斗+模型预测从亿级内容筛出最相关的几十条"**——召回保 recall、排序保 precision、重排保体验，特征+模型是核心，与算法同学紧密合作迭代。

## 常见考点
1. **怎么衡量推荐效果**？——CTR/停留时长/互动率/留存/GMV。
2. **AB 实验怎么做**？——流量分桶（hash uid）+ 指标显著性检验。
3. **向量召回用什么库**？——Faiss（CPU）/NGT/HNSW（图）/Milvus。
