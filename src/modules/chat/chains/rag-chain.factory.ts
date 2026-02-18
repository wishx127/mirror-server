import { Logger } from "@nestjs/common";
import { ChatOpenAI } from "@langchain/openai";
import { ChatPromptTemplate, MessagesPlaceholder } from "@langchain/core/prompts";
import { BaseRetriever } from "@langchain/core/retrievers";
import { RunnableSequence, RunnablePassthrough } from "@langchain/core/runnables";
import { BaseMessage } from "@langchain/core/messages";
import { StringOutputParser } from "@langchain/core/output_parsers";
import { Document } from "@langchain/core/documents";

interface DocMetadata {
  fileName?: string;
  similarity?: number;
}

export interface RAGChainConfig {
  llm: ChatOpenAI;
  retriever: BaseRetriever;
  systemPrompt?: string;
}

export interface RAGChainInput {
  input: string;
  chat_history?: BaseMessage[];
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

请优先使用参考资料中的信息回答。回答要准确、有帮助、友好。`;

  /**
   * 创建 RAG Chain
   * 使用 RunnableSequence 组合检索和生成
   */
  static createRAGChain(config: RAGChainConfig): RunnableSequence<RAGChainInput, string> {
    const { llm, retriever, systemPrompt } = config;

    // 1. 定义 prompt template
    const qaPrompt = ChatPromptTemplate.fromMessages([
      ["system", systemPrompt || this.DEFAULT_SYSTEM_PROMPT],
      new MessagesPlaceholder("chat_history"),
      ["human", "{input}"],
    ]);

    // 2. 创建 RunnableSequence
    // 使用 RunnablePassthrough 来保持输入，同时并行执行检索
    const ragChain = RunnableSequence.from([
      {
        context: retriever.pipe((docs: Document<DocMetadata>[]) => formatDocumentsAsString(docs)),
        input: new RunnablePassthrough(),
        chat_history: new RunnablePassthrough(),
      },
      {
        context: (prev: { context: string }) => prev.context,
        input: (prev: RAGChainInput) => prev.input,
        chat_history: (prev: RAGChainInput) => prev.chat_history || [],
      },
      qaPrompt,
      llm,
      new StringOutputParser(),
    ]);

    this.logger.log("RAG Chain created successfully");

    return ragChain as unknown as RunnableSequence<RAGChainInput, string>;
  }

  /**
   * 创建带自定义提示词的 RAG Chain
   */
  static createCustomRAGChain(
    llm: ChatOpenAI,
    retriever: BaseRetriever,
    customSystemPrompt: string
  ): RunnableSequence<RAGChainInput, string> {
    return this.createRAGChain({
      llm,
      retriever,
      systemPrompt: customSystemPrompt,
    });
  }

  /**
   * 创建简单 RAG Chain（无对话历史）
   */
  static createSimpleRAGChain(
    llm: ChatOpenAI,
    retriever: BaseRetriever
  ): RunnableSequence<{ input: string }, string> {
    const qaPrompt = ChatPromptTemplate.fromMessages([
      ["system", this.DEFAULT_SYSTEM_PROMPT],
      ["human", "{input}"],
    ]);

    const ragChain = RunnableSequence.from([
      {
        context: retriever.pipe((docs: Document<DocMetadata>[]) => formatDocumentsAsString(docs)),
        input: new RunnablePassthrough(),
      },
      {
        context: (prev: { context: string }) => prev.context,
        input: (prev: { input: string }) => prev.input,
      },
      qaPrompt,
      llm,
      new StringOutputParser(),
    ]);

    this.logger.log("Simple RAG Chain created successfully");

    return ragChain as unknown as RunnableSequence<{ input: string }, string>;
  }

  /**
   * 格式化检索结果为上下文
   */
  static formatContext(docs: Document<DocMetadata>[]): string {
    return formatDocumentsAsString(docs);
  }
}
