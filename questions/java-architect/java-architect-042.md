---
id: java-architect-042
difficulty: L3
category: java-architect
subcategory: 回滚
tags:
- Java 架构师
- 发布
- 灰度
- 回滚
feynman:
  essence: 发布策略解决"如何安全上线新版本"。蓝绿是"两套环境切流"（瞬间切换 + 瞬间回滚）、金丝雀是"小流量试错"（1% → 10% → 100% 阶段放量）、灰度是"按规则放量"（用户/地域/设备维度）。三者核心都是"先小范围验证再放量，出问题快速回滚"。
  analogy: 像 JD 新功能上线：蓝绿是"新旧两套系统同时跑，一键切流"（贵但稳）；金丝雀是"先给 1% 用户试用，没问题再加到 10%、100%"（渐进）；灰度是"先给内部员工/特定城市试用"（按规则）。本质都是"控制爆炸半径"——出问题只影响小范围。
  first_principle: 软件变更必然有风险（bug、性能、配置错误）。直接全量发布 = 把所有用户当小白鼠。发布策略的核心是"小范围先验证 + 快速回滚"——把爆炸半径控制在可接受范围。蓝绿/金丝雀/灰度是不同维度的"小范围"实现。
  key_points:
  - 蓝绿：两套环境切流，瞬间切换/回滚，资源贵
  - 金丝雀：1% → 10% → 100% 阶段放量，看监控指标决策
  - 灰度：按用户/地域/设备/请求头维度放量（规则更灵活）
  - 发布决策看：错误率、P99 延迟、业务成功率、用户反馈
  - 回滚必须快：发布是分钟级、回滚也要分钟级（不能等重新构建）
first_principle:
  problem: 如何在不影响全部用户的前提下安全上线新版本，出问题能快速回滚？
  axioms:
  - 变更必然有风险（代码 bug、配置错、性能回归）
  - 全量发布 = 全员当小白鼠，爆炸半径不可控
  - 回滚速度决定故障时长（回滚越快用户感知越短）
  rebuild: 用发布策略控制爆炸半径。蓝绿——两套环境切流（一键切/一键回，资源贵但最快）。金丝雀——小流量先验证（1% 跑 10 分钟看监控，无异常加到 10%、再 100%，出问题立即回滚小流量）。灰度——按规则放量（内部员工先、特定城市先、VIP 用户先，比金丝雀更细粒度）。三者本质都是"渐进放量 + 监控决策 + 快速回滚"。发布门禁看错误率、P99、业务成功率，异常立即回滚。
follow_up:
  - 蓝绿和灰度区别？——蓝绿是"两套环境二选一"（要么全绿要么全蓝）、灰度是"按比例/规则共存"（1% 新 99% 旧同时跑）。灰度更细粒度但复杂
  - 金丝雀放量节奏怎么定？——1% 看 10 分钟 → 10% 看 30 分钟 → 50% 看 30 分钟 → 100%。看错误率、P99、业务指标。异常立即回滚
  - 数据库变更怎么回滚？——DDL 难回滚（加列容易删列丢数据）。用"扩展-收缩模式"（先加新列兼容、再删旧列）
  - 回滚和重发布区别？——回滚是"切回旧版本"（秒级，已构建好的镜像）、重发布是"修 bug 后重新构建发布"（分钟到小时级）。故障时优先回滚而非重发布
  - "灰度规则怎么做？——按请求头（X-Gray-Release: true）、按用户 ID 哈希（userId % 100 < 5 表示 5%）、按地域（先北京）、按设备（先 iOS）、按租户（内部租户先）"
memory_points:
  - 蓝绿：两套环境切流（快但贵）
  - 金丝雀：1%→10%→100% 阶段放量
  - 灰度：按用户/地域/设备规则放量
  - 发布决策：看错误率、P99、业务成功率
  - 回滚要快：分钟级（已构建镜像，不重新构建）
---

# 【Java 后端架构师】蓝绿、金丝雀与灰度发布工程实践

> 适用场景：JD 核心技术。每天几百次发布，每次都可能引入 bug。下单、支付、库存核心链路发布必须控制爆炸半径——先给 1% 用户试用，没问题再放量，出问题 1 分钟回滚。架构师必须能设计发布策略、定义放量规则、配置自动监控门禁、规划回滚预案。

## 一、概念层：三种发布策略对比

**三种策略的本质区别**：

| 策略 | 原理 | 切换速度 | 资源成本 | 粒度 | 适用 |
|------|------|---------|---------|------|------|
| **蓝绿** | 两套环境二选一，切流 | 秒级 | 2 倍资源 | 全量 | 关键服务、需秒级回滚 |
| **金丝雀** | 新版本小流量验证 | 分钟级 | 1.x 倍 | 按比例 | 大多数服务（推荐） |
| **灰度** | 按规则放量（用户/地域） | 分钟级 | 1.x 倍 | 按维度 | 精细化发布（UI 改版） |

**蓝绿发布流程**：

```
        ┌─ Blue 环境（当前版本 v1）← 100% 流量
负载均衡
        └─ Green 环境（新版本 v2）← 0% 流量

Step 1：Green 部署 v2，跑 0 流量验证健康
Step 2：切流：Green ← 100% 流量，Blue ← 0%
Step 3：观察 30 分钟，无异常销毁 Blue
       有异常切回 Blue（秒级回滚）

特点：两套完整环境，瞬间切换瞬间回滚
成本：2 倍资源（一直有两套环境）
```

**金丝雀发布流程**：

```
        ┌─ 旧版本 v1（90 台）← 95% 流量
负载均衡
        └─ 新版本 v2（5 台）← 5% 流量

Step 1：部署 v2 到 5 台，导 5% 流量
Step 2：观察 10 分钟（错误率、P99、业务指标）
Step 3：无异常 → v2 扩到 20 台，导 20% 流量
Step 4：再观察 → 50% → 100%
Step 5：出问题 → 立即把 v2 那批从负载均衡摘掉（回滚）

特点：渐进放量，出问题只影响小比例流量
成本：1.x 倍资源（只多一小批）
```

**灰度发布流程**（按规则）：

```
        ┌─ 旧版本 v1 ← 通用流量
网关/路由
        └─ 新版本 v2 ← 按规则的流量

规则示例：
  - 请求头 X-Gray-Release: true → v2
  - userId % 100 < 5（5% 用户）→ v2
  - 地域 = 北京 → v2
  - 设备 = iOS → v2
  - 租户 = 内部测试租户 → v2

特点：按维度放量，比金丝雀更细粒度
适用：UI 改版（先员工再用户）、地域性功能、VIP 优先体验
```

## 二、机制层：金丝雀发布工程实现

**Kubernetes 金丝雀发布（Istio + Flagger）**：

```yaml
# Flagger Canary 资源（自动金丝雀）
apiVersion: flagger.app/v1beta1
kind: Canary
metadata:
  name: order-service
spec:
  targetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: order-service
  service:
    port: 8080
  analysis:
    interval: 1m          # 每 1 分钟分析一次
    threshold: 5          # 连续 5 次失败回滚
    maxWeight: 50         # 最多导 50% 流量到新版本
    stepWeight: 5         # 每次加 5%
    metrics:
      - name: error-rate
        threshold: 0.01              # 错误率 < 1%
        query: |
          sum(rate(http_requests_total{app="order-service",status=~"5.."}[1m]))
          /
          sum(rate(http_requests_total{app="order-service"}[1m]))
      - name: latency-p99
        threshold: 500               # P99 < 500ms
        query: |
          histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{app="order-service"}[1m]))
    webhooks:
      - name: load-test
        type: rollout
        url: http://flagger-loadtester.test/
```

**自动放量决策**：

```
时间线（Flagger 自动金丝雀）：

T+0min：部署 v2，Istio 导 5% 流量
T+1min：分析指标 → error-rate 0.5% < 1%, P99 300ms < 500ms ✓
        → 自动加到 10%
T+2min：分析 → 指标正常 → 加到 15%
T+3min：分析 → 指标正常 → 加到 20%
...
T+10min：加到 50%（maxWeight），持续观察
T+15min：50% 稳定 5 分钟 → 完成全量切换

异常场景：
T+3min：加到 15% 时 error-rate 突增到 5% > 1% ✗
        → Flagger 自动回滚，流量切回 v1
```

## 三、机制层：灰度规则实现

**网关层灰度路由**（Spring Cloud Gateway）：

```yaml
# application.yml - Spring Cloud Gateway 灰度路由
spring:
  cloud:
    gateway:
      routes:
        - id: order-service-v2-gray
          uri: lb://order-service-v2
          predicates:
            - Path=/order/**
            - Header=X-Gray-Release, true      # 按请求头灰度
            - Weight=v2-group, 5                # 或按权重 5%
          filters:
            - name: AddResponseHeader
              args:
                name: X-Served-By
                value: v2-gray

        - id: order-service-v1-default
          uri: lb://order-service-v1
          predicates:
            - Path=/order/**
          filters:
            - name: AddResponseHeader
              args:
                name: X-Served-By
                value: v1-default
```

**Java 自定义灰度路由**（按用户 ID 哈希）：

```java
@Component
public class GrayReleaseFilter implements GlobalFilter {

    @Resource LoadBalancerClientFactory factory;

    @Override
    public Mono<Void> filter(ServerWebExchange exchange, GatewayFilterChain chain) {
        String userId = exchange.getRequest().getHeaders().getFirst("X-User-Id");
        String grayHeader = exchange.getRequest().getHeaders().getFirst("X-Gray-Release");

        boolean shouldGray = false;
        if ("true".equals(grayHeader)) {
            shouldGray = true;   // 显式灰度标
        } else if (userId != null) {
            // 按用户 ID 哈希灰度（5% 用户）
            int hash = Math.abs(userId.hashCode()) % 100;
            shouldGray = (hash < grayConfig.getPercentage());   // percentage=5 表示 5%
        }

        if (shouldGray) {
            // 路由到 v2
            exchange.getAttributes().put("grayVersion", "v2");
        }
        return chain.filter(exchange);
    }
}
```

**服务实例元数据**（Nacos）：

```yaml
# order-service v1 注册到 Nacos
spring:
  cloud:
    nacos:
      discovery:
        metadata:
          version: v1    # 旧版本

# order-service v2 注册到 Nacos
spring:
  cloud:
    nacos:
      discovery:
        metadata:
          version: v2    # 新版本（灰度）

# LoadBalancer 按元数据路由
@Configuration
public class GrayLoadBalancerConfig {
    @Bean
    ReactorLoadBalancer<ServiceInstance> grayLoadBalancer(
            Environment env, LoadBalancerClientFactory factory) {
        return new GrayLoadBalancer(
            factory.getLazyProvider("order-service", ServiceInstanceListSupplier.class),
            env.getProperty("gray.version", "v1")   // 默认 v1，灰度时改 v2
        );
    }
}
```

## 四、机制层：发布门禁与自动回滚

**发布门禁指标**（异常自动暂停）：

```python
# 发布脚本集成监控检查（CI/CD pipeline）
def canary_health_check(service, version):
    # 检查 4 个核心指标，连续 3 次失败自动回滚
    metrics = {
        'error_rate': query_prometheus(
            f'rate(http_requests_total{{app="{service}",version="{version}",status=~"5.."}}[5m])'
            f' / rate(http_requests_total{{app="{service}",version="{version}"}}[5m])'
        ),
        'p99_latency': query_prometheus(
            f'histogram_quantile(0.99, rate(http_request_duration_seconds_bucket{{app="{service}",version="{version}"}}[5m]))'
        ),
        'success_rate': query_prometheus(
            f'rate(business_success_total{{app="{service}",version="{version}"}}[5m])'
            f' / rate(business_total{{app="{service}",version="{version}"}}[5m])'
        ),
        'cpu_usage': query_prometheus(
            f'avg(cpu_usage_percent{{app="{service}",version="{version}"}})'
        )
    }

    # 门禁规则
    if metrics['error_rate'] > 0.05:        # 错误率 > 5%
        return False, f"error rate {metrics['error_rate']} > 5%"
    if metrics['p99_latency'] > 0.5:         # P99 > 500ms
        return False, f"p99 {metrics['p99_latency']} > 500ms"
    if metrics['success_rate'] < 0.99:       # 业务成功率 < 99%
        return False, f"success rate {metrics['success_rate']} < 99%"
    if metrics['cpu_usage'] > 0.85:          # CPU > 85%
        return False, f"cpu {metrics['cpu_usage']} > 85%"

    return True, "healthy"

# 金丝雀发布循环
def canary_deploy(service, new_version):
    weights = [5, 10, 25, 50, 100]
    for weight in weights:
        route_traffic(service, new_version, weight)   # 导 weight% 流量
        sleep(600)   # 观察 10 分钟

        healthy, reason = canary_health_check(service, new_version)
        if not healthy:
            rollback(service, new_version)   # 自动回滚
            alert(f"Canary failed at {weight}%: {reason}")
            return False

    return True   # 全量成功
```

## 五、实战层：回滚预案与数据库变更

**回滚策略**（按变更类型）：

| 变更类型 | 回滚方式 | 时长 |
|---------|---------|------|
| **代码变更** | 切回旧版本镜像（K8s kubectl rollout undo） | 秒级 |
| **配置变更** | 配置中心切回旧版本（Nacos 历史版本） | 秒级 |
| **DB DDL（加列）** | 一般不回滚（兼容旧代码），或 DROP COLUMN | 分钟级（慎用） |
| **DB DDL（删列/改类型）** | 难回滚（数据丢失），用扩展-收缩模式 | 无法回滚 |
| **MQ topic 变更** | 难回滚（消息已消费），用新 topic 兼容 | 无法回滚 |

**扩展-收缩模式（Expand-Contract）**（数据库变更最佳实践）：

```
场景：把 status 字段从字符串改成枚举

错误做法（直接改）：
  Step 1：ALTER TABLE orders MODIFY status INT;
  Step 2：部署新代码
  问题：Step 1 后旧代码挂（不认识 INT），回滚丢数据

正确做法（扩展-收缩）：
  Phase 1 - 扩展（兼容期，新旧代码共存）：
    ALTER TABLE orders ADD COLUMN status_new INT;   # 加新列
    代码：双写（同时写 status 和 status_new）
    部署：新旧版本都能跑

  Phase 2 - 迁移（后台任务）：
    UPDATE orders SET status_new = CAST(status) WHERE status_new IS NULL;
    分批迁移，避免锁表

  Phase 3 - 收缩（新代码只用新列）：
    部署只读写 status_new 的代码
    观察 1 周

  Phase 4 - 清理（确认稳定）：
    ALTER TABLE orders DROP COLUMN status;
    ALTER TABLE orders RENAME COLUMN status_new TO status;

  任意阶段出问题都能回滚（向后兼容）
```

**回滚演练**（必做）：

```bash
# K8s 回滚命令
kubectl rollout undo deployment/order-service
# 回滚到上一个版本

kubectl rollout undo deployment/order-service --to-revision=3
# 回滚到指定版本

kubectl rollout status deployment/order-service
# 看回滚进度

# 配置回滚（Nacos）
# 通过 Nacos 控制台切到历史配置版本，秒级生效

# 全链路回滚 SOP：
# 1. 监控告警触发（error_rate > 5%）
# 2. 值班 SRE 决策回滚（5 分钟内）
# 3. 执行 kubectl rollout undo（30 秒）
# 4. 验证指标恢复（错误率下降、P99 恢复）
# 5. 事后复盘定根因
```

## 六、底层本质：为什么是渐进发布而非全量

回到第一性：**软件变更必然有风险，控制爆炸半径是发布工程的核心**。

**为什么不全量发布**：全量发布把所有用户当小白鼠，一旦有 bug 全员受影响。JD 大促前一次全量发布引入 bug 可能导致整个大促失败，损失千万级。渐进发布（金丝雀/灰度）把爆炸半径控制在 1%-5%，即使有 bug 也只影响小范围用户，损失可控。

**为什么蓝绿资源贵但仍有价值**：蓝绿保持两套完整环境，成本 2 倍。但对于"零停机 + 秒级回滚"刚需的核心服务（如支付），蓝绿的"瞬间切换瞬间回滚"无可替代。金丝雀/灰度虽然成本低，但回滚要摘节点、切流，仍需分钟级。蓝绿是"花资源换时间"——支付这类服务故障 1 分钟损失巨大，值得 2 倍资源。

**为什么金丝雀是大多数服务的最优解**：金丝雀在成本和安全性之间平衡。1.x 倍资源（只多一小批实例），渐进放量（出问题影响小），回滚快（摘掉新版本节点，分钟级）。Flagger + Istio 能自动化整个流程（放量决策、监控检查、自动回滚），把发布从"人工盯监控"变成"自动化流水线"。对 99% 的服务，金丝雀足够。

**为什么数据库变更要扩展-收缩**：DDL 难回滚（DROP COLUMN 丢数据、MODIFY TYPE 可能失败）。直接改的"扩展-修改代码-测试"模式中，任一步出问题都难回滚（代码回滚了但 DB 已变）。扩展-收缩模式让每个阶段都向后兼容——加新列（旧代码不感知）→ 双写（新旧都写）→ 切读（新代码读新列）→ 删旧列。任一步出问题都能回滚到上一阶段，因为始终兼容。

**回滚速度决定故障时长**：发布引入的 bug，从"用户感知"到"回滚完成"的时长决定损失。蓝绿秒级、金丝雀分钟级、重发布（修 bug 再构建）小时级。故障时优先回滚（切回旧版本）而非重发布（修 bug 再发）——回滚是把已知良好的版本切回来，确定性高；重发布是引入新代码，可能引入新 bug。

## 七、AI 架构师加问：5 个 AI 相关问题

1. **AI 模型发布的灰度怎么做？**
   模型比代码风险更大（输出不可预测）。灰度按用户分桶（1% 用户先试新模型）、按 prompt 类型分桶（简单查询先试、复杂推理后试）。监控新模型的幻觉率、用户满意度（点踩率）、token 消耗。出问题切回旧模型（模型版本管理 + 秒级切换）。

2. **让 AI 自动决策金丝雀放量，AI 接管哪段？**
   AI 分析发布期间的指标（错误率、P99、业务成功率、用户反馈），自动决策"继续放量/暂停/回滚"。比规则更灵活（能识别异常模式如"错误率没升但用户投诉突增"）。AI 出决策建议，人工 review 或自动执行（低风险自动、高风险人工确认）。

3. **AI Agent 的 prompt 模板怎么灰度？**
   prompt 模板变更影响输出质量，比代码变更难评估（输出对错要人工或自动评估）。灰度按用户分桶 + A/B 测试（新旧 prompt 并行，对比输出质量评分）。评估指标：任务完成率、用户满意度、token 成本。出问题切回旧 prompt。

4. **AI 推理回滚怎么做？**
   模型回滚 = 切回旧模型版本（模型权重文件）。模型版本管理（MLflow Registry 记录所有版本）、推理服务加载指定版本、回滚时改版本号重新加载。比代码回滚重（模型文件大，加载要分钟级），要预热。

5. **AI 服务发布的监控门禁怎么定？**
   除了传统指标（错误率、P99），AI 特有：幻觉率（自动评估）、token 消耗（成本）、用户满意度（点踩率）、任务完成率。门禁阈值要基于历史基线（如幻觉率不超过旧模型 +2 个百分点）。

## 八、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"蓝绿切流、金丝雀渐进、灰度按规则、监控门禁、扩展-收缩 DDL"**。

- **蓝绿**：两套环境秒级切流/回滚，资源 2 倍，适合支付核心
- **金丝雀**：1%→10%→50%→100% 渐进，Flagger+Istio 自动化
- **灰度**：按用户/地域/设备/请求头规则放量，比金丝雀细粒度
- **监控门禁**：错误率 < 5%、P99 < 500ms、业务成功率 > 99%、CPU < 85%
- **DDL 回滚**：扩展-收缩模式（加新列→双写→切读→删旧列），始终兼容

### 拟人化理解

把发布想成 **JD 新功能试点**。蓝绿是"新旧两套系统同时跑，一键切换"（贵但秒级切换秒级回滚，适合支付核心）。金丝雀是"先给 1% 用户试用，没问题再加到 10%、100%"（渐进放量，出问题摘掉新版本节点）。灰度是"先给北京用户、iOS 用户、VIP 用户试用"（按规则更细粒度）。监控门禁是"试点期间错误率超 5% 立即叫停切回旧版"。扩展-收缩是"DB 改字段时不直接改，而是加新列双写，确认稳定再删旧列，任何阶段都能回滚"。

### 面试现场 60 秒回答

> 三种发布策略。蓝绿是两套环境秒级切流/回滚，资源 2 倍，适合支付等零停机核心服务。金丝雀是 1%→10%→50%→100% 渐进放量，Flagger+Istio 自动化监控决策（错误率/P99 异常自动回滚），适合大多数服务。灰度按规则放量（用户 ID 哈希、地域、设备、请求头），比金丝雀细粒度，适合 UI 改版先员工再用户。监控门禁看错误率 < 5%、P99 < 500ms、业务成功率 > 99%。回滚优先于重发布——回滚切回已知良好版本（秒级），重发布引入新代码可能新 bug。DB DDL 用扩展-收缩模式（加新列→双写→切读→删旧列），始终向后兼容可回滚。

### 反问面试官

> 贵司核心服务发布是金丝雀还是蓝绿？发布门禁是自动还是人工？有自动回滚机制吗？DB 变更走扩展-收缩吗？这决定我发布工程方案的设计。

## 九、苏格拉底式面试追问

每一问先回答"为什么"，再"怎么做"，最后"如何证明"。

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不直接全量发布，要搞金丝雀？ | 全量爆炸半径不可控（bug 影响全员）。金丝雀控制 1%-5% 流量验证，出问题影响小。证明：历史统计金丝雀在 5% 阶段发现 30% 的 bug，避免全量事故 |
| 证据追问 | 怎么证明新版本该继续放量而非回滚？ | 4 个指标：错误率 < 5%、P99 < 500ms、业务成功率 > 99%、CPU < 85%。对比新旧版本同指标，新版本不退化才放量。用户反馈（投诉/点踩）作为辅助 |
| 边界追问 | 金丝雀能发现所有发布问题吗？ | 不能。①低频 bug（特定参数组合，5% 流量覆盖不到）；②数据相关 bug（特定用户数据触发）；③时间相关 bug（凌晨定时任务、跨天逻辑）。金丝雀发现"高频和性能"问题，长尾 bug 靠监控和反馈 |
| 反例追问 | 什么场景不用金丝雀？ | 紧急 hotfix（故障期间每秒都重要，直接全量止损）、内部工具（低风险）、试验性服务（频繁变更不值得金丝雀）。金丝雀适合稳定核心服务 |
| 风险追问 | 发布期间最大的风险？ | ①金丝雀门禁太松（异常没发现就放量）；②回滚太慢（决策犹豫，故障时长拉长）；③DDL 不可回滚（直接删列丢数据）；④新旧版本不兼容（协议/数据格式不兼容导致切流出错）。治法：自动门禁、回滚演练、扩展-收缩 DDL、版本兼容性测试 |
| 验证追问 | 怎么证明发布工程真的安全？ | 统计发布事故率（应 < 1%）、金丝雀拦截率（5% 阶段发现的 bug 占比，应 > 30%）、回滚 MTTR（应 < 5 分钟）、全量发布频率（应 0，全走金丝雀） |
| 沉淀追问 | 团队发布规范沉淀什么？ | 发布策略选择指南（按服务重要性）、金丝雀放量节奏模板、监控门禁规则、回滚 SOP、扩展-收缩 DDL 流程、发布事故复盘模板、Flagger/Istio 配置模板 |

### 现场对话示例

**面试官**：蓝绿和金丝雀怎么选？

**候选人**：看服务重要性和成本预算。蓝绿保持两套完整环境，资源 2 倍，但秒级切换秒级回滚——适合支付、风控这类"故障 1 分钟损失巨大"的零停机核心服务。金丝雀 1.x 倍资源（只多一小批实例），渐进放量，回滚是摘掉新版本节点（分钟级）——成本和安全性平衡，适合 99% 的服务。我的选择原则：支付/交易核心用蓝绿（值得 2 倍资源换秒级回滚），其他用金丝雀。如果预算紧，核心服务也可以用金丝雀 + 自动化门禁（Flagger 监控异常自动回滚），把回滚从分钟压到秒。

**面试官**：数据库变更怎么回滚？

**候选人**：DDL 难回滚，必须用扩展-收缩（Expand-Contract）模式。比如改字段类型，不是直接 ALTER MODIFY，而是：①扩展期加新列（status_new INT），代码双写（同时写旧列和新列），新旧版本都能跑；②迁移期后台任务分批 UPDATE 新列；③收缩期新代码只读写新列，观察 1 周；④清理期 DROP 旧列。任一阶段出问题都能回滚——因为始终向后兼容（旧代码读旧列、新代码读新列）。直接 ALTER MODIFY 的问题：改完旧代码挂（不认识新类型），回滚丢数据。扩展-收缩是数据库变更的事实标准。

**面试官**：金丝雀在 5% 时怎么看异常？

**候选人**：四个核心指标对比新旧版本。错误率：新版本 5xx 占比 vs 旧版本，应不退化（< 5% 或不高于旧版本）。P99 延迟：新版本 vs 旧版本，应不退化（< 500ms 或不高 20%）。业务成功率：订单创建成功率等核心业务指标，应不退化。CPU/内存：新版本资源消耗，应无突增（如内存泄漏）。Flagger 自动化——每 1 分钟查 Prometheus，连续 5 次异常自动回滚。人工层面，发布期间值班 SRE 盯 Grafana 大盘，看趋势异常立即决策。用户反馈（客服投诉）作为兜底信号——指标没异常但用户投诉突增也要警惕（可能是体验类问题指标看不出来）。

## 常见考点

1. **三种发布策略区别？**——蓝绿（两套环境秒级切流/回滚，资源 2 倍）、金丝雀（1%→10%→100% 渐进，1.x 倍资源）、灰度（按规则放量，细粒度）。
2. **金丝雀放量节奏？**——1% 看 10 分钟 → 10% 看 30 分钟 → 50% → 100%。看错误率、P99、业务成功率，异常回滚。
3. **DB 变更怎么回滚？**——用扩展-收缩模式（加新列→双写→切读→删旧列），始终向后兼容。直接 ALTER MODIFY 难回滚。
4. **回滚和重发布区别？**——回滚切回已知良好版本（秒级，已构建镜像）、重发布修 bug 再发（小时级，可能新 bug）。故障优先回滚。
5. **灰度规则怎么做？**——按请求头（X-Gray-Release）、用户 ID 哈希（userId % 100 < 5）、地域、设备、租户维度。比金丝雀更细粒度。

## 结构化回答

**30 秒电梯演讲：** 发布策略解决如何安全上线新版本。蓝绿是两套环境切流（瞬间切换 + 瞬间回滚）、金丝雀是小流量试错（1% → 10% → 100% 阶段放量）、灰度是按规则放量（用户/地域/设备维度）。三者核心都是先小范围验证再放量，出问题快速回滚

**展开框架：**
1. **蓝绿** — 两套环境切流，瞬间切换/回滚，资源贵
2. **金丝雀** — 1% → 10% → 100% 阶段放量，看监控指标决策
3. **灰度** — 按用户/地域/设备/请求头维度放量（规则更灵活）

**收尾：** 以上是我的整体思路。您想继续深入聊——蓝绿和灰度区别？


## 视频脚本

> 预计时长：2 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：蓝绿、金丝雀与灰度发布工程实践 | "这题一句话：发布策略解决如何安全上线新版本。" | 开场钩子 |
| 0:15 | 像 JD 新功能上线：蓝绿是新旧两套系统同时跑类比图 | "打个比方：像 JD 新功能上线：蓝绿是新旧两套系统同时跑。" | 核心类比 |
| 0:40 | 蓝绿示意/对比图 | "两套环境切流，瞬间切换/回滚，资源贵" | 蓝绿要点 |
| 1:05 | 金丝雀示意/对比图 | "1% → 10% → 100% 阶段放量，看监控指标决策" | 金丝雀要点 |
| 1:55 | 总结卡 | "记住：蓝绿。下期见。" | 收尾 |
