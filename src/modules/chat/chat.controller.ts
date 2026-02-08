import {
  Controller,
  Post,
  Body,
  Request,
  HttpCode,
  HttpStatus,
  Res,
  UseGuards,
  Injectable,
  UseInterceptors,
  UploadedFiles,
  BadRequestException,
} from "@nestjs/common";
import { FileFieldsInterceptor } from "@nestjs/platform-express";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
} from "@nestjs/swagger";
import { ChatService } from "./chat.service";
import {
  ChatDto,
  ImageData,
  FileData,
  ImageGenerationDto,
  ImageGenerationResponseDto,
} from "./chat.dto";
import { Response, Request as ExpressRequest } from "express";
import { AuthGuard } from "@nestjs/passport";
import { UserDto } from "../user/user.dto";
import { readFileSync } from "fs";
import WordExtractor from "word-extractor";
import pdf from "pdf-parse";
import * as mammoth from "mammoth";

// 定义带用户信息的请求接口
interface AuthenticatedRequest extends ExpressRequest {
  user?: UserDto;
}

// 定义 SSE 事件数据接口
interface SseEvent {
  data?: unknown;
}

@Injectable()
export class OptionalJwtAuthGuard extends AuthGuard("jwt") {
  handleRequest<UserDto>(
    _err: Error | null,
    user: UserDto | false,
  ): UserDto | null {
    // 如果有错误或没有用户，不抛出异常，只返回 null
    // 这样 req.user 在未登录时为 undefined，在已登录时为用户信息
    return user || null;
  }
}

@ApiTags("Chat")
@Controller("chat")
export class ChatController {
  constructor(private readonly chatService: ChatService) {}

  @Post()
  @UseGuards(OptionalJwtAuthGuard)
  @UseInterceptors(
    FileFieldsInterceptor([
      { name: "images", maxCount: 10 }, // 最多 10 张图片
      { name: "files", maxCount: 5 }, // 最多 5 个文件
    ]),
  )
  @HttpCode(HttpStatus.OK)
  @ApiConsumes("multipart/form-data")
  @ApiOperation({ summary: "发送聊天消息（流式响应，支持多模态）" })
  @ApiResponse({ status: 200, description: "成功开始流式输出" })
  @ApiResponse({ status: 401, description: "未授权" })
  @ApiResponse({ status: 400, description: "请求参数错误或模型配置缺失" })
  async chat(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ChatDto,
    @Res() res: Response,
    @UploadedFiles()
    uploadedFiles?: {
      images?: Express.Multer.File[];
      files?: Express.Multer.File[];
    },
  ): Promise<void> {
    const userId = req.user?.id;

    try {
      // 处理上传的图片
      if (uploadedFiles?.images && uploadedFiles.images.length > 0) {
        const imageData: ImageData[] = uploadedFiles.images.map((file) => {
          const buffer = file.buffer || readFileSync(file.path);
          const base64 = buffer.toString("base64");
          return {
            base64,
            mimeType: file.mimetype,
          };
        });

        const existingImages =
          dto.images && Array.isArray(dto.images) ? dto.images : [];

        dto.images = [...existingImages, ...imageData];
      }

      // 处理上传的文件
      if (uploadedFiles?.files && uploadedFiles.files.length > 0) {
        const fileData: FileData[] = await Promise.all(
          uploadedFiles.files.map(async (file) => {
            let content = "";
            // 解决文件名乱码问题
            const originalName = Buffer.from(
              file.originalname,
              "latin1",
            ).toString("utf8");
            const fileExtension =
              originalName.split(".").pop()?.toLowerCase() || "";

            const isTextFile =
              file.mimetype.startsWith("text/") ||
              file.mimetype === "application/json" ||
              ["md", "txt"].includes(fileExtension);

            const buffer = file.buffer || readFileSync(file.path);
            const base64 = buffer.toString("base64");

            if (isTextFile) {
              // 文本文件直接读取内容
              content = buffer.toString("utf-8");
            } else if (fileExtension === "pdf") {
              try {
                const data = await pdf(buffer);
                content = data.text;
              } catch (error) {
                throw new BadRequestException("PDF 解析失败: " + error);
              }
            } else if (fileExtension === "docx" || fileExtension === "doc") {
              // Word 文件提取文本
              try {
                let extractedText = "";
                const result = await mammoth.extractRawText({ buffer });
                extractedText = result.value || "";

                // 尝试 word-extractor
                if (!extractedText.trim()) {
                  try {
                    const extractor = new WordExtractor();
                    const extracted = await extractor.extract(buffer);
                    extractedText = extracted.getBody() || "";
                  } catch {
                    throw new BadRequestException(
                      "Word 文件解析失败：文件格式可能已损坏，或者不是有效的 .doc/.docx 文档",
                    );
                  }
                }
                content = extractedText;
              } catch (error) {
                throw new BadRequestException("Word 解析失败: " + error);
              }
            } else {
              // 其他二进制文件暂不提取内容，只记录文件信息
              content = `[文件: ${originalName}]`;
            }

            return {
              fileName: originalName,
              content,
              base64,
              mimeType: file.mimetype,
              size: file.size,
            };
          }),
        );

        const existingFiles =
          dto.files && Array.isArray(dto.files) ? dto.files : [];

        dto.files = [...existingFiles, ...fileData];
      }

      const observable = await this.chatService.chatStream(userId, dto);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");

      const subscription = observable.subscribe({
        next: (event: SseEvent) => {
          const data = event.data ? event.data : event;
          res.write(`data: ${JSON.stringify(data)}\n\n`);
        },
        error: () => {
          res.end();
        },
        complete: () => {
          res.end();
        },
      });

      req.on("close", () => {
        subscription.unsubscribe();
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "流式调用失败";
      res.status(HttpStatus.BAD_REQUEST).json({
        statusCode: HttpStatus.BAD_REQUEST,
        message,
      });
    }
  }

  @Post("generate-image")
  @UseGuards(OptionalJwtAuthGuard)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "通义万相图片生成（同步调用）" })
  @ApiResponse({
    status: 200,
    description: "图片生成成功",
    type: ImageGenerationResponseDto,
  })
  @ApiResponse({ status: 400, description: "请求参数错误或生成失败" })
  async generateImage(
    @Request() req: AuthenticatedRequest,
    @Body() dto: ImageGenerationDto,
  ): Promise<ImageGenerationResponseDto> {
    const userId = req.user?.id;
    return await this.chatService.generateImage(userId, dto);
  }
}
