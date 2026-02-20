# LangChain Memory 集成

## 新增需求 (ADDED Requirements)

### Requirement: PrismaChatMessageHistory

系统必须实现 `PrismaChatMessageHistory` 类，继承自 `BaseListChatMessageHistory`，使用现有的 Prisma 模式存储和检索聊天消息。

#### Scenario: 获取消息 (Retrieve messages)

- **WHEN** 调用 `getMessages()` 并传入特定的 `sessionId`
- **THEN** 通过 `conversationId` 查询 `ConversationDetail` 表
- **AND** 将存储的消息转换为 `BaseMessage[]`
- **AND** 返回消息列表

#### Scenario: 添加用户消息 (Add user message)

- **WHEN** 调用 `addUserMessage(message)`
- **THEN** 将消息追加到指定 `sessionId` 的 `ConversationDetail.content` 中
- **AND** 更新 `UserConversation.updatedAt` 时间戳
- **AND** 保持 `StoredMessage` 的现有 JSON 结构

#### Scenario: 添加 AI 消息 (Add AI message)

- **WHEN** 调用 `addAIChatMessage(message)`
- **THEN** 将消息追加到 `ConversationDetail.content` 中
- **AND** 更新 `UserConversation.updatedAt` 时间戳
- **AND** 支持存储 `additional_kwargs` 中的推理内容 (reasoning content)

#### Scenario: 清除消息 (Clear messages)

- **WHEN** 调用 `clear()`
- **THEN** 清空指定 `sessionId` 的 `ConversationDetail` 中的 `content` 数组
- **OR** 删除该 `ConversationDetail` 记录

### Requirement: 内存工厂 (Memory Factory)

系统必须提供一个工厂或服务方法，为给定的会话实例化 `PrismaChatMessageHistory`。

#### Scenario: 为会话创建内存 (Create memory for session)

- **WHEN** 请求包含 `chatId`
- **THEN** 创建一个绑定到该 `chatId` 的 `PrismaChatMessageHistory` 实例
