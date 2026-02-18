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

**选择**：使用 LangChain 的 `PGVectorStore`

**原因**：
1. **官方支持**：`@langchain/community` 已包含 PGVectorStore，无需额外依赖
2. **自动管理**：自动处理向量类型转换、批量插入、错误重试
3. **Retriever 接口**：可直接转换为 Retriever，集成到 RetrievalChain
4. **社区验证**：已在生产环境广泛使用，稳定可靠

**替代方案**：
- ❌ **继续使用原生 SQL**：维护成本高，缺少抽象层
- ❌ **自定义 VectorStore 子类**：重复造轮子，维护负担重
- ❌ **使用其他 VectorStore**（Pinecone/Weaviate）：需要迁移数据，成本高

**实现细节**：
```typescript
// 初始化 PGVectorStore
const vectorStore = await PGVectorStore.initialize(
  embeddings,
  {
    postgresConnectionOptions: {
      type: 'postgres',
      host: 'localhost',
      port: 5432,
      database: 'mirror',
      user: 'user',
      password: 'password',
    },
    tableName: 'Knowledge',        // 使用现有表
    columns: {
      idColumnName: 'id',
      vectorColumnName: 'embedding',
      contentColumnName: 'content',
      metadataColumnName: 'metadata', // 需要添加（可选）
    },
  }
);

// 添加文档
await vectorStore.addDocuments(splitDocs);

// 检索
const results = await vectorStore.similaritySearch(query, k, filter);
```

**风险**：
- PGVectorStore 默认期望 `metadata` 列（JSON 类型），当前表无此字段
- **解决方案**：在 Prisma schema 中添加可选的 `metadata Json?` 字段，或使用 filter 参数传递 userId

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

### Decision 4: 使用 createRetrievalChain 而非手动拼接上下文

**选择**：使用 `createRetrievalChain()` + `createStuffDocumentsChain()`

**原因**：
1. **标准化流程**：LangChain 推荐的 RAG 模式
2. **自动管理**：自动处理文档拼接、token 限制、错误处理
3. **Prompt 管理**：使用 PromptTemplate，便于维护和版本控制
4. **可观测性**：集成 LangChain callbacks，便于调试和监控

**替代方案**：
- ❌ **继续手动拼接**：维护性差，易出错
- ❌ **使用废弃的 RetrievalQAChain**：已被标记为 deprecated

**实现设计**：
```typescript
// src/modules/chat/chains/rag.chain.ts
export class RAGChainFactory {
  static async createRAGChain(
    llm: ChatOpenAI,
    retriever: HybridRetriever
  ) {
    // 1. 定义 prompt template
    const qaPrompt = ChatPromptTemplate.fromMessages([
      ['system', `你是 Mirror 智能助手。
      
根据以下参考资料回答用户问题。如果资料不足以回答，请根据你的知识补充。

参考资料：
{context}

请优先使用参考资料中的信息回答。`],
      new MessagesPlaceholder('chat_history'),
      ['human', '{input}'],
    ]);

    // 2. 创建 document chain
    const combineDocsChain = await createStuffDocumentsChain({
      llm,
      prompt: qaPrompt,
    });

    // 3. 创建 retrieval chain
    const ragChain = await createRetrievalChain({
      retriever,
      combineDocsChain,
    });

    return ragChain;
  }
}

// 使用示例
const ragChain = await RAGChainFactory.createRAGChain(llm, retriever);
const response = await ragChain.invoke({
  input: userQuery,
  chat_history: historyMessages,
});
```

**注意事项**：
- `chat_history` 需要从 `StoredMessage[]` 转换为 LangChain 的 `BaseMessage[]`
- 需要处理流式响应（SSE）

---

### Decision 5: 分阶段迁移而非一次性重构

**选择**：分 3 个阶段迁移

**原因**：
1. **降低风险**：每阶段独立测试，问题易定位
2. **渐进式改进**：每阶段都可部署上线
3. **团队学习**：团队逐步熟悉 LangChain 模式

**阶段划分**：

**Phase 1: VectorStore 迁移**（本变更）
- 引入 PGVectorStore
- 重构 `uploadFile()` 和 `vectorSearch()`
- 保留现有的混合检索逻辑
- **测试重点**：向量插入和检索准确性

**Phase 2: Retrieval Chain 集成**（本变更）
- 实现 HybridRetriever
- 引入 createRetrievalChain
- 重构 `chatStream()`
- **测试重点**：RAG 流程和检索质量

**Phase 3: Document Loaders 和 Reranking**（未来变更）
- 引入 Document Loaders
- 添加 Reranking 机制
- **测试重点**：文件解析和检索排序

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

**缓解措施**：
1. **方案 A（推荐）**：在 Prisma schema 添加可选字段
   ```prisma
   model Knowledge {
     // ... existing fields
     metadata Json? // 新增字段，允许为空
   }
   ```
   - 优点：完全兼容 PGVectorStore，未来可扩展
   - 缺点：需要数据库迁移

2. **方案 B**：自定义 filter 转换逻辑
   - 将 `userId` 等过滤条件硬编码到 SQL WHERE 子句
   - 不使用 PGVectorStore 的 filter 参数
   - 优点：无需 schema 变更
   - 缺点：需要额外开发，可能不稳定

3. **方案 C**：创建 `PGVectorStore` 子类，重写 SQL 生成逻辑
   - 完全控制向量操作
   - 优点：最大灵活性
   - 缺点：维护成本高

**决策**：优先尝试方案 B（filter 转换），如不可行则采用方案 A。

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

**缓解措施**：
1. **调研方案**：
   - LangChain 的 `stream()` 方法支持流式输出
   - 需要将 LangChain stream 转换为 RxJS Observable

2. **实现示例**：
   ```typescript
   const ragChain = await createRetrievalChain({...});
   const stream = await ragChain.stream({
     input: query,
     chat_history: history,
   });

   // 转换为 RxJS Observable
   return new Observable((subscriber) => {
     stream.on('data', (chunk) => {
       subscriber.next(chunk);
     });
     stream.on('end', () => {
       subscriber.complete();
     });
     stream.on('error', (err) => {
       subscriber.error(err);
     });
   });
   ```

3. **备选方案**：
   - 如流式集成复杂，可暂时保留 OpenAI API 直接调用
   - 仅使用 RetrievalChain 的检索部分，不使用对话部分

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

### Phase 1: VectorStore 基础迁移（预计 3 天）

**任务列表**：
1. ✅ 创建 `VectorStoreService`（全局服务）
   - 初始化 PGVectorStore
   - 配置连接参数（从环境变量读取）
   - 提供全局访问接口

2. ✅ 重构 `KnowledgeService.uploadFile()`
   - 替换原生 SQL 为 `vectorStore.addDocuments()`
   - 保留文件解析逻辑（Phase 3 再迁移到 Document Loaders）
   - 保留 `fileData` 存储（第一个 chunk）

3. ✅ 重构 `KnowledgeService.vectorSearch()`
   - 替换原生 SQL 为 `vectorStore.similaritySearchWithScore()`
   - 实现 userId 过滤（通过 filter 参数或自定义逻辑）

4. ✅ 单元测试
   - 测试文档插入
   - 测试向量检索
   - 测试用户隔离（userId 过滤）

**验收标准**：
- 文件上传成功，向量正确存储
- 检索返回预期结果
- userId 隔离正确（用户 A 不能检索到用户 B 的数据）

---

### Phase 2: HybridRetriever 和 Retrieval Chain（预计 4 天）

**任务列表**：
1. ✅ 创建 `HybridRetriever`
   - 实现 `BaseRetriever` 接口
   - 集成向量检索和关键词检索
   - 复用 RRF 算法逻辑

2. ✅ 创建 `RAGChainFactory`
   - 定义 PromptTemplate
   - 使用 `createStuffDocumentsChain()`
   - 使用 `createRetrievalChain()`

3. ✅ 重构 `ChatService.chatStream()`
   - 替换手动拼接上下文（line 318-344）
   - 集成 RAGChain
   - 处理流式响应转换

4. ✅ 集成测试
   - 测试完整 RAG 流程
   - 测试流式响应
   - 测试检索质量（对比迁移前后）

**验收标准**：
- 对话包含知识库上下文
- 检索质量不降低（F1 分数差异 < 5%）
- 流式响应正常工作

---

### Phase 3: Document Loaders 和优化（预计 2 天，可选）

**任务列表**：
1. 引入 Document Loaders
   - PDFLoader（替换 pdf-parse）
   - DocxLoader（替换 mammoth）
   - CSVLoader（用于 Excel）
   - TextLoader（TXT, MD）

2. 性能优化
   - 批量插入优化
   - 缓存机制
   - 连接池调优

3. 文档更新
   - 更新 `openspec/project.md`
   - 更新 `CODEBUDDY.md`

**验收标准**：
- 文件解析逻辑简化 > 50%
- 性能无回归

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

### Q1: PGVectorStore 的 metadata 字段如何处理？

**问题**：
PGVectorStore 默认期望 `metadata` 列，但当前 Knowledge 表无此字段。是否需要添加？

**选项**：
- A. 添加 `metadata Json?` 字段（需要数据库迁移）
- B. 自定义 filter 转换逻辑（无需 schema 变更）
- C. 创建 PGVectorStore 子类（高维护成本）

**决策时间**：Phase 1 开始时评估

**影响**：影响 VectorStore 初始化和检索过滤逻辑

---

### Q2: 如何处理流式响应与 RetrievalChain 的集成？

**问题**：
`createRetrievalChain()` 默认返回完整响应，如何适配现有的 SSE 流式响应？

**选项**：
- A. 使用 `ragChain.stream()` 方法（需验证 LangChain 支持）
- B. 仅使用 RetrievalChain 的检索部分，对话部分继续用 OpenAI API
- C. 放弃 RetrievalChain，仅使用 HybridRetriever

**决策时间**：Phase 2 实现时验证

**影响**：影响 ChatService 的重构方案

---

### Q3: 是否需要保留原有的原生 SQL 实现作为 fallback？

**问题**：
迁移后是否保留原有代码（标记为 deprecated），以便紧急情况下切换？

**选项**：
- A. 保留 3 个月，配置开关控制（推荐）
- B. 完全删除旧代码（代码库更清爽）
- C. 保留 6 个月（更保守）

**决策时间**：Phase 1 完成后评估

**影响**：影响代码维护成本和回滚能力

---

### Q4: 关键词检索逻辑是否需要重构？

**问题**：
当前关键词检索使用原生 SQL（line 389-397），存在 SQL 注入风险（虽然有 `escapeSQL()`）。是否需要重构？

**选项**：
- A. 保持现状，仅封装为 Retriever（风险可控）
- B. 使用 Prisma 查询重写（更安全，但性能可能下降）
- C. 引入 BM25 或 Elasticsearch（Phase 3）

**决策时间**：Phase 2 实现时评估

**影响**：影响安全性和性能

---

### Q5: 是否需要引入向量索引优化？

**问题**：
当前 Knowledge 表无向量索引，随着数据增长可能影响性能。是否需要添加 HNSW 或 IVFFlat 索引？

**背景**：
- PGVectorStore 支持自动创建索引
- 但需要额外配置和存储空间

**选项**：
- A. 本次迁移暂不添加，监控性能后决定（推荐）
- B. 添加 HNSW 索引（高性能，高内存）
- C. 添加 IVFFlat 索引（中等性能，低内存）

**决策时间**：Phase 1 完成后，根据性能测试结果决定

**影响**：影响检索性能和数据库资源

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

**文档版本**：1.0  
**创建日期**：2026-02-18  
**作者**：AI Assistant  
**审核状态**：待审核
