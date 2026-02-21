## 背景 (Context)

`ChatService` 中当前的聊天实现是手动从数据库中检索对话历史，将其格式化，然后传递给 LLM 链。这种方法比较僵化，无法利用 LangChain 内置的内存功能（如自动历史管理、摘要和上下文窗口处理）。

## 目标 / 非目标 (Goals / Non-Goals)

**目标:**

- 实现 `PrismaChatMessageHistory`，允许 LangChain 直接读写 `ConversationDetail` 表。
- 更新 `RAGChainFactory` 以支持 `RunnableWithMessageHistory`。
- 提供配置开关 (`USE_LANGCHAIN_MEMORY`) 以在传统的“手动模式”和新的“LangChain 内存模式”之间切换。
- 确保数据兼容性，使两种模式都能使用相同的数据库记录。

**非目标:**

- 修改数据库模式。
- 在第一步中实现高级内存功能（如摘要），仅关注基础设施的搭建。

## 决策 (Decisions)

### 1. `PrismaChatMessageHistory` 实现

我们将实现一个扩展 `BaseListChatMessageHistory` 的类。

- **存储**: 它将把 LangChain 的 `BaseMessage` 映射到 `ConversationDetail` 中使用的现有 `StoredMessage` JSON 格式。
- **映射**:
  - `HumanMessage` -> `role: "user"`
  - `AIMessage` -> `role: "assistant"`
  - `SystemMessage` -> `role: "system"`
  - 内容将映射到/自 `content` 字段。
- **处理新对话**: 当会话 ID 不存在时，它将在第一次写入时创建新的 `UserConversation` 和 `ConversationDetail` 记录。

### 2. 配置策略

我们将使用环境变量 `USE_LANGCHAIN_MEMORY` (默认: `false`)。

- **False**: `ChatService` 手动获取历史并传递给 `chat_history`。`ChatService` 手动保存消息。
- **True**: `ChatService` 将 `sessionId` 传递给链。链使用 `RunnableWithMessageHistory` 通过 `PrismaChatMessageHistory` 获取/保存消息。

### 3. 防止重复保存

当 `USE_LANGCHAIN_MEMORY` 为 true 时：

- `ChatService` 应 **跳过** 其对手动 `saveConversation` 的调用（针对由链处理的消息）。
- 但是，`ChatService` 可能仍需处理新对话的标题生成。如果是新对话，我们将单独触发标题生成，即使内存模块已经处理了消息存储。

## 风险 / 权衡 (Risks / Trade-offs)

**风险: 事务完整性**

- **问题**: 当前的手动保存将更新包装在 Prisma 事务中。LangChain 内存分别保存用户和 AI 消息（两次 DB 调用）。
- **缓解**: 暂时接受这种权衡。影响很小（最坏情况：保存了用户消息但 AI 消息失败，这是一种标准的故障模式）。

**风险: 数据格式分歧**

- **问题**: 如果 `PrismaChatMessageHistory` 写入的 JSON 结构与旧代码不同，前端可能会崩溃。
- **缓解**: 严格确保 `PrismaChatMessageHistory` 序列化消息的方式与 `ChatService` 完全一致（匹配 `StoredMessage` 接口）。我们将复用现有的类型定义。

## 迁移计划 (Migration Plan)

1. 实现 `PrismaChatMessageHistory`。
2. 更新 `RAGChainFactory`。
3. 更新 `ChatService` 并添加切换逻辑。
