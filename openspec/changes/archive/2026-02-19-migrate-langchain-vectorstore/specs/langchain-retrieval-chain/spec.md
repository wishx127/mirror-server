# LangChain Retrieval Chain 实现规范

## ADDED Requirements

### Requirement: 创建 RAG Prompt Template

系统 SHALL 使用 LangChain 的 ChatPromptTemplate 定义 RAG 流程的提示词模板。

#### Scenario: 定义系统提示词模板

- **WHEN** 创建 RAG Chain
- **THEN** 系统定义 ChatPromptTemplate，包含以下部分：
  - 系统角色定义："你是 Mirror 智能助手"
  - 参考资料说明："根据以下参考资料回答用户问题"
  - 动态上下文占位符：`{context}`
  - 对话历史占位符：`{chat_history}`
  - 用户输入占位符：`{input}`

#### Scenario: 多语言提示词支持

- **WHEN** 用户使用中文提问
- **THEN** 系统使用中文提示词模板
- **AND** 参考资料标题显示为"参考资料"
- **AND** 回答要求使用中文描述

### Requirement: 创建 StuffDocumentsChain

系统 SHALL 使用 `createStuffDocumentsChain()` 创建文档整合链，自动将检索到的文档整合到 prompt 中。

#### Scenario: 整合多个文档到 prompt

- **WHEN** 检索到 3 个相关文档 chunks
- **THEN** 系统调用 `createStuffDocumentsChain({ llm, prompt })`
- **AND** 自动将 3 个文档格式化为：
  ```
  参考资料：
  ### 文档 1
  <chunk 1 content>
  
  ### 文档 2
  <chunk 2 content>
  
  ### 文档 3
  <chunk 3 content>
  ```
- **AND** 将格式化后的文档插入到 prompt 的 `{context}` 占位符

#### Scenario: 处理空检索结果

- **WHEN** 检索结果为空（没有相关文档）
- **THEN** 系统将 `{context}` 替换为 "暂无相关参考资料"
- **AND** LLM 根据自身知识回答问题

### Requirement: 创建 RetrievalChain

系统 SHALL 使用 `createRetrievalChain()` 创建检索链，自动执行检索和对话流程。

#### Scenario: 完整 RAG 流程

- **WHEN** 用户提问 "如何使用 LangChain？"
- **THEN** 系统执行以下步骤：
  1. 调用 `retriever.getRelevantDocuments(query)` 检索文档
  2. 将检索到的文档传递给 `combineDocsChain`
  3. 格式化 prompt 并调用 LLM
  4. 返回 LLM 的回答
- **AND** 整个流程在 RetrievalChain 内部自动完成

#### Scenario: 包含对话历史

- **WHEN** 用户进行多轮对话
- **THEN** 系统将历史对话作为 `chat_history` 参数传递给 RetrievalChain
- **AND** LLM 可以基于历史上下文回答问题
- **AND** 历史对话格式为 LangChain 的 `BaseMessage[]` 类型

### Requirement: 流式响应支持

系统 SHALL 将 RetrievalChain 的流式输出转换为 SSE (Server-Sent Events) 格式，保持与现有前端兼容。

#### Scenario: 转换 LangChain stream 为 RxJS Observable

- **WHEN** RetrievalChain 执行流式输出
- **THEN** 系统将 LangChain 的 stream 转换为 RxJS Observable
- **AND** 每个 chunk 作为独立事件推送给前端
- **AND** 事件格式为 SSE：`data: { "type": "content", "data": "文本片段" }`

#### Scenario: 流式输出思维链内容

- **WHEN** LLM 生成思维链（reasoning_content）
- **THEN** 系统将思维链内容作为独立事件推送
- **AND** 事件类型为 `"type": "thinking"`
- **AND** 前端可以实时显示思维过程

#### Scenario: 流式输出完成通知

- **WHEN** RetrievalChain 流式输出完成
- **THEN** 系统发送 `[DONE]` 事件通知前端
- **AND** 关闭 SSE 连接

### Requirement: 集成 HybridRetriever

系统 SHALL 将自定义的 HybridRetriever 作为 RetrievalChain 的检索器，而非使用默认的 VectorStoreRetriever。

#### Scenario: 使用 HybridRetriever 检索

- **WHEN** 创建 RetrievalChain
- **THEN** 系统传入 HybridRetriever 实例
- **AND** RetrievalChain 调用 HybridRetriever 的 `_getRelevantDocuments()` 方法
- **AND** 自动执行混合检索（向量 + 关键词 + RRF）

#### Scenario: 传递检索参数

- **WHEN** 用户设置 topK=5, minSimilarity=0.3
- **THEN** 系统将参数传递给 HybridRetriever
- **AND** HybridRetriever 根据参数执行检索
- **AND** 返回最多 5 个相似度 >= 0.3 的文档

### Requirement: 错误处理

系统 SHALL 在 RetrievalChain 执行失败时提供清晰的错误信息。

#### Scenario: LLM API 调用失败

- **WHEN** LLM API 返回错误（如 rate limit exceeded）
- **THEN** 系统抛出 ServiceUnavailableException
- **AND** 提示 "AI 服务暂时不可用，请稍后重试"
- **AND** 记录详细错误日志

#### Scenario: 检索失败

- **WHEN** HybridRetriever 抛出异常
- **THEN** RetrievalChain 捕获异常并抛出 InternalServerErrorException
- **AND** 提示 "知识库检索失败"
- **AND** 不调用 LLM

### Requirement: 对话历史管理

系统 SHALL 将现有的 `StoredMessage[]` 格式转换为 LangChain 的 `BaseMessage[]` 格式。

#### Scenario: 转换消息格式

- **WHEN** 从数据库读取对话历史（StoredMessage[]）
- **THEN** 系统将每个 StoredMessage 转换为 BaseMessage：
  - role="user" → HumanMessage
  - role="assistant" → AIMessage
  - role="system" → SystemMessage
- **AND** 提取 StoredMessage.content 中的文本内容

#### Scenario: 处理多模态内容

- **WHEN** StoredMessage 包含图片或文件
- **THEN** 系统仅提取文本部分转换为 BaseMessage
- **AND** 忽略图片和文件内容（多模态检索在 Phase 3）

### Requirement: 保留上下文拼接逻辑的语义

系统 SHALL 确保新的 RetrievalChain 实现与原有手动拼接上下文的语义一致。

#### Scenario: 验证上下文拼接效果

- **WHEN** 用户提问并启用知识库
- **THEN** 新实现返回的答案与旧实现（line 318-344）语义一致
- **AND** 检索到的文档正确整合到 prompt
- **AND** LLM 根据文档内容回答问题

#### Scenario: 回答质量对比

- **WHEN** 使用相同的测试数据集（50+ 查询）
- **THEN** 新实现的回答质量（人工评分）不低于旧实现
- **AND** 准确率差异 < 5%
