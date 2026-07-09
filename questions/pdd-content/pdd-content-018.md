---
id: pdd-content-018
difficulty: L3
category: pdd-content
subcategory: 中台
tags:
- 拼多多
- 内容
- UGC
- 审核
- NLP
- 设计模式
feynman:
  essence: UGC 审核是"机审（规则+模型）+ 人审（疑难）"分级漏斗；用策略模式+责任链组装规则，机审过滤 90%，剩下人审降成本。
  analogy: 审核像海关——机审是 X 光（快速过滤大部分），人审是开箱（疑难重点看）。
  first_principle: UGC 合规风险高，但全人审成本不可承受，需分级漏斗。
  key_points:
  - 三级漏斗：规则→模型→人工
  - 维度：文本/图片/视频/音频
  - 设计模式：策略模式（规则）+责任链（流程）+工厂
  - 反馈闭环：人审结果回流训练模型
first_principle:
  problem: UGC 海量且合规风险高，如何低成本+高准确审核？
  axioms:
  - 全人审不可承受
  - 机审有误判
  - 多维度（文本/图片/视频）
  rebuild: 规则+模型+人工分级漏斗 + 反馈闭环。
follow_up:
  - 怎么降低误杀？——多层校验+灰度阈值+人审兜底+用户申诉
  - 怎么对抗变体（谐音/拆字）？——NLP 模型+变体词典+图像 OCR
  - 审核时效怎么保证？——优先级队列+机审实时+人审 SLA
memory_points:
  - 三级：规则→模型→人工
  - 维度：文本/图片/视频/音频
  - 模式：策略+责任链+工厂
  - 闭环：人审回流训练
---

# 【拼多多内容】UGC 内容审核架构（设计模式）？

> JD 依据："和算法同学挖掘业务问题"、"评价和行家社区"。

## 一、审核漏斗

```
UGC 内容（评价/直播弹幕/短视频）
        ↓
规则机审（敏感词/正则/IP 黑名单）→ 80% 直接通过/拒绝
        ↓ 剩下 20%
模型机审（NLP/视觉模型）→ 又判 70%
        ↓ 剩下 6%
人工审核（疑难/边界/高价值）→ 100% 准确
        ↓
结果回流（人审标注 → 训练模型）
```

## 二、多维度审核

| 维度 | 技术 | 场景 |
|------|------|------|
| 文本 | 敏感词/NLP 分类/相似度 | 评价/弹幕/标题 |
| 图片 | OCR/涉黄涉政/水印 | 评价图/直播封面 |
| 视频 | 抽帧+视觉模型/音转文字 | 短视频/直播录像 |
| 音频 | ASR 转文字+NLP | 直播音频 |

## 三、设计模式应用

**策略模式**（多种审核器）：
```java
public interface Auditor {
    AuditResult audit(Content c);
}

@Component
public class TextSensitiveWordAuditor implements Auditor { ... }

@Component
public class TextNlpAuditor implements Auditor { ... }

@Component
public class ImagePornAuditor implements Auditor { ... }
```

**责任链模式**（审核流程）：
```java
public abstract class AuditHandler {
    protected AuditHandler next;
    public AuditHandler setNext(AuditHandler n) { this.next = n; return n; }
    public abstract AuditResult handle(Content c);
}

public class RuleAuditHandler extends AuditHandler {
    public AuditResult handle(Content c) {
        AuditResult r = ruleEngine.check(c);
        if (r.isCertain()) return r;             // 确定（通过/拒绝）直接返回
        return next != null ? next.handle(c) : r; // 不确定交下一环
    }
}

public class ModelAuditHandler extends AuditHandler { ... }
public class HumanAuditHandler extends AuditHandler { ... }

// 组装链
AuditHandler chain = new RuleAuditHandler();
chain.setNext(new ModelAuditHandler())
     .setNext(new HumanAuditHandler());
```

**工厂模式**（按内容类型选链）：
```java
public class AuditChainFactory {
    public AuditHandler getChain(ContentType type) {
        switch (type) {
            case REVIEW: return reviewChain;
            case DANMAKU: return danmakuChain;
            case SHORT_VIDEO: return videoChain;
        }
    }
}
```

## 四、审核规则引擎

**敏感词匹配**（DATrie/AC 自动机）：
```java
@Autowired WordMatcher sensitiveWordMatcher;

public AuditResult checkText(String text) {
    Set<String> hits = sensitiveWordMatcher.match(text);
    if (!hits.isEmpty()) {
        return AuditResult.reject("敏感词: " + hits);
    }
    return AuditResult.uncertain();   // 进下一环
}
```

**变体对抗**：
- 谐音（"傻逼"→"煞笔"）→ 拼音索引+谐音词典
- 拆字（"违禁"→"韦 禁"）→ 去空格+合并
- 表情/符号替换 → 归一化

## 五、NLP 模型审核

```
文本分类模型（BERT/ERNIE 微调）：
  输入：文本
  输出：涉政/涉黄/广告/正常 + 置信度

阈值：
  置信度 > 0.95：直接判
  0.5 ~ 0.95：人审
  < 0.5：通过
```

**视觉模型**：
- 图片分类（涉黄/暴恐/广告）
- OCR → 文字再走文本审核

## 六、人审台

```
待审队列（按优先级）：
  - 直播实时（最高，秒级）
  - 新发评价（高，分钟级）
  - 历史回扫（低，异步）

审核员工作台：
  - 待审内容卡片
  - 上下文（用户历史/商品信息）
  - 决策按钮（通过/拒绝/打标签）
  - 标签：违规类型/严重度
```

## 七、反馈闭环

```
人审结果 → 标注库 → 模型训练 → 上线 → 准确率提升
              ↓
        规则补丁（新模式/变体加入词典）
```

```java
@EventListener
public void onHumanAudit(HumanAuditEvent e) {
    // 人审结果入标注库
    annotationRepo.save(e.toAnnotation());
    // 累积一定量后触发模型再训练
    if (annotationRepo.count() % 10000 == 0) {
        modelService.retrain("text-classifier");
    }
}
```

## 八、底层本质

UGC 审核本质是**"用规则+模型+人工分级漏斗+反馈闭环实现合规+成本平衡"**——机审扛量（90%）、人审定疑难（10%）、人审结果反哺模型持续优化。

## 常见考点
1. **怎么平衡误杀和漏判**？——多阈值（高阈值通过、低阈值拒绝、中间人审）+ 用户申诉。
2. **直播实时审核怎么做**？——抽帧+视觉模型流式审核，超时默认通过（先播后审）+ 强下线。
3. **怎么对抗新型违规**？——黑样本快速入库+模型增量训练+规则补丁。
