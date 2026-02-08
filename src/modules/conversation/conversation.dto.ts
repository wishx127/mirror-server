import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, IsNotEmpty, IsNumber } from "class-validator";
import { Type } from "class-transformer";
import { StoredMessage } from "../chat/chat.dto";

export class SaveConversationDto {
  @ApiPropertyOptional({ description: "对话ID" })
  @IsOptional()
  @IsString()
  conversationId?: string;

  @ApiPropertyOptional({ description: "对话标题" })
  @IsOptional()
  @IsString()
  title?: string;

  @ApiProperty({ description: "对话内容" })
  @IsNotEmpty()
  content?: StoredMessage[] | string;

  @ApiProperty({ description: "用户ID" })
  @Type(() => Number)
  @IsNumber()
  userId: number;
}

export class GetConversationsDto {
  @ApiProperty({ description: "用户ID", example: 1 })
  @Type(() => Number)
  @IsNumber()
  userId: number;

  @ApiPropertyOptional({
    description: "是否包含今日更新的对话详情",
    type: Boolean,
  })
  @IsOptional()
  @Type(() => Boolean)
  includeDetails?: boolean;
}

export class DeleteConversationDto {
  @ApiProperty({ description: "用户ID" })
  @Type(() => Number)
  @IsNumber()
  userId: number;

  @ApiProperty({ description: "对话ID" })
  @IsNotEmpty()
  @IsString()
  conversationId: string;
}

export class GetConversationDetailsQueryDto {
  @ApiProperty({ description: "用户ID" })
  @Type(() => Number)
  @IsNumber()
  userId: number;

  @ApiProperty({ description: "对话ID" })
  @IsNotEmpty()
  @IsString()
  conversationId: string;
}
