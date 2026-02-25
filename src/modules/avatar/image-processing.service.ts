import { Injectable } from "@nestjs/common";
import sharp from "sharp";
import { join } from "path";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import axios from "axios";

@Injectable()
export class ImageProcessingService {
  private readonly cacheDir: string;
  private memoryCache = new Map<string, Buffer>();

  constructor() {
    // 在 Vercel 环境中使用 /tmp 目录，其他环境使用相对路径
    this.cacheDir = process.env.VERCEL
      ? join("/tmp", "cache", "thumbnails")
      : join(__dirname, "..", "..", "..", "cache", "thumbnails");

    // 仅在非 Vercel 环境创建本地缓存目录
    if (!process.env.VERCEL && !existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  /**
   * 创建 base64 Data URL
   */
  private createDataUrl(imageBuffer: Buffer): string {
    const base64Image = imageBuffer.toString("base64");
    return `data:image/jpeg;base64,${base64Image}`;
  }

  /**
   * 压缩图片并生成缩略图URL
   * @param imageUrl 原始图片URL
   * @returns 压缩后的图片URL
   */
  async compressImage(imageUrl: string): Promise<string> {
    try {
      const fileName = this.generateFileName(imageUrl);
      const cacheFilePath = join(this.cacheDir, fileName);

      // 1. 检查内存缓存
      if (this.memoryCache.has(fileName)) {
        return this.createDataUrl(this.memoryCache.get(fileName)!);
      }

      // 2. 检查本地文件缓存（仅在非 Vercel 环境）
      if (!process.env.VERCEL && existsSync(cacheFilePath)) {
        const cachedImage = readFileSync(cacheFilePath);
        this.memoryCache.set(fileName, cachedImage);
        return `${process.env.SERVER_BASE_URL || "http://localhost:3000"}/cache/thumbnails/${fileName}`;
      }

      let imageBuffer: Buffer;
      if (imageUrl.startsWith("http")) {
        const response = await axios.get(imageUrl, {
          responseType: "arraybuffer",
        });
        imageBuffer = Buffer.from(response.data, "binary");
      } else if (imageUrl.startsWith("/uploads/")) {
        const imagePath = `.${imageUrl}`;
        if (!existsSync(imagePath)) {
          return imageUrl;
        }
        imageBuffer = readFileSync(imagePath);
      } else {
        return imageUrl;
      }

      // 使用sharp处理图片
      const compressedImage = await sharp(imageBuffer)
        .resize(200, 200, {
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80 })
        .toBuffer();

      // 保存到缓存
      this.memoryCache.set(fileName, compressedImage);

      // 本地文件缓存（仅在非 Vercel 环境）
      if (!process.env.VERCEL) {
        writeFileSync(cacheFilePath, compressedImage);
      }

      // 6. 返回结果
      if (process.env.VERCEL) {
        // Vercel 环境返回 base64 Data URL
        return this.createDataUrl(compressedImage);
      }

      // 非 Vercel 环境返回缓存URL
      return `${process.env.SERVER_BASE_URL || "http://localhost:3000"}/cache/thumbnails/${fileName}`;
    } catch (error) {
      console.error("图片处理失败:", error);
      // 出错时返回原始URL
      return imageUrl;
    }
  }

  /**
   * 生成基于原始URL的唯一文件名
   * @param imageUrl 原始图片URL
   * @returns 唯一文件名
   */
  private generateFileName(imageUrl: string): string {
    // 生成基于URL的哈希值作为文件名
    const hash = this.hashCode(imageUrl);
    return `${hash}.jpeg`;
  }

  /**
   * 计算字符串的哈希值
   * @param str 输入字符串
   * @returns 哈希值
   */
  private hashCode(str: string): string {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = (hash << 5) - hash + char;
      hash = hash & hash; // 转换为32位整数
    }
    return Math.abs(hash).toString();
  }
}
