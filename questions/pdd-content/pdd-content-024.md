---
id: pdd-content-024
difficulty: L4
category: pdd-content
subcategory: 内容架构
tags:
- 拼多多
- 内容
- UGC
- 审核
- 架构
- 规则引擎
- 事件驱动
feynman:
  essence: UGC 审核架构是"接入→预处理→机审（规则+模型）→人审→回流"漏斗+事件驱动；用规则引擎+模型服务+人审台组合，平衡准确率与成本。
  analogy: 审核架构像海关流水线——X 光机（规则）+ 智能识别（模型）+ 海关员开箱（人工），每步过滤一部分。
  first_principle: UGC 海量合规风险高，全人审不可承受，需漏斗式机审+人审兜底+反馈闭环。
  key_points:
  - 接入：Kafka 统一事件入口
  - 规则引擎：敏感词/正则/黑名单（毫秒级）
  - 模型服务：NLP/视觉（百毫秒级）
  - 人审台：疑难+高价值（分钟级）
  - 反馈闭环：人审结果回流训练
first_principle:
  problem: UGC 海量+合规风险，如何低成本+高准确+低延迟审核？
  axioms:
  - 全人审不可承受
  - 机审有误判
  - 多模态（文本/图/视频/音频）
  rebuild: 漏斗式机审+人审+反馈闭环+事件驱动。
follow_up:
  - 实时审核怎么保证低延迟？——抽帧+流式推理+模型蒸馏
  - 怎么平衡误杀和漏判？——多阈值+人审兜底+用户申诉
  - 新型违规怎么对抗？——黑样本快速入库+模型增量训练
memory_points:
  - 漏斗：规则→模型→人工
  - 多模态：文本/图/视频/音
  - 引擎：Drools/自研规则
  - 闭环：人审回流训练
---

# 【拼多多内容】UGC 内容审核架构怎么设计？

> JD 依据："和算法同学挖掘业务问题"、"评价和行家社区"、"系统架构优化"。

## 一、整体架构

```
UGC 入口（评价/弹幕/短视频/直播）
        ↓
   Kafka 统一事件总线（content.audit.request）
        ↓
┌─────────────── 审核调度服务 ──────────────┐
│  按内容类型 + 优先级 + 来源 路由           │
└───┬───────────────┬───────────────┬──────┘
    ▼               ▼               ▼
 规则引擎        模型服务         人审台
 (Drools/自研)  (NLP/视觉)      (工作台)
   毫秒           百毫秒           分钟
    │               │               │
    └─────── 决策合并 ──────────────┘
                ↓
        审核结果（status）
                ↓
        ┌───────┴───────┐
        ▼               ▼
   通知业务          人审标注库
   (上下架)            ↓
                   模型再训练
```

## 二、规则引擎

**Drools / 自研**：
```java
rule "敏感词命中"
when
    $c : Content(text matches ".*敏感词.*")
then
    $c.reject("SENSITIVE_WORD");
end

rule "新用户首条限频"
when
    $c : Content(uid age < 7 days, type == "REVIEW")
then
    $c.flag("NEW_USER_REVIEW");
end
```

**自研（更灵活）**：
- 敏感词：DATrie/AC 自动机
- 正则：广告/链接/手机号
- 黑名单：IP/UID/设备
- 行为：频次/突变

## 三、模型服务

**NLP（文本）**：
- BERT/ERNIE 微调分类（涉政/涉黄/广告/辱骂）
- SimHash/MinHash 查重（防模板复制）
- 命名实体识别（敏感人物/事件）

**视觉（图片/视频）**：
- 图片分类（涉黄/暴恐/广告）
- OCR → 转文字走文本审核
- 视频抽帧 → 每帧走视觉

**音频**：
- ASR 转文字 → 走文本审核
- 声纹识别（敏感人物）

**模型推理服务**（TF Serving/Triton）：
```
输入 → 预处理 → 模型 → 后处理 → 标签+置信度
```

## 四、人审台

```
工作台功能：
  - 待审队列（优先级：实时直播 > 评价 > 短视频）
  - 待审卡片（内容+上下文+历史）
  - 决策按钮（通过/拒绝/打标签）
  - 标签体系（违规类型/严重度/处置）
  - 性能监控（审核员吞吐/准确率）
```

**优先级队列**：
```java
PriorityQueue<Content> queue = new PriorityQueue<>(
    Comparator.comparing(Content::getPriority).reversed()
              .thenComparing(Content::getSubmitTime));
```

## 五、决策合并

```java
public AuditResult audit(Content c) {
    // 规则先跑（便宜）
    AuditResult rule = ruleEngine.check(c);
    if (rule.isReject()) return rule;          // 明确拒绝
    if (rule.isPass() && rule.confidence() > 0.95) return rule;

    // 模型跑（贵）
    AuditResult model = modelService.predict(c);
    if (model.confidence() > 0.95) return model;

    // 进人审（疑难）
    return humanAuditQueue.submit(c);
}
```

## 六、实时性（直播）

```
视频流 → 抽帧（1 帧/s） → 视觉模型（<500ms）
音频流 → ASR（流式）→ NLP（<500ms）

策略：
  - 抽帧+推理并行
  - 模型蒸馏（小模型实时，大模型异步）
  - 超时默认通过（先播后审）
  - 严重违规实时阻断
```

## 七、反馈闭环

```
人审结果 → 标注库 → 模型再训练 → 灰度上线 → 准确率提升
              ↓
        规则补丁（新型违规入库）
              ↓
        黑样本库（变体对抗）
```

```java
@EventListener
public void onHumanAudit(HumanAuditEvent e) {
    annotationRepo.save(e.toAnnotation());
    // 触发增量训练
    if (annotationRepo.uncappedSize() > 10000) {
        modelService.retrainAsync("text-classifier");
    }
}
```

## 八、容量与扩展

```
- Kafka：按 contentId 分区，保证顺序
- 规则引擎：无状态，K8s 弹性扩
- 模型服务：GPU 集群，按 QPS 弹性
- 人审台：B/C 端分离，按审核员数扩
- 标注库：MySQL + HBase（历史）
```

## 九、监控

```
审核指标：
  - 规则命中率（敏感词/广告）
  - 模型准确率/召回率
  - 人审吞吐/SLA
  - 误判率（用户申诉反推）
  - 端到端延迟

业务指标：
  - 内容合规率（线上抽检）
  - 用户投诉率
  - 模型版本对比
```

## 十、底层本质

UGC 审核架构本质是**"漏斗式机审+人审兜底+反馈闭环"**——规则扛 80%、模型扛 15%、人审 5%，结果回流持续优化；架构用事件驱动+多级决策，平衡成本/准确/延迟。

## 常见考点
1. **怎么降低误杀**？——多阈值+人审兜底+用户申诉+灰度上线。
2. **审核延迟怎么降**？——抽帧+流式推理+模型蒸馏+优先级队列。
3. **新型违规怎么对抗**？——黑样本快速入库+规则补丁+模型增量训练。
