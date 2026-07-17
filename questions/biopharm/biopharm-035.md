---
id: biopharm-035
difficulty: L3
category: biopharm
subcategory: 向量数据库
tags:
- 生物医药
- AI 全栈
- PGVector
- PostgreSQL
- 向量数据库
- OLTP
- 一体化
feynman:
  essence: "PostgreSQL+PGVector 是'把向量检索和业务事务合二为一'——一个库同时做 OLTP（增删改查）和向量检索，事务一致、权限统一、运维简单，中小规模 RAG 的甜点选型。"
  analogy: "像把图书馆和办公室合在一起——书（向量）和业务档案（业务表）在同一个柜子，借书（检索）和办公（事务）原子完成，不用跑两个地方对账。FAISS/Milvus 是单独的图书馆，要和办公室对账。"
  first_principle: "向量检索常需与业务元数据（权限/版本/标签）联合查询并保持一致。PGVector 的本质是'把向量作为一种数据类型集成进 PostgreSQL'，让向量检索和业务事务在同一数据库原子完成，省去多库对账的复杂度。"
  key_points:
  - "PGVector 是 PG 扩展，向量作为列类型，SQL 直接检索"
  - "一体化优势：事务一致、权限统一、join 业务表、运维复用"
  - "索引：HNSW（推荐）/ IVFFlat，百万级千万级可用"
  - "适合：中小规模、强一致、多表联合、已有 PG 运维"
  - "局限：超大规模（亿级）性能不如专用向量库"
  socratic:
  - "知识库文档向量要和权限表（谁能看）一起查，PGVector 和 Milvus 谁方便？"
  - "向量插入和业务元数据更新，怎么保证一致？"
  - "PGVector 能扛多少向量？什么时候该换 Milvus？"
  - "为什么中小药企知识库推荐 PGVector？"
  - "PGVector 的 HNSW 索引怎么建、怎么调？"
first_principle:
  problem: "如何在中小规模场景下，让向量检索和业务事务一体化、一致、简单？"
  axioms:
  - "向量检索常需联合业务元数据"
  - "多库分离带来一致性和运维复杂度"
  - "中小规模不需要专用向量库的复杂性"
  rebuild: "用 PGVector 把向量作为 PG 列类型，向量检索和业务事务同库原子完成，HNSW 索引支撑千万级，事务/权限/join 统一，省去多库对账，是中小规模 RAG 甜点。"
follow_up:
- "HNSW 索引怎么建？——CREATE INDEX ... USING hnsw (vec vector_cosine_ops) WITH (m=16, ef_construction=64)；查询设 ef_search 调召回。"
- "PGVector 性能极限？——千万级内好，更大要调参+分区+读写分离；亿级建议上专用向量库。"
- "权限怎么落到检索？——向量表带 tenant_id/dept/role/sensitivity 列，检索 WHERE 预过滤，PG 的强项。"
memory_points:
- "PGVector：向量作 PG 列，SQL 检索"
- "一体化：事务一致+权限统一+join"
- "HNSW 索引，千万级可用"
- "中小规模甜点，亿级换 Milvus"
---

# 【生物医药 AI】PostgreSQL + PGVector 实战怎么做（OLTP+向量一体化）？

> JD 依据："PGVector；MySQL/PostgreSQL；向量数据库选型。"

## 一、PGVector 是什么

```
PGVector = PostgreSQL 扩展
  向量作为一种列类型（vector(1536)）
  支持 ANN 索引（HNSW / IVFFlat）
  用 SQL 直接做向量检索

→ 一个 PG 库同时做：
  - OLTP（业务增删改查、事务、权限）
  - 向量检索（RAG）
```

## 二、一体化优势（核心价值）

### 1. 事务一致
```sql
-- 文档元数据更新 + 向量更新，原子提交
BEGIN;
  UPDATE docs SET status='published', version='2.0' WHERE id=1;
  UPDATE doc_chunks SET embedding='...' WHERE doc_id=1;
COMMIT;
-- 要么都成功，要么都失败，永远一致
```
FAISS/Milvus + 业务库分离时，两边一致性要自己保证（难）。

### 2. 权限与联合查询
```sql
-- 向量检索 + 权限过滤 + 业务 join，一条 SQL
SELECT c.content, d.title, d.version
FROM doc_chunks c
JOIN docs d ON c.doc_id = d.id
WHERE d.tenant_id = $1             -- 权限
  AND d.status = 'published'       -- 状态
  AND c.sensitivity <= $user_level -- 敏感级
ORDER BY c.embedding <=> $query_vec  -- 向量相似（余弦距离）
LIMIT 5;
```
- 向量检索和元数据过滤原子完成，预过滤无损失。

### 3. 运维统一
- 复用现有 PG 运维能力（备份/监控/主从/扩展）。
- 不用多养一套向量库。

## 三、实战用法

### 1. 建表
```sql
CREATE EXTENSION vector;

CREATE TABLE doc_chunks (
  id BIGSERIAL PRIMARY KEY,
  doc_id BIGINT,
  content TEXT,
  embedding vector(1536),       -- 向量列
  tenant_id INT, dept INT, role VARCHAR,
  sensitivity INT, version VARCHAR,
  created_at TIMESTAMP
);
```

### 2. 建索引（HNSW 推荐）
```sql
CREATE INDEX ON doc_chunks
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```
- `m`：邻居数（大→召回高/内存大）。
- `ef_construction`：建索引候选（大→质量好/慢）。
- 查询时设 `ef_search`（大→召回高/慢）。

### 3. 检索
```sql
-- 带权限过滤的向量检索
SELECT content, embedding <=> $query_vec AS distance
FROM doc_chunks
WHERE tenant_id = $1
  AND sensitivity <= $2
ORDER BY embedding <=> $query_vec
LIMIT 5;
```
`<=>` 是余弦距离，`<->` 是 L2，`<#>` 是负内积。

### 4. 结合业务
```sql
-- 检索 + join 文档元数据 + 引用信息
SELECT c.content, d.title, d.version, d.source_url
FROM doc_chunks c
JOIN docs d ON c.doc_id = d.id
WHERE c.tenant_id = $1
ORDER BY c.embedding <=> $query_vec
LIMIT 5;
```

## 四、规模与性能

| 规模 | PGVector 表现 |
|------|---------------|
| 百万级 | 优秀，毫秒级 |
| 千万级 | 良好，调参+索引 |
| 亿级 | 吃力，建议专用向量库 |

### 优化手段
- **HNSW 调参**：m/ef_construction/ef_search。
- **分区**：按 tenant 或时间分区缩小扫描。
- **读写分离**：写主读从。
- **过滤下推**：检索前过滤（WHERE），避免后过滤不足 k。
- **量化**：PG 0.7+ 支持 halfvec（半精度，省一半空间）。

## 五、医药场景的适用性

```
中小药企知识库（药品说明书/文献/SOP，百万~千万级）：
  ✅ 一体化（事务+权限+检索）
  ✅ 行级权限（GLIMIT 安全）
  ✅ 多表 join（文档+版本+权限）
  ✅ 运维简单（复用 DBA）
  → 推荐 PGVector

亿级文献库 / 超大规模：
  → Milvus（规模）+ PG（业务）组合
```

## 六、PGVector vs 专用向量库

| 维度 | PGVector | Milvus |
|------|----------|--------|
| 一致性 | 强（事务） | 最终一致 |
| 联合查询 | 强（SQL join） | 弱（需拼装） |
| 规模 | 千万级 | 亿级 |
| 运维 | 复用 PG | 独立复杂 |
| 适合 | 中小+强一致 | 海量+高吞吐 |

**选型**：中小规模/强一致/已有 PG 选 PGVector；海量/高 QPS 选 Milvus（见006）。

## 七、底层本质

PGVector 本质是**"把向量检索集成进 PostgreSQL，让 OLTP 和向量检索一体化"**。事务一致、权限统一、SQL 联合、运维复用，是中小规模 RAG 的甜点选型。

**很多团队一上来就选 Milvus 是过度设计** —— 中小知识库用 PGVector 更简单、更一致、更省运维，这是工程上的最优解。

## 常见考点

1. **PGVector 和 Milvus 怎么选？**——中小（千万内）/强一致/多表联合/已有 PG 选 PGVector；海量（亿级）/高 QPS/分布式选 Milvus；按规模和一致需求定。
2. **怎么提 PGVector 检索性能？**——建 HNSW 索引+调参（m/ef）、查询过滤下推（WHERE 预过滤）、分区、读写分离、halfvec 量化。
3. **权限怎么落到检索？**——向量表带 tenant/dept/role/sensitivity 列，检索 WHERE 预过滤，PG 行级安全（RLS）可强制，比专用向量库方便。


## 结构化回答

**30 秒电梯演讲：** 聊到PostgreSQL + PGVector 实战怎么做，我的理解是——PostgreSQL+PGVector 是'把向量检索和业务事务合二为一'——一个库同时做 OLTP（增删改查）和向量检索，事务一致、权限统一、运维简单，中小规模 RAG 的甜点选型。打个比方，像把图书馆和办公室合在一起——书（向量）和业务档案（业务表）在同一个柜子，借书（检索）和办公（事务）原子完成，不用跑两个地方对账。FAISS/Milvus 是单独的图书馆，要和办公室对账。

**展开框架：**
1. **PGVector 是 PG 扩展** — PGVector 是 PG 扩展，向量作为列类型，SQL 直接检索
2. **一体化优势** — 事务一致、权限统一、join 业务表、运维复用
3. **索引** — HNSW（推荐）/ IVFFlat，百万级千万级可用

**收尾：** 这块我在项目里也踩过坑——想深入的话，可以接着聊：HNSW 索引怎么建？您更想看哪个方向？

## 视频脚本

> 预计时长：3 分钟 | 由浅入深

| 时间 | 画面/字幕 | 口播台词 | 讲解要点 |
|------|----------|----------|----------|
| 0:00 | 标题卡 | "PostgreSQL + PGVector 实战怎么做——这道题面试官到底想考什么？我用 30 秒给你讲透。" | 开场钩子 |
| 0:15 | 向量检索流程图 | 先说核心：PostgreSQL+PGVector 是'把向量检索和业务事务合二为一'——一个库同时做 OLTP（增删改查）和向量检索，事务一致、权限统一、运维简单，中小规模 RAG 的甜。 | 核心定义 |
| 0:40 | SQL EXPLAIN 截图 | 事务一致、权限统一、join 业务表、运维复用。 | 一体化优势 |
| 1:05 | B+ 树索引结构图 | HNSW（推荐）/ IVFFlat，百万级千万级可用。 | 索引 |
| 2:30 | 总结卡 | 一句话记忆：PGVector：向量作 PG 列，SQL 检索。 下期可以接着聊：HNSW 索引怎么建。 | 收尾总结 |
