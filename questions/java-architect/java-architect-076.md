---
id: java-architect-076
difficulty: L2
category: java-architect
subcategory: 稳定性治理
tags:
- Java 架构师
- CI/CD
- 质量
- 制品
feynman:
  essence: CI/CD 流水线的本质是"把质量保障从人工评审变成自动化门禁"。流水线分阶段（构建→单测→集成测试→安全扫描→制品→部署），每阶段设质量门禁（覆盖率、漏洞数、镜像大小、性能基线），门禁不过自动阻断。制品治理保证"可追溯、可回滚、不可篡改"——每个制品绑定 commit、测试报告、SBOM。
  analogy: 像汽车总装线。每个工位（流水线阶段）有质检关卡（门禁）：焊接工位检查焊点数，涂装检查漆膜厚度，总装检查扭矩。一个工位不合格，整车不能流入下一工位。最终出厂的每辆车（制品）都有 VIN 号（版本）和质检报告（SBOM/测试报告）。
  first_principle: 线上事故的根因往往是"未经验证的代码上了生产"。CI/CD 的核心是"把验证自动化、把门禁强制化"——每个 PR 自动跑测试、扫描、构建，门禁不过不让合并；每个制品有唯一指纹（digest），部署只能用经过验证的制品，回滚秒级切上一个版本。
  key_points:
  - 流水线六阶段：Build → Unit Test → Integration Test → Security Scan → Artifact → Deploy
  - 质量门禁：覆盖率 > 80%、Sonar 零 Blocker、镜像漏洞 CVE、性能回归 < 5%
  - 制品治理：不可变镜像（digest）、SBOM（软件物料清单）、版本可追溯
  - 部署策略：蓝绿、金丝雀、滚动，支持秒级回滚
  - DORA 指标：部署频率、变更前置时间（lead_time）、变更失败率、MTTR
first_principle:
  problem: 一个 50 人的 Java 团队每天提交 100+ PR，如何保证每个 PR 不引入生产事故？
  axioms:
  - 人工 Code Review 会遗漏（疲劳、认知盲区）
  - 测试和扫描必须自动化才能覆盖每次提交
  - 制品不可变 + 可追溯才能快速回滚
  rebuild: 建立强制流水线——每个 PR 触发 Build + Unit Test（覆盖率门禁 > 80%）+ Sonar（零 Blocker）+ 集成测试 + Trivy 镜像扫描。门禁不过 PR 不能合并。合并后构建不可变镜像（SHA digest），打标签绑定 commit，生成 SBOM。部署分环境（dev→staging→prod），每环境自动测试，生产用金丝雀（先 1% 流量观察指标），异常自动回滚。监控 DORA 指标持续优化。
follow_up:
  - 质量门禁设太严会怎样？——开发效率下降（PR 堆积、门禁频繁失败）。门禁要分层：Blocker 必须阻断、Critical 警告、Minor 提醒。覆盖率从当前基线逐步提升（如每月 +2%），不要一步到位
  - 制品为什么用 digest 不用 tag？——tag 可变（latest 会被覆盖），digest 是内容哈希不可篡改。部署用 digest 保证拉到的是验证过的镜像。tag 用于人类可读（v1.2.3），digest 用于机器精确引用
  - 金丝雀发布怎么自动判断是否回滚？——对比金丝雀实例和稳定实例的核心指标（错误率、P99、CPU），金丝雀指标劣化超阈值（如错误率 +1%）自动回滚。关键是有明确的回滚规则，不能靠人判断
  - SBOM 是什么，为什么重要？——Software Bill of Materials，软件物料清单，列出所有依赖（直接+间接）及版本。用于漏洞追踪（某个 CVE 爆出，查 SBOM 看哪些制品受影响）和合规（供应链安全）
  - 流水线跑太久怎么办？——并行化（单测和扫描并行）、缓存（Maven/Gradle 缓存、Docker layer cache）、增量构建（只测变更模块）。目标：PR 流水线 < 10 分钟
memory_points:
  - 流水线六阶段：Build → Test → Integration → Security → Artifact → Deploy
  - 质量门禁：覆盖率 80%、Sonar 零 Blocker、CVE 扫描、性能回归 5%
  - 制品：digest（不可变）> tag（可变），SBOM 可追溯
  - 部署：金丝雀 + 自动回滚（错误率/P99 劣化）
  - DORA 指标：部署频率、lead_time、变更失败率、MTTR
  - 流水线目标：PR < 10 分钟（并行+缓存+增量）
---

# 【Java 后端架构师】CI/CD 流水线、质量门禁与制品治理

> 适用场景：JD 核心技术。50 人团队每天 100+ PR，核心交易服务每周发版 3 次。架构师必须设计自动化流水线、强制质量门禁、不可变制品管理，保证"每个 PR 都被验证、每个制品都可追溯、每次部署都可回滚"。

## 一、概念层：CI/CD 流水线全景

**流水线六阶段**（面试必画）：

```
PR 提交
  │
  ▼
┌─────────────────────────────────────────────────────────────┐
│  1. Build（构建）                                            │
│     - Maven/Gradle 编译                                      │
│     - 编译错误阻断                                           │
│     门禁：编译通过                                            │
└──────────────────────────┬──────────────────────────────────┘
                           │
  ┌────────────────────────┼────────────────────────┐
  │                        │                        │
  ▼                        ▼                        ▼
┌──────────┐      ┌──────────────┐        ┌──────────────┐
│ 2. Unit  │      │ 3. Sonar     │        │ 4. License   │
│   Test   │      │   代码质量    │        │   合规扫描    │
│ 覆盖率80%│      │ Blocker=0    │        │ 依赖许可证    │
└────┬─────┘      └──────┬───────┘        └──────┬───────┘
     │                   │                       │
     └───────────────────┼───────────────────────┘
                         │ （门禁全过）
                         ▼
              ┌───────────────────┐
              │ 5. 集成测试        │
              │   + 安全扫描（Trivy）│
              │   + 镜像构建       │
              └─────────┬─────────┘
                        │
                        ▼
              ┌───────────────────┐
              │ 6. 制品入库        │
              │   digest + SBOM   │
              │   + 测试报告绑定   │
              └─────────┬─────────┘
                        │
                        ▼ （合并到 main）
              ┌───────────────────┐
              │ 7. 部署            │
              │ dev → staging → prod│
              │ 金丝雀 + 自动回滚   │
              └───────────────────┘
```

**质量门禁矩阵**（每阶段的具体阈值）：

| 阶段 | 门禁项 | 阈值 | 失败动作 |
|------|--------|------|---------|
| Unit Test | 行覆盖率 | > 80% | 阻断 PR |
| Unit Test | 新代码覆盖率 | > 90% | 阻断 PR |
| Sonar | Blocker | 0 | 阻断 PR |
| Sonar | Critical | < 5 | 警告（可覆盖） |
| Sonar | 重复代码 | < 3% | 阻断 PR |
| Security | 依赖 CVE 高危 | 0 | 阻断 PR |
| Security | 镜像漏洞（Trivy） | 0 Critical | 阻断部署 |
| 性能 | P99 回归 | < 5% | 阻断部署 |
| 制品 | 镜像大小 | < 500MB | 警告 |

## 二、机制层：GitHub Actions 流水线 YAML

**完整 CI 流水线**（Java 项目，逐段能解释）：

```yaml
# .github/workflows/ci.yml
name: CI Pipeline

on:
  pull_request:
    branches: [main, develop]
  push:
    branches: [main]

jobs:
  # ============ 阶段 1-4：并行跑 ============
  build-and-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      # 缓存 Maven 依赖（加速构建）
      - uses: actions/cache@v3
        with:
          path: ~/.m2/repository
          key: ${{ runner.os }}-maven-${{ hashFiles('**/pom.xml') }}

      # JDK 设置
      - uses: actions/setup-java@v4
        with:
          java-version: '17'
          distribution: 'temurin'

      # 编译 + 单元测试 + 覆盖率
      - name: Build & Test
        run: mvn clean verify -B
          -Djacoco.minimum.coverage=0.80
          # 覆盖率 < 80% 构建失败

      # 上传覆盖率报告
      - name: Upload Coverage
        if: always()
        run: |
          bash <(curl -s https://codecov.io/bash) || true

  # Sonar 代码质量扫描（并行）
  sonar:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0   # Sonar 需要完整历史做增量分析
      - name: SonarQube Scan
        env:
          SONAR_TOKEN: ${{ secrets.SONAR_TOKEN }}
        run: mvn sonar:sonar
          -Dsonar.qualitygate.wait=true
          # qualitygate.wait=true：门禁不过流水线失败
          # 门禁：Blocker=0, Critical<5, Coverage>80%, Duplication<3%

  # 依赖安全扫描（并行）
  security-scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # CVE 漏洞扫描
      - name: Dependency Scan (Trivy)
        uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          scan-ref: '.'
          severity: 'CRITICAL,HIGH'
          exit-code: '1'     # 发现高危漏洞失败
      # 许可证合规
      - name: License Check
        run: mvn license:check
          # 禁止 GPL 等传染性许可证

  # ============ 阶段 5-6：构建镜像 + 制品 ============
  build-image:
    needs: [build-and-test, sonar, security-scan]   # 前置全过才跑
    runs-on: ubuntu-latest
    if: github.event_name == 'push'   # 只有 push 到 main 才构建镜像
    steps:
      - uses: actions/checkout@v4

      # 多阶段构建（减小镜像体积）
      - name: Build Docker Image
        run: |
          docker build -t order-service:${{ github.sha }} .
          # 用 commit SHA 做 digest，不用 latest

      # 镜像漏洞扫描
      - name: Image Scan (Trivy)
        run: trivy image --exit-code 1 --severity CRITICAL order-service:${{ github.sha }}

      # 推送到镜像仓库
      - name: Push Image
        run: |
          docker tag order-service:${{ github.sha }} registry.jd.com/order-service:${{ github.sha }}
          docker push registry.jd.com/order-service:${{ github.sha }}
          # digest = sha256:abc123...（不可变）

      # 生成 SBOM（软件物料清单）
      - name: Generate SBOM
        uses: anchore/sbom-action@v0
        with:
          image: registry.jd.com/order-service:${{ github.sha }}
          format: spdx-json
          output-file: sbom.json

      # 制品入库（绑定 commit、测试报告、SBOM）
      - name: Publish Artifact
        run: |
          curl -X POST https://artifact.jd.com/api/release \
            -d "{
              \"service\": \"order-service\",
              \"version\": \"${{ github.sha }}\",
              \"commit\": \"${{ github.sha }}\",
              \"sbom\": \"$(cat sbom.json | base64)\",
              \"test_report\": \"...\", 
              \"build_time\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"
            }"
```

## 三、机制层：ArgoCD GitOps 部署

**GitOps 部署流水线**（生产级）：

```yaml
# argocd-app.yaml - ArgoCD 应用定义
apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: order-service-prod
spec:
  source:
    repoURL: https://github.com/jd/k8s-manifests
    targetRevision: main
    path: prod/order-service
  destination:
    server: https://kubernetes.default.svc
    namespace: prod
  syncPolicy:
    automated:
      prune: true
      selfHeal: true
    # 金丝雀发布策略
    strategy:
      canary:
        steps:
          - setWeight: 1       # 1% 流量
          - pause: { duration: 5m }   # 观察 5 分钟
          - setWeight: 10      # 10%
          - pause: { duration: 10m }
          - setWeight: 50
          - pause: { duration: 10m }
          - setWeight: 100     # 全量
        # 自动回滚分析
        analysis:
          templates:
            - templateName: success-rate
          args:
            - name: service-name
              value: order-service
```

**自动回滚分析模板**（指标劣化自动回滚）：

```yaml
# analysis-template.yaml
apiVersion: argoproj.io/v1alpha1
kind: AnalysisTemplate
metadata:
  name: success-rate
spec:
  args:
    - name: service-name
  metrics:
    - name: success-rate
      interval: 1m
      # 查询 Prometheus：金丝雀实例的成功率
      successCondition: result[0] >= 0.99
      failureLimit: 3     # 连续 3 次失败触发回滚
      provider:
        prometheus:
          address: http://prometheus:9090
          query: |
            sum(rate(http_server_requests_seconds_count{
              app="{{args.service-name}}",
              status!~"5.."
            }[2m]))
            /
            sum(rate(http_server_requests_seconds_count{
              app="{{args.service-name}}"
            }[2m]))
```

## 四、实战层：制品治理与 SBOM

**制品生命周期**（从构建到销毁）：

```
构建 → 验证 → 入库 → 部署 → 运行 → 归档 → 销毁
  │       │      │      │      │      │      │
  SHA     测试   digest tag   金丝雀  监控   保留    清理
  绑定    门禁   不可变 可读  回滚    告警   180天   180天+

制品仓库（Harbor/Nexus）：
  ├── order-service:sha-abc123（digest: sha256:...）
  │     ├── commit: abc123
  │     ├── 构建时间: 2026-07-13T10:00:00Z
  │     ├── SBOM: spdx-json（所有依赖+版本）
  │     ├── 测试报告: 覆盖率 85%, 0 Blocker
  │     ├── 签名: cosign（防篡改）
  │     └── 扫描结果: 0 Critical CVE
  ├── order-service:sha-def456（上个版本，用于回滚）
  └── order-service:v1.2.3（人类可读 tag，指向某 digest）
```

**SBOM 示例（SPDX 格式）**：

```json
{
  "spdxVersion": "SPDX-2.3",
  "name": "order-service",
  "SPDXID": "SPDXRef-DOCUMENT",
  "packages": [
    {
      "name": "order-service",
      "versionInfo": "1.2.3",
      "SPDXID": "SPDXRef-Package-OrderService",
      "licenseConcluded": "Apache-2.0"
    },
    {
      "name": "spring-boot-starter-web",
      "versionInfo": "3.2.0",
      "SPDXID": "SPDXRef-Package-SpringBoot",
      "licenseConcluded": "Apache-2.0"
    },
    {
      "name": "log4j-core",
      "versionInfo": "2.17.1",
      "SPDXID": "SPDXRef-Package-Log4j",
      "licenseConcluded": "Apache-2.0"
    }
  ]
}
```

**SBOM 的价值**：当 Log4Shell（CVE-2021-44228）爆出时，查询所有制品的 SBOM，几秒内知道哪些服务用了受影响版本，精准应急。

## 五、底层本质：为什么要 CI/CD + 质量门禁

回到第一性：**线上事故的根因是"未经验证的变更进入生产"，CI/CD 把验证从人工变成自动化、从随机变成强制**。

- **质量左移**：越早发现问题成本越低（生产事故成本是 PR 阶段的 100 倍）。CI 把测试、扫描、覆盖率检查放到 PR 阶段，门禁不过不让合并，从源头拦截问题。
- **制品不可变**：传统部署"拉代码→构建→部署"每次构建可能不同（依赖版本、环境变量）。不可变镜像（digest）保证"测试过的是部署的"——测试用 abc123 digest，部署也用 abc123，不会因为环境差异引入问题。
- **可追溯**：每个制品绑定 commit、测试报告、SBOM、签名。出问题能查到"哪个 PR 引入、谁合并的、测试是否覆盖、依赖什么版本"。这是事后复盘和合规审计的基础。
- **可回滚**：金丝雀 + 自动回滚保证"出问题秒级切回上一版本"。关键是回滚是自动的（基于指标判断），不是等人决策——人反应慢（MTTR 分钟级），自动回滚秒级。
- **DORA 指标驱动改进**：部署频率（Elite 团队每天多次）、变更前置时间（< 1 小时）、变更失败率（< 15%）、MTTR（< 1 小时）。这四个指标衡量 CI/CD 成熟度，持续优化。

**流水线效率的取舍**：门禁太严开发效率下降（PR 堆积），太松线上事故频发。解法是分层——Blocker 阻断、Critical 警告可覆盖、Minor 提醒。覆盖率从基线逐步提升（如每月 +2%），不要一步到 80%。

## 六、AI 架构师加问：5 个

1. **AI 能自动修复 CI 门禁失败吗？**
   能做辅助。AI 分析 Sonar 告警（如空指针风险、重复代码），生成修复 PR。但修复要人工 review——AI 可能引入新问题。Blocker 级别的修复必须人工确认，Minor 级可自动合并。

2. **AI 怎么帮助分析流水线效率瓶颈？**
   AI 分析每个阶段的耗时分布、失败原因聚类（如"60% 的失败是单测覆盖率不足"）、并行度。推荐优化（"把 Sonar 和单测并行可省 3 分钟"）。DORA 指标趋势预测（"变更失败率上升，建议加强集成测试"）。

3. **AI 辅助 Code Review 怎么做？**
   AI 在 PR 阶段做初步 review（代码风格、潜在 bug、安全风险），生成评论。人工 review 聚焦业务逻辑。但 AI review 不能替代人工——复杂业务逻辑、架构决策 AI 看不懂。AI 适合机械性检查（格式、命名、常见 bug 模式）。

4. **制品漏洞爆发（如 Log4Shell），AI 能自动应急吗？**
   AI 能自动扫描所有制品的 SBOM，找出受影响的服务，生成修复 PR（升级依赖版本）。但部署决策（哪些服务先修、是否紧急发版）需人工判断。AI 加速"发现+生成修复"，人工决策"优先级+节奏"。

5. **让 AI 管理金丝雀发布的回滚决策，风险在哪？**
   AI 能实时分析指标判断是否回滚，但风险是指标误判（如大促期间正常错误率波动被误判为故障）。解法：回滚规则明确（错误率 > 基线 + 阈值）、AI 建议回滚但人工确认（关键链路）、或 AI 自动回滚但通知人工复核。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"六阶段、质量门禁、digest 制品、金丝雀回滚、DORA"**。

- **六阶段**：Build → Test → Integration → Security → Artifact → Deploy
- **门禁**：覆盖率 80%、Sonar Blocker=0、CVE 扫描、性能回归 5%
- **制品**：digest（不可变）替代 tag，SBOM 可追溯漏洞，cosign 签名防篡改
- **部署**：金丝雀 1%→10%→100%，指标劣化自动回滚
- **DORA**：部署频率、lead_time、变更失败率、MTTR

### 拟人化理解

把 CI/CD 想成**汽车总装线**。每个工位（流水线阶段）有质检关卡（门禁）——焊接检查焊点、涂装检查漆膜、总装检查扭矩，不合格不能流入下一工位。出厂的每辆车（制品）有 VIN 号（digest）和质检报告（SBOM）。金丝雀发布是"先让 1% 客户试驾，有问题立刻召回（回滚）"。

### 面试现场 60 秒回答

> 流水线六阶段：Build、Unit Test、Integration Test、Security Scan、Artifact、Deploy，每阶段设质量门禁。PR 阶段并行跑单测（覆盖率 > 80%）、Sonar（Blocker=0）、Trivy CVE 扫描，门禁不过 PR 不能合并。合并后构建不可变镜像（用 commit SHA 做 digest，不用 latest），生成 SBOM 绑定到制品。部署走 GitOps（ArgoCD），dev → staging → prod，生产用金丝雀（1%→10%→100%），Prometheus 实时监控错误率和 P99，劣化超阈值自动回滚。制品用 digest 保证"测试过的是部署的"，SBOM 保证漏洞爆发时秒级定位受影响服务。用 DORA 指标（部署频率、lead_time、变更失败率、MTTR）衡量成熟度持续优化。流水线效率靠并行化 + 缓存 + 增量构建，目标 PR 流水线 < 10 分钟。

### 反问面试官

> 贵司用什么 CI/CD（Jenkins/GitHub Actions/GitLab CI）？制品仓库是 Harbor 还是 Nexus？有没有 SBOM 管理？部署是 GitOps（ArgoCD）还是传统脚本？这决定我聊门禁设计还是部署策略。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不让开发手动部署，要搞 CI/CD？ | 用数据说话：手动部署 lead_time 数小时（CI/CD < 1 小时）、变更失败率高（人工易错）、不可追溯（谁部署了什么）。CI/CD 把重复工作自动化，开发专注写代码。证明：DORA 指标对比（部署频率、lead_time、失败率、MTTR） |
| 证据追问 | 怎么证明流水线真的拦住了问题？ | 统计 pipeline 阻断率（门禁失败比例）、被阻断的 PR 后续发现的真实 bug 数、上线后事故率趋势。如果门禁拦截率高但上线事故率没降，说明门禁阈值不准（拦截了太多无关项） |
| 边界追问 | CI/CD 能保证零事故吗？ | 不能。解决不了业务逻辑 bug（单测覆盖不到）、配置错误（环境差异）、容量问题（压测没覆盖）。CI/CD 是"降低事故概率和加快恢复"，不是"零事故"。还要监控、灰度、降级兜底 |
| 反例追问 | 什么场景不适合完整 CI/CD？ | 小团队（1-2 人）简单项目（门禁开销 > 收益）、紧急 hotfix（先修复后补流程）、实验性项目（快速迭代不需要门禁）。但核心生产服务必须完整 CI/CD |
| 风险追问 | 流水线本身的最大风险？ | ① 流水线单点故障（GitLab/Jenkins 挂了无法部署）；② 门禁误判（阈值过严阻断正常 PR）；③ 密钥泄漏（CI 里的 secrets 管理不当）；④ 制品仓库被篡改（用 cosign 签名防护）；⑤ 回滚失败（上个版本也有 bug） |
| 验证追问 | 怎么证明金丝雀回滚真的有效？ | 故障演练：故意部署一个会 5xx 的版本，验证金丝雀是否在阈值内自动回滚。统计 mean_time_to_rollback（应 < 2 分钟）。线上真实故障的回滚记录 |
| 沉淀追问 | 团队 CI/CD 规范沉淀什么？ | 流水线模板（Java/Go/Python 不同）、门禁阈值 SOP（按服务级别分级）、制品命名规范（digest + tag）、金丝雀策略模板、回滚演练脚本、SBOM 管理流程、DORA 大盘 |

### 现场对话示例

**面试官**：质量门禁设太严开发抱怨，怎么平衡？

**候选人**：门禁分层，不要一刀切。Blocker（如编译错误、安全漏洞、覆盖率 < 50%）必须阻断，没有商量。Critical（如 Sonar Critical 告警）警告但允许 Tech Lead 审批覆盖。Minor 提醒不阻断。覆盖率从当前基线逐步提升——如果现在 50%，先设门禁 55%，每月 +2% 到 80%，不要一步到位（团队抵触）。关键数据：看 pipeline_failure_rate（门禁失败比例），如果 > 30% 说明门禁太多或太严，要精简。看 false_positive 率（门禁拦截了但实际没问题），高的话调阈值。让开发参与门禁制定，不是架构师单方面定规则。

**面试官**：制品用 digest 不用 tag，具体怎么操作？

**候选人**：tag 是人类可读但可变（latest、v1.2 都会被覆盖），digest 是镜像内容的 SHA256 哈希不可篡改。流程是：CI 构建镜像用 commit SHA 命名（order-service:abc123），同时打 tag（order-service:v1.2.3）。镜像仓库存储时计算 digest（sha256:xxx）。部署时 K8s 的 Deployment 用 digest 引用（image: registry/order-service@sha256:xxx），不是 tag。这样保证"测试用的镜像是部署用的镜像"——不会因为 tag 被覆盖导致部署了未验证的版本。回滚就是改 Deployment 的 digest 指向上一个版本。tag 只用于人类查询和可读性。

**面试官**：金丝雀发布怎么自动判断回滚？

**候选人**：用 ArgoCD Rollouts 或 Flagger，定义 AnalysisTemplate 查 Prometheus。指标对比金丝雀实例和稳定实例——错误率（金丝雀 5xx 比例 vs 稳定实例）、P99 延迟（金丝巷 vs 稳定）、CPU/内存。规则：错误率 > 稳定基线 + 1%、或 P99 > 基线 × 1.2、连续 3 次（1 分钟间隔）触发回滚。关键是回滚自动、规则明确，不靠人判断（人反应慢，MTTR 分钟级）。故障演练验证：故意部署 5xx 版本，看金丝雀是否在 2 分钟内自动回滚。如果回滚太敏感（正常波动触发），调大阈值或观察窗口。

## 常见考点

1. **质量门禁有哪些？**——覆盖率（行覆盖 > 80%、新代码 > 90%）、Sonar（Blocker=0、Critical<5、重复<3%）、CVE 扫描（Trivy 扫依赖和镜像）、性能回归（P99 < 基线 105%）、许可证合规（禁 GPL）。
2. **制品为什么用 digest？**——digest 是内容哈希不可篡改，tag 可变（会被覆盖）。部署用 digest 保证"测试过的是部署的"。tag 用于人类可读，digest 用于机器精确引用。回滚就是切 digest。
3. **SBOM 是什么？**——Software Bill of Materials，软件物料清单（SPDX 格式），列出所有依赖+版本+许可证。用于漏洞爆发时秒级定位受影响制品，和供应链安全合规。
4. **金丝雀发布怎么做？**——流量 1%→10%→50%→100% 渐进，每阶段观察指标（错误率、P99）。用 ArgoCD Rollouts 定义 AnalysisTemplate 查 Prometheus，指标劣化自动回滚。关键是自动回滚（不靠人）。
5. **DORA 指标是什么？**——部署频率（Elite：每天多次）、变更前置时间（< 1 小时）、变更失败率（< 15%）、MTTR（< 1 小时）。衡量 CI/CD 成熟度的四个黄金指标。

## 结构化回答

**30 秒电梯演讲：** CI/CD 流水线的本质是把质量保障从人工评审变成自动化门禁。流水线分阶段（构建→单测→集成测试→安全扫描→制品→部署），每阶段设质量门禁（覆盖率、漏洞数、镜像大小、性能基线），门禁不过自动阻断。制品治理保证可追溯、可回滚、不可篡改——每个制品绑定 commit、测试报告、SBOM

**展开框架：**
1. **流水线六阶段** — Build → Unit Test → Integration Test → Security Scan → Artifact → Deploy
2. **质量门禁** — 覆盖率 > 80%、Sonar 零 Blocker、镜像漏洞 CVE、性能回归 < 5%
3. **制品治理** — 不可变镜像（digest）、SBOM（软件物料清单）、版本可追溯

**收尾：** 以上是我的整体思路。您想继续深入聊——质量门禁设太严会怎样？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：CI/CD 流水线、质量门禁与制品治理 | "这题一句话：CI/CD 流水线的本质是把质量保障从人工评审变成自动化门禁。" | 开场钩子 |
| 0:15 | 流水线六阶段示意/对比图 | "Build → Unit Test → Integration Test → Security Scan → Artifact → Deploy" | 流水线六阶段要点 |
| 0:40 | 质量门禁示意/对比图 | "覆盖率 > 80%、Sonar 零 Blocker、镜像漏洞 CVE、性能回归 < 5%" | 质量门禁要点 |
| 1:25 | 总结卡 | "记住：流水线六阶段。下期见。" | 收尾 |
