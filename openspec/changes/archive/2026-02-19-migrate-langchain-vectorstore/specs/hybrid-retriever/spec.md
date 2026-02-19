# 自定义混合检索器规范

## ADDED Requirements

### Requirement: 实现 BaseRetriever 接口

系统 SHALL 创建 HybridRetriever 类，实现 LangChain 的 BaseRetriever 接口，使其可集成到 RetrievalChain。

#### Scenario: 类定义和继承

- **WHEN** 创建 HybridRetriever
- **THEN** 类继承自 LangChain 的 BaseRetriever
- **AND** 实现 `_getRelevantDocuments(query: string): Promise<Document[]>` 方法
- **AND** 设置 `lc_namespace = ['mirror', 'retrievers']`

#### Scenario: 构造函数参数

- **WHEN** 实例化 HybridRetriever
- **THEN** 构造函数接收以下参数：
  - `vectorStore: PGVectorStore` - 向量存储实例
  - `userId: number` - 用户 ID，用于数据隔离
  - `options?: HybridRetrieverOptions` - 可选配置项
- **AND** 调用 `super()` 初始化父类

#### Scenario: 配置选项

- **WHEN** 传递 HybridRetrieverOptions
- **THEN** 支持以下配置：
  - `limit: number` - 返回结果数量（默认 5）
  - `minSimilarity: number` - 最小相似度阈值（默认 0.3）
  - `rrfK: number` - RRF 算法参数 k（默认 60）
  - `vectorWeight: number` - 向量检索权重（默认 0.7）
  - `keywordWeight: number` - 关键词检索权重（默认 0.3）

### Requirement: 执行向量检索

系统 SHALL 在 HybridRetriever 中调用 PGVectorStore 执行向量相似度检索。

#### Scenario: 向量检索基本流程

- **WHEN** 调用 `_getRelevantDocuments(query)`
- **THEN** 系统首先执行向量检索：
  1. 调用 `vectorStore.similaritySearchWithScore(query, limit * 2)`
  2. 传递 filter 参数过滤 userId
  3. 过滤掉相似度 < minSimilarity 的结果
- **AND** 返回带分数的检索结果

#### Scenario: 用户数据隔离

- **WHEN** 执行向量检索
- **THEN** 构造 filter 对象：`{ userId: { $eq: this.userId } }`
- **AND** 将 filter 传递给 similaritySearchWithScore
- **AND** 确保不检索其他用户的数据

#### Scenario: 处理向量检索失败

- **WHEN** 向量检索抛出异常（如数据库连接失败）
- **THEN** 记录错误日志
- **AND** 向量检索结果为空数组
- **AND** 继续执行关键词检索（降级策略）

### Requirement: 执行关键词检索

系统 SHALL 在 HybridRetriever 中复用现有的关键词检索逻辑。

#### Scenario: 关键词提取

- **WHEN** 执行关键词检索
- **THEN** 调用 `extractKeywords(query)` 提取关键词
- **AND** 使用 N-gram 方法提取中文词组（2-4 字）
- **AND** 使用正则提取英文单词
- **AND** 过滤停用词（中英文）
- **AND** 最多返回 10 个关键词

#### Scenario: 关键词匹配

- **WHEN** 提取到关键词
- **THEN** 构建动态 SQL 条件，使用 ILIKE 匹配
- **AND** 计算每个文档匹配的关键词数量
- **AND** 按匹配数量降序排序
- **AND** 限制返回结果为 `limit * 2`

#### Scenario: 用户数据隔离

- **WHEN** 执行关键词检索
- **THEN** SQL WHERE 子句包含 `userId = this.userId`
- **AND** 确保不检索其他用户的数据

#### Scenario: 关键词提取失败

- **WHEN** 提取的关键词为空（如查询全是停用词）
- **THEN** 返回空数组
- **AND** 记录警告日志
- **AND** 不影响向量检索结果

### Requirement: 使用 RRF 算法融合结果

系统 SHALL 使用 RRF (Reciprocal Rank Fusion) 算法融合向量和关键词检索结果。

#### Scenario: RRF 基本算法

- **WHEN** 获得向量检索结果和关键词检索结果
- **THEN** 对每个文档计算 RRF 分数：
  - `score = Σ (weight_i / (k + rank_i))`
  - k = rrfK (默认 60)
  - rank_i = 文档在第 i 个检索列表中的排名（从 1 开始）
  - weight_vector = vectorWeight (默认 0.7)
  - weight_keyword = keywordWeight (默认 0.3)
- **AND** 按 RRF 分数降序排序
- **AND** 返回前 `limit` 个文档

#### Scenario: 文档去重

- **WHEN** 同一文档同时出现在向量和关键词检索结果中
- **THEN** 使用文档 ID 作为唯一标识
- **AND** 合并两个检索列表的 RRF 分数
- **AND** 文档仅出现一次在最终结果中

#### Scenario: 仅向量检索结果

- **WHEN** 关键词检索返回空结果
- **THEN** 仅使用向量检索结果
- **AND** 按 RRF 分数排序（仅向量部分）
- **AND** 返回向量检索的前 `limit` 个文档

#### Scenario: 仅关键词检索结果

- **WHEN** 向量检索返回空结果
- **THEN** 仅使用关键词检索结果
- **AND** 按 RRF 分数排序（仅关键词部分）
- **AND** 返回关键词检索的前 `limit` 个文档

### Requirement: 保留现有 RRF 实现

系统 SHALL 复用现有的 RRF 算法逻辑（knowledge.service.ts line 618-697），而非重新实现。

#### Scenario: 提取 RRF 逻辑为独立方法

- **WHEN** 重构 HybridRetriever
- **THEN** 将现有的 `mergeResultsWithRRF()` 方法移至 HybridRetriever 类
- **AND** 保持算法逻辑完全一致
- **AND** 保持参数签名一致

#### Scenario: 单元测试覆盖

- **WHEN** 迁移 RRF 逻辑
- **THEN** 添加单元测试验证：
  - 文档去重正确性
  - RRF 分数计算正确性
  - 权重分配正确性
  - 边界情况（空结果、单结果）

### Requirement: 异常处理

系统 SHALL 在混合检索过程中妥善处理异常。

#### Scenario: 两个检索都失败

- **WHEN** 向量检索和关键词检索都抛出异常
- **THEN** 抛出 InternalServerErrorException
- **AND** 提示 "知识库检索失败"
- **AND** 记录详细错误日志（包含两个异常信息）

#### Scenario: 部分检索失败

- **WHEN** 向量检索失败，关键词检索成功
- **THEN** 使用关键词检索结果继续处理
- **AND** 记录警告日志："向量检索失败，使用关键词检索降级"
- **AND** 不影响用户体验

### Requirement: 性能优化

系统 SHALL 优化混合检索性能，确保响应时间合理。

#### Scenario: 并行执行检索

- **WHEN** 调用 `_getRelevantDocuments(query)`
- **THEN** 使用 `Promise.all()` 并行执行向量检索和关键词检索
- **AND** 总耗时约等于单个检索的耗时（而非两者之和）

#### Scenario: 限制检索数量

- **WHEN** 执行单个检索（向量或关键词）
- **THEN** 限制返回结果为 `limit * 2`
- **AND** 避免检索过多数据导致性能下降

#### Scenario: 记录检索耗时

- **WHEN** 混合检索完成
- **THEN** 记录以下指标到日志：
  - 向量检索耗时
  - 关键词检索耗时
  - RRF 融合耗时
  - 总耗时
- **AND** 如果总耗时 > 500ms，记录警告日志

### Requirement: 日志和可观测性

系统 SHALL 提供详细的日志记录，便于调试和监控。

#### Scenario: 记录检索详情

- **WHEN** 混合检索完成
- **THEN** 记录以下信息：
  - 查询内容
  - 提取的关键词
  - 向量检索结果数量
  - 关键词检索结果数量
  - 最终返回结果数量
  - 每个 top-3 结果的文件名和分数

#### Scenario: 记录性能指标

- **WHEN** 启用调试模式
- **THEN** 记录每个步骤的耗时明细
- **AND** 记录数据库查询语句（关键词检索部分）

### Requirement: 可配置权重

系统 SHALL 允许动态调整向量和关键词检索的权重。

#### Scenario: 使用默认权重

- **WHEN** 不传递 options 参数
- **THEN** 使用默认权重：vectorWeight=0.7, keywordWeight=0.3
- **AND** RRF 分数计算使用默认权重

#### Scenario: 自定义权重

- **WHEN** 传递 `options: { vectorWeight: 0.8, keywordWeight: 0.2 }`
- **THEN** 使用自定义权重计算 RRF 分数
- **AND** 向量检索结果权重更高

#### Scenario: 权重验证

- **WHEN** 传递 `vectorWeight: 0.6, keywordWeight: 0.6`（总和不为 1）
- **THEN** 系统接受权重配置
- **AND** RRF 算法不要求权重总和为 1
- **AND** 记录警告日志："权重总和不为 1，建议调整"

### Requirement: 单元测试覆盖

系统 SHALL 为 HybridRetriever 提供完整的单元测试。

#### Scenario: 测试向量检索

- **WHEN** 运行单元测试
- **THEN** 验证向量检索返回正确结果
- **AND** 验证用户隔离正确
- **AND** 验证相似度阈值过滤正确

#### Scenario: 测试关键词检索

- **WHEN** 运行单元测试
- **THEN** 验证关键词提取正确
- **AND** 验证 SQL 构建正确
- **AND** 验证用户隔离正确

#### Scenario: 测试 RRF 融合

- **WHEN** 运行单元测试
- **THEN** 验证文档去重正确
- **AND** 验证 RRF 分数计算正确
- **AND** 验证权重分配正确

#### Scenario: 测试边界情况

- **WHEN** 运行单元测试
- **THEN** 验证以下边界情况：
  - 空查询
  - 空结果
  - 单结果
  - 全部结果相似度 < minSimilarity
  - 全部关键词为停用词

### Requirement: 集成测试

系统 SHALL 提供 HybridRetriever 与 RetrievalChain 的集成测试。

#### Scenario: 端到端检索流程

- **WHEN** 运行集成测试
- **THEN** 验证完整的 RAG 流程：
  1. 上传文档到知识库
  2. 创建 HybridRetriever
  3. 创建 RetrievalChain
  4. 执行查询
  5. 验证返回结果包含检索到的文档
- **AND** 确保与前端 API 兼容
