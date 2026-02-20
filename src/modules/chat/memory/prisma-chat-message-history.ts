import { BaseListChatMessageHistory } from "@langchain/core/chat_history";
import { BaseMessage } from "@langchain/core/messages";
import { PrismaService } from "../../prisma/prisma.service";
import { Prisma } from "@prisma/client";
import {
  StoredMessage,
  MessageContentPart,
  convertToBaseMessages,
} from "../utils/message-converter";
import * as crypto from "crypto";

export interface PrismaChatMessageHistoryInput {
  sessionId: string;
  userId: number;
  prismaService: PrismaService;
}

export class PrismaChatMessageHistory extends BaseListChatMessageHistory {
  lc_namespace = ["langchain", "stores", "message", "prisma"];

  private sessionId: string;
  private userId: number;
  private prisma: PrismaService;

  constructor(fields: PrismaChatMessageHistoryInput) {
    super(fields);
    this.sessionId = fields.sessionId;
    this.userId = fields.userId;
    this.prisma = fields.prismaService;
  }

  async getMessages(): Promise<BaseMessage[]> {
    const detail = await this.prisma.conversationDetail.findFirst({
      where: { conversationId: this.sessionId },
    });

    if (!detail || !detail.content) {
      return [];
    }

    const storedMessages = detail.content as unknown as StoredMessage[];
    return convertToBaseMessages(storedMessages);
  }

  async addMessage(message: BaseMessage): Promise<void> {
    await this.addMessages([message]);
  }

  async addMessages(messages: BaseMessage[]): Promise<void> {
    const storedMessages = messages.map((msg) =>
      this.mapBaseMessageToStoredMessage(msg),
    );

    await this.prisma.$transaction(async (tx) => {
      // 1. Ensure UserConversation exists
      const conversation = await tx.userConversation.findUnique({
        where: { id: this.sessionId },
      });

      if (!conversation) {
        // Initial title, will be updated by ChatService logic if needed,
        // or we use a default. ChatService generates title asynchronously usually.
        // We use "New Conversation" as placeholder.
        await tx.userConversation.create({
          data: {
            id: this.sessionId,
            userId: this.userId,
            title: "New Conversation",
          },
        });
      } else {
        // Update updatedAt
        await tx.userConversation.update({
          where: { id: this.sessionId },
          data: { updatedAt: new Date() },
        });
      }

      // 2. Update ConversationDetail
      const detail = await tx.conversationDetail.findFirst({
        where: { conversationId: this.sessionId },
      });

      if (detail) {
        const currentContent = Array.isArray(detail.content)
          ? (detail.content as unknown as StoredMessage[])
          : [detail.content as unknown as StoredMessage];

        await tx.conversationDetail.update({
          where: { id: detail.id },
          data: {
            content: [
              ...currentContent,
              ...storedMessages,
            ] as unknown as Prisma.InputJsonArray,
          },
        });
      } else {
        await tx.conversationDetail.create({
          data: {
            conversationId: this.sessionId,
            content: storedMessages as unknown as Prisma.InputJsonArray,
          },
        });
      }
    });
  }

  async clear(): Promise<void> {
    await this.prisma.conversationDetail.updateMany({
      where: { conversationId: this.sessionId },
      data: { content: [] },
    });
  }

  private mapBaseMessageToStoredMessage(message: BaseMessage): StoredMessage {
    const role = this.getRole(message);
    const contentParts: MessageContentPart[] = [];

    if (typeof message.content === "string") {
      contentParts.push({
        type: "content",
        data: message.content,
      });
    } else if (Array.isArray(message.content)) {
      (
        message.content as {
          type: string;
          text?: string;
          image_url?: { url: string };
        }[]
      ).forEach((part) => {
        if (part.type === "text" && part.text) {
          contentParts.push({ type: "content", data: part.text });
        } else if (part.type === "image_url" && part.image_url) {
          contentParts.push({
            type: "image",
            data: { url: part.image_url.url },
          });
        }
      });
    }

    return {
      role,
      content: contentParts,
      key: this.getRandomKey(),
      time: this.formatChineseTime(new Date()),
      reasoning_content: message.additional_kwargs?.reasoning_content as
        | string
        | undefined,
    };
  }

  private getRole(message: BaseMessage): "user" | "assistant" | "system" {
    if (message._getType() === "human") return "user";
    if (message._getType() === "ai") return "assistant";
    if (message._getType() === "system") return "system";
    return "user";
  }

  private getRandomKey(): string {
    return crypto.randomBytes(8).toString("hex");
  }

  private formatChineseTime(date: Date): string {
    return new Intl.DateTimeFormat("zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
      timeZone: "Asia/Shanghai",
    })
      .format(date)
      .replace(/\//g, "-");
  }
}
