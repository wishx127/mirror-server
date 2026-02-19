import { Injectable, BadRequestException, Inject, forwardRef, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { ConfigService } from "@nestjs/config";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { Document } from "@langchain/core/documents";
import { VectorStoreService } from "./vectorstore.service";
import { HybridRetriever, HybridRetrieverOptions, SearchResult } from "./retrievers/hybrid.retriever";
import { DocumentLoaderFactory } from "./loaders/document-loader.factory";
import WordExtractor from "word-extractor";
import pdf from "pdf-parse";
import * as mammoth from "mammoth";
import * as XLSX from "xlsx";

// 搜索结果类型
export interface KnowledgeSearchResult {
  id: number;
  fileName: string;
  content: string;
  preview: string;
  size: number;
  type: string;
  similarity: number;
  keywordScore?: number; // 关键词匹配得分
  hybridScore?: number; // 混合检索最终得分
}

// 向量检索结果类型
interface VectorSearchResult {
  id: number;
  fileName: string;
  content: string;
  preview: string;
  size: number;
  type: string;
  similarity: number;
}

// 关键词检索结果类型
interface KeywordSearchResult {
  id: number;
  fileName: string;
  content: string;
  preview: string;
  size: number;
  type: string;
  matchCount: number;
}

// 知识列表项类型
export interface KnowledgeListItem {
  id: number;
  fileName: string;
  preview: string;
  size: number;
  type: string;
  fileData?: Buffer;
  createdAt: Date;
  updatedAt: Date;
}

// Polyfill for pdf-parse in Node.js environment
if (typeof global.DOMMatrix === "undefined") {
  // @ts-expect-error DOMMatrix polyfill for Node.js environment
  global.DOMMatrix = class DOMMatrix {
    constructor() {}
  };
}

// 提取错误信息的辅助函数
function getErrorMessage(error: Error | string): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

// 清理字符串中的 null 字节，防止 PostgreSQL 报错
function sanitizeString(str: string): string {
  return str.replace(/\0/g, "");
}

@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);
  private readonly allowedExtensions = [
    "pdf",
    "docx",
    "doc",
    "txt",
    "md",
    "xlsx",
    "xls",
  ];

  private readonly typeMap: Record<number, string[]> = {
    1: ["pdf"],
    2: ["docx"],
    3: ["doc"],
    4: ["xlsx"],
    5: ["xls"],
    6: ["txt", "text"],
    7: ["md", "markdown"],
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    @Inject(forwardRef(() => VectorStoreService))
    private readonly vectorStoreService: VectorStoreService
  ) {}

  /**
   * 获取用户配置的 API key，如果没有则使用默认的 DASHSCOPE_API_KEY
   */
  private async getApiKey(userId: number): Promise<string> {
    const modelConfig = await this.prisma.modelConfig.findUnique({
      where: { userId },
    });

    const apiKey =
      modelConfig?.apiKey ||
      this.configService.get<string>("DASHSCOPE_API_KEY") ||
      "";

    if (!apiKey) {
      throw new BadRequestException("未配置 API Key，请先在设置中配置您的 API Key");
    }

    return apiKey;
  }

  async uploadFile(userId: number, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException("未上传文件");
    }

    const originalname = sanitizeString(
      file.originalname
        ? Buffer.from(file.originalname, "latin1").toString("utf8")
        : ""
    );
    const fileExtension = originalname.split(".").pop()?.toLowerCase() || "";

    if (!this.allowedExtensions.includes(fileExtension)) {
      throw new BadRequestException(`不支持的文件格式 "${fileExtension}"`);
    }

    // 获取用户的 API key
    const apiKey = await this.getApiKey(userId);

    const blob = new Blob([new Uint8Array(file.buffer)]);
    let docs: Document[] = [];

    // 1. 解析文件
    try {
      if (fileExtension === "pdf") {
        const data = await pdf(file.buffer);
        docs = [new Document({ pageContent: data.text })];
      } else if (fileExtension === "docx" || fileExtension === "doc") {
        const result = await mammoth.extractRawText({ buffer: file.buffer });
        if (result.value && result.value.trim()) {
          docs = [new Document({ pageContent: result.value })];
        } else {
          try {
            const extractor = new WordExtractor();
            const extracted = await extractor.extract(file.buffer);
            const content = extracted.getBody();
            if (content && content.trim()) {
              docs = [new Document({ pageContent: content })];
            } else {
              throw new Error("WordExtractor 解析结果为空");
            }
          } catch {
            throw new BadRequestException(
              "Word 文件解析失败：文件格式可能已损坏，或者不是有效的 .doc/.docx 文档"
            );
          }
        }
      } else if (fileExtension === "txt" || fileExtension === "md") {
        const text = await blob.text();
        docs = [new Document({ pageContent: text })];
      } else if (fileExtension === "xlsx" || fileExtension === "xls") {
        const workbook = XLSX.read(file.buffer, { type: "buffer" });
        let fullText = "";
        workbook.SheetNames.forEach((sheetName) => {
          const worksheet = workbook.Sheets[sheetName];
          const sheetText = XLSX.utils.sheet_to_csv(worksheet);
          if (sheetText.trim()) {
            fullText += `Sheet: ${sheetName}\n${sheetText}\n\n`;
          }
        });
        docs = [new Document({ pageContent: fullText })];
      }

      if (!docs.length || !docs[0].pageContent.trim()) {
        throw new BadRequestException("文件内容为空");
      }

      // 生成预览内容
      const fullText = docs.map((d) => d.pageContent).join("\n");
      const preview = sanitizeString(
        fileExtension === "md"
          ? fullText.slice(0, 200)
          : fullText.replace(/[ \t]+/g, "").slice(0, 200)
      );

      // 优化显示的文件类型
      const displayType = this.getDisplayType(fileExtension, file.mimetype);

      // 2. 使用 LangChain 进行文本切片
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 150,
        separators: ["\n\n", "\n", "。", "！", "？", ".", "!", "?", " "],
      });

      const splitDocs = await splitter.splitDocuments(docs);

      // 3. 删除旧的同名文件记录
      await this.prisma.knowledge.deleteMany({
        where: {
          userId,
          fileName: originalname,
        },
      });

      // 4. 使用 VectorStoreService 添加文档（包含批量插入优化）
      const fileBuffer = Buffer.isBuffer(file.buffer)
        ? file.buffer
        : Buffer.from(file.buffer);

      await this.vectorStoreService.addDocuments(
        splitDocs,
        {
          userId,
          fileName: originalname,
          fileSize: file.size,
          fileType: displayType,
          preview,
          fileData: fileBuffer,
          isFirstChunk: true,
        },
        apiKey
      );

      return {
        success: true,
        fileName: originalname,
        type: displayType,
        chunks: splitDocs.length,
      };
    } catch (error) {
      throw new BadRequestException(
        `处理文件失败: ${getErrorMessage(error as Error | string)}`
      );
    }
  }

  /**
   * 使用 DocumentLoaderFactory 上传文件
   * 使用 LangChain Document Loaders 替代手动文件解析
   */
  async uploadFileWithLoader(userId: number, file: Express.Multer.File) {
    if (!file) {
      throw new BadRequestException("未上传文件");
    }

    const originalname = sanitizeString(
      file.originalname
        ? Buffer.from(file.originalname, "latin1").toString("utf8")
        : ""
    );
    const fileExtension = originalname.split(".").pop()?.toLowerCase() || "";

    if (!this.allowedExtensions.includes(fileExtension)) {
      throw new BadRequestException(`不支持的文件格式 "${fileExtension}"`);
    }

    // 获取用户的 API key
    const apiKey = await this.getApiKey(userId);

    try {
      const fileBuffer = Buffer.isBuffer(file.buffer)
        ? file.buffer
        : Buffer.from(file.buffer);

      // 1. 使用 DocumentLoaderFactory 加载文档
      const loaderResult = await DocumentLoaderFactory.loadDocument(
        fileBuffer,
        originalname,
        fileExtension
      );

      if (
        !loaderResult.documents.length ||
        !loaderResult.documents[0].pageContent.trim()
      ) {
        throw new BadRequestException("文件内容为空");
      }

      // 附加元数据
      const docs = DocumentLoaderFactory.attachMetadata(loaderResult.documents, {
        fileName: originalname,
        fileSize: file.size,
        fileType: fileExtension,
        uploadTime: new Date(),
      });

      // 生成预览内容
      const fullText = docs.map((d) => d.pageContent).join("\n");
      const preview = sanitizeString(
        fileExtension === "md"
          ? fullText.slice(0, 200)
          : fullText.replace(/[ \t]+/g, "").slice(0, 200)
      );

      const displayType = this.getDisplayType(fileExtension, file.mimetype);

      // 2. 使用 LangChain 进行文本切片
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1000,
        chunkOverlap: 150,
        separators: ["\n\n", "\n", "。", "！", "？", ".", "!", "?", " "],
      });

      const splitDocs = await splitter.splitDocuments(docs);

      // 3. 删除旧的同名文件记录
      await this.prisma.knowledge.deleteMany({
        where: {
          userId,
          fileName: originalname,
        },
      });

      // 4. 使用 VectorStoreService 添加文档
      await this.vectorStoreService.addDocuments(
        splitDocs,
        {
          userId,
          fileName: originalname,
          fileSize: file.size,
          fileType: displayType,
          preview,
          fileData: fileBuffer,
          isFirstChunk: true,
        },
        apiKey
      );

      this.logger.log(
        `File uploaded with DocumentLoader: ${originalname}, ${splitDocs.length} chunks`
      );

      return {
        success: true,
        fileName: originalname,
        type: displayType,
        chunks: splitDocs.length,
        pageCount: loaderResult.pageCount,
        wordCount: loaderResult.wordCount,
      };
    } catch (error) {
      throw new BadRequestException(
        `处理文件失败: ${getErrorMessage(error as Error | string)}`
      );
    }
  }

  private getDisplayType(extension: string, mimetype: string): string {
    const ext = extension.toLowerCase();
    if (ext === "pdf") return "pdf";
    if (ext === "docx" || ext === "doc") return ext;
    if (ext === "md") return "markdown";
    if (ext === "txt") return "text";
    if (ext === "xlsx" || ext === "xls") return ext;
    return mimetype;
  }

  /**
   * 混合检索：结合向量检索和关键词检索
   * 使用 RRF (Reciprocal Rank Fusion) 算法融合两种检索结果
   */
  async search(
    userId: number,
    query: string,
    limit: number = 5,
    minSimilarity: number = 0.3
  ) {
    try {
      // 获取用户的 API key
      const apiKey = await this.getApiKey(userId);

      // 并行执行向量检索和关键词检索
      const [vectorResults, keywordResults] = await Promise.all([
        this.vectorSearch(userId, query, limit * 2, minSimilarity, apiKey),
        this.keywordSearch(userId, query, limit * 2),
      ]);

      // 使用 RRF 算法融合结果
      const mergedResults = this.mergeResultsWithRRF(
        vectorResults,
        keywordResults,
        limit
      );

      mergedResults.forEach((res, index) => {
        console.log(
          `[混合搜索] 结果 ${index + 1}: ${res.fileName}, ` +
            `向量相似度: ${res.similarity?.toFixed(3)}, ` +
            `关键词得分: ${res.keywordScore?.toFixed(3)}, ` +
            `混合得分: ${res.hybridScore?.toFixed(3)}`
        );
      });

      return { success: true, results: mergedResults };
    } catch (error) {
      throw new BadRequestException(
        `搜索失败: ${getErrorMessage(error as Error | string)}`
      );
    }
  }

  /**
   * 使用 HybridRetriever 进行混合检索
   * 这是新的推荐搜索方法，使用 LangChain Retriever 接口
   */
  async searchWithRetriever(
    userId: number,
    query: string,
    options: HybridRetrieverOptions = {}
  ): Promise<{ success: boolean; results: SearchResult[] }> {
    try {
      // 获取用户的 API key
      const apiKey = await this.getApiKey(userId);

      const pool = this.vectorStoreService.getPool() as import("pg").Pool;
      if (!pool) {
        throw new Error("Database pool not initialized");
      }

      const retriever = new HybridRetriever(
        pool,
        this.vectorStoreService.getEmbeddings(apiKey),
        userId,
        {
          limit: options.limit ?? 5,
          minSimilarity: options.minSimilarity ?? 0.3,
          rrfK: options.rrfK ?? 60,
          vectorWeight: options.vectorWeight ?? 0.7,
          keywordWeight: options.keywordWeight ?? 0.3,
        }
      );

      const results = await retriever.getSearchResults(query);

      this.logger.log(
        `HybridRetriever search completed, returned ${results.length} results`
      );

      return { success: true, results };
    } catch (error) {
      throw new BadRequestException(
        `搜索失败: ${getErrorMessage(error as Error | string)}`
      );
    }
  }

  /**
   * 创建 HybridRetriever 实例
   * 用于集成到 RAG Chain
   */
  async createRetriever(
    userId: number,
    options: HybridRetrieverOptions = {}
  ): Promise<HybridRetriever> {
    // 获取用户的 API key
    const apiKey = await this.getApiKey(userId);

    const pool = this.vectorStoreService.getPool() as import("pg").Pool;
    if (!pool) {
      throw new Error("Database pool not initialized");
    }

    return new HybridRetriever(
      pool,
      this.vectorStoreService.getEmbeddings(apiKey),
      userId,
      options
    );
  }

  /**
   * 向量检索
   */
  private async vectorSearch(
    userId: number,
    query: string,
    limit: number,
    minSimilarity: number,
    apiKey: string
  ): Promise<VectorSearchResult[]> {
    // 使用 VectorStoreService 进行向量检索
    const results = await this.vectorStoreService.similaritySearch(
      query,
      userId,
      limit,
      minSimilarity,
      apiKey
    );

    // 转换为 VectorSearchResult 格式
    // 需要从数据库获取额外的字段（fileName, preview, size, type）
    const ids = results.map((r) => r.id);
    const records = await this.prisma.knowledge.findMany({
      where: { id: { in: ids } },
      select: { id: true, fileName: true, preview: true, size: true, type: true },
    });

    const recordMap = new Map(records.map((r) => [r.id, r]));

    return results.map((r) => {
      const record = recordMap.get(r.id);
      return {
        id: r.id,
        fileName: record?.fileName || "",
        content: r.content,
        preview: record?.preview || "",
        size: record?.size || 0,
        type: record?.type || "",
        similarity: r.similarity,
      };
    });
  }

  /**
   * 关键词检索
   * 提取查询中的关键词，使用 LIKE 匹配进行检索
   */
  private async keywordSearch(
    userId: number,
    query: string,
    limit: number
  ): Promise<KeywordSearchResult[]> {
    // 提取关键词
    const keywords = this.extractKeywords(query);

    if (keywords.length === 0) {
      return [];
    }

    // 构建动态 SQL 条件
    // 计算每个文档匹配的关键词数量作为得分
    const keywordConditions = keywords
      .map(
        (kw) =>
          `CASE WHEN content ILIKE '%${this.escapeSQL(kw)}%' THEN 1 ELSE 0 END`
      )
      .join(" + ");

    const keywordWhereClause = keywords
      .map((kw) => `content ILIKE '%${this.escapeSQL(kw)}%'`)
      .join(" OR ");

    const results: KeywordSearchResult[] = await this.prisma.$queryRawUnsafe(`
      SELECT id, "fileName", content, preview, size, type,
             (${keywordConditions}) as "matchCount"
      FROM "Knowledge"
      WHERE "userId" = ${userId}
      AND (${keywordWhereClause})
      ORDER BY "matchCount" DESC, id ASC
      LIMIT ${limit}
    `);

    return results;
  }

  /**
   * 从查询中提取关键词
   * 使用分词和停用词过滤
   */
  private extractKeywords(query: string): string[] {
    // 中文停用词列表
    const stopWords = new Set([
      "的",
      "了",
      "是",
      "在",
      "我",
      "有",
      "和",
      "就",
      "不",
      "人",
      "都",
      "一",
      "一个",
      "上",
      "也",
      "很",
      "到",
      "说",
      "要",
      "去",
      "你",
      "会",
      "着",
      "没有",
      "看",
      "好",
      "自己",
      "这",
      "那",
      "什么",
      "怎么",
      "如何",
      "为什么",
      "哪些",
      "哪个",
      "请",
      "能",
      "可以",
      "帮",
      "帮我",
      "告诉",
      "介绍",
      "关于",
      "以及",
      "或者",
      "并且",
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "can",
      "must",
      "shall",
      "of",
      "to",
      "in",
      "for",
      "on",
      "with",
      "at",
      "by",
      "from",
      "as",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "between",
      "under",
      "again",
      "further",
      "then",
      "once",
      "here",
      "there",
      "when",
      "where",
      "why",
      "how",
      "all",
      "each",
      "few",
      "more",
      "most",
      "other",
      "some",
      "such",
      "no",
      "nor",
      "not",
      "only",
      "own",
      "same",
      "so",
      "than",
      "too",
      "very",
      "just",
      "and",
      "but",
      "if",
      "or",
      "because",
      "as",
      "until",
      "while",
      "about",
      "against",
      "between",
      "into",
      "through",
      "what",
      "which",
      "who",
      "whom",
      "this",
      "that",
      "these",
      "those",
      "am",
      "it",
      "its",
      "my",
      "your",
      "his",
      "her",
      "their",
      "our",
      "i",
      "me",
      "you",
      "he",
      "she",
      "they",
      "we",
      "us",
      "him",
      "them",
    ]);

    // 分词：支持中英文混合
    // 中文按字符分割，英文按单词分割，保留长度>=2的词
    const words: string[] = [];

    // 英文单词提取
    const englishWords = query.match(/[a-zA-Z]+/g) || [];
    englishWords.forEach((word) => {
      const lowerWord = word.toLowerCase();
      if (lowerWord.length >= 2 && !stopWords.has(lowerWord)) {
        words.push(lowerWord);
      }
    });

    // 中文词组提取（使用简单的N-gram方法）
    const chineseChars = query.match(/[\u4e00-\u9fa5]+/g) || [];
    chineseChars.forEach((segment) => {
      // 对于中文，提取2-4字的词组
      for (let len = 2; len <= Math.min(4, segment.length); len++) {
        for (let i = 0; i <= segment.length - len; i++) {
          const word = segment.slice(i, i + len);
          if (!stopWords.has(word)) {
            words.push(word);
          }
        }
      }
      // 也添加整个中文片段（如果不是停用词）
      if (segment.length >= 2 && !stopWords.has(segment)) {
        words.push(segment);
      }
    });

    // 去重并限制关键词数量
    const uniqueWords = [...new Set(words)];
    return uniqueWords.slice(0, 10); // 最多10个关键词
  }

  /**
   * 转义SQL特殊字符，防止SQL注入
   */
  private escapeSQL(str: string): string {
    return str.replace(/'/g, "''").replace(/%/g, "\\%").replace(/_/g, "\\_");
  }

  /**
   * 使用 RRF (Reciprocal Rank Fusion) 算法融合检索结果
   * RRF公式: score = Σ 1/(k + rank_i)
   * k 是一个常数，通常设为60
   */
  private mergeResultsWithRRF(
    vectorResults: VectorSearchResult[],
    keywordResults: KeywordSearchResult[],
    limit: number,
    k: number = 60,
    vectorWeight: number = 0.7, // 向量检索权重
    keywordWeight: number = 0.3 // 关键词检索权重
  ): KnowledgeSearchResult[] {
    const scoreMap = new Map<
      number,
      {
        result: KnowledgeSearchResult;
        vectorRank: number | null;
        keywordRank: number | null;
        vectorScore: number;
        keywordScore: number;
      }
    >();

    // 处理向量检索结果
    vectorResults.forEach((result, index) => {
      const rrfScore = 1 / (k + index + 1);
      scoreMap.set(result.id, {
        result: {
          ...result,
          keywordScore: 0,
          hybridScore: 0,
        },
        vectorRank: index + 1,
        keywordRank: null,
        vectorScore: rrfScore * vectorWeight,
        keywordScore: 0,
      });
    });

    // 处理关键词检索结果
    keywordResults.forEach((result, index) => {
      const rrfScore = 1 / (k + index + 1);
      const existing = scoreMap.get(result.id);

      if (existing) {
        // 如果已存在，累加得分
        existing.keywordRank = index + 1;
        existing.keywordScore = rrfScore * keywordWeight;
        existing.result.keywordScore =
          result.matchCount / this.extractKeywords("").length ||
          result.matchCount;
      } else {
        // 如果不存在，添加新记录
        scoreMap.set(result.id, {
          result: {
            id: result.id,
            fileName: result.fileName,
            content: result.content,
            preview: result.preview,
            size: result.size,
            type: result.type,
            similarity: 0,
            keywordScore: result.matchCount,
            hybridScore: 0,
          },
          vectorRank: null,
          keywordRank: index + 1,
          vectorScore: 0,
          keywordScore: rrfScore * keywordWeight,
        });
      }
    });

    // 计算最终混合得分并排序
    const mergedResults = Array.from(scoreMap.values())
      .map(({ result, vectorScore, keywordScore }) => ({
        ...result,
        hybridScore: vectorScore + keywordScore,
      }))
      .sort((a, b) => (b.hybridScore || 0) - (a.hybridScore || 0))
      .slice(0, limit);

    return mergedResults;
  }

  async getList(
    userId: number,
    page: number = 1,
    pageSize: number = 10,
    types?: number[]
  ) {
    try {
      const skip = (page - 1) * pageSize;

      // 解析映射后的类型字符串列表
      let typeStrings: string[] = [];
      if (types && types.length > 0) {
        types.forEach((t) => {
          if (this.typeMap[t]) {
            typeStrings = typeStrings.concat(this.typeMap[t]);
          }
        });
      }

      // 使用 Prisma 的 $queryRaw 并动态构建参数
      let totalResult: { count: bigint }[];
      let list: KnowledgeListItem[];

      if (typeStrings.length > 0) {
        // 当有类型筛选时
        [totalResult, list] = await Promise.all([
          this.prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(DISTINCT "fileName") as count 
            FROM "Knowledge" 
            WHERE "userId" = ${userId} AND "type" IN (${Prisma.join(typeStrings)})
          `,
          this.prisma.$queryRaw<KnowledgeListItem[]>`
            SELECT 
              MAX(id) as id, 
              "fileName", 
              MAX(preview) as preview,
              MAX(size) as size,
              MAX(type) as type,
              MAX("createdAt") as "createdAt", 
              MAX("updatedAt") as "updatedAt"
            FROM "Knowledge"
            WHERE "userId" = ${userId} AND "type" IN (${Prisma.join(typeStrings)})
            GROUP BY "fileName"
            ORDER BY "createdAt" DESC
            LIMIT ${pageSize} OFFSET ${skip}
          `,
        ]);
      } else {
        // 没有筛选或 types 为空时
        [totalResult, list] = await Promise.all([
          this.prisma.$queryRaw<{ count: bigint }[]>`
            SELECT COUNT(DISTINCT "fileName") as count 
            FROM "Knowledge" 
            WHERE "userId" = ${userId}
          `,
          this.prisma.$queryRaw<KnowledgeListItem[]>`
            SELECT 
              MAX(id) as id, 
              "fileName", 
              MAX(preview) as preview,
              MAX(size) as size,
              MAX(type) as type,
              MAX("createdAt") as "createdAt", 
              MAX("updatedAt") as "updatedAt"
            FROM "Knowledge"
            WHERE "userId" = ${userId}
            GROUP BY "fileName"
            ORDER BY "createdAt" DESC
            LIMIT ${pageSize} OFFSET ${skip}
          `,
        ]);
      }

      const total = Number(totalResult[0]?.count || 0);

      return {
        success: true,
        list,
        pagination: {
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
        },
      };
    } catch (error) {
      throw new BadRequestException(
        `获取列表失败: ${getErrorMessage(error as Error | string)}`
      );
    }
  }

  async deleteFile(userId: number, id: number, fileName: string) {
    try {
      const record = await this.prisma.knowledge.findFirst({
        where: {
          id,
          userId,
          fileName,
        },
      });

      if (!record) {
        throw new BadRequestException("文件不存在");
      }

      await this.prisma.knowledge.deleteMany({
        where: {
          userId,
          fileName,
        },
      });

      return {
        success: true,
        message: `删除成功`,
      };
    } catch (error) {
      throw new BadRequestException(
        `删除文件失败: ${getErrorMessage(error as Error | string)}`
      );
    }
  }

  async getDetail(userId: number, id: number) {
    try {
      const baseRecord = await this.prisma.knowledge.findFirst({
        where: {
          id,
          userId,
        },
      });

      if (!baseRecord) {
        throw new BadRequestException("文件不存在或无权查看");
      }

      const allChunks = await this.prisma.knowledge.findMany({
        where: {
          userId,
          fileName: baseRecord.fileName,
        },
        orderBy: {
          id: "asc",
        },
        select: {
          content: true,
        },
      });

      const fullContent = allChunks.map((chunk) => chunk.content).join("");

      return {
        success: true,
        data: {
          id: baseRecord.id,
          fileName: baseRecord.fileName,
          type: baseRecord.type,
          content: fullContent,
        },
      };
    } catch (error) {
      throw new BadRequestException(
        `获取文件详情失败: ${getErrorMessage(error as Error | string)}`
      );
    }
  }

  async downloadFile(userId: number, id: number) {
    try {
      const baseRecord = await this.prisma.knowledge.findFirst({
        where: {
          id,
          userId,
        },
        select: {
          fileName: true,
          type: true,
          size: true,
        },
      });

      if (!baseRecord) {
        throw new BadRequestException("文件不存在或无权访问");
      }

      // 查找包含源文件数据的记录（第一个 chunk）
      // 使用原始 SQL 查询来处理 Bytes 类型字段
      const records = await this.prisma.$queryRaw<
        Array<{
          id: number;
          fileName: string;
          type: string | null;
          size: number | null;
          fileData: Buffer | null;
        }>
      >`
        SELECT id, "fileName", type, size, "fileData"
        FROM "Knowledge"
        WHERE "userId" = ${userId}
        AND "fileName" = ${baseRecord.fileName}
        AND "fileData" IS NOT NULL
        LIMIT 1
      `;

      const record = records[0];

      // 如果有源文件数据，直接返回
      if (record && record.fileData) {
        const mimeType = this.getMimeType(record.type || "", record.fileName);

        // 确保 fileData 是 Buffer 类型
        // PostgreSQL 的 bytea 可能返回 Buffer 或其他格式
        let fileBuffer: Buffer;
        if (Buffer.isBuffer(record.fileData)) {
          fileBuffer = record.fileData;
        } else if (
          typeof record.fileData === "object" &&
          record.fileData !== null
        ) {
          // 可能是 Uint8Array 或类似对象
          fileBuffer = Buffer.from(record.fileData as unknown as ArrayBuffer);
        } else {
          throw new BadRequestException("文件数据格式异常");
        }

        return {
          success: true,
          data: {
            fileName: record.fileName,
            mimeType,
            size: record.size,
            fileData: fileBuffer,
          },
        };
      } else {
        throw new BadRequestException("文件内容不存在");
      }
    } catch (error) {
      if (error instanceof BadRequestException) {
        throw error;
      }
      throw new BadRequestException(
        `下载文件失败: ${getErrorMessage(error as Error | string)}`
      );
    }
  }

  private getMimeType(type: string, fileName: string): string {
    const extension = fileName.split(".").pop()?.toLowerCase() || "";
    const mimeTypes: Record<string, string> = {
      pdf: "application/pdf",
      doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      txt: "text/plain",
      md: "text/markdown",
      markdown: "text/markdown",
      text: "text/plain",
    };
    return (
      mimeTypes[extension] || mimeTypes[type] || "application/octet-stream"
    );
  }
}
