import {
  Controller,
  Post,
  Body,
  UploadedFile,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  BadRequestException,
  Res,
} from "@nestjs/common";
import { Response } from "express";
import { FileInterceptor } from "@nestjs/platform-express";
import {
  ApiTags,
  ApiOperation,
  ApiResponse,
  ApiConsumes,
  ApiBody,
} from "@nestjs/swagger";
import { KnowledgeService } from "./knowledge.service";
import {
  UploadKnowledgeDto,
  SearchKnowledgeDto,
  ListKnowledgeDto,
  DeleteKnowledgeDto,
  DetailKnowledgeDto,
  DownloadKnowledgeDto,
} from "./knowledge.dto";

// 文件大小限制：5MB
const MAX_FILE_SIZE = 5 * 1024 * 1024;

@ApiTags("Knowledge")
@Controller("knowledge")
export class KnowledgeController {
  constructor(private readonly knowledgeService: KnowledgeService) {}

  @Post("upload")
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(
    FileInterceptor("file", {
      limits: { fileSize: MAX_FILE_SIZE },
    })
  )
  @ApiOperation({ summary: "上传知识库文件（最大5MB）" })
  @ApiConsumes("multipart/form-data")
  @ApiBody({
    schema: {
      type: "object",
      properties: {
        userId: { type: "number" },
        file: {
          type: "string",
          format: "binary",
        },
      },
    },
  })
  @ApiResponse({ status: 200, description: "上传成功" })
  async upload(
    @Body() dto: UploadKnowledgeDto,
    @UploadedFile() file: Express.Multer.File
  ) {
    if (!file) {
      throw new BadRequestException("请选择要上传的文件");
    }
    // 二次校验文件大小（防止绕过 multer 限制）
    if (file.size > MAX_FILE_SIZE) {
      throw new BadRequestException(
        `文件大小超过限制，最大允许 ${MAX_FILE_SIZE / 1024 / 1024}MB，当前文件大小 ${file.size / 1024 / 1024}MB`
      );
    }
    return this.knowledgeService.uploadFileWithLoader(Number(dto.userId), file);
  }

  @Post("search")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "向量检索知识库" })
  @ApiResponse({ status: 200, description: "检索成功" })
  async search(@Body() dto: SearchKnowledgeDto) {
    return this.knowledgeService.search(
      Number(dto.userId),
      dto.query,
      Number(dto.limit || 5),
      Number(dto.minSimilarity || 0.6)
    );
  }

  @Post("list")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "查询知识库列表" })
  @ApiResponse({ status: 200, description: "查询成功" })
  async list(@Body() dto: ListKnowledgeDto) {
    return this.knowledgeService.getList(
      Number(dto.userId),
      Number(dto.page || 1),
      Number(dto.pageSize || 10),
      dto.types
    );
  }

  @Post("delete")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "删除知识库文件" })
  @ApiResponse({ status: 200, description: "删除成功" })
  async delete(@Body() dto: DeleteKnowledgeDto) {
    return this.knowledgeService.deleteFile(
      Number(dto.userId),
      Number(dto.id),
      dto.fileName
    );
  }

  @Post("detail")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "获取文件内容详情" })
  @ApiResponse({ status: 200, description: "获取成功" })
  async detail(@Body() dto: DetailKnowledgeDto) {
    return this.knowledgeService.getDetail(Number(dto.userId), Number(dto.id));
  }

  @Post("download")
  @ApiOperation({ summary: "下载知识库源文件" })
  @ApiResponse({ status: 200, description: "下载成功" })
  async download(
    @Body() dto: DownloadKnowledgeDto,
    @Res() res: Response
  ): Promise<void> {
    const result = await this.knowledgeService.downloadFile(
      Number(dto.userId),
      Number(dto.id)
    );

    const { fileName, mimeType, fileData } = result.data;

    // 设置响应头
    res.set({
      "Content-Type": mimeType,
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
      "Content-Length": fileData.length.toString(),
      "Cache-Control": "no-cache",
    });

    // 使用 end() 发送原始二进制数据，避免 send() 可能的转换
    res.end(fileData);
  }
}
