# 迁移知识库向量存储到 LangChain VectorStore

## Why

当前项目使用 PostgreSQL 原生 SQL 直接操作 pgvector 向量数据库，虽然功能完整，但存在以下问题：

1. **缺少抽象层**：直接使用 Prisma 的 `$queryRaw` 和 `$executeRaw` 操作向量，代码耦合度高，难以维护和迁移到其他向量数据库
2. **未遵循 LangChain 最佳实践**：手动实现向量存储和检索逻辑，未使用 LangChain 提供的 VectorStore 抽象和 RetrievalChain，错失框架提供的优化和扩展能力
3. **手动拼接上下文**：在 ChatService 中手动将检索结果拼接到 system prompt，缺乏结构化的 RAG 流程管理
4. **重复造轮子**：手动实现文件解析、关键词提取、混合检索等逻辑，而 LangChain 已提供成熟的 Document Loaders、Text Splitters 和检索器组件

**为什么现在做**：
- LangChain 生态日趋成熟，PGVectorStore 和相关组件已稳定可用
- 当前实现已暴露维护性问题（如 line 241-262 的手动向量插入、line 347-355 的原生 SQL 查询）
- 为未来引入 Reranking、多模态检索、以及迁移到其他向量数据库（如 Pinecone、Weaviate）打下基础

## What Changes

### 核心变更

1. **引入 LangChain PGVectorStore**
   - 替换原生的 PostgreSQL 向量操作（`$queryRaw`, `$executeRaw`）
   - 使用 `PGVectorStore.fromDocuments()` 自动处理向量存储
   - 使用 `vectorStore.similaritySearch()` 替代手动向量检索

2. **引入 LangChain Retrieval Chain**
   - 使用 `createRetrievalChain()` 替代手动拼接知识库上下文到 system prompt
   - 使用 `createStuffDocumentsChain()` 自动整合检索文档到对话流程
   - 保留当前的混合检索策略（向量 + 关键词 + RRF），但通过 LangChain Retriever 接口实现

3. **引入 LangChain Document Loaders**
   - 替换手动文件解析逻辑（PDF, Word, Excel, TXT, MD）
   - 使用 `PDFLoader`, `DocxLoader`, `CSVLoader`, `TextLoader`, `UnstructuredLoader` 等
   - 简化代码，提升可维护性

4. **优化检索流程**
   - 保留混合检索（向量 + 关键词）和 RRF 算法
   - 通过自定义 Retriever 实现混合检索逻辑
   - 为未来引入 Reranking 机制预留扩展点

### 非功能变更

- 数据库表结构保持不变（Knowledge 表继续使用 pgvector）
- API 接口保持不变（前端无需改动）
- 用户数据和向量数据无需迁移

### **BREAKING** 变更

- **内部实现重构**：KnowledgeService 和 ChatService 的内部实现将大幅重构，但保持公共 API 不变
- **依赖变更**：新增 `@langchain/community` 依赖（可能已部分安装）

## Capabilities

### New Capabilities

- `langchain-vectorstore`: LangChain VectorStore 集成，使用 PGVectorStore 管理向量存储和检索
- `langchain-retrieval-chain`: LangChain Retrieval Chain 实现，自动化 RAG 流程
- `langchain-document-loaders`: LangChain Document Loaders 集成，替换手动文件解析逻辑
- `hybrid-retriever`: 自定义混合检索器，结合向量检索和关键词检索，使用 RRF 算法融合结果

### Modified Capabilities

> 无。当前 `openspec/specs/` 为空，所有 capabilities 均为新增。

## Impact

### 受影响的代码模块

1. **`src/modules/knowledge/knowledge.service.ts`**（核心重构）
   - `uploadFile()`: 使用 Document Loaders 和 PGVectorStore.fromDocuments()
   - `search()`: 使用自定义 HybridRetriever 或 VectorStoreRetriever
   - `vectorSearch()`: 迁移到 PGVectorStore.similaritySearch()
   - `keywordSearch()`: 封装为独立的 Retriever 组件
   - 删除手动向量操作代码（line 241-262, 347-355）

2. **`src/modules/chat/chat.service.ts`**（中度重构）
   - `chatStream()`: 使用 createRetrievalChain() 替代手动拼接知识库上下文（line 318-344）
   - 引入 LangChain Chain 和 Prompt Template

3. **`src/modules/knowledge/knowledge.module.ts`**（小改动）
   - 初始化 PGVectorStore 实例
   - 配置 VectorStore 为全局可注入服务

### 受影响的依赖

**新增依赖**：
- `@langchain/community`: 包含 PGVectorStore、各种 Document Loaders
- 可能需要：`pdf-parse`（已有）、`mammoth`（已有）、`xlsx`（已有）

**依赖版本**：
- 现有 LangChain 依赖：
  - `@langchain/openai`: 已安装（OpenAIEmbeddings）
  - `@langchain/textsplitters`: 已安装（RecursiveCharacterTextSplitter）
  - `langchain`: 未安装（核心包，包含 Chain 抽象）

### 数据库影响

- **无 schema 变更**：继续使用现有 Knowledge 表和 pgvector 扩展
- **无数据迁移**：现有向量数据可被 PGVectorStore 直接读取（需验证兼容性）

### API 接口影响

- **无破坏性变更**：所有公共 API 保持不变
- 前端无需修改
- 知识库功能对用户透明

### 性能影响

**预期改进**：
- LangChain VectorStore 内部优化（批量插入、索引管理）
- 更好的错误处理和重试机制
- 为未来引入 Reranking 提供基础

**潜在风险**：
- 初次集成可能有性能调优需求
- 需验证 PGVectorStore 与现有数据的兼容性

### 测试影响

- 需要更新 `knowledge.service.spec.ts` 单元测试
- 需要更新知识库相关的 E2E 测试
- 需要测试迁移后的向量检索准确性

### 文档影响

- 需要更新 `openspec/project.md` 中的知识库架构说明（line 187-276）
- 需要更新 `CODEBUDDY.md` 中的已知问题部分（line 258-276）
