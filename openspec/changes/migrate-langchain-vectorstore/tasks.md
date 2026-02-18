# 实现任务清单

## 1. 环境准备和依赖配置

- [x] 1.1 验证 LangChain 依赖版本兼容性
  - 检查 @langchain/community@1.1.1
  - 检查 langchain@1.2.3
  - 检查 @langchain/core@1.1.8
  - 检查 @langchain/openai@1.2.0
  - 检查 @langchain/textsplitters@1.0.1

- [x] 1.2 安装 PGVectorStore 相关类型定义（如有需要）

- [x] 1.3 配置 TypeScript 编译选项（确保 LangChain 类型正确）

## 2. Phase 1: VectorStore 基础迁移

### 2.1 创建 VectorStore 服务

- [x] 2.1.1 创建 VectorStoreService 类
  - 文件路径: `src/modules/knowledge/vectorstore.service.ts`
  - 注入 PrismaService 和 ConfigService
  - 初始化 PGVectorStore 实例

- [x] 2.1.2 配置 PGVectorStore 连接参数
  - 从 DATABASE_URL 解析连接信息
  - 设置 tableName: 'Knowledge'
  - 设置 vectorColumnName: 'embedding'
  - 设置 contentColumnName: 'content'

- [x] 2.1.3 实现 VectorStore 初始化方法
  - `async initialize(): Promise<PGVectorStore>`
  - 使用 OpenAIEmbeddings（现有配置）
  - 处理初始化异常

- [x] 2.1.4 在 KnowledgeModule 中注册 VectorStoreService
  - 添加到 providers
  - 设置为全局可注入（optional）

### 2.2 重构文档上传逻辑

- [x] 2.2.1 创建 VectorStore 文档插入辅助方法
  - 将 splitDocs 转换为 LangChain Document 格式
  - 附加 metadata（fileName, userId, fileSize 等）

- [x] 2.2.2 重构 KnowledgeService.uploadFile() - 使用 VectorStore
  - 替换 line 241-262 的原生 SQL 插入
  - 调用 `vectorStore.addDocuments(splitDocs)`
  - 保留 fileData 存储逻辑（第一个 chunk）

- [x] 2.2.3 实现批量插入优化
  - 分批调用 addDocuments（BATCH_SIZE=10）
  - 使用事务包装批量插入
  - 记录插入耗时日志

- [ ] 2.2.4 测试文档上传功能
  - 上传 PDF 文件验证
  - 上传 Word 文件验证
  - 上传 Excel 文件验证
  - 检查数据库记录正确性

### 2.3 重构向量检索逻辑

- [x] 2.3.1 实现 VectorStore 相似度检索方法
  - 调用 `vectorStore.similaritySearchWithScore(query, k, filter)`
  - 实现用户隔离 filter 逻辑

- [x] 2.3.2 重构 KnowledgeService.vectorSearch()
  - 替换 line 347-355 的原生 SQL 查询
  - 使用 VectorStore.similaritySearchWithScore()
  - 计算相似度（1 - distance）

- [x] 2.3.3 实现相似度阈值过滤
  - 过滤掉相似度 < minSimilarity 的结果
  - 返回格式化为 VectorSearchResult 类型

- [ ] 2.3.4 测试向量检索功能
  - 测试基本相似度检索
  - 测试用户数据隔离
  - 测试相似度阈值过滤
  - 对比新旧实现检索质量

### 2.4 数据兼容性验证

- [ ] 2.4.1 测试 PGVectorStore 读取现有数据
  - 使用已有向量数据执行检索
  - 验证相似度计算一致性（误差 < 0.01）

- [ ] 2.4.2 测试新旧数据混合检索
  - 插入新数据（使用 VectorStore）
  - 检索新旧混合数据
  - 验证检索质量一致

- [ ] 2.4.3 编写 Phase 1 单元测试
  - VectorStoreService 初始化测试
  - 文档插入测试
  - 向量检索测试
  - 用户隔离测试

## 3. Phase 2: HybridRetriever + Retrieval Chain

### 3.1 创建 HybridRetriever

- [x] 3.1.1 创建 HybridRetriever 类
  - 文件路径: `src/modules/knowledge/retrievers/hybrid.retriever.ts`
  - 继承 BaseRetriever
  - 实现 lc_namespace

- [x] 3.1.2 定义 HybridRetrieverOptions 接口
  - limit: number
  - minSimilarity: number
  - rrfK: number
  - vectorWeight: number
  - keywordWeight: number

- [x] 3.1.3 实现构造函数
  - 接收 vectorStore, userId, options 参数
  - 设置默认配置值

- [x] 3.1.4 实现 _getRelevantDocuments() 方法框架
  - 调用并行检索（Promise.all）
  - 调用 RRF 融合
  - 返回 Document 数组

### 3.2 实现向量检索部分

- [x] 3.2.1 移植向量检索逻辑到 HybridRetriever
  - 从 VectorStoreService 调用 similaritySearchWithScore
  - 实现 userId 过滤
  - 处理检索异常（返回空数组）

- [x] 3.2.2 实现向量检索结果格式化
  - 转换为统一格式
  - 提取相似度分数

### 3.3 实现关键词检索部分

- [x] 3.3.1 提取关键词提取逻辑为独立工具类
  - 文件路径: `src/modules/knowledge/utils/keyword-extractor.ts`
  - 移植 extractKeywords() 方法（line 406-604）

- [x] 3.3.2 优化关键词提取逻辑
  - 添加停用词配置
  - 添加 N-gram 配置
  - 添加单元测试

- [x] 3.3.3 实现关键词检索方法
  - 移植 keywordSearch() 逻辑（line 364-400）
  - 使用 Prisma 查询替代原生 SQL（可选）
  - 实现 userId 过滤

- [x] 3.3.4 实现关键词检索结果格式化
  - 转换为统一格式
  - 提取匹配数量

### 3.4 实现 RRF 融合算法

- [x] 3.4.1 移植 RRF 算法逻辑
  - 移植 mergeResultsWithRRF() 方法（line 618-697）
  - 保持算法逻辑完全一致

- [x] 3.4.2 实现文档去重逻辑
  - 使用 Map 以文档 ID 为键
  - 合并向量检索和关键词检索结果

- [x] 3.4.3 实现 RRF 分数计算
  - 计算向量检索分数（weight_vector / (k + rank)）
  - 计算关键词检索分数（weight_keyword / (k + rank)）
  - 合并为最终分数

- [x] 3.4.4 实现结果排序和限制
  - 按混合分数降序排序
  - 返回前 limit 个文档

### 3.5 创建 RAG Chain 工厂

- [x] 3.5.1 创建 RAGChainFactory 类
  - 文件路径: `src/modules/chat/chains/rag-chain.factory.ts`

- [x] 3.5.2 定义 RAG Prompt Template
  - 使用 ChatPromptTemplate.fromMessages()
  - 包含系统角色、上下文、历史、输入占位符
  - 支持多语言（中文）

- [x] 3.5.3 实现 createStuffDocumentsChain()
  - 调用 LangChain 的 createStuffDocumentsChain()
  - 传入 ChatOpenAI 和 prompt
  - 处理空检索结果场景

- [x] 3.5.4 实现 createRetrievalChain()
  - 调用 LangChain 的 createRetrievalChain()
  - 传入 HybridRetriever 和 combineDocsChain

### 3.6 集成到 ChatService

- [x] 3.6.1 创建消息格式转换工具
  - 文件路径: `src/modules/chat/utils/message-converter.ts`
  - 实现 StoredMessage[] → BaseMessage[] 转换
  - 提取文本内容（忽略图片/文件）

- [x] 3.6.2 重构 ChatService.chatStream() - 集成 RetrievalChain
  - 创建 HybridRetriever 实例（传入 userId, options）
  - 创建 RAGChain（传入 llm, retriever）
  - 替换 line 318-344 的手动拼接逻辑

- [x] 3.6.3 实现流式响应转换
  - 调用 ragChain.stream()
  - 转换 LangChain stream 为 RxJS Observable
  - 保留 SSE 事件格式

- [x] 3.6.4 实现思维链内容提取
  - 从流式输出中提取 reasoning_content
  - 转换为 "thinking" 类型事件
  - 推送给前端

### 3.7 测试和验证

- [ ] 3.7.1 编写 HybridRetriever 单元测试
  - 测试向量检索
  - 测试关键词检索
  - 测试 RRF 融合
  - 测试边界情况（空结果、单结果）

- [ ] 3.7.2 编写 RAGChain 集成测试
  - 测试端到端 RAG 流程
  - 测试对话历史管理
  - 测试流式响应

- [ ] 3.7.3 检索质量对比测试
  - 准备测试数据集（50+ 查询）
  - 对比新旧实现检索准确率
  - 确保 F1 分数差异 < 5%

- [ ] 3.7.4 性能测试
  - 测试检索延迟（目标 < 500ms）
  - 测试流式响应首字延迟
  - 记录性能指标日志

## 4. Phase 3: Document Loaders 和优化（可选）

### 4.1 引入 Document Loaders

- [x] 4.1.1 创建 DocumentLoaderFactory 类
  - 文件路径: `src/modules/knowledge/loaders/document-loader.factory.ts`
  - 根据文件扩展名返回对应 Loader

- [x] 4.1.2 集成 PDFLoader
  - 导入 @langchain/community/pdf_loader
  - 替换 pdf-parse 库
  - 处理扫描版 PDF 异常

- [x] 4.1.3 集成 DocxLoader
  - 导入 @langchain/community/docx_loader
  - 替换 mammoth 库（保留作为降级方案）
  - 测试 .doc 和 .docx 解析

- [x] 4.1.4 集成 CSVLoader（用于 Excel）
  - 使用 xlsx 库转换为 CSV
  - 使用 @langchain/community/csv_loader
  - 处理多工作表场景

- [x] 4.1.5 集成 TextLoader
  - 导入 @langchain/community/text_loader
  - 支持 .txt 和 .md 文件
  - 处理不同编码（UTF-8, GBK）

- [x] 4.1.6 重构 KnowledgeService.uploadFile() - 使用 Document Loaders
  - 替换手动文件解析逻辑（line 140-177）
  - 调用 DocumentLoaderFactory
  - 保留元数据附加逻辑

### 4.2 错误处理和降级

- [x] 4.2.1 实现 Loader 失败降级机制
  - PDFLoader 失败 → 使用 pdf-parse
  - DocxLoader 失败 → 使用 mammoth/word-extractor

- [x] 4.2.2 添加详细的错误日志
  - 记录 Loader 切换事件
  - 记录文件名和失败原因
  - 用于问题排查

### 4.3 性能优化

- [x] 4.3.1 实现批量插入优化
  - 调整 BATCH_SIZE（根据性能测试结果）
  - 使用 PGVectorStore 的批量插入 API
  - 添加插入进度日志

- [ ] 4.3.2 实现向量索引优化（可选）
  - 评估是否需要 HNSW 或 IVFFlat 索引
  - 创建索引 SQL 脚本
  - 测试索引对检索性能的影响

- [ ] 4.3.3 添加缓存机制（可选）
  - 缓存热门查询的检索结果
  - 设置缓存 TTL（如 5 分钟）
  - 实现 LRU 缓存淘汰策略

### 4.4 清理旧代码

- [x] 4.4.1 标记旧代码为 @deprecated
  - 标记 line 140-177（文件解析）
  - 标记 line 241-262（手动向量插入）
  - 标记 line 347-355（手动向量检索）
  - 添加迁移说明注释

- [ ] 4.4.2 更新相关测试用例
  - 移除旧实现的测试
  - 添加新实现的测试
  - 确保测试覆盖率不降低

- [ ] 4.4.3 3个月后删除旧代码（待定）
  - 验证新实现稳定性
  - 删除 @deprecated 代码
  - 更新文档

## 5. 文档更新

- [x] 5.1 更新 openspec/project.md
  - 更新知识库架构说明（line 187-276）
  - 添加 LangChain VectorStore 使用说明
  - 添加 HybridRetriever 设计说明

- [x] 5.2 更新 CODEBUDDY.md
  - 移除已知问题部分（line 258-276）
  - 添加新的技术栈说明（PGVectorStore）
  - 更新性能优化建议

- [x] 5.3 添加 API 文档注释
  - 为 VectorStoreService 添加 JSDoc
  - 为 HybridRetriever 添加 JSDoc
  - 为 RAGChainFactory 添加 JSDoc

- [ ] 5.4 编写迁移指南
  - 创建 `docs/migration-guide.md`
  - 说明新旧实现差异
  - 提供配置开关说明（USE_LANGCHAIN_VECTORSTORE）

## 6. 测试和验收

- [ ] 6.1 单元测试
  - VectorStoreService 测试覆盖率 > 80%
  - HybridRetriever 测试覆盖率 > 80%
  - RAGChainFactory 测试覆盖率 > 70%
  - DocumentLoaderFactory 测试覆盖率 > 70%

- [ ] 6.2 集成测试
  - 完整 RAG 流程测试
  - 多用户并发测试
  - 文件上传和检索端到端测试

- [ ] 6.3 性能测试
  - 文档上传性能基准
  - 检索延迟基准
  - 流式响应延迟基准
  - 对比新旧实现性能

- [ ] 6.4 回归测试
  - 运行现有 E2E 测试
  - 确保 API 兼容性
  - 确保前端功能正常

- [ ] 6.5 用户验收测试
  - 准备测试场景和测试用例
  - 验证检索质量不降低
  - 验证用户体验无影响

## 7. 部署和监控

- [ ] 7.1 准备部署配置
  - 更新 docker-compose.yml（如有需要）
  - 更新环境变量配置
  - 添加配置开关（USE_LANGCHAIN_VECTORSTORE）

- [ ] 7.2 准备回滚方案
  - 编写回滚脚本
  - 验证配置开关有效性
  - 准备紧急回滚文档

- [ ] 7.3 配置监控和告警
  - 添加向量操作耗时监控
  - 添加检索延迟监控
  - 添加错误率监控
  - 配置告警阈值

- [ ] 7.4 灰度发布计划
  - 先在测试环境验证
  - 部署到预生产环境
  - 逐步灰度到生产环境（10% → 50% → 100%）
  - 监控用户反馈和错误日志

- [ ] 7.5 生产环境验证
  - 验证文档上传功能
  - 验证检索功能
  - 验证对话功能
  - 验证性能指标

---

**总任务数**: 112 个任务
**预计总工时**: 9-11 天（Phase 1: 3天, Phase 2: 4天, Phase 3: 2天, 其他: 2天）
**关键路径**: 1 → 2 → 3 → 6 → 7
