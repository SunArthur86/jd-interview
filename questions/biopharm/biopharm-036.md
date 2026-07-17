---
id: biopharm-036
difficulty: L3
category: biopharm
subcategory: 异步
tags:
- 生物医药
- AI 全栈
- 异步任务
- Celery
- RabbitMQ
- 长任务编排
feynman:
  essence: "异步任务系统是'把耗时的 AI 任务从请求线程剥离，丢给后台 worker 慢慢跑'——Celery 编排、RabbitMQ 派单、worker 消费，支撑文档解析/批量推理/训练等长任务不阻塞、可恢复、可监控。"
  analogy: "像餐厅后厨——服务员点单把单子夹到传送带（RabbitMQ 队列）就回去服务下一桌（不阻塞），后厨按顺序取单做菜（worker 消费），复杂的宴席菜还能拆成多步（编排），做完按铃（回调）端菜。"
  first_principle: "AI 任务（文档解析/批量推理/训练）耗时长（分钟~小时级），同步处理会阻塞请求、耗尽线程。异步任务系统的本质是'用队列解耦生产消费，让长任务后台跑、不阻塞、可恢复、可监控、可编排'。"
  key_points:
  - "三角色：生产者（提交）+ Broker（RabbitMQ 派单）+ Worker（消费）"
  - "Celery：Python 任务队列框架，编排/重试/定时/追踪"
  - "RabbitMQ：消息中间件，可靠投递/路由/持久化"
  - "长任务编排：任务链/组/和弦，支持多步 DAG"
  - "可靠性：持久化+ack+幂等+重试+死信，任务不丢不重"
  socratic:
  - "用户上传 100 页 PDF 让解析，HTTP 请求挂 5 分钟等结果合理吗？"
  - "1000 个批量推理任务同时来，怎么不把系统打爆？"
  - "worker 跑到一半进程挂了，任务丢了吗？怎么补？"
  - "一个任务要分三步（解析→抽取→总结），怎么编排？"
  - "任务积压 10 万个，怎么发现和处理？"
first_principle:
  problem: "如何让耗时的 AI 长任务不阻塞请求、可恢复、可编排、可监控？"
  axioms:
  - "AI 长任务不能同步阻塞"
  - "任务会失败需重试，进程会挂需恢复"
  - "复杂任务需多步编排"
  rebuild: "用任务队列（Celery+RabbitMQ）解耦生产消费——生产者提交任务到 broker，worker 池按速率消费，支持持久化/ack/重试/幂等保不丢不重，任务链/组编排多步，监控积压，支撑长任务可靠运行。"
follow_up:
- "Celery 和 RQ/Kafka 区别？——Celery 功能全（编排/重试/定时/追踪）适合任务队列；RQ 轻量简单；Kafka 是流式消息平台适合事件流，非典型任务队列。"
- "怎么保证任务不丢不重？——broker 持久化+消息 ack（消费成功才 ack）+ worker 崩溃消息重回队列 + 任务幂等（幂等键防重复执行）。"
- "长任务怎么不阻塞监控？——任务状态持久化（PENDING/STARTED/SUCCESS/FAILED）+ 进度上报 + 结果后端存储 + 超时熔断。"
memory_points:
- "三角色：生产者+Broker(RabbitMQ)+Worker"
- "Celery 编排，RabbitMQ 派单"
- "可靠：持久化+ack+幂等+重试"
- "长任务编排：链/组/和弦"
---

# 【生物医药 AI】异步任务系统怎么做（Celery/RabbitMQ/长任务编排）？

> JD 依据："异步编程；异步任务、资源调度；Kafka/RabbitMQ。"

## 一、为什么 AI 需要异步任务系统

```
同步处理长任务：
  用户上传 PDF → HTTP 等 5 分钟解析 → 超时/阻塞/线程耗尽
  批量推理 1000 个 → 同步排队 → 系统卡死

异步任务系统：
  提交任务 → 立刻返回 task_id → worker 后台跑 → 完成通知
  → 不阻塞、可恢复、可编排、可监控
```

## 二、三角色架构

```
[生产者]                  [Broker]               [Worker 池]
业务代码 ──提交任务──→ RabbitMQ/Redis ──派单──→ Celery worker
  ↑                        │                       │
  │                        │ ←─ack─────────────────┘
  └────查状态/结果──────────┘ ←─结果存储←──────────┘
```

- **生产者**：业务代码调用 `task.delay()` 提交。
- **Broker**（RabbitMQ/Redis）：暂存任务消息，可靠投递。
- **Worker**（Celery）：消费任务，执行逻辑。
- **结果后端**：存任务状态和结果。

## 三、Celery 实战

### 1. 定义任务
```python
from celery import Celery, chain, group, chord

app = Celery('biopharm', broker='pyamqp://rabbitmq', backend='redis://redis')

@app.task(bind=True, max_retries=3)
def parse_document(self, doc_id):
    try:
        doc = load(doc_id)
        result = heavy_parse(doc)        # 耗时解析
        return result
    except TransientError as e:
        raise self.retry(exc=e, countdown=2**self.request.retries)  # 重试
```

### 2. 提交
```python
result = parse_document.delay(doc_id)    # 异步，立刻返回
task_id = result.id
status = result.status                    # PENDING/STARTED/SUCCESS
output = result.get()                     # 阻塞取（或前端轮询/Webhook）
```

### 3. 长任务编排
```python
# 链：依次执行
workflow = chain(parse.s(doc_id), extract.s(), summarize.s())
workflow.apply_async()

# 组：并行
parallel = group(infer.s(x) for x in batch)
parallel.apply_async()

# 和弦：并行+汇总
chord(group(infer.s(x) for x in batch))(aggregate.s())
```

## 四、RabbitMQ 的角色

```
任务消息可靠投递：
  - 持久化：消息写磁盘，broker 挂不丢
  - ack：worker 消费成功才 ack，崩溃消息重回队列
  - 路由：按 routing key 分发到不同队列（优先级/类型）
  - 死信队列：失败/超时任务进死信，便于排查
```
- 比 Redis broker 更可靠（Redis 作 broker 有丢消息风险）。
- 支持优先级队列、延迟队列、多消费者。

## 五、可靠性保障（不丢不重）

| 机制 | 作用 |
|------|------|
| 持久化 | broker 挂消息不丢 |
| ack | worker 崩溃消息重回 |
| 重试 | 瞬时失败自动重试（退避） |
| 幂等 | 重试不重复执行（幂等键） |
| 死信 | 失败任务进死信排查 |
| 超时 | 防任务挂死 |
| 并发控制 | 限 worker 数防过载 |

```python
# 幂等：相同任务不重复执行
@app.task
def infer(idempotency_key, ...):
    if already_done(idempotency_key): return cached
    ...
```

## 六、长任务的可观测

```
任务状态：PENDING/STARTED/SUCCESS/FAILED/RETRY
进度：长任务定期上报进度（如 30%）
积压监控：队列长度告警
耗时：各任务类型 P99
失败率：重试/死信统计
→ worker 水位、积压、失败一目了然
```

## 七、医药 AI 的异步场景

```
文档解析：上传说明书 → 异步解析+切分+embedding → 入库
批量推理：药物筛选 → 批量调模型 → 汇总
训练/微调：离线任务，长跑几小时，断点恢复
报告生成：多步（检索→分析→总结→审批→导出），workflow 编排
临床监测：持续流式任务，实时处理
```

## 八、与 Workflow 引擎的关系

```
简单异步：Celery 任务队列够用（单任务/链/组）
复杂编排：Workflow 引擎（DAG+状态机+人工节点+补偿，见004）
→ 简单用 Celery，复杂用 Workflow，或 Celery 做底层执行 + Workflow 做编排
```

## 九、底层本质

异步任务系统本质是**"用队列解耦生产消费，让长任务后台可靠运行"**。Celery 编排，RabbitMQ 派单，worker 消费，持久化+ack+幂等+重试保不丢不重，状态可观测。

**这是 AI 长任务的工程基石** —— 没有异步任务系统，长任务要么阻塞要么丢，规模化 AI 服务不可能。

## 常见考点

1. **Celery 为什么比线程池好？**——支持持久化（不丢）、ack（崩溃恢复）、重试、编排（链/组）、分布式（多 worker）、监控，比线程池健壮得多。
2. **怎么保证任务不重复执行？**——幂等键（业务唯一标识）+ 执行前检查是否已完成 + 结果缓存，重试时直接返回。
3. **任务积压怎么办？**——监控队列长度告警 → 加 worker 扩容 → 限流（拒绝新任务/降级）→ 分析慢任务（优化/拆分）→ 必要时丢弃低优先级。


## 结构化回答

**30 秒电梯演讲：** 聊到异步任务系统怎么做，我的理解是——异步任务系统是'把耗时的 AI 任务从请求线程剥离，丢给后台 worker 慢慢跑'——Celery 编排、RabbitMQ 派单、worker 消费，支撑文档解析/批量推理/训练等长任务不阻塞、可恢复、可监控。打个比方，像餐厅后厨——服务员点单把单子夹到传送带（RabbitMQ 队列）就回去服务下一桌（不阻塞），后厨按顺序取单做菜（worker 消费），复杂的宴席菜还能拆成多步（编排），做完按铃（回调）端菜。

**展开框架：**
1. **三角色** — 生产者（提交）+ Broker（RabbitMQ 派单）+ Worker（消费）
2. **Celery** — Python 任务队列框架，编排/重试/定时/追踪
3. **RabbitMQ** — 消息中间件，可靠投递/路由/持久化

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：Celery 和 RQ/Kafka 区别？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "异步任务系统怎么做——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | Agent 编排链路图 | 先说核心：异步任务系统是'把耗时的 AI 任务从请求线程剥离，丢给后台 worker 慢慢跑'——Celery 编排、RabbitMQ 派单、worker 消费，支撑文档解析/批量推理/。 | 核心定义 |
| 0:40 | 消息队列架构图 | Python 任务队列框架，编排/重试/定时/追踪。 | Celery |
| 1:05 | 概念结构示意图 | 消息中间件，可靠投递/路由/持久化。 | RabbitMQ |
| 2:30 | 总结卡 | 一句话记忆：三角色：生产者+Broker(RabbitMQ)+Worker。 下期可以接着聊：Celery 和 RQ/Kafka 区别。 | 收尾总结 |
