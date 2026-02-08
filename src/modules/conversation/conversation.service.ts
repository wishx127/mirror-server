import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SaveConversationDto } from "./conversation.dto";
import { StoredMessage } from "../chat/chat.dto";
import * as crypto from "crypto";

// 对话列表项类型（导出供 controller 使用）
export interface ConversationListItem {
  id: string;
  title: string;
  createdAt: Date;
  updatedAt: Date;
}

// 带详情的对话列表项类型（导出供 controller 使用）
export interface ConversationWithDetails extends ConversationListItem {
  content: StoredMessage[];
}

@Injectable()
export class ConversationService {
  constructor(private readonly prisma: PrismaService) {}

  private generateConversationId(
    userId: number,
    title?: string,
    content?: string | object,
  ): string {
    const userIdStr = typeof userId === "number" ? userId.toString() : userId;
    const titleStr = typeof title === "string" ? title : "";
    const contentStr =
      typeof content === "string" ? content : JSON.stringify(content);
    const hashInput = `${userIdStr}:${titleStr}:${contentStr}`;
    return crypto.createHash("sha256").update(hashInput).digest("hex");
  }

  async saveConversation(
    dto: SaveConversationDto,
  ): Promise<{ success: boolean; conversationId: string }> {
    let currentConversationId: string;

    if (dto.conversationId) {
      currentConversationId = dto.conversationId;

      const existingConversation =
        await this.prisma.userConversation.findUnique({
          where: { id: currentConversationId },
        });

      if (
        !existingConversation ||
        existingConversation.userId !== Number(dto.userId)
      ) {
        throw new UnauthorizedException("对话不存在");
      }

      await this.prisma.$transaction(async (tx) => {
        await tx.userConversation.update({
          where: { id: currentConversationId },
          data: {
            ...(dto.title && { title: dto.title }),
            updatedAt: new Date(),
          },
        });

        if (dto.content) {
          const contentValue = dto.content as string | object;
          await tx.conversationDetail.updateMany({
            where: { conversationId: currentConversationId },
            data: {
              content: contentValue,
              updatedAt: new Date(),
            },
          });
        }
      });
    } else {
      const dtoContent = dto.content as string | object;
      currentConversationId = this.generateConversationId(
        Number(dto.userId),
        dto.title,
        dtoContent,
      );

      const parsedContent = JSON.parse(dtoContent as string) as StoredMessage[];
      let finalContent: string | object = dtoContent;
      if (Array.isArray(parsedContent) && parsedContent.length > 0) {
        parsedContent[0].conversationId = currentConversationId;
        finalContent = JSON.stringify(parsedContent);
      }

      await this.prisma.$transaction(async (tx) => {
        const conv = await tx.userConversation.create({
          data: {
            id: currentConversationId,
            userId: Number(dto.userId),
            title: dto.title as string,
          },
        });
        await tx.conversationDetail.create({
          data: {
            conversationId: conv.id,
            content: finalContent,
          },
        });
      });
    }

    return { success: true, conversationId: currentConversationId };
  }

  async getConversations(
    userId: number,
    includeDetails?: boolean,
  ): Promise<{
    success: boolean;
    conversations: (ConversationListItem | ConversationWithDetails)[];
  }> {
    const list = await this.prisma.userConversation.findMany({
      where: { userId: Number(userId) },
      orderBy: { createdAt: "desc" },
      select: { id: true, title: true, createdAt: true, updatedAt: true },
    });

    if (!includeDetails) {
      return { success: true, conversations: list };
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);

    // 优化：筛选出今日更新的对话ID，然后批量查询详情（减少查询次数）
    const todayConversationIds = list
      .filter(
        (conv) =>
          conv.updatedAt &&
          conv.updatedAt >= today &&
          conv.updatedAt < tomorrow,
      )
      .map((conv) => conv.id);

    // 如果没有今日更新的对话，直接返回
    if (todayConversationIds.length === 0) {
      return { success: true, conversations: list };
    }

    // 批量查询所有今日更新的对话详情（1次查询代替N次）
    const allDetails = await this.prisma.conversationDetail.findMany({
      where: { conversationId: { in: todayConversationIds } },
      orderBy: { createdAt: "asc" },
      select: { conversationId: true, content: true },
    });

    // 构建 conversationId -> StoredMessage[] 的映射
    const detailsMap = new Map<string, StoredMessage[]>();
    allDetails.forEach((detail) => {
      if (!detailsMap.has(detail.conversationId)) {
        detailsMap.set(detail.conversationId, []);
      }
      // 将内容展平并添加到映射中
      const content = detail.content as unknown as StoredMessage[];
      if (Array.isArray(content)) {
        detailsMap.get(detail.conversationId)!.push(...content);
      }
    });

    // 为今日更新的对话添加详情
    const conversationsWithDetails: (
      | ConversationListItem
      | ConversationWithDetails
    )[] = list.map((conversation) => {
      const details = detailsMap.get(conversation.id);
      if (details) {
        return { ...conversation, content: details } as ConversationWithDetails;
      }
      return conversation;
    });

    return { success: true, conversations: conversationsWithDetails };
  }

  async deleteConversation(
    userId: number,
    conversationId: string,
  ): Promise<{ success: boolean }> {
    const conversation = await this.prisma.userConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new NotFoundException("对话不存在");
    }
    if (conversation.userId !== userId) {
      throw new UnauthorizedException("未授权");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.conversationDetail.deleteMany({
        where: { conversationId },
      });

      await tx.userConversation.delete({
        where: { id: conversationId },
      });
    });

    return { success: true };
  }

  async getConversationDetails(
    userId: number,
    conversationId: string,
  ): Promise<{ success: boolean; content: StoredMessage[] }> {
    const conversation = await this.prisma.userConversation.findUnique({
      where: { id: conversationId },
    });
    if (!conversation) {
      throw new NotFoundException("对话不存在");
    }
    if (conversation.userId !== Number(userId)) {
      throw new UnauthorizedException("未授权");
    }
    const detail = await this.prisma.conversationDetail.findMany({
      where: { conversationId },
      orderBy: { createdAt: "asc" },
      select: { content: true },
    });

    const flattenedContent = detail.flatMap(
      (d) => d.content as unknown as StoredMessage[],
    );

    return { success: true, content: flattenedContent };
  }
}
