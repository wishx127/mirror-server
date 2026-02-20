## Why

当前项目的 RAG 系统缺少重排序（Reranking）机制，导致检索结果的相关性不够理想。虽然已实现向量检索 + 关键词检索的混合检索（Hybrid Retrieval），但缺乏对初步检索结果进行二次排序的能力。引入 BM25 算法作为重排序机制，可以显著提升搜索结果的相关性和准确率。

## What Changes

1. 引入 BM25 重排序功能 - 使用 elasticlunr 库实现 BM25 算法
2. 创建可配置的 BM25 索引管理器 - 支持增量索引更新和缓存
3. 集成 BM25 重排序到现有混合检索流程 - 与现有 HybridRetriever 兼容
4. 支持检索结果的多阶段排序 - 初筛（向量+关键词）→ 重排序（BM25）

## Capabilities

### New Capabilities
- `bm25-reranking`: BM25 重排序能力，提供基于词频的文档相关性评分，与向量检索形成互补

### Modified Capabilities
- `hybrid-retrieval`: 扩展现有混合检索能力，集成 BM25 重排序阶段

## Impact

- **新增依赖**: `elasticlunr` 库
- **核心模块影响**: `src/modules/knowledge/` - 知识检索模块
- **检索器影响**: `HybridRetriever` - 需要兼容新的重排序机制
- **数据库变更**: 无（BM25 索引存储在内存中）
- **API 变更**: 知识检索 API 保持兼容，仅调整内部排序逻辑
