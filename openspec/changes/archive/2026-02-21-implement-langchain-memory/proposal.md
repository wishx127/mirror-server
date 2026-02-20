## 为什么需要变更 (Why)

目前项目中使用手动方式检索和格式化对话历史。使用 LangChain 的 Memory 组件可以提供一种标准、灵活的方式来管理对话历史，为未来支持自动摘要和上下文窗口管理等功能打下基础。我们需要支持这种现代化的方法，同时保持与现有实现的向后兼容性，以确保迁移过程中的稳定性。

## 变更内容 (What Changes)

- 实现 `PrismaChatMessageHistory` 类，继承自 LangChain 的 `BaseListChatMessageHistory`，将 LangChain 的内存机制与现有的 Prisma 数据库模式 (`ConversationDetail` 表) 连接起来。
- 更新 `RAGChainFactory` 以支持创建被 `RunnableWithMessageHistory` 包装的链。
- 添加配置（例如环境变量 `USE_LANGCHAIN_MEMORY`），以便在传统的“手动历史管理”和新的“LangChain 内存管理”模式之间进行切换。
- 重构 `ChatService` 以利用配置的内存策略。

## 能力 (Capabilities)

### 新增能力 (New Capabilities)

- `langchain-memory`: 集成 LangChain Memory 组件与 Prisma 后端，实现持久化对话历史。

### 修改能力 (Modified Capabilities)

- `langchain-retrieval-chain`: 更新 RAG 链的创建逻辑，支持 `RunnableWithMessageHistory` 和可配置的内存注入。

## 影响范围 (Impact)

- **代码库**:
  - `src/modules/chat/chat.service.ts`: 历史检索和链执行的逻辑。
  - `src/modules/chat/chains/rag-chain.factory.ts`: 链的构建逻辑。
  - 新文件 `src/modules/chat/memory/prisma-chat-message-history.ts`。
- **数据库**: 不需要更改模式（复用 `UserConversation` 和 `ConversationDetail`），但在新模式下，链访问/写入数据的方式将发生变化。
- **配置**: 新增配置选项以切换内存模式。
