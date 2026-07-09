---
id: pdd-scm-025
difficulty: L4
category: pdd-scm
subcategory: 供应链架构
tags:
- 拼多多
- 供应链
- 对账
- 结算
- 系统设计
feynman:
  essence: 结算对账系统是供应链的"财务大脑"，用"三单匹配（订单/到货/发票）+ T+1 全量对账 + 实时差异监控"保证资金流和信息流一致，日处理百亿 GMV。
  analogy: 对账像企业的"账房先生"——每天核对三本账（订单账/仓储账/财务账），三方一致才平账，不一致就查差异。
  first_principle: 资金不允许错，必须多源数据交叉验证（三单匹配）+ 全量对账兜底。
  key_points:
  - 三单匹配：订单 + 到货 + 发票（金额/数量一致才付款）
  - T+1 全量对账：订单系统 vs 仓储系统 vs 财务系统
  - 实时差异监控：金额对不上、库存负数即时告警
  - 差异处理：自动调账规则 + 人工核查
first_principle:
  problem: 日百亿 GMV，如何保证订单/仓储/财务三套系统数据一致、资金不出错？
  axioms:
  - 资金不允许错
  - 多系统异步可能不一致
  - 必须交叉验证 + 全量兜底
  rebuild: 三单匹配（付款前校验）+ T+1 全量对账 + 实时差异监控 + 差异处理。
follow_up:
- 对账发现差异怎么处理？——自动调账规则（已知差异类型）+ 人工核查（复杂差异）
- 实时对账 vs T+1 对账？——实时监控关键指标（负库存/金额异常）；T+1 全量兜底
- 怎么保证对账性能？——Flink 实时聚合 + Spark 离线全量
memory_points:
- 三单匹配：订单 + 到货 + 发票（一致才付款）
- T+1 全量对账：订单 vs 仓储 vs 财务
- 实时差异监控（负库存/金额异常告警）
- 差异处理：自动调账 + 人工核查
---

# 【拼多多供应链】设计结算对账系统（日百亿 GMV）

> JD 依据："结算"是供应链核心环节。

## 一、对账体系

```
实时监控（Flink）          T+1 全量对账（Spark）
   ↓                          ↓
差异告警（秒级）            平账/差异报告（天级）
```

## 二、三单匹配（付款前）

```java
public boolean match(Long poId) {
    PurchaseOrder po = poService.get(poId);        // 采购单
    ArrivalNote arrival = arrivalService.get(poId); // 到货单
    Invoice invoice = invoiceService.get(poId);    // 发票

    return po.amount == arrival.amount          // 金额一致
        && po.qty == arrival.qty                // 数量一致
        && po.amount == invoice.amount;          // 发票金额一致
}
// 三单一致才允许付款
```

## 三、T+1 全量对账

```
订单系统数据 vs 仓储系统数据 vs 财务系统数据
   ↓ 三方比对
一致 → 平账
不一致 → 差异表 → 自动调账 or 人工核查
```

**Spark 批处理**：
```sql
SELECT o.order_id, o.amount as order_amt, w.amount as wh_amt, f.amount as fin_amt
FROM orders o
FULL OUTER JOIN warehouse w ON o.order_id = w.order_id
FULL OUTER JOIN finance f ON o.order_id = f.order_id
WHERE COALESCE(o.amount,0) != COALESCE(w.amount,0)
   OR COALESCE(w.amount,0) != COALESCE(f.amount,0);
```

## 四、实时差异监控（Flink）

```java
// 库存负数监控
stockStream.filter(s -> s.qty < 0).addSink(new AlertSink());

// 金额突变监控
orderStream
    .keyBy(o -> o.skuId)
    .window(TumblingEventTimeWindows.of(Time.minutes(5)))
    .aggregate(new SumAggregator("amount"))
    .filter(amt -> amt > threshold)  // 5 分钟金额异常
    .addSink(new AlertSink());
```

## 五、差异处理

| 差异类型 | 处理 |
|---------|------|
| 时序差（跨日订单） | 自动延后一天对账 |
| 退货未同步 | 触发逆向同步 |
| 价格变更未同步 | 财务补录 |
| 复杂差异 | 人工核查工单 |

## 六、底层本质

对账本质是**"多源数据的交叉验证"**——单一系统可能有 bug 或延迟，多系统交叉才能保证资金绝对正确。这是金融级系统的" defense in depth"（纵深防御）。

**钱学森工程理论**：技术上可行（成熟大数据栈）、经济上合理（自动对账省人力）、协调运转（订单/仓储/财务三系统协同）。

## 常见考点
1. **对账性能怎么保证**？——Spark 批处理（TB 级）+ 分区裁剪 + 增量对账。
2. **怎么防止重复付款**？——付款单唯一（业务幂等）+ 三单匹配校验。
3. **实时和离线对账区别**？——实时抓关键异常（秒级）；离线全量兜底（天级）。
