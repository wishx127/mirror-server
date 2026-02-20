import { Logger } from "@nestjs/common";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate } from "@langchain/core/prompts";
import { BaseRetriever } from "@langchain/core/retrievers";
import {
  RunnableSequence,
  RunnableLambda,
  RunnableWithMessageHistory,
  Runnable,
} from "@langchain/core/runnables";
import {
  BaseMessage,
  HumanMessage,
  AIMessage,
  isBaseMessage,
} from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { Document } from "@langchain/core/documents";
import { BaseListChatMessageHistory } from "@langchain/core/chat_history";

/**
 * 反序列化 LangChain 消息
 * 处理从 JSON 反序列化后的消息对象
 */
function deserializeMessage(msg: unknown): BaseMessage | null {
  // 如果已经是 BaseMessage，直接返回
  if (isBaseMessage(msg)) {
    return msg;
  }

  // 如果是序列化格式的对象
  if (msg && typeof msg === "object") {
    const msgObj = msg as Record<string, unknown>;

    // 检查是否是 LangChain 序列化格式 (lc: 1)
    if (msgObj.lc === 1 && msgObj.type === "constructor") {
      const id = msgObj.id as string[] | undefined;
      const kwargs = (msgObj.kwargs as Record<string, unknown>) || {};
      const content = (kwargs.content as string) || "";
      const additional_kwargs =
        (kwargs.additional_kwargs as Record<string, unknown>) || {};
      const response_metadata =
        (kwargs.response_metadata as Record<string, unknown>) || {};

      // 根据 id 判断消息类型
      if (id && id.includes("HumanMessage")) {
        return new HumanMessage({
          content,
          additional_kwargs,
          response_metadata,
        });
      } else if (id && id.includes("AIMessage")) {
        return new AIMessage({
          content,
          additional_kwargs,
          response_metadata,
        });
      }
    }
  }

  return null;
}

/**
 * 确保 chat_history 是 BaseMessage 数组
 * 处理序列化后的消息对象
 */
function ensureChatHistory(chatHistory: unknown): BaseMessage[] {
  if (!chatHistory) {
    return [];
  }

  // 如果已经是数组
  if (Array.isArray(chatHistory)) {
    return chatHistory
      .map((msg) => deserializeMessage(msg))
      .filter((msg): msg is BaseMessage => msg !== null);
  }

  // 如果是单个消息对象
  const msg = deserializeMessage(chatHistory);
  return msg ? [msg] : [];
}

interface DocMetadata {
  fileName?: string;
  similarity?: number;
}

export interface RAGChainConfig {
  llm: ChatOpenAI;
  retriever: BaseRetriever;
  systemPrompt?: string;
  useMemory?: boolean;
  getMessageHistory?: (
    sessionId: string,
  ) => Promise<BaseListChatMessageHistory>;
}

export interface RAGChainInput {
  input: string;
  chat_history?: BaseMessage[];
}

/**
 * 将对话历史格式化为字符串
 */
function formatChatHistory(messages: BaseMessage[]): string {
  if (messages.length === 0) {
    return "";
  }
  return messages
    .map((msg) => {
      // 使用 constructor.name 来判断消息类型
      const role = msg.constructor.name === "HumanMessage" ? "用户" : "助手";
      // 确保 content 是字符串
      const content =
        typeof msg.content === "string"
          ? msg.content
          : JSON.stringify(msg.content);
      return `${role}: ${content}`;
    })
    .join("\n\n");
}

/**
 * 将文档数组格式化为上下文字符串
 */
function formatDocumentsAsString(docs: Document<DocMetadata>[]): string {
  if (docs.length === 0) {
    return "暂无相关参考资料";
  }
  return docs
    .map((doc, i) => {
      const fileName = doc.metadata?.fileName || "未知来源";
      const similarity = doc.metadata?.similarity
        ? ` [相似度: ${(doc.metadata.similarity * 100).toFixed(1)}%]`
        : "";
      return `### 资料 ${i + 1}${similarity}\n来源: ${fileName}\n内容: ${doc.pageContent}`;
    })
    .join("\n\n");
}

/**
 * RAG Chain 工厂
 * 使用 RunnableSequence 创建检索增强生成链
 */
export class RAGChainFactory {
  private static readonly logger = new Logger(RAGChainFactory.name);

  /**
   * 默认系统提示词
   */
  private static readonly DEFAULT_SYSTEM_PROMPT = `你是 Mirror 智能助手。

根据以下参考资料回答用户问题。如果资料不足以回答，请根据你的知识补充。

参考资料：
{context}

{chat_history}

请优先使用参考资料中的信息回答。回答要准确、有帮助、友好。`;

  /**
   * 创建 RAG Chain
   * 使用 RunnableSequence 组合检索和生成
   */
  static createRAGChain(config: RAGChainConfig): Runnable {
    const { llm, retriever, systemPrompt, useMemory, getMessageHistory } =
      config;

    // 打印 LLM 配置信息用于调试
    this.logger.log(`Creating RAG Chain with LLM`);

    // 1. 定义 prompt template
    // 使用 fromTemplate 正确解析 system prompt 中的 {context} 和 {chat_history} 变量
    const promptTemplate = systemPrompt || this.DEFAULT_SYSTEM_PROMPT;
    const qaPrompt = ChatPromptTemplate.fromTemplate(promptTemplate);

    // 2. 创建 RunnableSequence
    // 使用 RunnableLambda 准备输入，确保 chat_history 被正确处理
    const prepareInputRunnable = RunnableLambda.from(
      async (input: RAGChainInput) => {
        // 获取检索结果
        const docs = await retriever.invoke(input.input);
        const context = formatDocumentsAsString(
          docs as Document<DocMetadata>[],
        );

        // 确保 chat_history 是正确的 BaseMessage 数组格式
        // 处理序列化后的消息对象
        const chatMessages = ensureChatHistory(input.chat_history);
        const historyStr = formatChatHistory(chatMessages);
        const formattedHistory = historyStr
          ? `## 对话历史\n${historyStr}\n`
          : "";

        // 打印发送给 LLM 的内容用于调试
        this.logger.log(`========== RAG Chain Input ==========`);
        this.logger.log(`[Input]: ${input.input}`);
        this.logger.log(
          `[Context - ${docs.length} docs]: ${context.substring(0, 500)}${context.length > 500 ? "..." : ""}`,
        );
        this.logger.log(`[Chat History]: ${formattedHistory || "(none)"}`);
        this.logger.log(`========================================`);

        // 返回干净的输入对象，只包含需要的字段
        return {
          input: input.input,
          context,
          chat_history: formattedHistory,
        };
      },
    );

    const ragChain = RunnableSequence.from([
      prepareInputRunnable,
      qaPrompt,
      llm,
      new StringOutputParser(),
    ]);

    if (useMemory && getMessageHistory) {
      this.logger.log("Wrapping RAG Chain with RunnableWithMessageHistory");
      return new RunnableWithMessageHistory({
        runnable: ragChain,
        getMessageHistory,
        inputMessagesKey: "input",
        historyMessagesKey: "chat_history",
      });
    }

    this.logger.log("RAG Chain created successfully");

    return ragChain;
  }

  /**
   * 创建带自定义提示词的 RAG Chain
   * 将角色提示词与 RAG 上下文格式结合，确保上下文被正确注入
   */
  static createCustomRAGChain(
    llm: ChatOpenAI,
    retriever: BaseRetriever,
    customSystemPrompt: string,
    useMemory?: boolean,
    getMessageHistory?: (
      sessionId: string,
    ) => Promise<BaseListChatMessageHistory>,
  ): Runnable {
    // 构建完整的系统提示词，包含 RAG 所需的占位符
    const fullSystemPrompt = `${customSystemPrompt}

根据以下参考资料回答用户问题。如果资料不足以回答，请根据你的知识补充。

参考资料：
{context}

{chat_history}

请优先使用参考资料中的信息回答。回答要准确、有帮助、友好。`;

    return this.createRAGChain({
      llm,
      retriever,
      systemPrompt: fullSystemPrompt,
      useMemory,
      getMessageHistory,
    });
  }
}
