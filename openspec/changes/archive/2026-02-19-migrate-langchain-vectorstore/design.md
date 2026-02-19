# 技术设计：迁移到 LangChain VectorStore

## Context

### 当前状态

**知识库模块**（`src/modules/knowledge/knowledge.service.ts`）：
- 使用 Prisma 的 `$queryRaw` 和 `$executeRaw` 执行原生 SQL 操作 pgvector
- 手动实现向量插入（line 241-262）：构造 SQL INSERT 语句，手动处理 vector 类型转换
- 手动实现向量检索（line 347-355）：使用 `<=>` 操作符计算余弦距离
- 手动实现文件解析：PDF、Word、Excel、TXT、MD 等格式
- 实现混合检索：向量检索 + 关键词检索 + RRF 算法融合

**对话模块**（`src/modules/chat/chat.service.ts`）：
- 手动拼接知识库检索结果到 system prompt（line 318-344）
- 使用 OpenAI API 直接对话，未使用 LangChain Chain 抽象

**已安装的依赖**（package.json）：
- ✅ `@langchain/community`: v1.1.1（包含 PGVectorStore）
- ✅ `langchain`: v1.2.3（包含 Chain 抽象）
- ✅ `@langchain/core`: v1.1.8（核心接口）
- ✅ `@langchain/openai`: v1.2.0（OpenAI Embeddings）
- ✅ `@langchain/textsplitters`: v1.0.1（文本切片器）

### 约束条件

1. **数据库兼容性**：必须保持现有 Knowledge 表结构和数据
   - `embedding` 字段：`Unsupported("vector(1536)")`
   - `fileData` 字段：存储源文件二进制数据
   - 现有向量数据不能丢失

2. **API 兼容性**：所有公共接口保持不变
   - 前端代码无需修改
   - 用户无感知迁移

3. **检索质量**：混合检索策略必须保留
   - 向量检索 + 关键词检索
   - RRF 算法融合结果
   - 检索准确性不能降低

### 利益相关者

- **后端开发团队**：需要理解和维护新代码
- **前端团队**：API 兼容性要求
- **用户**：功能稳定性和性能
- **运维团队**：部署和监控

---

## Goals / Non-Goals

### Goals

1. **引入 VectorStore 抽象层**
   - 使用 `PGVectorStore` 替代原生 SQL 操作
   - 提供统一的向量存储和检索接口
   - 为未来迁移到其他向量数据库预留扩展点

2. **实现结构化 RAG 流程**
   - 使用 `createRetrievalChain()` 替代手动拼接上下文
   - 使用 `createStuffDocumentsChain()` 整合检索文档
   - 提升代码可维护性和可测试性

3. **简化文件解析逻辑**
   - 引入 LangChain Document Loaders
   - 减少 200+ 行手动解析代码
   - 提升对新文件格式的扩展能力

4. **保留混合检索策略**
   - 通过自定义 Retriever 实现混合检索
   - 保持 RRF 算法的检索质量
   - 为未来 Reranking 预留接口

### Non-Goals

1. **不修改数据库 schema**
   - 不改变 Knowledge 表结构
   - 不添加新字段或索引

2. **不迁移历史数据**
   - 现有向量数据保持原样
   - 仅迁移代码实现

3. **不改变 API 接口**
   - 不修改请求/响应格式
   - 不添加新端点

4. **不引入 Reranking**（Phase 2 目标）
   - 本次不实现 Reranking 机制
   - 仅预留扩展接口

5. **不支持多模态检索**（Phase 3 目标）
   - 本次仅支持文本检索
   - 图像/音频检索不在范围内

---

## Decisions

### Decision 1: 使用 PGVectorStore 而非自定义实现

**选择**：使用 LangChain 的 `PGVectorStore` + 直接 SQL 混合实现

**原因**：
1. **官方支持**：`@langchain/community` 已包含 PGVectorStore，无需额外依赖
2. **Retriever 接口**：可直接转换为 Retriever，集成到 RetrievalChain
3. **数据库连接管理**：利用 PGVectorStore 的连接池管理
4. **灵活性**：由于现有表无 metadata 列，使用直接 SQL 操作更灵活

**实际实现**：
```typescript
// 初始化 PGVectorStore（主要用于连接池管理）
this.vectorStore = await PGVectorStore.initialize(this.defaultEmbeddings, {
  pool: rawPool as PgPool,
  tableName: this.config.tableName,
  columns: {
    idColumnName: this.config.idColumnName,
    vectorColumnName: this.config.vectorColumnName,
    contentColumnName: this.config.contentColumnName,
    // 不使用 metadata 列，因为我们没有这个字段
  },
});

// 文档插入使用直接 SQL（保留 fileData 逻辑）
await client.query(
  `INSERT INTO "Knowledge" ("userId", "fileName", "content", "preview", "size", "type", "fileData", "embedding", "updatedAt")
   VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, NOW())`,
  [...]

// 检索使用直接 SQL（实现用户隔离过滤）
const result = await client.query(
  `SELECT id, content, 1 - (embedding <=> $1::vector) as similarity
   FROM "Knowledge"
   WHERE "userId" = $2 AND 1 - (embedding <=> $1::vector) >= $3
   ORDER BY embedding <=> $1::vector
   LIMIT $4`,
  [...]
```

**决策说明**：
- 选择了直接 SQL 而非完全依赖 PGVectorStore API，因为：
  - 现有 Knowledge 表无 `metadata` 列
  - 需要保留 `fileData` 字段存储源文件（仅第一个 chunk）
  - 直接 SQL 提供了更好的灵活性和控制

---

### Decision 2: 使用现有的 Knowledge 表而非创建新表

**选择**：直接使用现有 Knowledge 表

**原因**：
1. **数据保留**：现有向量数据无需迁移
2. **向后兼容**：已上传文件继续可用
3. **零停机**：用户无感知迁移

**替代方案**：
- ❌ **创建新表**：需要数据迁移脚本，风险高
- ❌ **使用 collection 模式**：PGVectorStore 默认的 collection 模式会创建新表

**实现策略**：
```typescript
// PGVectorStore 配置使用现有表
const config = {
  tableName: 'Knowledge',  // 直接映射到现有表
  columns: {
    idColumnName: 'id',
    vectorColumnName: 'embedding',
    contentColumnName: 'content',
    // metadata 不映射，使用 filter 替代
  },
};

// 使用 filter 参数实现 userId 过滤
const filter = { userId: { $eq: userId } };
const results = await vectorStore.similaritySearch(query, k, filter);
```

**注意事项**：
- PGVectorStore 的 filter 语法需要适配到现有表结构
- 可能需要自定义 `filter` 转换逻辑（将 LangChain filter 转为 SQL WHERE 条件）

---

### Decision 3: 创建自定义 HybridRetriever 而非仅使用 VectorStoreRetriever

**选择**：实现自定义 `HybridRetriever` 类

**原因**：
1. **保留混合检索**：当前实现的 RRF 算法效果良好，不能丢失
2. **灵活组合**：可自由组合向量检索、关键词检索、未来 Reranking
3. **接口兼容**：实现 `BaseRetriever` 接口，可直接用于 RetrievalChain
4. **可测试性**：独立类更容易单元测试

**替代方案**：
- ❌ **仅使用 VectorStoreRetriever**：丢失关键词检索和 RRF 算法
- ❌ **在 Service 层手动组合**：不符合 RetrievalChain 模式

**实现设计**：
```typescript
// src/modules/knowledge/retrievers/hybrid.retriever.ts
export class HybridRetriever extends BaseRetriever {
  lc_namespace = ['mirror', 'retrievers'];

  constructor(
    private vectorStore: PGVectorStore,
    private userId: number,
    private options: HybridRetrieverOptions = {}
  ) {
    super();
  }

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    // 1. 向量检索
    const vectorResults = await this.vectorRetrieval(query);

    // 2. 关键词检索
    const keywordResults = await this.keywordRetrieval(query);

    // 3. RRF 融合
    const mergedResults = this.mergeWithRRF(
      vectorResults,
      keywordResults
    );

    return mergedResults;
  }

  private async vectorRetrieval(query: string): Promise<...> {
    // 使用 PGVectorStore.similaritySearchWithScore()
    return this.vectorStore.similaritySearchWithScore(
      query,
      this.options.limit * 2,
      { userId: { $eq: this.userId } }
    );
  }

  private async keywordRetrieval(query: string): Promise<...> {
    // 复用现有的 keywordSearch 逻辑
    // 可以优化为使用 Prisma 查询而非原生 SQL
    return this.keywordSearch(query);
  }

  private mergeWithRRF(vectorResults, keywordResults): Document[] {
    // 复用现有的 RRF 算法逻辑（line 618-697）
  }
}
```

**优势**：
- 清晰的职责分离
- 易于添加新的检索策略（如 BM25）
- 为 Reranking 预留扩展点

---

### Decision 4: 使用 RunnableSequence 而非 createRetrievalChain

**选择**：使用 `RunnableSequence` 自定义实现 RAG Chain

**原因**：
1. **灵活性**：RunnableSequence 提供更灵活的控制
2. **流式支持**：`stream()` 方法原生支持，更容易集成 SSE
3. **现代化**：LangChain v0.1+ 推荐使用 Runnable 接口
4. **自定义逻辑**：更容易添加预处理/后处理逻辑

**替代方案**：
- ❌ **createRetrievalChain**：流式支持不如 RunnableSequence 直接
- ❌ **继续手动拼接**：维护性差，易出错

**实际实现**：
```typescript
// src/modules/chat/chains/rag-chain.factory.ts
export class RAGChainFactory {
  static createRAGChain(config: RAGChainConfig): RunnableSequence<RAGChainInput, string> {
    const { llm, retriever, systemPrompt } = config;

    // 1. 定义 prompt template
    const qaPrompt = ChatPromptTemplate.fromTemplate(systemPrompt || this.DEFAULT_SYSTEM_PROMPT);

    // 2. 创建 RunnableSequence
    // 使用 RunnableLambda 准备输入，确保 chat_history 被正确处理
    const prepareInputRunnable = RunnableLambda.from(async (input: RAGChainInput) => {
      // 获取检索结果
      const docs = await retriever.invoke(input.input);
      const context = formatDocumentsAsString(docs);
      const chatMessages = ensureChatHistory(input.chat_history);
      const historyStr = formatChatHistory(chatMessages);

      return {
        input: input.input,
        context,
        chat_history: historyStr ? `## 对话历史\n${historyStr}\n` : "",
      };
    });

    const ragChain = RunnableSequence.from([
      prepareInputRunnable,
      qaPrompt,
      llm,
      new StringOutputParser(),
    ]);

    return ragChain;
  }
}

// 使用示例
const ragChain = RAGChainFactory.createRAGChain({ llm, retriever, systemPrompt });
const stream = await ragChain.stream({
  input: userQuery,
  chat_history: historyMessages,
});

// 流式处理
for await (const chunk of stream) {
  subscriber.next({ data: { content: chunk, ... } });
}
```

**注意事项**：
- `chat_history` 需要从 `StoredMessage[]` 转换为 LangChain 的 `BaseMessage[]`
- 已实现 `ensureChatHistory()` 和 `deserializeMessage()` 处理序列化后的消息
- 使用 `stream()` 方法实现 SSE 流式响应

---

### Decision 5: 分阶段迁移而非一次性重构

**选择**：本变更实现 Phase 1-3，Phase 3 不再是未来变更

**原因**：
1. **降低风险**：每阶段独立实现，问题易定位
2. **渐进式改进**：每阶段都可部署上线
3. **团队学习**：团队逐步熟悉 LangChain 模式

**实际实现阶段**：

**Phase 1: VectorStore 迁移** ✅
- 引入 PGVectorStore
- 创建 VectorStoreService
- 重构 `uploadFile()` 和 `vectorSearch()`
- 保留现有的混合检索逻辑

**Phase 2: Retrieval Chain 集成** ✅
- 实现 HybridRetriever（向量检索 + 关键词检索 + RRF）
- 引入 RunnableSequence
- 重构 `chatStream()` 集成 RAG Chain

**Phase 3: Document Loaders** ✅
- 引入 DocumentLoaderFactory
- 集成 PDFLoader、DocxLoader、TextLoader、CSVLoader
- 实现 Loader 失败降级机制

**未来扩展**（不在本变更范围内）：
- Reranking 机制
- 向量索引优化（HNSW/IVFFlat）
- 缓存机制

---

### Decision 6: 保留关键词检索逻辑而非完全移除

**选择**：保留并优化关键词检索，作为 HybridRetriever 的一部分

**原因**：
1. **检索质量**：关键词检索在某些场景下优于向量检索
2. **RRF 效果**：混合检索的 RRF 融合已被验证有效
3. **用户习惯**：某些用户习惯关键词搜索

**替代方案**：
- ❌ **完全移除关键词检索**：降低检索质量
- ❌ **使用 BM25**：需要引入额外依赖和索引

**优化方向**：
- 将关键词提取逻辑（line 406-604）封装为独立工具类
- 考虑使用 Prisma 查询替代原生 SQL（减少 SQL 注入风险）
- 添加单元测试覆盖

---

## Risks / Trade-offs

### Risk 1: PGVectorStore 与现有数据不兼容

**风险描述**：
PGVectorStore 默认期望 `metadata` 列（JSON 类型），当前 Knowledge 表无此字段，可能导致检索失败或数据插入异常。

**影响等级**：高

**概率**：中

**实际采用的方案**：方案 B（直接 SQL）

**实现细节**：
1. **文档插入**：使用直接 SQL 插入，保留 `fileData` 字段逻辑
   ```typescript
   await client.query(
     `INSERT INTO "Knowledge" ("userId", "fileName", "content", "preview", "size", "type", "fileData", "embedding", "updatedAt")
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, NOW())`,
     [...]
   );
   ```

2. **向量检索**：使用直接 SQL 实现用户隔离
   ```typescript
   const result = await client.query(
     `SELECT id, content, 1 - (embedding <=> $1::vector) as similarity
      FROM "Knowledge"
      WHERE "userId" = $2 AND 1 - (embedding <=> $1::vector) >= $3
      ORDER BY embedding <=> $1::vector
      LIMIT $4`,
     [...]
   );
   ```

3. **PGVectorStore 角色**：主要用于：
   - 数据库连接池管理
   - Embeddings 接口封装
   - 未来可能的完全迁移预留接口

**决策**：采用方案 B，避免数据库 schema 变更，保持向后兼容。

---

### Risk 2: 检索质量下降

**风险描述**：
迁移到 PGVectorStore 后，向量检索的实现细节可能不同，导致检索准确率下降。

**影响等级**：高

**概率**：中

**缓解措施**：
1. **基准测试**：迁移前后对比检索准确率
   - 准备测试数据集（100+ 文档，50+ 查询）
   - 计算召回率、精确率、F1 分数
   - 确保 F1 分数不降低 > 5%

2. **参数调优**：
   - 保持相同的 `chunkSize=1000, chunkOverlap=150`
   - 保持相同的相似度阈值 `minSimilarity=0.3`
   - 调整 PGVectorStore 的距离度量（确保使用余弦距离）

3. **A/B 测试**：
   - 部署后监控用户满意度
   - 准备回滚方案

**回滚策略**：
- 保留原有代码（标记为 deprecated）
- 配置开关：`USE_LANGCHAIN_VECTORSTORE=true/false`
- 24 小时内可快速回滚

---

### Risk 3: 性能回归

**风险描述**：
LangChain VectorStore 可能引入额外开销，导致检索延迟增加。

**影响等级**：中

**概率**：低

**缓解措施**：
1. **性能基准测试**：
   - 测试批量插入 1000 个 chunk 的时间
   - 测试检索 100 次的平均延迟
   - 目标：延迟增加 < 10%

2. **优化策略**：
   - 使用批量插入（`addDocuments` 而非逐个插入）
   - 启用 PGVectorStore 的批量查询优化
   - 监控数据库连接池

3. **生产监控**：
   - 添加性能指标收集
   - 设置告警阈值（P95 延迟 > 500ms）

---

### Risk 4: 流式响应集成复杂

**风险描述**：
`createRetrievalChain` 默认返回完整响应，需要适配现有的 SSE 流式响应机制。

**影响等级**：中

**概率**：高

**实际实现方案**：使用 RunnableSequence 的 `stream()` 方法

**实现细节**：
```typescript
// ChatService 中实现
private async streamRAGChain(...): Promise<{ observable: Observable<ChatSseEvent>; ... }> {
  // 1. 创建 HybridRetriever
  const retriever = await this.knowledgeService.createRetriever(userId, {...});

  // 2. 创建 ChatOpenAI 实例
  const llm = this.createChatOpenAI(apiKey, baseURL, modelName);

  // 3. 创建 RAG Chain
  const ragChain = RAGChainFactory.createCustomRAGChain(llm, retriever, systemPrompt);

  // 4. 使用 stream() 实现流式响应
  const observable = new Observable((subscriber) => {
    void (async () => {
      try {
        const stream = await ragChain.stream({
          input: query,
          chat_history: chatHistory,
        });

        for await (const chunk of stream) {
          if (chunk) {
            fullReplyRef.value += chunk;
            subscriber.next({
              data: {
                content: chunk,
                reasoningContent: "",
                isFinishThinking: true,
                ...
              },
            });
          }
        }
        subscriber.complete();
      } catch (error) {
        subscriber.error(new BadRequestException(`RAG Chain 流式调用失败: ${message}`));
      }
    })();
  });

  return { observable, fullReplyRef, ... };
}
```

**关键决策**：
- 使用 `RunnableSequence` 而非 `createRetrievalChain`，因为其 `stream()` 方法更直接
- LangChain 的 `stream()` 返回 AsyncGenerator，支持 `for await...of` 遍历
- 每个 chunk 直接转换为 SSE 事件推送给前端

---

### Trade-off 1: 依赖 LangChain 生态 vs. 自主控制

**权衡**：
- ✅ **选择依赖 LangChain**：获得社区支持、自动更新、最佳实践
- ❌ **放弃自主控制**：受 LangChain 版本影响，可能需要跟进 breaking changes

**决策依据**：
- 项目已部分使用 LangChain（Embeddings, TextSplitter）
- 团队需要学习成本，但长期收益高
- LangChain 社区活跃，问题可快速解决

---

### Trade-off 2: 保留关键词检索 vs. 仅向量检索

**权衡**：
- ✅ **选择保留**：混合检索质量更高，RRF 算法有效
- ❌ **增加复杂度**：需要维护两套检索逻辑

**决策依据**：
- 当前检索质量已验证良好
- 用户反馈关键词搜索有价值
- HybridRetriever 设计可封装复杂度

---

### Trade-off 3: 完全重构 vs. 渐进迁移

**权衡**：
- ✅ **选择渐进迁移**：风险可控，每阶段可上线
- ❌ **延长周期**：需要 3 个 phase，总体时间更长

**决策依据**：
- 生产系统不能承受大爆炸式重构
- 团队可逐步熟悉新技术
- 每阶段都有价值，投资回报快

---

## Migration Plan

### Phase 1: VectorStore 基础迁移 ✅

**任务列表**：
1. ✅ 创建 `VectorStoreService`（全局服务）
   - 文件: `src/modules/knowledge/vectorstore.service.ts`
   - 初始化 PGVectorStore
   - 配置连接参数（从 DATABASE_URL 解析）
   - 提供 `addDocuments()` 和 `similaritySearch()` 方法

2. ✅ 重构 `KnowledgeService.uploadFile()`
   - 使用 `VectorStoreService.addDocuments()` 替代原生 SQL
   - 保留文件解析逻辑（pdf-parse, mammoth, xlsx）
   - 保留 `fileData` 存储（第一个 chunk）

3. ✅ 重构 `KnowledgeService.vectorSearch()`
   - 使用 `VectorStoreService.similaritySearch()` 替代原生 SQL
   - 实现 userId 过滤（直接 SQL WHERE 子句）

**实现文件**：
- `src/modules/knowledge/vectorstore.service.ts` - VectorStore 服务

**验收标准**：✅
- 文件上传成功，向量正确存储
- 检索返回预期结果
- userId 隔离正确

---

### Phase 2: HybridRetriever 和 Retrieval Chain ✅

**任务列表**：
1. ✅ 创建 `HybridRetriever`
   - 文件: `src/modules/knowledge/retrievers/hybrid.retriever.ts`
   - 实现 `BaseRetriever` 接口
   - 集成向量检索和关键词检索
   - 复用 RRF 算法逻辑

2. ✅ 创建 `RAGChainFactory`
   - 文件: `src/modules/chat/chains/rag-chain.factory.ts`
   - 定义 PromptTemplate
   - 使用 `RunnableSequence` 实现 RAG Chain
   - 支持流式响应

3. ✅ 重构 `ChatService.chatStream()`
   - 集成 RAGChain
   - 处理流式响应转换（LangChain stream → RxJS Observable）
   - 支持对话历史

**实现文件**：
- `src/modules/knowledge/retrievers/hybrid.retriever.ts` - 混合检索器
- `src/modules/chat/chains/rag-chain.factory.ts` - RAG Chain 工厂
- `src/modules/chat/chat.service.ts` - 集成到聊天服务

**验收标准**：✅
- 对话包含知识库上下文
- 流式响应正常工作
- 支持用户隔离

---

### Phase 3: Document Loaders 和优化 ✅

**任务列表**：
1. ✅ 引入 Document Loaders
   - 文件: `src/modules/knowledge/loaders/document-loader.factory.ts`
   - PDFLoader（LangChain）
   - DocxLoader（LangChain）
   - CSVLoader（LangChain）
   - TextLoader（LangChain）

2. ✅ 性能优化
   - 批量插入优化（已实现）
   - 连接池管理

3. ✅ 文档更新
   - 更新 `openspec/project.md` ✅
   - 更新 `CODEBUDDY.md` ✅

**实现文件**：
- `src/modules/knowledge/loaders/document-loader.factory.ts` - Document Loader 工厂
- `src/modules/knowledge/loaders/` - 各类型 Loader

**验收标准**：✅
- 文件解析逻辑使用 LangChain Document Loaders
- 支持降级机制（LangChain Loader 失败时使用原有解析器）

---

### 回滚策略

**触发条件**：
- 检索质量下降 > 10%
- 性能延迟增加 > 20%
- 出现严重 bug 影响用户

**回滚步骤**：
1. 环境变量设置 `USE_LANGCHAIN_VECTORSTORE=false`
2. 重启服务（自动切换到旧实现）
3. 监控错误日志和用户反馈
4. 修复问题后重新部署

**数据安全**：
- 现有向量数据保持不变
- 回滚不影响已上传文件
- 无需数据迁移

---

## Open Questions

### Q1: PGVectorStore 的 metadata 字段如何处理？ ✅ 已解决

**问题**：
PGVectorStore 默认期望 `metadata` 列，但当前 Knowledge 表无此字段。是否需要添加？

**决策**：采用方案 B - 使用直接 SQL

**理由**：
- 无需修改数据库 schema
- 保持向后兼容
- 提供更灵活的控制

**影响**：已实现 - VectorStore 主要用于连接池和_embeddings_ 接口封装

---

### Q2: 如何处理流式响应与 RetrievalChain 的集成？ ✅ 已解决

**问题**：
`createRetrievalChain()` 默认返回完整响应，如何适配现有的 SSE 流式响应？

**决策**：使用 `RunnableSequence.stream()` 方法

**实现**：
- 选用 `RunnableSequence` 而非 `createRetrievalChain`
- LangChain `stream()` 返回 AsyncGenerator
- 使用 `for await...of` 遍历 chunk
- 直接转换为 SSE 事件

**影响**：ChatService 已成功集成流式 RAG Chain

---

### Q3: 是否需要保留原有的原生 SQL 实现作为 fallback？ ✅ 已解决

**问题**：
迁移后是否保留原有代码（标记为 deprecated），以便紧急情况下切换？

**决策**：保留原有代码，标记为 @deprecated

**实现**：
- 原文件解析逻辑保留在 KnowledgeService 中
- 原向量操作代码保留
- 标记 `@deprecated` 注释
- 保留3个月后评估是否删除

**影响**：便于回滚和问题排查

---

### Q4: 关键词检索逻辑是否需要重构？ ✅ 已解决

**问题**：
当前关键词检索使用原生 SQL，存在 SQL 注入风险。是否需要重构？

**决策**：保持现状，封装到 HybridRetriever 中

**实现**：
- 关键词检索逻辑移至 HybridRetriever
- 使用 `escapeSQL()` 转义特殊字符
- 使用参数化查询（$1, $2 等）

**影响**：安全性可控，性能满足需求

---

### Q5: 是否需要引入向量索引优化？ ⏳ 待定

**问题**：
当前 Knowledge 表无向量索引，随着数据增长可能影响性能。是否需要添加 HNSW 或 IVFFlat 索引？

**决策**：暂不添加，监控性能后决定

**待定原因**：
- 当前数据量较小，性能满足需求
- 添加索引需要额外配置和测试
- 可在未来变更中实现

**未来工作**：
- 监控检索延迟
- 根据数据增长情况评估是否需要添加索引

---

## 附录：技术参考

### PGVectorStore API

```typescript
// 初始化
const vectorStore = await PGVectorStore.initialize(embeddings, config);

// 添加文档
await vectorStore.addDocuments([
  { pageContent: "text", metadata: { userId: 1 } }
]);

// 相似度检索
const docs = await vectorStore.similaritySearch(query, k);

// 带分数的检索
const results = await vectorStore.similaritySearchWithScore(query, k);

// 转换为 Retriever
const retriever = vectorStore.asRetriever(k);
```

### RetrievalChain API

```typescript
// 创建 document chain
const combineDocsChain = await createStuffDocumentsChain({
  llm,
  prompt: qaPrompt,
});

// 创建 retrieval chain
const ragChain = await createRetrievalChain({
  retriever,
  combineDocsChain,
});

// 执行
const response = await ragChain.invoke({
  input: "question",
  chat_history: messages,
});
```

### HybridRetriever 设计

```typescript
class HybridRetriever extends BaseRetriever {
  constructor(
    private vectorStore: PGVectorStore,
    private userId: number,
    private options: HybridRetrieverOptions
  ) {
    super();
  }

  async _getRelevantDocuments(query: string): Promise<Document[]> {
    const [vector, keyword] = await Promise.all([
      this.vectorSearch(query),
      this.keywordSearch(query),
    ]);
    return this.mergeWithRRF(vector, keyword);
  }
}
```

---

## 实现摘要

### 已实现的核心组件

| 组件 | 文件路径 | 描述 |
|------|----------|------|
| VectorStoreService | `src/modules/knowledge/vectorstore.service.ts` | 向量存储服务，管理 PGVectorStore 连接和操作 |
| HybridRetriever | `src/modules/knowledge/retrievers/hybrid.retriever.ts` | 混合检索器，结合向量和关键词检索 |
| RAGChainFactory | `src/modules/chat/chains/rag-chain.factory.ts` | RAG Chain 工厂，创建可流式输出的 Chain |
| DocumentLoaderFactory | `src/modules/knowledge/loaders/document-loader.factory.ts` | 文档加载器工厂，统一文件解析入口 |

### 技术决策总结

1. **PGVectorStore 使用方式**：连接池管理 + 直接 SQL 操作
2. **RAG Chain 实现**：RunnableSequence 而非 createRetrievalChain
3. **流式响应**：LangChain stream → RxJS Observable → SSE
4. **Document Loaders**：LangChain Loaders + 降级机制
5. **用户隔离**：SQL WHERE 子句过滤

### 与原设计的差异

| 原设计 | 实际实现 | 原因 |
|--------|----------|------|
| 使用 PGVectorStore addDocuments() | 直接 SQL 插入 | 保留 fileData 字段逻辑 |
| createRetrievalChain | RunnableSequence | 更灵活的流式支持 |
| Phase 3 延期 | 本次实现 | 减少变更次数 |

### 待完成（非本次变更）

- 向量索引优化（HNSW/IVFFlat）
- 缓存机制
- 单元测试和集成测试
- 部署和监控配置

---

**文档版本**：1.1
**更新日期**：2026-02-19
**作者**：AI Assistant
**审核状态**：已完成实现
