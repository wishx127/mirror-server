import { Logger } from "@nestjs/common";
import { Document } from "@langchain/core/documents";
import { PDFLoader } from "@langchain/community/document_loaders/fs/pdf";
import { DocxLoader } from "@langchain/community/document_loaders/fs/docx";
import * as XLSX from "xlsx";
import * as mammoth from "mammoth";
import WordExtractor from "word-extractor";
import pdf from "pdf-parse";

export interface LoaderResult {
  documents: Document[];
  pageCount?: number;
  wordCount?: number;
}

export interface FileMetadata {
  fileName: string;
  fileSize: number;
  fileType: string;
  uploadTime: Date;
}

/**
 * Document Loader 工厂
 * 根据文件扩展名自动选择合适的 Loader
 * 支持降级到原有解析方式
 */
export class DocumentLoaderFactory {
  private static readonly logger = new Logger(DocumentLoaderFactory.name);

  /**
   * 支持的文件扩展名
   */
  private static readonly SUPPORTED_EXTENSIONS = [
    "pdf",
    "docx",
    "doc",
    "txt",
    "md",
    "xlsx",
    "xls",
    "csv",
  ];

  /**
   * 检查是否支持该文件类型
   */
  static isSupported(extension: string): boolean {
    return this.SUPPORTED_EXTENSIONS.includes(extension.toLowerCase());
  }

  /**
   * 加载文档
   * 自动选择合适的 Loader，失败时降级到原有实现
   */
  static async loadDocument(
    buffer: Buffer,
    fileName: string,
    fileExtension: string
  ): Promise<LoaderResult> {
    const ext = fileExtension.toLowerCase();

    if (!this.isSupported(ext)) {
      throw new Error(`不支持的文件格式: .${ext}`);
    }

    try {
      switch (ext) {
        case "pdf":
          return await this.loadPDF(buffer, fileName);
        case "docx":
          return await this.loadDocx(buffer, fileName);
        case "doc":
          return await this.loadDoc(buffer, fileName);
        case "txt":
        case "md":
          return await this.loadText(buffer, fileName, ext);
        case "xlsx":
        case "xls":
          return await this.loadExcel(buffer, fileName);
        default:
          throw new Error(`不支持的文件格式: .${ext}`);
      }
    } catch (error) {
      this.logger.error(`Failed to load document ${fileName}: ${error}`);
      throw error;
    }
  }

  /**
   * 加载 PDF 文件
   * 优先使用 LangChain PDFLoader，失败时降级到 pdf-parse
   */
  private static async loadPDF(
    buffer: Buffer,
    fileName: string
  ): Promise<LoaderResult> {
    try {
      // 尝试使用 LangChain PDFLoader
      const blob = new Blob([buffer]);
      const loader = new PDFLoader(blob, {
        splitPages: false, // 不按页分割，返回完整文档
      });

      const documents = await loader.load();

      if (documents.length === 0 || !documents[0].pageContent.trim()) {
        throw new Error("PDF 内容为空");
      }

      this.logger.log(`PDFLoader successfully loaded: ${fileName}`);

      return {
        documents,
        pageCount: documents.length,
      };
    } catch (error) {
      // 降级到 pdf-parse
      this.logger.warn(
        `PDFLoader failed for ${fileName}, falling back to pdf-parse: ${error}`
      );

      try {
        const data = await pdf(buffer);
        if (!data.text || !data.text.trim()) {
          throw new Error("PDF 内容为空，可能是扫描版 PDF");
        }

        const documents = [
          new Document({
            pageContent: data.text,
            metadata: {
              fileName,
              fileType: "pdf",
              pageCount: data.numpages,
            },
          }),
        ];

        this.logger.log(
          `pdf-parse fallback successful for ${fileName}, ${data.numpages} pages`
        );

        return {
          documents,
          pageCount: data.numpages,
        };
      } catch (fallbackError) {
        throw new Error(
          `PDF 解析失败: ${fallbackError instanceof Error ? fallbackError.message : "未知错误"}`
        );
      }
    }
  }

  /**
   * 加载 .docx 文件
   * 优先使用 LangChain DocxLoader
   */
  private static async loadDocx(
    buffer: Buffer,
    fileName: string
  ): Promise<LoaderResult> {
    try {
      // 尝试使用 LangChain DocxLoader
      const blob = new Blob([buffer]);
      const loader = new DocxLoader(blob);

      const documents = await loader.load();

      if (documents.length === 0 || !documents[0].pageContent.trim()) {
        throw new Error("Word 文档内容为空");
      }

      this.logger.log(`DocxLoader successfully loaded: ${fileName}`);

      return {
        documents,
      };
    } catch (error) {
      // 降级到 mammoth
      this.logger.warn(
        `DocxLoader failed for ${fileName}, falling back to mammoth: ${error}`
      );

      try {
        const result = await mammoth.extractRawText({ buffer });

        if (!result.value || !result.value.trim()) {
          throw new Error("Word 文档内容为空");
        }

        const documents = [
          new Document({
            pageContent: result.value,
            metadata: {
              fileName,
              fileType: "docx",
            },
          }),
        ];

        this.logger.log(`mammoth fallback successful for ${fileName}`);

        return { documents };
      } catch (fallbackError) {
        throw new Error(
          `Word 文档解析失败: ${fallbackError instanceof Error ? fallbackError.message : "未知错误"}`
        );
      }
    }
  }

  /**
   * 加载 .doc 文件（旧版 Word 格式）
   * 使用 mammoth 或 word-extractor
   */
  private static async loadDoc(
    buffer: Buffer,
    fileName: string
  ): Promise<LoaderResult> {
    try {
      // 尝试使用 mammoth
      const result = await mammoth.extractRawText({ buffer });

      if (result.value && result.value.trim()) {
        const documents = [
          new Document({
            pageContent: result.value,
            metadata: {
              fileName,
              fileType: "doc",
            },
          }),
        ];

        this.logger.log(`mammoth loaded .doc file: ${fileName}`);

        return { documents };
      }

      throw new Error("mammoth 解析结果为空");
    } catch {
      // 降级到 word-extractor
      this.logger.warn(
        `mammoth failed for .doc ${fileName}, falling back to word-extractor`
      );

      try {
        const extractor = new WordExtractor();
        const extracted = await extractor.extract(buffer);
        const content = extracted.getBody();

        if (!content || !content.trim()) {
          throw new Error("Word 文档内容为空");
        }

        const documents = [
          new Document({
            pageContent: content,
            metadata: {
              fileName,
              fileType: "doc",
            },
          }),
        ];

        this.logger.log(`word-extractor fallback successful for ${fileName}`);

        return { documents };
      } catch (fallbackError) {
        throw new Error(
          `Word 文档解析失败: ${fallbackError instanceof Error ? fallbackError.message : "未知错误"}`
        );
      }
    }
  }

  /**
   * 加载文本文件（.txt, .md）
   * 使用 LangChain TextLoader
   */
  private static loadText(
    buffer: Buffer,
    fileName: string,
    extension: string
  ): Promise<LoaderResult> {
    try {
      // TextLoader 需要文件路径，我们使用 Blob 替代
      // 直接解析文本内容
      const text = buffer.toString("utf-8");

      if (!text || !text.trim()) {
        throw new Error("文件内容为空");
      }

      const documents = [
        new Document({
          pageContent: text,
          metadata: {
            fileName,
            fileType: extension,
          },
        }),
      ];

      this.logger.log(`TextLoader loaded: ${fileName}`);

      return Promise.resolve({
        documents,
        wordCount: text.length,
      });
    } catch (error) {
      throw new Error(
        `文本文件解析失败: ${error instanceof Error ? error.message : "未知错误"}`
      );
    }
  }

  /**
   * 加载 Excel 文件（.xlsx, .xls）
   * 使用 xlsx 库转换为文本
   */
  private static loadExcel(
    buffer: Buffer,
    fileName: string
  ): Promise<LoaderResult> {
    try {
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const documents: Document[] = [];

      workbook.SheetNames.forEach((sheetName) => {
        const worksheet = workbook.Sheets[sheetName];
        const sheetText = XLSX.utils.sheet_to_csv(worksheet);

        if (sheetText.trim()) {
          documents.push(
            new Document({
              pageContent: `Sheet: ${sheetName}\n${sheetText}`,
              metadata: {
                fileName,
                fileType: "xlsx",
                sheetName,
              },
            })
          );
        }
      });

      if (documents.length === 0) {
        throw new Error("Excel 文件内容为空");
      }

      this.logger.log(
        `Excel loaded: ${fileName}, ${documents.length} sheets`
      );

      return Promise.resolve({
        documents,
      });
    } catch (error) {
      throw new Error(
        `Excel 文件解析失败: ${error instanceof Error ? error.message : "未知错误"}`
      );
    }
  }

  /**
   * 附加元数据到文档
   */
  static attachMetadata(
    documents: Document[],
    metadata: FileMetadata
  ): Document[] {
    return documents.map((doc) => ({
      ...doc,
      metadata: {
        ...doc.metadata,
        ...metadata,
      },
    }));
  }
}
