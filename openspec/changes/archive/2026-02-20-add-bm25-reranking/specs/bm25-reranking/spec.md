# BM25 Reranking

## Overview

BM25 重排序能力，为知识库检索提供基于词频的文档相关性评分，与向量检索形成互补。

## ADDED Requirements

### Requirement: BM25 索引管理

系统 SHALL 支持为用户的知识库文档构建和管理 BM25 索引。

#### Scenario: 用户首次检索时自动创建 BM25 索引
- **WHEN** 用户发起知识库检索请求且该用户没有 BM25 索引
- **THEN** 系统 SHALL 自动扫描该用户的所有知识库文档并构建 BM25 索引

#### Scenario: 用户上传新文档后更新索引
- **WHEN** 用户上传新的知识库文档
- **THEN** 系统 SHALL 将新文档内容增量添加到 BM25 索引中

#### Scenario: 用户删除文档后更新索引
- **WHEN** 用户删除知识库文档
- **THEN** 系统 SHALL 从 BM25 索引中移除对应文档

### Requirement: BM25 重排序

系统 SHALL 使用 BM25 算法对初步检索结果进行重排序，提升结果相关性。

#### Scenario: 对混合检索结果进行 BM25 重排序
- **WHEN** 知识库检索返回初步结果后
- **THEN** 系统 SHALL 使用 BM25 算法计算每个文档与查询词的相关性得分
- **AND** SHALL 根据 BM25 得分调整结果排序

#### Scenario: BM25 与向量分数融合
- **WHEN** 启用 BM25 重排序时
- **THEN** 系统 SHALL 将向量检索得分（权重 0.7）与 BM25 得分（权重 0.3）进行加权融合
- **AND** SHALL 返回融合后的最终排序结果

### Requirement: BM25 配置选项

系统 SHALL 提供可配置的 BM25 重排序参数。

#### Scenario: 用户可配置重排序开关
- **WHEN** 用户在知识库设置中配置重排序功能
- **THEN** 系统 SHALL 允许用户启用或禁用 BM25 重排序

#### Scenario: 用户可配置 BM25 权重
- **WHEN** 用户配置重排序参数
- **THEN** 系统 SHALL 允许用户调整 BM25 在融合得分中的权重（默认 0.3）

### Requirement: 与现有 HybridRetriever 兼容

BM25 重排序 SHALL 与项目现有的自定义混合检索器（HybridRetriever）兼容。

#### Scenario: HybridRetriever 使用 BM25 重排序
- **WHEN** HybridRetriever 执行检索时启用 BM25 重排序
- **THEN** 系统 SHALL 在完成向量和关键词初筛后调用 BM25 重排序模块
- **AND** SHALL 返回重排序后的最终结果

#### Scenario: 保留向后兼容性
- **WHEN** 用户不启用 BM25 重排序
- **THEN** 系统 SHALL 使用原有的 RRF 融合排序方式，保持现有行为不变
