# LangChain VectorStore 集成规范

## ADDED Requirements

### Requirement: 初始化 PGVectorStore 实例

系统 SHALL 在应用启动时初始化一个全局的 PGVectorStore 实例，用于管理向量存储和检索。

#### Scenario: 成功初始化 PGVectorStore

- **WHEN** 应用启动并加载 KnowledgeModule
- **THEN** 系统创建 PGVectorStore 实例，配置连接到现有 Knowledge 表
- **AND** 使用现有的 embedding 字段存储向量
- **AND** 使用现有的 content 字段存储文档内容

#### Scenario: 配置数据库连接参数

- **WHEN** 初始化 PGVectorStore
- **THEN** 系统从环境变量读取数据库连接信息（DATABASE_URL）
- **AND** 设置 tableName 为 "Knowledge"
- **AND** 设置 vectorColumnName 为 "embedding"
- **AND** 设置 contentColumnName 为 "content"

### Requirement: 使用 PGVectorStore 添加文档向量

系统 SHALL 使用 PGVectorStore 的 `addDocuments()` 方法自动处理向量生成和存储，替代原生 SQL 插入。

#### Scenario: 上传文档并生成向量

- **WHEN** 用户上传一个 PDF 文件（例如 10 页）
- **THEN** 系统使用 LangChain TextSplitter 将文档切分为 chunks（例如 15 个 chunks）
- **AND** 系统调用 `vectorStore.addDocuments(chunks)` 自动生成向量并存储
- **AND** 每个 chunk 正确存储到 Knowledge 表的 content 字段
- **AND** 每个 chunk 的向量正确存储到 embedding 字段

#### Scenario: 批量插入优化

- **WHEN** 上传文档产生超过 10 个 chunks
- **THEN** 系统使用 PGVectorStore 的批量插入机制
- **AND** 批量大小设置为 10（BATCH_SIZE），避免 API 限流
- **AND** 所有 chunks 在一个事务中插入

#### Scenario: 保留源文件二进制数据

- **WHEN** 上传文档的第一个 chunk 被存储
- **THEN** 系统在第一个 chunk 的 fileData 字段保存源文件二进制数据
- **AND** 后续 chunks 的 fileData 字段为 null

### Requirement: 使用 PGVectorStore 进行向量检索

系统 SHALL 使用 PGVectorStore 的 `similaritySearchWithScore()` 方法进行向量相似度检索，替代原生 SQL 查询。

#### Scenario: 基本相似度检索

- **WHEN** 用户查询 "如何使用 LangChain？"
- **THEN** 系统调用 `vectorStore.similaritySearchWithScore(query, k=5)`
- **AND** 返回相似度最高的 5 个文档 chunks
- **AND** 每个结果包含文档内容和相似度分数（0-1 之间）

#### Scenario: 用户数据隔离过滤

- **WHEN** 用户 A（userId=1）检索知识库
- **THEN** 系统仅返回 userId=1 的文档 chunks
- **AND** 不返回用户 B（userId=2）的文档 chunks
- **AND** 通过 PGVectorStore 的 filter 参数实现用户隔离

#### Scenario: 设置相似度阈值

- **WHEN** 用户设置最小相似度为 0.3
- **THEN** 系统过滤掉相似度 < 0.3 的文档
- **AND** 仅返回相似度 >= 0.3 的结果

### Requirement: PGVectorStore 与现有数据兼容

系统 SHALL 确保 PGVectorStore 能够正确读取现有的向量数据，无需数据迁移。

#### Scenario: 读取已有向量数据

- **WHEN** 用户查询知识库，且数据库中已有使用原生 SQL 插入的向量数据
- **THEN** 系统使用 PGVectorStore 成功检索到这些文档
- **AND** 相似度计算结果与原有实现一致（误差 < 0.01）

#### Scenario: 混合存储模式

- **WHEN** 数据库中同时存在原生 SQL 插入的旧数据和 PGVectorStore 插入的新数据
- **THEN** 系统同时检索到新旧数据
- **AND** 所有文档的检索质量保持一致

### Requirement: 错误处理和重试

系统 SHALL 在向量生成或存储失败时提供清晰的错误信息和重试机制。

#### Scenario: 向量生成失败

- **WHEN** OpenAI Embeddings API 返回错误（如 API Key 无效）
- **THEN** 系统抛出 BadRequestException，提示 "向量生成失败：API Key 无效"
- **AND** 不插入任何文档到数据库

#### Scenario: 数据库连接失败

- **WHEN** PostgreSQL 连接超时
- **THEN** 系统抛出 ServiceUnavailableException，提示 "数据库连接失败"
- **AND** 记录错误日志，包含连接字符串（密码脱敏）

#### Scenario: 文档大小超限

- **WHEN** 上传的文档切分后产生超过 1000 个 chunks
- **THEN** 系统抛出 BadRequestException，提示 "文档过大，请分批上传"
- **AND** 不插入任何文档

### Requirement: 性能监控

系统 SHALL 收集向量操作的耗时指标，用于性能监控和优化。

#### Scenario: 记录插入耗时

- **WHEN** 使用 PGVectorStore 插入 100 个 chunks
- **THEN** 系统记录总耗时到日志
- **AND** 记录平均每个 chunk 的插入耗时
- **AND** 如果总耗时 > 10 秒，记录警告日志

#### Scenario: 记录检索耗时

- **WHEN** 用户执行知识库检索
- **THEN** 系统记录检索耗时到日志
- **AND** 如果检索耗时 > 500ms，记录警告日志
