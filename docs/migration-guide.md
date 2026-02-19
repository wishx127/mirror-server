# LangChain VectorStore 迁移指南

## 概述

本文档说明从原有实现迁移到 LangChain VectorStore 方案的技术变更etails。

## 架构变更

### 新增组件

| 组件 | 路径 | 描述 |
|------|------|------|
| VectorStoreService | `src/modules/knowledge/vectorstore.service.ts` | 向量存储服务 |
| HybridRetriever | `src/modules/knowledge/retrievers/hybrid.retriever.ts` | 混合检索器 |
| RAGChainFactory | `src/modules/chat/chains/rag-chain.factory.ts` | RAG Chain 工厂 |
| DocumentLoaderFactory | `src/modules/knowledge/loaders/document-loader.factory.ts` | 文档加载器工厂 |

## 实现差异

### 1. 向量存储实现

**原有实现**：
- 使用 Prisma `$queryRaw` 和 `$executeRaw` 执行原生 SQL
- 手动构造 SQL INSERT 语句处理 vector 类型转换
- 手动实现向量检索（`<=>` 操作符计算余弦距离）

**新实现**：
- 使用直接 SQL（放弃 PGVectorStore 方法）
- 原因：现有 Knowledge 表无 metadata 列，PGVectorStore API 不兼容
- PGVectorStore 仅用于 Embeddings 接口封装

```typescript
// 文档插入 - 直接 SQL
await client.query(
  `INSERT INTO "Knowledge" ("userId", "fileName", "content", "preview", "size", "type", "fileData", "embedding", "updatedAt")
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, NOW())`,
  [userId, fileName, content, preview, size, type, fileData, embedding]
);

// 向量检索 - 直接 SQL + 用户隔离
const result = await client.query(
  `SELECT id, "fileName", content, preview, "fileData",
     1 - (embedding <=> $1::vector) as similarity
   FROM "Knowledge"
   WHERE "userId" = $2 AND 1 - (embedding <=> $1::vector) >= $3
   ORDER BY embedding <=> $1::vector
   LIMIT $4`,
  [embedding, userId, minSimilarity, limit]
);
```

### 2. RAG Chain 实现

**原有实现**：
- 手动拼接知识库检索结果到 system prompt
- 使用 OpenAI API 直接对话

**新实现**：
- 使用 `RunnableSequence` 而非 `createRetrievalChain`
- 原因：`stream()` 方法原生支持，更容易集成 SSE

```typescript
// 创建 RAG Chain
const ragChain = RunnableSequence.from([
  prepareInputRunnable,  // 检索 + 格式化上下文
  qaPrompt,              // Prompt 模板
  llm,                   // ChatOpenAI
  new StringOutputParser(),
]);

// 流式输出
const stream = await ragChain.stream({
  input: userQuery,
  chat_history: historyMessages,
});
```

### 3. 混合检索策略

**保留**：
- 向量检索 + 关键词检索
- RRF (Reciprocal Rank Fusion) 算法融合
- 权重配置：vectorWeight=0.7, keywordWeight=0.3

**封装**：
- 移至 `HybridRetriever` 类
- 实现 `BaseRetriever` 接口
- 可直接用于 LangChain Chain

### 4. 文档加载器

**原有实现**：
- 手动实现文件解析（pdf-parse, mammoth, xlsx 等库）
- 约 200+ 行解析代码

**新实现**：
- 引入 LangChain Document Loaders
- PDFLoader, DocxLoader, CSVLoader, TextLoader
- 保留降级机制（LangChain Loader 失败时使用原有解析器）

```typescript
// DocumentLoaderFactory 使用示例
const loader = DocumentLoaderFactory.createLoader(filePath, fileExtension);
const docs = await loader.load();
```

## 配置开关

迁移后可通过环境变量控制功能：

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `USE_LANGCHAIN_VECTORSTORE` | 启用 LangChain VectorStore | `true` |

## 向后兼容性

- 所有公共 API 接口保持不变
- 前端代码无需修改
- 用户无感知迁移
- 现有向量数据保持不变

## 已废弃代码

以下代码已标记 `@deprecated`，计划 3 个月后评估是否删除：

- `KnowledgeService` 中的手动向量插入逻辑（line 241-262）
- `KnowledgeService` 中的手动向量检索逻辑（line 347-355）
- 原有文件解析逻辑（line 140-177）

## 回滚方案

如需回滚到原有实现：

1. 设置环境变量：`USE_LANGCHAIN_VECTORSTORE=false`
2. 重启服务
3. 无需数据迁移

---

**文档版本**：1.0
**更新日期**：2026-02-19
