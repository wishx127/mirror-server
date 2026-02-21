import {
  Injectable,
  NotFoundException,
  BadRequestException,
  UnauthorizedException,
  Logger,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../prisma/prisma.service";
import { KnowledgeService } from "../knowledge/knowledge.service";
import { RoleService } from "../role/role.service";
import {
  ChatDto,
  ImageGenerationDto,
  ImageGenerationResponseDto,
  StoredMessage,
  StoredMessageContentPart,
  ImageContentPart,
  FileContentPart,
  ChatSseEvent,
  StoredImageMetadata,
} from "./chat.dto";
import OpenAI from "openai";
import * as crypto from "crypto";
import { Observable, Subscriber } from "rxjs";
import axios from "axios";
import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { ChatOpenAI } from "@langchain/openai";
import { HumanMessage, AIMessage, BaseMessage } from "@langchain/core/messages";
import { RAGChainFactory } from "./chains/rag-chain.factory";
import { PrismaChatMessageHistory } from "./memory/prisma-chat-message-history";

// OpenAI 流式响应 delta 类型
interface StreamDelta {
  content?: string;
  reasoning_content?: string;
}

// OpenAI 流式响应 chunk 类型
interface StreamChunk {
  choices: Array<{
    delta?: StreamDelta;
  }>;
}

// OpenAI 消息内容部分（支持多模态）
interface MessageContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
}

// OpenAI 消息参数类型（支持多模态）
interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | MessageContentPart[];
  reasoning_content?: string;
  images?: string[];
}

// 阿里云通义万相 API 响应类型
interface AliyunImageResponse {
  output?: {
    choices?: Array<{
      finish_reason?: string;
      message?: {
        role?: string;
        content?: Array<{
          image?: string;
        }>;
      };
    }>;
    task_metric?: {
      TOTAL?: number;
      FAILED?: number;
      SUCCEEDED?: number;
    };
  };
  usage?: {
    width?: number;
    height?: number;
    image_count?: number;
  };
  message?: string;
  request_id?: string;
}

@Injectable()
export class ChatService {
  private supabase: SupabaseClient | null;
  private readonly logger = new Logger(ChatService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly knowledgeService: KnowledgeService,
    private readonly roleService: RoleService,
  ) {
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseKey = process.env.SUPABASE_KEY;

    if (supabaseUrl && supabaseKey) {
      this.supabase = createClient(supabaseUrl, supabaseKey);
    } else {
      this.supabase = null;
    }
  }

  /**
   * 创建 ChatOpenAI 实例
   */
  private createChatOpenAI(
    apiKey: string,
    baseURL: string,
    modelName: string,
  ): ChatOpenAI {
    // 临时设置环境变量，确保 LangChain 在任何地方都能获取到 apiKey
    // 这是解决 stream 模式下 apiKey 丢失问题的最可靠方法
    process.env.OPENAI_API_KEY = apiKey;
    if (baseURL) {
      process.env.OPENAI_BASE_URL = baseURL;
    }

    return new ChatOpenAI({
      openAIApiKey: apiKey,
      model: modelName,
      streaming: true,
      temperature: 0.7,
    });
  }

  /**
   * 将存储的消息转换为 LangChain BaseMessage 格式
   */
  private convertToBaseMessages(messages: ChatMessage[]): BaseMessage[] {
    return messages
      .filter((msg) => msg.role !== "system") // 系统消息在 RAG Chain 中单独处理
      .map((msg) => {
        const content =
          typeof msg.content === "string"
            ? msg.content
            : JSON.stringify(msg.content);
        if (msg.role === "user") {
          return new HumanMessage(content);
        } else if (msg.role === "assistant") {
          return new AIMessage(content);
        }
        return new HumanMessage(content);
      });
  }

  private calculateAspectRatio(width: number, height: number): string {
    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const divisor = gcd(width, height);
    const simplifiedRatio = `${width / divisor}:${height / divisor}`;

    const commonRatios = [
      { ratio: "1:1", value: 1 },
      { ratio: "4:3", value: 4 / 3 },
      { ratio: "3:4", value: 3 / 4 },
      { ratio: "16:9", value: 16 / 9 },
      { ratio: "9:16", value: 9 / 16 },
    ];

    const targetRatio = width / height;

    let closestRatio = simplifiedRatio;
    let minDifference = Infinity;

    for (const common of commonRatios) {
      const difference = Math.abs(common.value - targetRatio);
      if (difference < minDifference) {
        minDifference = difference;
        closestRatio = common.ratio;
      }
    }

    return closestRatio;
  }

  /**
   * 使用 RAG Chain 进行流式对话
   * 将 LangChain 流式响应转换为 RxJS Observable
   * @returns Observable 和一个用于存储完整回复的引用
   */
  private async streamRAGChain(
    userId: number,
    query: string,
    chatHistory: BaseMessage[],
    systemPrompt: string,
    apiKey: string,
    baseURL: string,
    modelName: string,
    options: {
      topK?: number;
      minSimilarity?: number;
      useMemory?: boolean;
      chatId?: string;
    } = {},
  ): Promise<{
    observable: Observable<ChatSseEvent>;
    fullReplyRef: { value: string };
    assistantKey: string;
    assistantTime: string;
  }> {
    const {
      topK = 5,
      minSimilarity = 0.2,
      useMemory = false,
      chatId,
    } = options;
    const assistantKey = this.getRandomKey();
    const assistantTime = this.formatChineseTime(new Date());
    const fullReplyRef = { value: "" };

    // 1. 创建 HybridRetriever
    const retriever = await this.knowledgeService.createRetriever(userId, {
      limit: topK,
      minSimilarity,
    });

    this.logger.log(
      `Creating ChatOpenAI with apiKey: ${apiKey ? "provided" : "MISSING"}, baseURL: ${baseURL || "MISSING"}, model: ${modelName}`,
    );

    // 2. 创建 ChatOpenAI 实例
    const llm = this.createChatOpenAI(apiKey, baseURL, modelName);

    // 3. 创建 RAG Chain
    const ragChain = RAGChainFactory.createCustomRAGChain(
      llm,
      retriever,
      systemPrompt,
      useMemory,
      useMemory
        ? (sessionId: string) => {
            return new PrismaChatMessageHistory({
              sessionId,
              userId,
              prismaService: this.prisma,
            });
          }
        : undefined,
    );

    this.logger.log(`RAG Chain created successfully for user ${userId}`);

    // 4. 执行流式调用并转换为 Observable
    const observable = new Observable(
      (subscriber: Subscriber<ChatSseEvent>) => {
        void (async () => {
          try {
            const stream = await ragChain.stream(
              {
                input: query,
                chat_history: useMemory ? undefined : chatHistory,
              },
              useMemory && chatId
                ? { configurable: { sessionId: chatId } }
                : undefined,
            );

            for await (const chunk of stream) {
              // chunk 是字符串片段
              if (chunk) {
                fullReplyRef.value += chunk as string;
                subscriber.next({
                  data: {
                    content: chunk as string,
                    reasoningContent: "",
                    isFinishThinking: true,
                    chatId: undefined,
                    key: assistantKey,
                    time: assistantTime,
                  },
                });
              }
            }

            subscriber.complete();
          } catch (error: unknown) {
            const message = error instanceof Error ? error.message : "未知错误";
            this.logger.error(`RAG Chain stream error: ${message}`);
            subscriber.error(
              new BadRequestException(`RAG Chain 流式调用失败: ${message}`),
            );
          }
        })();
      },
    );

    return { observable, fullReplyRef, assistantKey, assistantTime };
  }

  /**
   * 保存对话到数据库
   * 统一的消息存储逻辑，供 RAG Chain 和 OpenAI SDK 流程共用
   */
  private async saveConversation(
    userId: number,
    chatId: string,
    isNewConversation: boolean,
    newMessages: StoredMessage[],
    apiKey: string,
    baseURL: string,
    modelName: string,
    userContent: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // 如果是新对话，先创建对话记录并生成标题
      if (isNewConversation) {
        const title = await this.generateConversationTitle(
          apiKey,
          baseURL,
          modelName,
          userContent,
        );
        await tx.userConversation.create({
          data: {
            id: chatId,
            userId: userId,
            title: title,
          },
        });
      }

      // 获取已有的对话详情
      const existingDetail = await tx.conversationDetail.findFirst({
        where: { conversationId: chatId },
      });

      if (existingDetail) {
        const currentContent = Array.isArray(existingDetail.content)
          ? (existingDetail.content as unknown as StoredMessage[])
          : [existingDetail.content as unknown as StoredMessage];

        await tx.conversationDetail.update({
          where: { id: existingDetail.id },
          data: {
            content: [...currentContent, ...newMessages] as unknown as object[],
          },
        });
      } else {
        // 如果不存在，则创建新记录
        await tx.conversationDetail.create({
          data: {
            conversationId: chatId,
            content: newMessages as unknown as object[],
          },
        });
      }

      // 更新对话最后活跃时间
      if (!isNewConversation) {
        await tx.userConversation.update({
          where: { id: chatId },
          data: { updatedAt: new Date() },
        });
      }
    });
  }

  async chatStream(
    userId: number | undefined,
    dto: ChatDto,
  ): Promise<Observable<ChatSseEvent>> {
    // 1. 获取用户模型配置
    const modelConfig = userId
      ? await this.prisma.modelConfig.findUnique({
          where: { userId },
        })
      : null;

    const apiKey =
      modelConfig?.apiKey || this.configService.get<string>("DEFAULT_API_KEY");
    const baseURL =
      modelConfig?.baseURL ||
      this.configService.get<string>("DEFAULT_BASE_URL");
    const modelName = dto.model || "deepseek-v3.1";

    // 校验图片处理模型限制
    if (dto.images && dto.images.length > 0 && modelName !== "qwen3-vl-plus") {
      throw new BadRequestException(
        `模型 "${modelName}" 不支持图片处理，请切换至 "qwen3-vl-plus" 模型。`,
      );
    }

    if (!apiKey || !baseURL) {
      throw new BadRequestException("未配置个人 API Key 和 Base URL");
    }

    // 2. 确定 chatId 和获取上下文
    let chatId = dto.chatId;
    let isNewConversation = false;
    const messages: ChatMessage[] = [];

    if (userId) {
      if (chatId) {
        const conversation = await this.prisma.userConversation.findUnique({
          where: { id: chatId },
        });
        if (!conversation) throw new NotFoundException("对话不存在");
        if (conversation.userId !== userId)
          throw new UnauthorizedException("无权访问该对话");

        // 处理重新生成/编辑逻辑
        if (dto.isRegenerate && chatId) {
          const detail = await this.prisma.conversationDetail.findFirst({
            where: { conversationId: chatId },
          });

          if (detail && Array.isArray(detail.content)) {
            const currentContent = detail.content as unknown as StoredMessage[];
            if (currentContent.length > 0) {
              // 查找最后一条助理消息和其对应的用户消息
              let lastIndex = currentContent.length - 1;
              if (currentContent[lastIndex].role === "assistant") {
                currentContent.pop();
                lastIndex--;
              }
              if (lastIndex >= 0 && currentContent[lastIndex].role === "user") {
                currentContent.pop();
              }

              await this.prisma.conversationDetail.update({
                where: { id: detail.id },
                data: {
                  content: currentContent as unknown as object[],
                },
              });
            }
          }
        }

        const details = await this.prisma.conversationDetail.findMany({
          where: { conversationId: chatId },
          orderBy: { createdAt: "asc" },
        });

        details.forEach((detail) => {
          const content = detail.content;
          if (Array.isArray(content)) {
            content.forEach((msg: unknown) => {
              const storedMsg = msg as StoredMessage;
              if (
                storedMsg.role === "assistant" &&
                Array.isArray(storedMsg.content)
              ) {
                let combinedContent = "";
                let reasoningContent = "";
                const imageUrls: string[] = [];
                const contentParts = storedMsg.content as unknown as (
                  | StoredMessageContentPart
                  | ImageContentPart
                  | FileContentPart
                )[];
                contentParts.forEach((part) => {
                  if (part.type === "thinking") reasoningContent += part.data;
                  if (part.type === "content") combinedContent += part.data;
                  if (part.type === "image") {
                    const imagePart = part as unknown as ImageContentPart;
                    imageUrls.push(imagePart.data.url);
                  }
                  if (part.type === "file") {
                    const filePart = part as unknown as FileContentPart;
                    combinedContent += `\n\n文件: ${filePart.data.fileName}\n链接: ${filePart.data.url}`;
                  }
                });
                messages.push({
                  role: "assistant",
                  content: combinedContent,
                  reasoning_content: reasoningContent || undefined,
                  images: imageUrls.length > 0 ? imageUrls : undefined,
                });
              } else if (
                storedMsg.role === "user" &&
                Array.isArray(storedMsg.content)
              ) {
                let combinedContent = "";
                const imageUrls: string[] = [];
                const contentParts = storedMsg.content as unknown as (
                  | StoredMessageContentPart
                  | ImageContentPart
                  | FileContentPart
                )[];
                contentParts.forEach((part) => {
                  if (part.type === "content") combinedContent += part.data;
                  if (part.type === "image") {
                    const imagePart = part as unknown as ImageContentPart;
                    imageUrls.push(imagePart.data.url);
                  }
                  if (part.type === "file") {
                    const filePart = part as unknown as FileContentPart;
                    combinedContent += `\n\n文件: ${filePart.data.fileName}\n链接: ${filePart.data.url}`;
                  }
                });
                messages.push({
                  role: "user",
                  content: combinedContent,
                  images: imageUrls.length > 0 ? imageUrls : undefined,
                });
              } else if (
                typeof storedMsg.content === "string" &&
                (storedMsg.role === "user" ||
                  storedMsg.role === "assistant" ||
                  storedMsg.role === "system")
              ) {
                messages.push({
                  role: storedMsg.role,
                  content: storedMsg.content,
                  reasoning_content: storedMsg.reasoning_content,
                });
              }
            });
          } else if (
            typeof content === "object" &&
            content !== null &&
            "role" in content &&
            "content" in content
          ) {
            const storedMsg = content as unknown as StoredMessage;
            if (typeof storedMsg.content === "string") {
              messages.push({
                role: storedMsg.role,
                content: storedMsg.content,
                reasoning_content: storedMsg.reasoning_content,
              });
            }
          }
        });
      } else {
        chatId = crypto.randomUUID();
        isNewConversation = true;
      }
    } else {
      chatId = "";
    }

    // 获取系统提示词 (动态获取用户当前选择的角色)
    let systemContent =
      "你是一个专业、精准、高效的智能问答助手，名字叫Mirror。";
    if (userId) {
      systemContent = await this.roleService.getUserSystemPrompt(userId);
    }

    // 3. 判断是否使用 RAG Chain（启用知识库且有用户ID）
    const useRAGChain =
      dto.enableKnowledge &&
      userId &&
      !dto.images?.length &&
      !dto.files?.length;

    // 获取 LangChain Memory 配置
    const useLangChainMemory =
      this.configService.get<string>("USE_LANGCHAIN_MEMORY") === "true";

    // if (!useRAGChain && dto.enableKnowledge && userId) {
    //   const searchResult = await this.knowledgeService.search(
    //     userId,
    //     dto.content,
    //     dto.topK ?? 5,
    //     dto.minSimilarity ?? 0.2,
    //   );
    //   if (searchResult.success && searchResult.results.length > 0) {
    //     const knowledgeContext = `
    //       ## 参考资料（按相关性排序）
    //       ${searchResult.results
    //         .map(
    //           (res, i) => `
    //         ### 资料 ${i + 1} [相似度: ${(res.similarity * 100).toFixed(1)}%]
    //           - 来源: ${res.fileName}
    //           - 内容: ${res.content}
    //         `,
    //         )
    //         .join("\n\n")}
    //       ## 回答要求
    //         1. 优先使用上述参考资料回答
    //         2. 若资料不足，可结合自身知识补充
    //     `;
    //     systemContent += `\n\n以下是与用户问题相关的参考资料，请优先根据这些内容进行回答，若资料不足以回答问题，请根据自己的知识进行回答：\n\n${knowledgeContext}`;
    //   }
    // }

    messages.unshift({
      role: "system",
      content: systemContent,
    });

    // 构建用户消息内容（支持多模态）
    const userContentParts: MessageContentPart[] = [];

    // 添加文本内容
    let finalContent = dto.content;

    // 准备存储的消息内容片段
    const userMessageContent: (
      | StoredMessageContentPart
      | ImageContentPart
      | FileContentPart
    )[] = [];

    // 添加图像
    if (dto.images && dto.images.length > 0) {
      for (const image of dto.images) {
        let imageUrl: string | undefined;
        let imageBase64: string | undefined;
        let mimeType = "image/png";
        let fileName = `image-${Date.now()}-${this.getRandomKey()}.png`;

        if (typeof image === "string") {
          imageUrl = image;
          if (image.startsWith("data:")) {
            const matches = image.match(/^data:(.+);base64,(.+)$/);
            if (matches) {
              mimeType = matches[1];
              imageBase64 = matches[2];
              const extension = mimeType.split("/")[1] || "png";
              fileName = `image-${Date.now()}-${this.getRandomKey()}.${extension}`;
            }
          }
        } else if (typeof image === "object" && image !== null) {
          imageUrl = image.url;
          imageBase64 = image.base64;
          mimeType = image.mimeType || "image/png";
          const extension = mimeType.split("/")[1] || "png";
          fileName = `image-${Date.now()}-${this.getRandomKey()}.${extension}`;
        }

        if (imageUrl || imageBase64) {
          let finalImageUrl = imageUrl;

          if (imageBase64 || (imageUrl && imageUrl.startsWith("data:"))) {
            const dataToUpload =
              imageBase64 ||
              (imageUrl && imageUrl.startsWith("data:")
                ? imageUrl.split(",")[1]
                : "");
            if (dataToUpload) {
              try {
                const uploadResult = await this.uploadToSupabase(
                  dataToUpload,
                  fileName,
                  mimeType,
                );
                finalImageUrl = uploadResult.url;
                fileName = uploadResult.fileName;
                mimeType = uploadResult.mimeType;
                const size = uploadResult.size;

                if (finalImageUrl) {
                  userContentParts.push({
                    type: "image_url",
                    image_url: {
                      url: finalImageUrl,
                    },
                  });

                  // 添加到存储的消息
                  userMessageContent.push({
                    type: "image",
                    data: {
                      fileName,
                      mimeType,
                      size,
                      url: finalImageUrl,
                      uploadedAt: this.formatChineseTime(new Date()),
                    },
                  });
                }
              } catch (error) {
                console.error("图片上传失败:", error);
                finalImageUrl =
                  imageUrl || `data:${mimeType};base64,${imageBase64}`;

                if (finalImageUrl) {
                  userContentParts.push({
                    type: "image_url",
                    image_url: {
                      url: finalImageUrl,
                    },
                  });

                  // 添加到存储的消息
                  userMessageContent.push({
                    type: "image",
                    data: {
                      fileName,
                      mimeType,
                      size: 0,
                      url: finalImageUrl,
                      uploadedAt: this.formatChineseTime(new Date()),
                    },
                  });
                }
              }
            }
          } else if (finalImageUrl) {
            userContentParts.push({
              type: "image_url",
              image_url: {
                url: finalImageUrl,
              },
            });

            // 添加到存储的消息
            userMessageContent.push({
              type: "image",
              data: {
                fileName,
                mimeType,
                size: 0,
                url: finalImageUrl,
                uploadedAt: this.formatChineseTime(new Date()),
              },
            });
          }
        }
      }
    }

    // 添加文件内容
    if (dto.files && dto.files.length > 0) {
      let filesText = "\n\n以下是用户上传的文件内容：\n";
      for (const file of dto.files) {
        filesText += `\n文件名: ${file.fileName}\n`;
        filesText += `类型: ${file.mimeType}\n`;
        if (file.size) {
          filesText += `大小: ${(file.size / 1024).toFixed(2)} KB\n`;
        }
        filesText += `内容:\n${file.content}\n`;
        filesText += "---";

        // 上传文件到 Supabase
        // try {
        //   // 优先使用原始文件的 base64，如果没有则使用解析后的 content
        //   const base64Data =
        //     file.base64 ||
        //     (/^[A-Za-z0-9+/]*={0,2}$/.test(file.content)
        //       ? file.content
        //       : Buffer.from(file.content).toString("base64"));

        //   const uploadResult = await this.uploadToSupabase(
        //     base64Data,
        //     file.fileName,
        //     file.mimeType,
        //   );

        //   const fileType =
        //     uploadResult.fileName.split(".").pop()?.toLowerCase() || "";

        //   // 添加到存储的消息
        //   userMessageContent.push({
        //     type: "file",
        //     data: {
        //       fileName: uploadResult.fileName,
        //       mimeType: uploadResult.mimeType,
        //       size: uploadResult.size,
        //       url: uploadResult.url,
        //       uploadedAt: this.formatChineseTime(new Date()),
        //       fileType,
        //     },
        //   });
        // } catch (error) {
        //   console.error(`文件 ${file.fileName} 上传失败:`, error);
        //   const fileType = file.fileName.split(".").pop()?.toLowerCase() || "";
        //   userMessageContent.push({
        //     type: "file",
        //     data: {
        //       fileName: file.fileName,
        //       mimeType: file.mimeType,
        //       size: file.size || 0,
        //       url: "",
        //       uploadedAt: this.formatChineseTime(new Date()),
        //       fileType,
        //     },
        //   });
        // }
        const fileType = file.fileName.split(".").pop()?.toLowerCase() || "";
        userMessageContent.push({
          type: "file",
          data: {
            fileName: file.fileName,
            mimeType: file.mimeType,
            size: file.size || 0,
            url: "", // 不存储文件，无下载链接
            uploadedAt: this.formatChineseTime(new Date()),
            fileType,
          },
        });
      }
      finalContent += filesText;
    }

    userContentParts.push({
      type: "text",
      text: finalContent,
    });

    userMessageContent.push({
      type: "content",
      data: dto.content,
    });

    const userMessage: StoredMessage = {
      role: "user",
      content: userMessageContent,
      key: this.getRandomKey(),
      time: this.formatChineseTime(new Date()),
    };

    // 给 OpenAI 的消息格式（多模态内容）
    messages.push({
      role: "user",
      content:
        userContentParts.length === 1 && userContentParts[0].type === "text"
          ? userContentParts[0].text || dto.content
          : userContentParts,
    });

    // 4. 如果启用知识库且无图片/文件，使用 RAG Chain 进行流式处理
    if (useRAGChain) {
      this.logger.log(`Using RAG Chain for user ${userId}`);

      // 将历史消息转换为 LangChain BaseMessage 格式
      const chatHistory = this.convertToBaseMessages(messages);

      // 调用 RAG Chain 流式处理
      const ragResult = await this.streamRAGChain(
        userId,
        dto.content,
        chatHistory,
        systemContent,
        apiKey,
        baseURL,
        modelName,
        {
          topK: dto.topK ?? 5,
          minSimilarity: dto.minSimilarity ?? 0.2,
          useMemory: useLangChainMemory,
          chatId: chatId || undefined,
        },
      );

      // 包装 Observable 以添加消息存储逻辑
      return new Observable((subscriber) => {
        void (() => {
          let fullReply = "";

          ragResult.observable.subscribe({
            next: (event) => {
              fullReply += event.data.content;
              // 更新 chatId
              event.data.chatId = chatId || undefined;
              subscriber.next(event);
            },
            complete: () => {
              // 保存消息到数据库
              if (userId && chatId) {
                if (useLangChainMemory) {
                  // 如果启用了 LangChain Memory，消息保存由 Memory 自动处理
                  // 但如果是新对话，我们需要更新标题
                  if (isNewConversation) {
                    const title = await this.generateConversationTitle(
                      apiKey,
                      baseURL,
                      modelName,
                      dto.content,
                    );
                    await this.prisma.userConversation.update({
                      where: { id: chatId },
                      data: { title },
                    });
                  }
                } else {
                  const assistantContent: StoredMessageContentPart[] = [];
                  if (fullReply) {
                    assistantContent.push({ type: "content", data: fullReply });
                  }

                  const newMessages: StoredMessage[] = [
                    {
                      role: "user",
                      content: userMessage.content,
                      key: userMessage.key,
                      time: userMessage.time,
                    },
                    {
                      role: "assistant",
                      content: assistantContent,
                      key: ragResult.assistantKey,
                      time: ragResult.assistantTime,
                      isFinishThinking: true,
                    },
                  ];

                  await this.saveConversation(
                    userId,
                    chatId,
                    isNewConversation,
                    newMessages,
                    apiKey,
                    baseURL,
                    modelName,
                    dto.content,
                  );
                }
              }
              subscriber.complete();
            },
            error: (error) => {
              subscriber.error(error);
            },
          });
        })();
      });
    }

    // 5. 常规流程：使用 OpenAI SDK 进行流式处理
    const openai = new OpenAI({
      apiKey: apiKey,
      baseURL: baseURL,
    });

    return new Observable((subscriber) => {
      void (async () => {
        try {
          const stream = (await openai.chat.completions.create({
            model: modelName,
            messages: messages,
            stream: true,
            enable_thinking: dto.enableThinking,
            enable_search: dto.enableSearch,
            stream_options: dto.enableSearch
              ? {
                  include_usage: true,
                  forced_search: dto.enableSearch,
                }
              : undefined,
          } as Parameters<
            typeof openai.chat.completions.create
          >[0])) as AsyncIterable<StreamChunk>;

          let fullReply = "";
          let fullReasoning = "";
          let hasStartedAnswer = false;

          // 预先生成助手的 key 和 time，确保整个流中一致
          const assistantKey = this.getRandomKey();
          const assistantTime = this.formatChineseTime(new Date());

          for await (const chunk of stream) {
            const delta = chunk.choices[0]?.delta;
            if (!delta) continue;

            const content: string = delta.content || "";
            const reasoning: string = delta.reasoning_content || "";

            if (reasoning) {
              fullReasoning += reasoning;
            }

            if (content) {
              if (!hasStartedAnswer) {
                hasStartedAnswer = true;
              }
              fullReply += content;
            }

            subscriber.next({
              data: {
                content,
                reasoningContent: reasoning,
                isFinishThinking: hasStartedAnswer,
                chatId: chatId || undefined,
                key: assistantKey,
                time: assistantTime,
              },
            });
          }

          // 6. 只有已登录用户才保存对话详情
          if (userId && chatId) {
            const assistantContent: StoredMessageContentPart[] = [];
            if (fullReasoning) {
              assistantContent.push({ type: "thinking", data: fullReasoning });
            }
            if (fullReply) {
              assistantContent.push({ type: "content", data: fullReply });
            }

            const newMessages: StoredMessage[] = [
              {
                role: "user",
                content: userMessage.content,
                key: userMessage.key,
                time: userMessage.time,
              },
              {
                role: "assistant",
                content: assistantContent,
                key: assistantKey,
                time: assistantTime,
                isFinishThinking: true,
              },
            ];

            await this.saveConversation(
              userId,
              chatId,
              isNewConversation,
              newMessages,
              apiKey,
              baseURL,
              modelName,
              dto.content,
            );
          }

          subscriber.complete();
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : "未知错误";
          subscriber.error(
            new BadRequestException(`大模型流式调用失败: ${message}`),
          );
        }
      })();
    });
  }

  /**
   * 压缩图片
   * @param buffer 图片 Buffer
   * @param mimeType MIME 类型
   * @returns 压缩后的 Buffer 和新的 MIME 类型
   */
  private async compressImage(
    buffer: Buffer,
    mimeType: string,
  ): Promise<{ buffer: Buffer; mimeType: string }> {
    if (
      !mimeType.startsWith("image/") ||
      mimeType === "image/gif" ||
      mimeType === "image/svg+xml" ||
      mimeType === "image/webp"
    ) {
      return { buffer, mimeType };
    }

    try {
      const sharpModule = await import("sharp");
      const sharp = (
        sharpModule as unknown as { default: typeof import("sharp") }
      ).default;

      let pipeline = sharp(buffer);
      const metadata = await pipeline.metadata();

      // 如果图片过大，进行等比例缩放，最大宽度 2048
      if (metadata.width && metadata.width > 2048) {
        pipeline = pipeline.resize(2048, null, {
          withoutEnlargement: true,
          fit: "inside",
        });
      }

      // 转换为 webp 格式，在保证高质量（quality: 80）的前提下尽可能压缩体积
      const compressedBuffer = await pipeline
        .webp({
          quality: 80,
          effort: 4, // 0-6, 4 is a good balance between speed and compression
        })
        .toBuffer();

      // 如果压缩后的体积反而变大了（极少数情况），则返回原图
      if (compressedBuffer.length >= buffer.length) {
        return { buffer, mimeType };
      }

      return { buffer: compressedBuffer, mimeType: "image/webp" };
    } catch (error) {
      console.error("图片压缩失败:", error);
      return { buffer, mimeType };
    }
  }

  /**
   * 上传文件到 Supabase Storage
   * @param data Base64 字符串或 Buffer
   * @param fileName 文件名
   * @param mimeType MIME 类型
   * @param bucket 存储桶名称
   * @returns 公开访问 URL 和文件元数据
   */
  private async uploadToSupabase(
    data: string | Buffer,
    fileName: string,
    mimeType: string,
    bucket = "mirror",
  ): Promise<{
    url: string;
    size: number;
    mimeType: string;
    fileName: string;
  }> {
    if (!this.supabase) {
      throw new BadRequestException("Supabase 未配置，无法上传文件");
    }

    let buffer = typeof data === "string" ? Buffer.from(data, "base64") : data;
    let finalMimeType = mimeType;
    let finalFileName = fileName;

    // 如果是图片且不是 gif/svg，尝试压缩
    if (
      mimeType.startsWith("image/") &&
      mimeType !== "image/gif" &&
      mimeType !== "image/svg+xml"
    ) {
      const compressed = await this.compressImage(buffer, mimeType);
      buffer = compressed.buffer;
      finalMimeType = compressed.mimeType;

      // 如果格式转换为 webp，更新文件名后缀
      if (finalMimeType === "image/webp" && !finalFileName.endsWith(".webp")) {
        const nameWithoutExt = finalFileName.includes(".")
          ? finalFileName.substring(0, finalFileName.lastIndexOf("."))
          : finalFileName;
        finalFileName = `${nameWithoutExt}.webp`;
      }
    }

    const path = `${Date.now()}-${finalFileName}`;

    const { error } = await this.supabase.storage
      .from(bucket)
      .upload(path, buffer, {
        contentType: finalMimeType,
        upsert: true,
      });

    if (error) {
      throw new Error(`文件上传到 Supabase 失败: ${error.message}`);
    }

    const {
      data: { publicUrl },
    } = this.supabase.storage.from(bucket).getPublicUrl(path);

    return {
      url: publicUrl,
      size: buffer.length,
      mimeType: finalMimeType,
      fileName: finalFileName,
    };
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
    if (content.trim().length <= 30) {
      return content.trim() || "新对话";
    }

    try {
      const openai = new OpenAI({ apiKey, baseURL });
      const titlePrompt: ChatMessage = {
        role: "system",
        content:
          "你是一个专业的标题生成助手。请根据以下对话内容生成一个简洁、准确的标题，标题不超过15个字，不要使用引号或其他标点符号。",
      };

      const titleUserMessage: ChatMessage = {
        role: "user",
        content:
          content.length > 200 ? content.substring(0, 200) + "..." : content,
      };

      const response = await openai.chat.completions.create({
        model: modelName,
        messages: [titlePrompt, titleUserMessage] as Parameters<
          typeof openai.chat.completions.create
        >[0]["messages"],
        temperature: 0.7,
        max_tokens: 20,
      });

      let title = response.choices[0]?.message?.content?.trim() || "";
      title = title.replace(/^["'""]+|["'""]+$/g, "");

      return title || "新对话";
    } catch (error: unknown) {
      console.error("生成标题失败: ", error);
      return content.substring(0, 20) || "新对话";
    }
  }

  /**
   * 生成随机 Key
   */
  private getRandomKey(): string {
    return crypto.randomBytes(8).toString("hex");
  }

  /**
   * 格式化中国时间
   */
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

  /**
   * 下载并保存图片到云存储
   * @param imageUrl 远程图片URL
   * @param chatId 对话ID（用于子目录命名）
   * @returns 图片元数据
   */
  private async downloadAndSaveImage(
    imageUrl: string,
    chatId: string,
  ): Promise<StoredImageMetadata> {
    const response = await axios.get(imageUrl, {
      responseType: "arraybuffer",
    });

    const buffer = Buffer.from(response.data);
    const contentType = response.headers["content-type"] as string | undefined;
    const initialMimeType = contentType || "image/jpeg";

    // 压缩图片
    const { buffer: compressedBuffer, mimeType } = await this.compressImage(
      buffer,
      initialMimeType,
    );

    let extension = mimeType.split("/")[1] || "jpg";
    if (extension === "jpeg") extension = "jpg";

    const fileName = `${crypto.randomBytes(16).toString("hex")}.${extension}`;

    let width: number | undefined;
    let height: number | undefined;
    try {
      const sharpModule = await import("sharp");
      const sharp = (
        sharpModule as unknown as { default: typeof import("sharp") }
      ).default;
      const metadata = await sharp(compressedBuffer).metadata();
      width = metadata.width;
      height = metadata.height;
    } catch {
      // 忽略尺寸获取错误
    }

    const ratio =
      width && height ? this.calculateAspectRatio(width, height) : undefined;

    if (!this.supabase) {
      throw new Error("Supabase 未配置，无法上传图片");
    }

    const { data, error } = await this.supabase.storage
      .from("mirror")
      .upload(`${chatId}/${fileName}`, compressedBuffer, {
        contentType: mimeType,
        upsert: false,
      });

    if (error) {
      throw new Error(`上传图片到云存储失败: ${error.message}`);
    }

    const {
      data: { publicUrl },
    } = this.supabase.storage.from("mirror").getPublicUrl(data.path);

    return {
      fileName,
      mimeType,
      size: compressedBuffer.length,
      width,
      height,
      ratio,
      localPath: data.path,
      url: publicUrl,
      uploadedAt: this.formatChineseTime(new Date()),
    };
  }

  /**
   * 图片生成
   * @param userId 用户 ID
   * @param dto 图片生成参数
   * @returns 生成的图片 URL 和对话ID
   */
  async generateImage(
    userId: number | undefined,
    dto: ImageGenerationDto,
  ): Promise<ImageGenerationResponseDto> {
    const modelConfig =
      userId && dto.userId
        ? await this.prisma.modelConfig.findUnique({
            where: { userId: dto.userId },
          })
        : null;

    const apiKey =
      modelConfig?.apiKey || this.configService.get<string>("DEFAULT_API_KEY");

    if (!apiKey) {
      throw new BadRequestException("未配置 API Key");
    }

    let chatId = dto.chatId;
    let isNewConversation = false;
    const effectiveUserId = dto.userId || userId;

    if (effectiveUserId) {
      if (chatId) {
        const conversation = await this.prisma.userConversation.findUnique({
          where: { id: chatId },
        });

        if (!conversation) {
          throw new NotFoundException("对话不存在");
        }

        if (conversation.userId !== effectiveUserId) {
          throw new UnauthorizedException("无权访问该对话");
        }

        if (dto.isRegenerate) {
          const detail = await this.prisma.conversationDetail.findFirst({
            where: { conversationId: chatId },
          });

          if (detail && Array.isArray(detail.content)) {
            const currentContent = detail.content as unknown as StoredMessage[];
            if (currentContent.length > 0) {
              let lastIndex = currentContent.length - 1;
              if (currentContent[lastIndex].role === "assistant") {
                currentContent.pop();
                lastIndex--;
              }
              if (lastIndex >= 0 && currentContent[lastIndex].role === "user") {
                currentContent.pop();
              }

              await this.prisma.conversationDetail.update({
                where: { id: detail.id },
                data: {
                  content: currentContent as unknown as object[],
                },
              });
            }
          }
        }
      } else {
        chatId = crypto.randomUUID();
        isNewConversation = true;
      }
    } else {
      chatId = "";
    }

    const model = dto.model || "qwen-image-max";

    const requestBody: {
      model: string;
      input: {
        messages: Array<{
          role: string;
          content: Array<{ text: string }>;
        }>;
      };
      parameters?: {
        size?: string;
        negative_prompt?: string;
        prompt_extend?: boolean;
        watermark?: boolean;
      };
    } = {
      model,
      input: {
        messages: [
          {
            role: "user",
            content: [
              {
                text: `请根据以下描述生成图片：${dto.prompt}`,
              },
            ],
          },
        ],
      },
    };

    if (dto.negative_prompt || dto.size || dto.prompt_extend || dto.watermark) {
      requestBody.parameters = {};

      if (dto.negative_prompt) {
        requestBody.parameters.negative_prompt = dto.negative_prompt;
      }

      if (dto.size) {
        requestBody.parameters.size = dto.size;
      }

      if (dto.prompt_extend) {
        requestBody.parameters.prompt_extend = dto.prompt_extend;
      }

      if (dto.watermark) {
        requestBody.parameters.watermark = dto.watermark;
      }
    }

    try {
      const response = await axios.post<AliyunImageResponse>(
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
        requestBody,
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          timeout: 0,
        },
      );

      const data = response.data;

      if (data.output?.choices && data.output.choices.length > 0) {
        const choice = data.output.choices[0];
        const imageContent = choice.message?.content?.[0];
        const remoteImageUrl = imageContent?.image;

        if (!remoteImageUrl) {
          throw new BadRequestException("图片生成成功但未返回 URL");
        }

        const imageMetadata =
          effectiveUserId && chatId
            ? await this.downloadAndSaveImage(remoteImageUrl, chatId)
            : null;

        if (effectiveUserId && chatId && imageMetadata) {
          const userMessage: StoredMessage = {
            role: "user",
            content: [
              {
                type: "content",
                data: dto.prompt,
              },
            ],
            key: this.getRandomKey(),
            time: this.formatChineseTime(new Date()),
          };

          const assistantMessage: StoredMessage = {
            role: "assistant",
            content: [
              {
                type: "image",
                data: imageMetadata,
              },
            ],
            key: this.getRandomKey(),
            time: this.formatChineseTime(new Date()),
          };

          if (isNewConversation) {
            await this.prisma.userConversation.create({
              data: {
                id: chatId,
                userId: effectiveUserId,
                title: dto.prompt.substring(0, 30) || "图片生成",
              },
            });
          }

          const existingDetail = await this.prisma.conversationDetail.findFirst(
            {
              where: { conversationId: chatId },
            },
          );

          const newMessages: StoredMessage[] = [userMessage, assistantMessage];

          if (existingDetail) {
            const currentContent = Array.isArray(existingDetail.content)
              ? (existingDetail.content as unknown as StoredMessage[])
              : [existingDetail.content as unknown as StoredMessage];

            await this.prisma.conversationDetail.update({
              where: { id: existingDetail.id },
              data: {
                content: [
                  ...currentContent,
                  ...newMessages,
                ] as unknown as object[],
              },
            });
          } else {
            await this.prisma.conversationDetail.create({
              data: {
                conversationId: chatId,
                content: newMessages as unknown as object[],
              },
            });
          }

          if (!isNewConversation) {
            await this.prisma.userConversation.update({
              where: { id: chatId },
              data: { updatedAt: new Date() },
            });
          }
        }

        const imageUrl = imageMetadata?.url || remoteImageUrl;

        return {
          chatId: chatId || "",
          url: imageUrl,
          requestId: data.request_id,
        };
      } else {
        const errorMessage = data.message || "响应格式异常";
        throw new BadRequestException(`图片生成失败: ${errorMessage}`);
      }
    } catch (error) {
      if (axios.isAxiosError(error)) {
        const errorData = error.response?.data as
          | AliyunImageResponse
          | undefined;
        const errorMessage = errorData?.message || error.message;
        const statusCode = error.response?.status;
        throw new BadRequestException(
          `阿里云图片生成失败 (${statusCode}): ${errorMessage}`,
        );
      }
      throw new BadRequestException(
        `图片生成失败: ${error instanceof Error ? error.message : "未知错误"}`,
      );
    }
  }
}
