---
id: java-architect-077
difficulty: L2
category: java-architect
subcategory: 安全架构
tags:
- Java 架构师
- 密钥
- 证书
- 安全
feynman:
  essence: 配置、密钥、证书的安全发布核心是"敏感数据与代码分离 + 动态注入 + 最小权限 + 全程加密 + 可审计"。明文密钥进代码库（硬编码）是头号安全事件根因。正确做法是密钥存专门系统（Vault/KMS），运行时动态注入（环境变量/挂载卷），自动轮换，全程不落盘、不日志、不异常。
  analogy: 像银行金库管理。钱（密钥）不放在柜台（代码）而放金库（Vault），柜员（应用）凭权限卡（IAM）按需取，取完不放抽屉（不落盘），金库密码定期换（轮换），每次取钱有监控记录（审计）。
  first_principle: 密钥泄露的三条路径——代码库硬编码（Git 历史永久留存）、日志/异常打印（日志系统泄露）、配置文件明文（CI/CD 产物含密钥）。治理本质是"密钥从不以明文出现在代码、配置、日志中"，通过专门的密钥管理系统（Vault/KMS）做存储、访问控制、轮换、审计。
  key_points:
  - 密钥与代码分离：Vault/KMS/AWS Secrets Manager 集中存储，运行时注入
  - 动态注入：K8s Secret、环境变量、Sidecar 挂载，不落盘
  - 最小权限：IAM 按服务授权，密钥访问需审计
  - 自动轮换：证书 90 天轮换、数据库密码 30 天轮换，自动不依赖人工
  - 证书管理：cert-manager 自动签发/续期 Let's Encrypt 或内部 CA
  - 全程加密：传输 TLS、存储加密、日志脱敏
first_principle:
  problem: 数百个服务的数据库密码、API Key、TLS 证书散落在代码库和配置文件中，如何统一安全治理？
  axioms:
  - 硬编码密钥会永久留存 Git 历史，删除提交无法彻底清除
  - 明文配置在 CI/CD 产物（镜像、日志）中泄露
  - 人工轮换不可靠（会忘、会拖延），必须自动化
  rebuild: 三层治理——第一层，密钥集中存储到 Vault 或云 KMS，不进代码库。第二层，运行时动态注入：K8s 通过 Vault Agent Sidecar 或 External Secrets 拉取密钥挂载为临时文件/环境变量，应用读取后内存使用不落盘。第三层，自动轮换：cert-manager 管理 TLS 证书自动签发续期，数据库密码用 Vault 动态生成临时凭据。全程审计（谁、何时、访问什么密钥），日志脱敏（密钥不进日志）。
follow_up:
  - K8s Secret 安全吗？——默认是 base64 编码（不是加密），etcd 里可读。要开启 etcd 静态加密（EncryptionConfiguration），或用 Vault/外部 Secret 系统替代。生产不建议用 K8s Secret 存高敏感密钥（如数据库密码），用 Vault 动态注入
  - 证书过期了怎么办？——cert-manager 自动续期（Let's Encrypt 30 天前续、内部 CA 按配置）。关键是监控证书过期告警（cert-manager 指标 cert_expiration_timestamp），过期前人工介入
  - 数据库密码怎么轮换不停服？——用 Vault 动态数据库凭据——Vault 连数据库管理员账号，按需生成临时账号密码（TTL 1 小时），应用用完自动销毁。或双密码轮换（新旧密码并存窗口期）
  - 密钥泄漏到 Git 怎么彻底清除？——git filter-branch 或 BFG Repo-Cleaner 重写历史，但已 clone 的仓库无法清除。正确做法：立即轮换该密钥（视为已泄露），新密钥从 Vault 重新生成。预防用 pre-commit hook 扫描（truffleHog/git-secrets）
  - 微服务间通信的 mTLS 怎么管理证书？——用 Istio/Linkerd Service Mesh 自动 mTLS，证书自动签发轮换（SPIFFE 身份），应用无感知。比手动管理双向 TLS 证书简单
memory_points:
  - 密钥不进代码库，存 Vault/KMS，运行时注入
  - K8s Secret 是 base64 不是加密，要开 etcd 加密或用 Vault
  - cert-manager 自动签发续期 TLS 证书
  - Vault 动态数据库凭据（TTL 临时账号）
  - 日志脱敏：密钥/密码/Token 不进日志
  - 预防 Git 泄漏：pre-commit hook（truffleHog/git-secrets）
---

# 【Java 后端架构师】配置、密钥与证书的安全发布

> 适用场景：JD 核心技术。数百个服务的数据库密码、第三方 API Key、TLS 证书需要安全管理。架构师必须设计密钥集中存储、动态注入、自动轮换方案，杜绝硬编码泄漏。

## 一、概念层：密钥安全的三层治理

**密钥管理的五项原则**（面试必答）：

| 原则 | 含义 | 违反后果 |
|------|------|---------|
| **与代码分离** | 密钥存 Vault/KMS，不进代码库 | Git 历史永久泄漏 |
| **动态注入** | 运行时拉取，不写死在配置文件 | CI/CD 产物（镜像/日志）泄漏 |
| **最小权限** | 每个服务只能访问自己的密钥 | 一个服务被攻破波及全局 |
| **自动轮换** | 证书/密码定期自动更换，不依赖人工 | 过期证书导致服务中断 |
| **全程审计** | 密钥访问记录可追溯 | 泄漏后无法追查 |

**密钥泄漏的三条路径**（必须封堵）：

```
路径 1：代码库硬编码
  password = "JD@prod#2024"  → Git 提交 → 永久留存历史
  即使删除提交，clone 过的仓库仍有

路径 2：日志/异常打印
  log.info("connecting with password: " + password)
  → 日志系统（ELK）明文存储 → 运维可看

路径 3：CI/CD 产物
  Docker 镜像里含 application.yml 明文密码
  → 镜像仓库泄漏 → 密码外泄
```

**正确架构**：

```
┌──────────────┐
│  Git 仓库     │  只存代码，不存密钥
│  (代码)      │  application.yml 只用占位符 ${DB_PASSWORD}
└──────────────┘

┌──────────────┐
│  Vault/KMS   │  密钥集中存储（加密），访问需审计
│  (密钥仓库)  │  支持自动轮换、动态凭据
└──────┬───────┘
       │ 运行时动态拉取（Sidecar/Init Container）
       ▼
┌──────────────┐
│  K8s Pod     │  密钥以临时文件/环境变量注入
│  (应用)      │  应用读取后内存使用，不落盘、不日志
└──────────────┘
```

## 二、机制层：Vault 密钥管理与动态注入

**Vault Agent Sidecar 注入模式**（生产标准）：

```yaml
# K8s Deployment + Vault Agent Sidecar
apiVersion: apps/v1
kind: Deployment
metadata:
  name: order-service
  annotations:
    # Vault Agent 注入注解
    vault.hashicorp.com/agent-inject: "true"
    vault.hashicorp.com/role: "order-service"
    # 注入数据库密码到文件
    vault.hashicorp.com/agent-inject-secret-db-password: "database/creds/order-service"
    vault.hashicorp.com/agent-inject-template-db-password: |
      {{- with secret "database/creds/order-service" -}}
      DB_PASSWORD={{ .Data.password }}
      DB_USER={{ .Data.username }}
      {{- end }}
spec:
  template:
    spec:
      containers:
        - name: order-service
          image: registry.jd.com/order-service:1.0.0
          # 应用从挂载文件读密钥（不是环境变量硬编码）
          env:
            - name: SPRING_DATASOURCE_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: order-secrets    # Vault Agent 生成的临时 Secret
                  key: db-password
```

**Vault 动态数据库凭据**（核心安全能力）：

```bash
# Vault 配置：连接数据库管理员账号（这个账号只有 Vault 知道）
vault write database/config/order-mysql \
    plugin_name=mysql-database-plugin \
    connection_url="root:{{username}}:{{password}}@tcp(mysql:3306)/" \
    allowed_roles="order-service" \
    username="vault-admin" \
    password="VAULT_ADMIN_PASSWORD"

# 创建角色：order-service 每次申请，生成临时账号（TTL 1 小时）
vault write database/roles/order-service \
    db_name=order-mysql \
    creation_statements="CREATE USER '{{name}}'@'%' IDENTIFIED BY '{{password}}'; \
                         GRANT SELECT,INSERT,UPDATE ON order_db.* TO '{{name}}'@'%';" \
    default_ttl="1h" \
    max_ttl="24h"

# 应用每次启动，Vault 生成临时账号密码
vault read database/creds/order-service
#   Key            Value
#   lease_id       database/creds/order-service/abc123
#   lease_duration 1h
#   username       v-token-order-xYz    # 临时账号
#   password       A1b2C3d4E5f6G7h8     # 随机密码
# 1 小时后自动销毁，不用人工轮换
```

**Java 应用读取 Vault 密钥**：

```java
// Spring Cloud Vault 配置
// bootstrap.yml
spring:
  cloud:
    vault:
      uri: https://vault.jd.com:8200
      authentication: kubernetes          # K8s ServiceAccount 认证
      kubernetes:
        role: order-service
        service-account-token-file: /var/run/secrets/kubernetes.io/serviceaccount/token
      database:
        enabled: true
        role: order-service
        backend: database
# Spring Boot 启动时自动从 Vault 拉取数据库密码，注入 DataSource

// 代码里不出现任何密码（从配置注入）
@Configuration
public class DataSourceConfig {
    @Value("${spring.datasource.password}")  // 由 Vault 注入
    private String dbPassword;

    @Bean
    public DataSource dataSource() {
        HikariDataSource ds = new HikariDataSource();
        ds.setPassword(dbPassword);  // 密码只在内存，不日志
        return ds;
    }
}
```

## 三、机制层：证书管理（cert-manager）

**cert-manager 自动签发 TLS 证书**：

```yaml
# 1. 安装 cert-manager（CRD + Controller）
# 2. 配置 Issuer（Let's Encrypt 或内部 CA）
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: sre@jd.com
    privateKeySecretRef:
      name: letsencrypt-prod
    solvers:
      - http01:
          ingress:
            class: nginx

# 3. 为服务签发证书（自动续期）
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: order-service-tls
spec:
  secretName: order-service-tls       # 证书存入这个 Secret
  dnsNames:
    - order-service.jd.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
  duration: 2160h        # 90 天有效期
  renewBefore: 360h      # 过期前 15 天自动续期
# cert-manager 监控证书过期，自动续期，应用无感知
```

**证书过期监控与告警**：

```yaml
# Prometheus 告警：证书即将过期
groups:
  - name: certificate
    rules:
      - alert: CertificateExpiringSoon
        expr: |
          certmanager_certificate_expiration_timestamp_seconds - time() < 86400 * 7
        for: 1h
        labels: { severity: critical }
        annotations:
          summary: "证书 {{ $labels.name }} 将在 7 天内过期"
          # cert-manager 应自动续期，告警说明续期失败

      - alert: CertificateIssuanceFailed
        expr: certmanager_certificate_ready_status{condition="False"} == 1
        for: 10m
        annotations:
          summary: "证书签发失败，检查 ACME/Issuer 配置"
```

## 四、实战层：日志脱敏与 Git 泄漏防护

**日志脱敏**（密钥绝不进日志）：

```java
// Logback 脱敏配置（logback-spring.xml）
<pattern>
  %replace(%msg){'password=\S+', 'password=***'}
  %replace(%msg){'token=\S+', 'token=***'}
  %replace(%msg){'\d{16,19}', '***CARD***'}   # 银行卡号
  %replace(%msg){'\d{15}|\d{18}', '***ID***'}  # 身份证
</pattern>

// Java 代码层脱敏（防 AI 打印密码）
@Slf4j
public class OrderService {
    // 用 @ToString(exclude = ) 防止 toString 泄漏
    @ToString(exclude = {"password", "apiKey"})
    public class Credential {
        private String password;
        private String apiKey;
    }

    // 日志不打印敏感参数
    public void connect(String host, String password) {
        // ❌ 错误：log.info("connecting to {} with password {}", host, password);
        // ✓ 正确：
        log.info("connecting to {}", host);
    }
}
```

**Git 密钥泄漏防护**（pre-commit hook）：

```bash
# .git/hooks/pre-commit（或用 truffleHog）
#!/bin/bash
# 扫描提交内容是否含密钥模式（AWS Key、私有密钥、高熵字符串）

# 安装 truffleHog
pip install trufflehog

# pre-commit 扫描
trufflehog git file://. --since-commit HEAD --branches HEAD
# 发现密钥模式（如 AKIA 开头的 AWS Key）阻止提交

# 或用 git-secrets
git secrets --scan
```

**Git 历史密钥清除**（密钥已泄漏的应急）：

```bash
# 用 BFG Repo-Cleaner 清除历史中的密钥文件
bfg --delete-files application-prod.yml my-repo.git
bfg --replace-text passwords.txt my-repo.git

# git filter-branch（原生，较慢）
git filter-branch --tree-filter 'rm -f application-prod.yml' HEAD

# ⚠ 重要：清除历史后，必须轮换该密钥（视为已泄露）
# 因为已 clone/fork 的仓库无法清除
# 新密钥从 Vault 重新生成，不再进代码库
```

## 五、底层本质：为什么密钥安全这么难

回到第一性：**密钥是"机密性"和"可用性"的矛盾体——应用需要用它（可用），但又不能让任何不该看的人看到（机密）**。

- **机密性 vs 可用性**：应用运行时必须能拿到密钥（连数据库、调 API），但密钥在内存中就可能被 dump（heap dump、core dump）。完全的机密性需要硬件级保护（HSM、TEE），但成本高。工程取舍是"降低暴露面"——密钥不进代码库、不进日志、不进 CI/CD 产物，只在运行时内存中短暂存在。
- **人工 vs 自动轮换**：密钥长期不换，一旦泄漏窗口期长。但人工轮换不可靠（会忘、会拖延、操作失误导致服务中断）。自动轮换（Vault 动态凭据 TTL 1 小时、cert-manager 证书 90 天自动续期）是唯一可扩展的方案。关键是轮换过程不停服（双密码窗口期、动态凭据无缝切换）。
- **集中 vs 分散**：密钥分散在每个服务的配置文件，难以统一管理（轮换、审计、吊销）。集中到 Vault 统一管理，但 Vault 成为单点（必须高可用 + 备份）。工程取舍是"集中存储 + 分布式缓存"——Vault 集群高可用存储，应用本地缓存密钥（TTL），Vault 短暂不可用不影响应用。
- **代码库的永久性**：Git 历史是不可篡改的（设计如此）。一旦密钥提交，即使后续删除，历史记录仍留存，任何 clone 的人都能看到。这是为什么"密钥不能进代码库"是铁律——Git 的永久性与密钥的机密性根本对立。

## 六、AI 架构师加问：5 个

1. **AI 能自动检测代码里的硬编码密钥吗？**
   能。AI 扫描代码（变量名 password/apiKey/secret + 高熵字符串 + 已知密钥模式如 AWS Key），发现疑似硬编码告警。比正则更准（理解上下文，区分测试 mock 和真实密钥）。但要做人工确认——AI 可能误报（如测试用的假密码）。

2. **用 AI 做密钥泄漏的暗网监控？**
   AI 监控公开的代码仓库（GitHub/GitLab）、Pastebin、暗网论坛，扫描是否出现本公司密钥模式。发现泄漏立即告警 + 自动轮换。这是"假设已经泄漏"的防御思维。

3. **AI 推理服务的 API Key 怎么安全管理？**
   用 API Gateway 做统一 Key 管理（签发、轮换、吊销、配额）。AI 服务的 Key 要比普通业务 Key 更严格（AI 调用有成本，Key 泄漏可能产生巨额账单）。按 Key 设配额（每天调用次数、Token 消耗上限），异常消费告警。

4. **Vault 被 AI Agent 调用怎么控权限？**
   AI Agent 访问 Vault 要用独立的 ServiceAccount 和最小权限策略（只能读特定路径的密钥）。每次访问审计记录（哪个 Agent、何时、读了什么）。高风险密钥（如生产数据库密码）不允许 Agent 直接读，由确定性代码在可信环境读后传给 Agent。

5. **AI 辅助证书过期预测和自动续期决策？**
   AI 分析证书使用情况（哪些证书被频繁使用、哪些即将过期）、预测续期需求（大促前证书需求增加）。但续期动作（cert-manager 自动续期）是确定性的，不需要 AI。AI 价值在"发现续期失败的根因"（如 ACME 验证失败、DNS 配置错误）并给出修复建议。

## 七、记忆口诀与面试现场表达

### 1 分钟记忆口诀

抓 **"密钥不进库、Vault 集中存、动态注入、自动轮换、日志脱敏"**。

- **不进库**：密钥不硬编码到 Git，用占位符 ${DB_PASSWORD}
- **Vault**：集中存储 + 访问审计 + 动态凭据（临时账号 TTL 1 小时）
- **注入**：Sidecar/Init Container 运行时注入，不落盘
- **轮换**：证书 cert-manager 自动续期、密码 Vault 动态生成
- **脱敏**：日志/异常不打印密钥，Git pre-commit hook 防泄漏

### 拟人化理解

把密钥管理想成**银行金库**。钱（密钥）不放柜台（代码）而放金库（Vault），柜员（应用）凭权限卡（IAM/K8s SA）按需取，取完不放抽屉（内存使用不落盘），金库密码定期换（自动轮换），每次取钱有监控记录（审计）。钱不小心掉柜台了（硬编码 Git），要立刻作废换新钞（轮换），因为已经被监控拍到了（Git 历史）。

### 面试现场 60 秒回答

> 核心是密钥与代码分离 + 动态注入 + 自动轮换。密钥不进代码库（用占位符 ${DB_PASSWORD}），集中存到 Vault 或云 KMS，运行时通过 Vault Agent Sidecar 动态注入到 Pod（临时文件或环境变量），应用读取后内存使用不落盘。数据库密码用 Vault 动态凭据——Vault 连数据库管理员账号，按需生成临时账号（TTL 1 小时），自动销毁不用人工轮换。TLS 证书用 cert-manager 自动签发续期（Let's Encrypt 或内部 CA，过期前 15 天自动续）。全程审计（谁何时访问什么密钥），日志脱敏（Logback %replace 脱敏密码/Token）。预防 Git 泄漏用 pre-commit hook（truffleHog 扫密钥模式）。K8s Secret 默认是 base64 不是加密，高敏感密钥用 Vault 替代。

### 反问面试官

> 贵司密钥管理用 Vault 还是云 KMS？证书是自建 CA 还是 Let's Encrypt？有没有遇到过证书过期导致的事故？这决定我聊 Vault 架构还是 cert-manager 配置。

## 八、苏格拉底式面试追问

| 追问层级 | 面试官可能这样问 | 高分回答方向 |
|----------|------------------|--------------|
| 目标追问 | 为什么不能用 K8s Secret 存所有密钥？ | K8s Secret 默认是 base64 编码（不是加密），etcd 里明文可读。虽然能开启 etcd 静态加密，但不支持自动轮换、动态凭据、细粒度审计。高敏感密钥（数据库密码、API Key）用 Vault，低敏感（feature flag、非生产配置）可用 K8s Secret |
| 证据追问 | 怎么证明没有硬编码密钥？ | 用 truffleHog/git-secrets 扫描全仓库历史，扫描 CI/CD 产物（镜像、日志）。定期安全审计。Git pre-commit hook 阻止提交。漏扫发现硬编码后立即轮换 |
| 边界追问 | 密钥管理能保证零泄漏吗？ | 不能。应用内存里的密钥可能被 heap dump、core dump 提取。HSM/TEE 能硬件级保护但成本高。工程上降低暴露面（不进代码/日志/产物），不能绝对零泄漏。还要监控异常密钥访问（谁在非工作时间读了生产密钥） |
| 反例追问 | 什么场景不适合 Vault？ | 小团队简单项目（Vault 运维成本高，用云 KMS 或 K8s Secret 够了）、本地开发（用 .env 文件 + gitignore）、无状态边缘计算（无 Vault 连接条件）。Vault 适合中大型团队多服务场景 |
| 风险追问 | 密钥治理最大风险？ | ① Vault 单点故障（高可用 + 备份 + 本地缓存）；② 密钥轮换导致服务中断（双密码窗口期、动态凭据无缝）；③ Git 历史泄漏（pre-commit + 定期扫描）；④ 证书过期未续期（cert-manager + 过期告警）；⑤ 内部人员作恶（审计 + 最小权限） |
| 验证追问 | 怎么证明自动轮换真的有效？ | 定期故障演练：手动删掉数据库临时账号，验证 Vault 重新生成。证书演练：缩短证书 TTL 到 1 天，验证 cert-manager 自动续期。统计 mean_time_to_rotate（应分钟级）。检查 certificate_expiration 告警是否触发 |
| 沉淀追问 | 团队密钥规范沉淀什么？ | 密钥分级（公开/内部/机密/绝密，不同管理方式）、Vault 接入模板、证书申请 SOP、日志脱敏规范、Git 泄漏应急流程（轮换+清除+通知）、密钥审计 checklist |

### 现场对话示例

**面试官**：数据库密码怎么不停服轮换？

**候选人**：两种方案。第一种是 Vault 动态数据库凭据——Vault 持有数据库管理员账号（这个账号只有 Vault 知道，不进任何配置），应用每次启动向 Vault 申请，Vault 用管理员账号创建临时账号（如 v-order-xYz）授权读写，TTL 1 小时自动销毁。应用用临时账号连库，密码从来不是固定的，无需轮换。第二种是双密码窗口期——数据库同时支持新旧两个密码，新密码推送后应用滚动重启用新密码，全部切换后删除旧密码。适合不能用 Vault 的场景。两种都要保证应用能动态感知密码变化（Spring Cloud Config Bus 刷新、或 Vault Agent 推送新密钥触发连接重建）。

**面试官**：K8s Secret 不安全，但又不得不用，怎么加固？

**候选人**：三层加固。第一，开启 etcd 静态加密——配置 EncryptionConfiguration，K8s 在写入 etcd 前用 KMS 提供的密钥加密 Secret 数据，etcd 里是密文。第二，RBAC 限制 Secret 访问——只有特定 ServiceAccount 能读特定 Secret，普通 Pod 不能 kubectl get secret。第三，用 External Secrets Operator 替代原生 Secret——密钥存在 Vault/AWS Secrets Manager，ESO 同步到 K8s Secret（可设短 TTL 自动刷新），原生 Secret 只是临时载体。高敏感密钥建议直接用 Vault Agent Sidecar，绕过 K8s Secret。

**面试官**：证书过期导致全站不可用的事故怎么防？

**候选人**：三道防线。第一，cert-manager 自动续期——证书过期前 15 天自动 ACME 续期，应用无感知。配置 renewBefore 留足缓冲。第二，过期告警——Prometheus 监控 certmanager_certificate_expiration_timestamp_seconds，过期前 30 天/7 天/1 天分级告警。第三，人工兜底——SRE 每周 review 证书大盘，重点关注即将过期的证书。事故根因通常是 cert-manager 续期失败（ACME 验证失败、DNS 配置错误、配额用尽），告警能提前发现。建议证书 TTL 不要太长（90 天），频繁续期能及时发现问题（如果续期机制坏了，90 天内必暴露）。

## 常见考点

1. **K8s Secret 安全吗？**——默认是 base64 编码（不是加密），etcd 明文可读。要开启 etcd 静态加密（EncryptionConfiguration），或用 Vault/External Secrets 替代。高敏感密钥不建议用 K8s Secret。
2. **证书怎么自动管理？**——cert-manager（K8s CRD）自动签发和续期 TLS 证书。配置 ClusterIssuer（Let's Encrypt 或内部 CA）+ Certificate 资源，cert-manager 监控过期自动续期。配合 Prometheus 过期告警兜底。
3. **Git 历史密钥怎么清？**——用 BFG Repo-Cleaner 或 git filter-branch 重写历史。但已 clone 的仓库无法清除，必须轮换该密钥（视为已泄露）。预防用 pre-commit hook（truffleHog）扫描。
4. **Vault 动态数据库凭据是什么？**——Vault 持有数据库管理员账号，按需生成临时账号密码（TTL 1 小时），应用用完自动销毁。密码从不是固定的，无需人工轮换。
5. **日志脱敏怎么做？**——Logback 的 %replace 模式脱敏密码/Token/银行卡号/身份证。代码层用 @ToString(exclude) 防止 toString 泄漏。关键是养成习惯——日志永不打印敏感参数。

## 结构化回答

**30 秒电梯演讲：** 配置、密钥、证书的安全发布核心是敏感数据与代码分离 + 动态注入 + 最小权限 + 全程加密 + 可审计。明文密钥进代码库（硬编码）是头号安全事件根因。正确做法是密钥存专门系统（Vault/KMS），运行时动态注入（环境变量/挂载卷），自动轮换，全程不落盘、不日志、不异常

**展开框架：**
1. **密钥与代码分离** — Vault/KMS/AWS Secrets Manager 集中存储，运行时注入
2. **动态注入** — K8s Secret、环境变量、Sidecar 挂载，不落盘
3. **最小权限** — IAM 按服务授权，密钥访问需审计

**收尾：** 以上是我的整体思路。您想继续深入聊——K8s Secret 安全吗？


## 视频脚本

> 预计时长：1 分 30 秒 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡：配置、密钥与证书的安全发布 | "这题一句话：配置、密钥、证书的安全发布核心是敏感数据与代码分离 + 动态注入 + 最小权限 + 全程加密 + 可审计。" | 开场钩子 |
| 0:15 | 密钥与代码分离示意/对比图 | "Vault/KMS/AWS Secrets Manager 集中存储，运行时注入" | 密钥与代码分离要点 |
| 0:40 | 动态注入示意/对比图 | "K8s Secret、环境变量、Sidecar 挂载，不落盘" | 动态注入要点 |
| 1:25 | 总结卡 | "记住：密钥不进代码库。下期见。" | 收尾 |
