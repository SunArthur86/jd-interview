---
id: pdd-trade-022
difficulty: L4
category: pdd-trade
subcategory: 交易架构
tags:
- 拼多多
- 交易
- 支付
- 路由
- 对账
feynman:
  essence: 支付路由是"在多通道（微信/支付宝/银行）间按成本/成功率/限额智能选择"的决策层，用规则+模型动态切换，保证高成功率和低成本。
  analogy: 支付路由像"打车软件"——多个通道像司机，路由器按距离（成本）/评分（成功率）/接单（限额）给你派一个最合适的。
  first_principle: 多支付通道各有优劣（费率/成功率/限额），需要智能调度最大化成功率、最小化成本。
  key_points:
  - 路由维度：通道成功率/费率/单笔限额/MAU 配额
  - 策略：规则（优先级）+ 模型（动态成功率预测）
  - 降级：主通道失败自动切备通道
  - 对账：T+1 与各通道对账，差错处理
first_principle:
  problem: 多支付通道如何选择才能既高成功率又低成本？
  axioms:
  - 通道成功率波动（网络/限额）
  - 费率不同（微信/支付宝/银行）
  - 单通道有配额/限额
  rebuild: 路由决策层（规则+模型）+ 实时成功率反馈 + 自动降级。
follow_up:
  - 怎么知道通道成功率？——实时统计（滑动窗口）+ 离线汇总
  - 路由决策放客户端还是服务端？——服务端（统一控制+可热切换）
  - 支付失败重试策略？——失败立即切通道，最多 3 次（限流防套）
memory_points:
  - 路由维度：成功率/费率/限额/配额
  - 策略：规则+模型（动态成功率）
  - 降级：主备通道自动切换
  - 对账：T+1 差错处理
---

# 【拼多多交易】支付路由怎么设计？

> JD 依据："交易系统技术升级"、"基础电商业务架构"。

## 一、支付链路

```
用户支付 → 网关 → 支付路由 → [微信/支付宝/银行/余额] → 回调 → 订单状态
                       ↑
                  路由决策（规则+模型）
```

## 二、路由决策

```java
public class PayRouter {
    // 通道实时成功率（滑动窗口 5 分钟）
    private Map<String, RateWindow> successRate;
    // 通道配置（费率/限额/配额）
    private Map<String, ChannelConfig> channels;

    public String route(PayRequest req) {
        List<String> candidates = channels.values().stream()
            .filter(c -> c.supports(req.getAmount(), req.getPayType()))
            .filter(c -> c.hasQuota(req.getUid()))
            .sorted(Comparator.comparingDouble(c -> score(c, req)))
            .map(ChannelConfig::getName)
            .collect(Collectors.toList());
        return candidates.get(0);  // 最优通道
    }

    // 综合评分：成本（低）+ 成功率（高）+ 当前负载（低）
    private double score(ChannelConfig c, PayRequest req) {
        double costScore = c.getFeeRate();                      // 越低越好
        double succScore = 1 - successRate.get(c.getName()).get(); // 失败率
        double loadScore = c.getCurrentQps() * 1.0 / c.getMaxQps();
        return costScore * 0.4 + succScore * 0.5 + loadScore * 0.1;
    }
}
```

## 三、实时成功率统计

```java
// 滑动窗口统计（每个通道）
class RateWindow {
    private Window<Long> success = new SlidingWindow(5, MINUTES);
    private Window<Long> total   = new SlidingWindow(5, MINUTES);
    public void record(boolean ok) { total.add(1L); if (ok) success.add(1L); }
    public double get() { return success.sum() * 1.0 / Math.max(1, total.sum()); }
}
```

成功率低于阈值（如 95%）自动降权或熔断切其他通道。

## 四、对账系统（T+1）

```
1. 下载各通道 T 日账单
2. 与本地支付流水比对
   ├─ 平台有/通道无 → 长款（可能通道延迟）
   └─ 通道有/平台无 → 短款（可能掉单）
3. 差错处理：补单/退款/人工介入
```

## 五、拼多多特色

- **多通道并存**：微信/支付宝/银联/苹果支付/余额
- **大额分期**：路由到支持分期的通道
- **下沉市场**：覆盖货到付款/线下代收
- **资金归集**：各通道资金 T+1 归集到主账户

## 六、底层本质

支付路由本质是**"多目标优化（成功率最高+成本最低+风险最小）"**——用规则保证基础正确，用模型动态学习，用对账兜底资金正确。

## 常见考点
1. **路由决策为什么放服务端**？——统一控制、可热切换、防客户端被破解。
2. **掉单（用户扣钱订单未支付）怎么处理**？——主动查询通道+对账兜底+退款。
3. **大促通道限额怎么办**？——预热配额+多通道分流+限流保护。
