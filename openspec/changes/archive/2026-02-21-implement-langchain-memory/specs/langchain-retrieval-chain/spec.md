# LangChain 检索链内存支持 (LangChain Retrieval Chain Memory Support)

## 新增需求 (ADDED Requirements)

### Requirement: 感知内存的链 (Memory-Aware Chain)

`RAGChainFactory` 必须支持创建被 `RunnableWithMessageHistory` 包装的链，以自动管理对话历史。

#### Scenario: 可配置的内存策略 (Configurable Memory Strategy)

- **WHEN** 启用 `USE_LANGCHAIN_MEMORY` 配置
- **THEN** `RAGChainFactory` 使用 `RunnableWithMessageHistory` 包装基础链
- **AND** 使用 `PrismaChatMessageHistory` 作为历史记录后端
- **AND** 自动处理输入 `input` 和占位符 `chat_history`

#### Scenario: 遗留兼容性 (Legacy Compatibility)

- **WHEN** 禁用 `USE_LANGCHAIN_MEMORY`（默认）
- **THEN** `RAGChainFactory` 像以前一样创建链
- **AND** 必须在输入中手动传递 `chat_history`

### Requirement: 会话 ID 处理 (Session ID Handling)

当启用内存时，系统必须将 `sessionId` (chatId) 传递给链的执行过程。

#### Scenario: 带 Session ID 执行 (Execute with Session ID)

- **WHEN** 执行感知内存的链
- **THEN** 在 invoke 选项中传递 `configurable: { sessionId: chatId }`
