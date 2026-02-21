## 1. 准备工作

- [x] 1.1 创建 `src/modules/chat/memory/` 目录。
- [x] 1.2 验证 `@langchain/core` 版本是否支持 `BaseListChatMessageHistory`。

## 2. 核心实现

- [x] 2.1 在 `src/modules/chat/memory/prisma-chat-message-history.ts` 中实现 `PrismaChatMessageHistory`。

## 3. 链集成

- [x] 3.1 更新 `src/modules/chat/chains/rag-chain.factory.ts` 中的 `RAGChainFactory`，以支持 `RunnableWithMessageHistory`。
- [x] 3.2 添加逻辑，根据 `useMemory` 标志有条件地包装链。

## 4. 服务集成

- [x] 4.1 更新 `ChatService` 以读取 `USE_LANGCHAIN_MEMORY` 配置。
- [x] 4.2 重构 `ChatService.streamRAGChain`，在启用时使用感知内存的链工厂方法。
- [x] 4.3 更新 `ChatService.saveConversation` 逻辑，在启用内存时避免重复保存。

## 5. 验证

- [x] 5.1 运行现有测试，确保默认模式下无回归。
- [x] 5.2 通过设置 `USE_LANGCHAIN_MEMORY=true` 并测试聊天流程来验证新模式。
