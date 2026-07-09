---
id: pdd-trade-025
difficulty: L4
category: pdd-trade
subcategory: 交易架构
tags:
- 拼多多
- 交易
- 风控联调
- 反作弊
- 拦截
feynman:
  essence: 风控联调是"交易和风控系统的边界契约"——交易在下单关键节点同步调风控（拦截/放行），用规则引擎+模型毫秒级决策，失败降级保证下单可用。
  analogy: 风控联调像机场安检——你（订单）到登机口前必经安检（风控），3 秒判定放行或拦下，安检机器坏了开绿色通道（降级）。
  first_principle: 反作弊要拦在交易前（防损失），但风控不能阻塞下单体验，需 RT<100ms + 强降级。
  key_points:
  - 触发节点：下单/支付/领券/退款
  - 同步决策：规则+模型 < 100ms
  - 降级：风控超时/挂 → 默认放行（白名单）+ 异步复核
  - 数据回流：交易行为回流风控训练
first_principle:
  problem: 如何在交易关键节点实时拦截作弊，又不影响正常下单体验？
  axioms:
  - 作弊要事前拦截（防资金损失）
  - 正常用户不能等（RT 敏感）
  - 风控可能挂（要降级）
  rebuild: 同步轻量决策（规则+模型）+ 多级降级 + 数据回流闭环。
follow_up:
  - 风控决策放同步还是异步？——核心拦截同步（下单前），非核心异步（领券后）
  - 风控挂了怎么办？——超时降级放行+异步复核，宁可漏拦不阻塞正常用户
  - 风控规则怎么热更新？——规则中心+热加载（动态配置）
memory_points:
  - 触发：下单/支付/领券/退款
  - 同步决策 < 100ms（规则+模型）
  - 降级：超时放行+异步复核
  - 数据回流：交易行为→风控
---

# 【拼多多交易】交易和风控怎么联调？

> JD 依据："交易系统技术升级"、"基础电商业务架构"。

## 一、联调节点

```
用户 → [领券] → [下单] → [支付] → [退款]
       风控     风控     风控     风控
       异步     同步     同步     异步
       （发券） （拦）   （拦）   （复核）
```

| 节点 | 同步/异步 | 决策 | 阈值 |
|------|-----------|------|------|
| 下单 | 同步 | 拦截/放行/挑战（验证码） | 100ms |
| 支付 | 同步 | 拦截（高风险） | 100ms |
| 领券 | 异步 | 延迟撤销 | 秒级 |
| 退款 | 异步 | 人工复核 | 分钟 |

## 二、同步决策

```java
public class RiskGateway {
    @HystrixCommand(fallbackMethod = "defaultPass", commandProperties = {
        @HystrixProperty(name = "execution.isolation.thread.timeoutInMilliseconds", value = "100")
    })
    public RiskResult check(RiskReq req) {
        // 1. 规则引擎（毫秒级）
        RiskResult ruleResult = ruleEngine.eval(req);
        if (ruleResult.isBlock()) return ruleResult;
        // 2. 模型评分（< 50ms，特征预热）
        double score = modelService.score(req);
        return score > THRESHOLD ? RiskResult.block("模型拦截") : RiskResult.pass();
    }
    // 降级：风控挂了默认放行（不阻塞下单）
    private RiskResult defaultPass(RiskReq req) {
        asyncRecheck(req);  // 异步补救
        return RiskResult.pass();
    }
}
```

## 三、规则引擎 + 模型

**规则（白名单/黑名单/限购）**：
```
IF uid IN blacklist THEN block
IF 同 IP > 10 单/分钟 THEN challenge  // 验证码
IF 同设备 > 5 单/天 THEN block
IF 新用户首单 > 1000 元 THEN review
```

**模型（GBDT/深度学习）**：
- 特征：用户画像/设备指纹/行为序列/图关系
- 输出：作弊概率 0-1
- 阈值：> 0.9 拦截，0.7-0.9 挑战，< 0.7 放行

## 四、多级降级

```
风控正常 → 同步拦截
风控慢（>80ms）→ 跳过模型，仅规则
风控挂 → 默认放行 + 异步复核（事后退款/封号）
大促预热 → 已知白名单用户跳过风控
```

## 五、数据回流闭环

```
交易行为（订单/支付/退款）→ Kafka → 风控特征平台
  → 更新用户画像/设备图
  → 离线训练新模型
  → 上线（A/B + 灰度）
```

## 六、底层本质

风控联调本质是**"用同步决策+多级降级平衡反作弊和体验"**——核心拦在交易前（防损），失败宁可放过不阻塞正常用户（事后追责）。

## 常见考点
1. **风控决策 RT 怎么保证 < 100ms**？——规则引擎前置+模型特征预热+本地缓存。
2. **风控和交易的事务关系**？——风控独立服务，交易调风控失败降级，不影响创单事务。
3. **模型怎么不停服上线**？——A/B 灰度（5%→20%→100%）+ 影子流量验证 + 一键回滚。
