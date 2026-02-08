import {
  IsString,
  IsOptional,
  IsNotEmpty,
  IsBoolean,
  IsNumber,
  IsArray,
} from "class-validator";
import { ApiProperty } from "@nestjs/swagger";

// 存储的消息内容片段类型
export interface StoredMessageContentPart {
  type: "thinking" | "content";
  data: string;
}

// 存储的图片元数据
export interface StoredImageMetadata {
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

// 图片内容片段类型
export interface ImageContentPart {
  type: "image";
  data: StoredImageMetadata;
}

// 存储的文件元数据
export interface StoredFileMetadata {
  fileName: string;
  mimeType: string;
  size: number;
  url: string;
  uploadedAt: string;
  fileType?: string; // 简化的文件类型
}

// 文件内容片段类型
export interface FileContentPart {
  type: "file";
  data: StoredFileMetadata;
}

// 存储的消息格式（支持图片和文件）
export interface StoredMessage {
  role: "system" | "user" | "assistant";
  content:
    | string
    | (StoredMessageContentPart | ImageContentPart | FileContentPart)[];
  key?: string;
  time?: string;
  reasoning_content?: string;
  isFinishThinking?: boolean;
  conversationId?: string;
}

// SSE 流式响应数据
export interface ChatStreamData {
  content: string;
  reasoningContent: string;
  isFinishThinking: boolean;
  chatId: string | undefined;
  key: string;
  time: string;
}

// SSE 事件结构
export interface ChatSseEvent {
  data: ChatStreamData;
}

// 图像数据接口
export interface ImageData {
  url?: string; // 图像 URL
  base64?: string; // 或 Base64 编码的图像数据
  mimeType?: string; // 图像 MIME 类型，如 image/jpeg, image/png
}

// 文件数据接口
export interface FileData {
  fileName: string; // 文件名
  content: string; // 文件解析后的文本内容
  base64?: string; // 原始文件的 Base64 编码（可选，用于上传）
  mimeType: string; // 文件 MIME 类型
  size?: number; // 文件大小（字节）
}

export class ChatDto {
  @ApiProperty({ description: "用户输入的内容", example: "你好" })
  @IsString()
  @IsNotEmpty()
  content: string;

  @ApiProperty({
    description: "图像数组（可选），支持 URL 或 Base64",
    example: [{ url: "https://example.com/image.jpg" }],
    required: false,
  })
  @IsArray()
  @IsOptional()
  images?: (ImageData | string)[];

  @ApiProperty({
    description: "文件数组（可选），用于文件分析",
    example: [
      { fileName: "document.txt", content: "...", mimeType: "text/plain" },
    ],
    required: false,
  })
  @IsArray()
  @IsOptional()
  files?: FileData[];

  @ApiProperty({
    description:
      "对话ID，首次调用时不传，后端生成并返回，后续调用带上以维持上下文",
    example: "conv_123456",
    required: false,
  })
  @IsString()
  @IsOptional()
  chatId?: string;

  @ApiProperty({
    description: "指定使用的模型名称，如 gpt-4, gpt-3.5-turbo 等",
    example: "gpt-4",
    required: false,
  })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiProperty({
    description: "是否开启深度思考",
    example: false,
    required: false,
  })
  @IsOptional()
  enableThinking?: boolean;

  @ApiProperty({
    description: "是否开启联网搜索",
    example: false,
    required: false,
  })
  @IsOptional()
  enableSearch?: boolean;

  @ApiProperty({
    description: "是否启用知识库",
    example: false,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  enableKnowledge?: boolean;

  @ApiProperty({
    description: "是否是重新生成或编辑触发的对话",
    example: false,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isRegenerate?: boolean;

  @ApiProperty({
    description: "知识库检索TopK",
    example: 5,
    required: false,
  })
  @IsNumber()
  @IsOptional()
  topK?: number;

  @ApiProperty({
    description: "知识库检索相似度阈值",
    example: 0.5,
    required: false,
  })
  @IsNumber()
  @IsOptional()
  minSimilarity?: number;
}

export class ChatResponseDto {
  @ApiProperty({ description: "AI回复的内容" })
  content: string;

  @ApiProperty({ description: "AI思考的内容", required: false })
  reasoningContent?: string;

  @ApiProperty({ description: "对话ID" })
  chatId: string;
}

// 图片生成 DTO
export class ImageGenerationDto {
  @ApiProperty({
    description:
      "对话ID，首次调用时不传，后端生成并返回，后续调用带上以维持上下文",
    example: "conv_123456",
    required: false,
  })
  @IsString()
  @IsOptional()
  chatId?: string;

  @ApiProperty({
    description: "用户ID",
    example: 1,
    required: false,
  })
  @IsNumber()
  @IsOptional()
  userId?: number;

  @ApiProperty({
    description: "是否是重新生成",
    example: false,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isRegenerate?: boolean;

  @ApiProperty({
    description: "模型名称",
    example: "qwen-image-max",
    required: false,
  })
  @IsString()
  @IsOptional()
  model?: string;

  @ApiProperty({
    description: "图片描述文本",
    example: "一副典雅庄重的对联",
  })
  @IsString()
  @IsNotEmpty()
  prompt: string;

  @ApiProperty({
    description: "负面提示词，描述不希望出现的内容",
    example: "低分辨率，低画质，肢体畸形",
    required: false,
  })
  @IsString()
  @IsOptional()
  negative_prompt?: string;

  @ApiProperty({
    description: "图片尺寸",
    example: "1664*928",
    required: false,
  })
  @IsString()
  @IsOptional()
  size?: string;

  @ApiProperty({
    description: "是否扩展提示词",
    example: true,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  prompt_extend?: boolean;

  @ApiProperty({
    description: "是否添加水印",
    example: false,
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  watermark?: boolean;
}

// 图片生成响应 DTO
export class ImageGenerationResponseDto {
  @ApiProperty({ description: "对话ID" })
  chatId: string;

  @ApiProperty({ description: "生成的图片 URL" })
  url: string;

  @ApiProperty({ description: "图片宽度", required: false })
  width?: number;

  @ApiProperty({ description: "图片高度", required: false })
  height?: number;

  @ApiProperty({ description: "请求 ID", required: false })
  requestId?: string;
}
