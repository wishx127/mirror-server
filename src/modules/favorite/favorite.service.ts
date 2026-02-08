import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import {
  CreateFavoriteDto,
  RemoveFavoriteDto,
  GetFavoritesDto,
  GetFavoriteDetailDto,
} from "./favorite.dto";
import * as crypto from "crypto";
import OpenAI from "openai";

// 存储的图片元数据
interface StoredImageMetadata {
  fileName: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  ratio?: string;
  localPath?: string;
  url: string;
  uploadedAt: string;
}

// 存储的文件元数据
interface StoredFileMetadata {
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  uploadedAt: string;
}

// 消息内容片段类型
interface MessageContentPart {
  type: "thinking" | "content" | "image" | "file";
  data: string | StoredImageMetadata | StoredFileMetadata;
}

// 聊天消息类型
interface ChatMessage {
  role: "user" | "assistant" | "system";
  content: string | MessageContentPart[];
  key?: string;
}

// OpenAI 消息参数类型
interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// 收藏内容查询条件类型
interface FavoriteContentWhereInput {
  id: { in: string[] };
  OR?: Array<{
    title?: { contains: string; mode: string };
    description?: { contains: string; mode: string };
  }>;
  tags?: { has: string };
}

@Injectable()
export class FavoriteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  // 生成基于userId和conversation内容的哈希ID
  private generateContentId(
    userId: number,
    conversation: ChatMessage[],
  ): string {
    const userIdStr = typeof userId === "number" ? userId.toString() : userId;
    const conversationStr =
      typeof conversation === "string"
        ? conversation
        : JSON.stringify(conversation);

    const hashInput = `${userIdStr}:${conversationStr}`;
    return crypto.createHash("sha256").update(hashInput).digest("hex");
  }

  /**
   * 生成聊天标题
   * @param apiKey API Key
   * @param baseURL Base URL
   * @param modelName 模型名称
   * @param content 用户发送的第一条消息内容
   * @returns 生成的标题
   */
  private async generateConversationTitle(
    apiKey: string,
    baseURL: string,
    modelName: string,
    content: string,
  ): Promise<string> {
    try {
      const openai = new OpenAI({ apiKey, baseURL });
      const titlePrompt = {
        role: "system",
        content:
          "你是一个专业的标题生成助手。请根据以下对话内容生成一个简洁、准确的标题，标题不超过15个字，不要使用引号或其他标点符号。这段话的内容是：",
      };

      const userMessage = {
        role: "user",
        content:
          content.length > 200 ? content.substring(0, 200) + "..." : content,
      };

      const response = await openai.chat.completions.create({
        model: modelName,
        messages: [titlePrompt, userMessage] as OpenAIMessage[] as Parameters<
          typeof openai.chat.completions.create
        >[0]["messages"],
        temperature: 0.7,
        max_tokens: 20,
      });

      let title = response.choices[0]?.message?.content?.trim() || "";
      title = title.replace(/^["'“”]+|["'“”]+$/g, "");

      return title || "新收藏";
    } catch (error) {
      console.error("生成标题失败: ", error);
      return content.substring(0, 20) || "新收藏";
    }
  }

  // 用户收藏
  async addFavorite(createFavoriteDto: CreateFavoriteDto & { title?: string }) {
    const {
      userId,
      conversationId,
      key,
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      id: _id,
      ...contentData
    } = createFavoriteDto;

    if (!userId || isNaN(userId)) {
      throw new BadRequestException("无效的用户ID");
    }

    // 1. 检查用户是否存在
    const userExists = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { modelConfig: true },
    });

    if (!userExists) {
      throw new NotFoundException(`用户不存在`);
    }

    // 2. 获取对话详情
    const conversationDetail = await this.prisma.conversationDetail.findFirst({
      where: { conversationId },
    });

    if (!conversationDetail) {
      throw new NotFoundException("对话记录不存在");
    }

    const messages = (Array.isArray(conversationDetail.content)
      ? conversationDetail.content
      : []) as unknown as ChatMessage[];
    const index = messages.findIndex((m) => m.key === key);

    if (index === -1) {
      throw new NotFoundException("该消息不存在");
    }

    const targetMsg = messages[index];
    const pairedMessages: ChatMessage[] = [];

    if (targetMsg.role === "user") {
      pairedMessages.push(targetMsg);
      if (
        index + 1 < messages.length &&
        messages[index + 1].role === "assistant"
      ) {
        pairedMessages.push(messages[index + 1]);
      }
    } else if (targetMsg.role === "assistant") {
      if (index - 1 >= 0 && messages[index - 1].role === "user") {
        pairedMessages.push(messages[index - 1]);
      }
      pairedMessages.push(targetMsg);
    } else {
      pairedMessages.push(targetMsg);
    }

    // 3. 确定标题
    let title: string | undefined = createFavoriteDto.title;
    if (!title) {
      const userMsg = pairedMessages.find((m) => m.role === "user");
      const assistantMsg = pairedMessages.find((m) => m.role === "assistant");
      const firstMsg = userMsg || assistantMsg || pairedMessages[0];

      if (firstMsg) {
        let contentStr = "";
        if (typeof firstMsg.content === "string") {
          contentStr = firstMsg.content;
        } else if (Array.isArray(firstMsg.content)) {
          contentStr = firstMsg.content
            .map((c: MessageContentPart) => {
              if (typeof c.data === "string") {
                return c.data;
              }
              if (c.type === "image") {
                return `[图片: ${(c.data as StoredImageMetadata).fileName}]`;
              }
              if (c.type === "file") {
                return `[文件: ${(c.data as StoredFileMetadata).fileName}]`;
              }
              return "";
            })
            .join("");
        } else {
          contentStr = JSON.stringify(firstMsg.content);
        }

        const apiKey =
          userExists.modelConfig?.apiKey ||
          this.configService.get<string>("DEFAULT_API_KEY");
        const baseURL =
          userExists.modelConfig?.baseURL ||
          this.configService.get<string>("DEFAULT_BASE_URL");
        const modelName = userExists.modelConfig?.modelName || "deepseek-v3.1";

        if (apiKey && baseURL) {
          title = await this.generateConversationTitle(
            apiKey,
            baseURL,
            modelName,
            contentStr,
          );
        } else {
          title =
            contentStr.substring(0, 20) + (contentStr.length > 20 ? "..." : "");
        }
      } else {
        title = "收藏的消息";
      }
    }

    const conversation = pairedMessages;
    const contentId = this.generateContentId(userId, conversation);

    // 4. 检查用户是否已经收藏过此内容
    const existingFavorite = await this.prisma.userFavorite.findUnique({
      where: {
        userId_contentId: {
          userId,
          contentId,
        },
      },
    });

    if (existingFavorite) {
      throw new BadRequestException("该内容已存在");
    }

    // 5. 使用事务确保两个操作要么都成功，要么都失败
    return await this.prisma.$transaction(async (tx) => {
      // 创建收藏内容
      await tx.favoriteContent.create({
        data: {
          id: contentId,
          title: title || "收藏的消息",
          conversation: conversation as object[],
          description: contentData.description,
        },
      });

      // 创建用户收藏记录
      const userFavorite = await tx.userFavorite.create({
        data: {
          userId,
          contentId,
        },
      });

      return {
        success: true,
        message: "收藏成功",
        contentId: userFavorite.contentId,
      };
    });
  }

  // 删除收藏
  async removeFavorite(removeFavoriteDto: RemoveFavoriteDto) {
    const { userId, contentId } = removeFavoriteDto;

    if (!userId || isNaN(userId)) {
      throw new BadRequestException("无效的用户ID");
    }

    if (!contentId) {
      throw new BadRequestException("无效的内容ID");
    }

    // 检查用户收藏记录是否存在
    const userFavorite = await this.prisma.userFavorite.findUnique({
      where: {
        userId_contentId: {
          userId,
          contentId,
        },
      },
    });

    if (!userFavorite) {
      throw new NotFoundException(`内容 ${contentId}不存在`);
    }

    // 使用事务确保两个操作要么都成功，要么都失败
    return await this.prisma.$transaction(async (tx) => {
      // 删除用户收藏记录
      await tx.userFavorite.delete({
        where: {
          userId_contentId: {
            userId,
            contentId,
          },
        },
      });

      // 检查是否还有其他用户收藏了这个内容
      const otherFavorites = await tx.userFavorite.findMany({
        where: { contentId },
      });

      // 如果没有其他用户收藏，则删除收藏内容
      if (otherFavorites.length === 0) {
        await tx.favoriteContent.delete({
          where: { id: contentId },
        });
      }

      return {
        success: true,
        message: "删除成功",
      };
    });
  }

  // 获取收藏列表
  async getUserFavorites(getFavoritesDto: GetFavoritesDto) {
    const { userId, page = 1, limit = 20, search, tag } = getFavoritesDto;

    const pageNumber = typeof page === "string" ? parseInt(page, 10) : page;
    const limitNumber = typeof limit === "string" ? parseInt(limit, 10) : limit;
    const skip = (pageNumber - 1) * limitNumber;

    // 确保userId是整数类型
    const userIdNumber =
      typeof userId === "string" ? parseInt(userId, 10) : userId;

    if (!userIdNumber || isNaN(userIdNumber)) {
      throw new BadRequestException("无效的用户ID");
    }

    // 检查用户是否存在
    const userExists = await this.prisma.user.findUnique({
      where: { id: userIdNumber },
    });

    if (!userExists) {
      throw new NotFoundException(`用户ID ${userIdNumber} 不存在`);
    }

    // 先获取用户收藏的内容ID列表
    const userFavorites = await this.prisma.userFavorite.findMany({
      where: { userId: userIdNumber },
      select: { contentId: true },
    });

    const contentIds = userFavorites.map((fav) => fav.contentId);

    // 如果没有收藏任何内容，返回空结果
    if (contentIds.length === 0) {
      return {
        success: true,
        data: [],
        total: 0,
        page,
        limit,
        totalPages: 0,
      };
    }

    // 构建收藏内容的查询条件
    const where: FavoriteContentWhereInput = {
      id: { in: contentIds },
    };

    // 如果有搜索关键词
    if (search) {
      where.OR = [
        { title: { contains: search, mode: "insensitive" } },
        { description: { contains: search, mode: "insensitive" } },
      ];
    }

    // 如果有标签过滤
    if (tag) {
      where.tags = {
        has: tag,
      };
    }

    // 获取总数
    const total = await this.prisma.favoriteContent.count({
      where: where as object,
    });

    // 获取分页数据
    const favoriteContents = await this.prisma.favoriteContent.findMany({
      where: where as object,
      skip,
      take: limitNumber,
      select: {
        id: true,
        title: true,
        description: true,
        conversation: true,
        createdAt: true,
      },
      orderBy: {
        createdAt: "desc",
      },
    });

    return {
      success: true,
      favorites: favoriteContents,
      total,
      page: pageNumber,
      limit: limitNumber,
      totalPages: Math.ceil(total / limitNumber),
    };
  }

  // 查询单个收藏
  async getFavoriteDetail(getFavoriteDto: GetFavoriteDetailDto) {
    const { contentId } = getFavoriteDto;

    if (!contentId) {
      throw new BadRequestException("无效的内容ID");
    }

    // 获取收藏内容详情
    const favoriteContent = await this.prisma.favoriteContent.findUnique({
      where: { id: contentId },
      select: {
        id: true,
        title: true,
        description: true,
        conversation: true,
        createdAt: true,
      },
    });

    if (!favoriteContent) {
      throw new NotFoundException(`收藏内容 ${contentId} 不存在`);
    }

    return {
      success: true,
      favorite: favoriteContent,
    };
  }
}
