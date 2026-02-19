import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from "@langchain/core/messages";

/**
 * 存储的消息内容部分
 */
export interface MessageContentPart {
  type: "thinking" | "content" | "image" | "file";
  data: string | ImageMetadata | FileMetadata;
}

/**
 * 图片元数据
 */
export interface ImageMetadata {
  url: string;
  base64?: string;
  mimeType?: string;
}

/**
 * 文件元数据
 */
export interface FileMetadata {
  name: string;
  content?: string;
  base64?: string;
  mimeType?: string;
}

/**
 * 存储的消息格式（数据库中的格式）
 */
export interface StoredMessage {
  role: "user" | "assistant" | "system";
  content: MessageContentPart[];
  key: string;
  time: string;
  reasoning_content?: string;
}

/**
 * 将存储的消息转换为 LangChain BaseMessage 格式
 * 仅提取文本内容，忽略图片和文件
 */
export function convertToBaseMessages(messages: StoredMessage[]): BaseMessage[] {
  return messages.map((msg) => {
    // 提取文本内容
    const textContent = extractTextContent(msg.content);
    
    // 根据角色创建对应的消息类型
    switch (msg.role) {
      case "user":
        return new HumanMessage(textContent);
      case "assistant":
        return new AIMessage(textContent);
      case "system":
        return new SystemMessage(textContent);
      default:
        // 默认作为人类消息处理
        return new HumanMessage(textContent);
    }
  });
}

/**
 * 从消息内容部分提取文本
 * 忽略图片和文件内容
 */
export function extractTextContent(parts: MessageContentPart[]): string {
  return parts
    .filter((part) => part.type === "content" || part.type === "thinking")
    .map((part) => {
      if (typeof part.data === "string") {
        return part.data;
      }
      return "";
    })
    .join("\n");
}

/**
 * 提取思维链内容
 */
export function extractReasoningContent(message: StoredMessage): string | null {
  return message.reasoning_content || null;
}

/**
 * 从存储的消息中提取最近的 N 条作为上下文
 */
export function getRecentMessages(
  messages: StoredMessage[],
  limit: number = 10
): StoredMessage[] {
  return messages.slice(-limit);
}

/**
 * 将 BaseMessage 数组转换为简单的对话历史字符串
 * 用于日志或调试
 */
export function formatChatHistory(messages: BaseMessage[]): string {
  return messages
    .map((msg) => {
      const role = msg._getType();
      const content = typeof msg.content === "string" 
        ? msg.content 
        : JSON.stringify(msg.content);
      return `[${role}]: ${content.slice(0, 100)}...`;
    })
    .join("\n");
}
