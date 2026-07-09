---
id: pdd-scm-024
difficulty: L4
category: pdd-scm
subcategory: 供应链架构
tags:
- 拼多多
- 供应链
- 采购
- SRM
- 系统设计
feynman:
  essence: 采购协同平台（SRM）连接拼多多和供应商，覆盖"寻源→合同→订单→到货→对账→付款"全流程，用"供应商分级+自动化采购+协同门户"降低采购成本。
  analogy: SRM 像企业的"采购部数字化"——管理供应商档案（分级）、发采购单（自动化）、跟踪到货（协同）、对账付款（结算），让采购透明高效。
  first_principle: 采购是供应链成本大头（商品成本 70%+），数字化降低采购成本、提升协同效率。
  key_points:
  - 供应商分级（A/B/C/D，按绩效）
  - 自动采购（库存低于阈值自动下单）
  - 协同门户（供应商在线接单/发货/对账）
  - 合同管理（框架协议+价格协议）
first_principle:
  problem: 万级供应商、百万采购单，如何高效协同、降低采购成本？
  axioms:
  - 采购成本占商品成本大头
  - 供应商多、协同复杂
  - 库存需要自动补充
  rebuild: 供应商分级管理 + 自动补货算法 + 协同门户 + 合同/价格管理。
follow_up:
- 自动补货怎么算？——安全库存 + 销量预测（历史+大促）+ 提前期
- 供应商怎么分级？——交期/质量/价格/响应 综合评分
- 采购合同怎么管？——框架协议（长期价格）+ 执行单（每次采购）
memory_points:
- SRM = 寻源→合同→订单→到货→对账→付款 全流程
- 供应商分级（A/B/C/D）+ 自动补货
- 协同门户（供应商在线操作）
- 框架协议管价格，执行单管每次采购
---

# 【拼多多供应链】设计采购协同平台（SRM）

> JD 依据："供应商管理"。

## 一、SRM 全流程

```
寻源 → 供应商准入 → 合同签订 → 采购订单 → 到货 → 质检 → 对账 → 付款
 │       │            │          │        │      │      │      │
寻源单  供应商档案   框架协议    PO      到货单  质检单  账单   付款单
```

## 二、供应商管理

```sql
CREATE TABLE supplier (
    id BIGINT,
    name VARCHAR,
    level ENUM('A','B','C','D'),   -- 分级
    score DECIMAL,                 -- 综合评分
    categories JSON,               -- 供货类目
    status ENUM('合作','暂停','淘汰')
);
```

**分级标准**：
- A：交期准时率 > 98%、质量合格率 > 99%、价格竞争力强
- D：淘汰（多次质量问题）

## 三、自动补货

```java
public void autoReplenish(Long skuId) {
    long stock = stockService.get(skuId);
    long safety = configService.getSafetyStock(skuId);
    if (stock < safety) {
        long forecast = forecastService.predict(skuId, 30);  // 30 天预测销量
        long leadTime = supplierService.getLeadTime(skuId);  // 采购提前期
        long orderQty = forecast * (leadTime + 7) / 30 - stock;  // 补到提前期+7天
        purchaseOrderService.create(skuId, orderQty);
    }
}
```

## 四、协同门户

供应商在线：
- 接收采购单（确认/拒绝）
- 录入发货信息
- 查看对账单
- 提交发票

降低沟通成本，全流程留痕。

## 五、合同管理

- **框架协议**：长期价格约定（季度谈价）
- **执行单**：每次采购引用框架协议价格
- **价格变更**：需审批，版本化

## 六、底层本质

SRM 本质是**"采购流程的数字化协同"**——把线下采购搬到线上，用系统保证透明、高效、可追溯。核心价值是降低采购成本（比价、谈判、自动化）和提升协同效率（门户、自动）。

## 常见考点
1. **怎么选供应商**？——RFQ（报价请求）+ 综合评分（价格/质量/交期/服务）。
2. **自动补货的难点**？——销量预测准确度（大促/季节性），提前期波动。
3. **采购和财务怎么对接**？——三单匹配（采购单/到货单/发票）+ 自动对账。
