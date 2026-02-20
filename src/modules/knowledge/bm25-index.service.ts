import { Injectable, Logger } from "@nestjs/common";
import elasticlunr from "elasticlunr";
import { TokenizerService } from "./tokenizer.service";

/**
 * BM25 索引文档结构
 */
export interface BM25Document {
  /** 文档唯一标识 */
  id: string;
  /** 文档内容 */
  content: string;
  /** 文件名 */
  fileName?: string;
  /** 预览文本 */
  preview?: string;
  /** 其他元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * BM25 搜索结果
 */
export interface BM25SearchResult {
  /** 文档ID */
  id: string;
  /** BM25 得分 */
  score: number;
  /** 文档内容 */
  content: string;
  /** 文件名 */
  fileName?: string;
  /** 预览文本 */
  preview?: string;
  /** 元数据 */
  metadata?: Record<string, unknown>;
}

/**
 * BM25 索引配置选项
 */
export interface BM25IndexOptions {
  /** BM25 k1 参数（词频饱和度，默认 1.2） */
  k1?: number;
  /** BM25 b 参数（文档长度归一化，默认 0.75） */
  b?: number;
  /** 是否启用 boost */
  boost?: boolean;
}

/**
 * BM25 配置常量
 */
const DEFAULT_BM25_K1 = 1.2;
const DEFAULT_BM25_B = 0.75;

/**
 * 统一的分词参数配置
 */
const TOKENIZER_CONFIG = {
  /** 是否过滤停用词 */
  filterStopWords: true,
  /** 最小词长度（索引和查询统一使用 1） */
  minWordLength: 1,
};

/**
 * elasticlunr 索引类型
 */
interface ElasticlunrIndex {
  addField(fieldName: string): void;
  setRef(refName: string): void;
  addDoc(doc: BM25Document & { tokens?: string }): void;
  removeDocByRef(docRef: string): void;
  documentStore: {
    getDoc(docRef: string): BM25Document | null;
    hasDoc(docRef: string): boolean;
    docs: Record<string, BM25Document>;
    length: number;
    getFieldLength(docRef: string, fieldName: string): number;
  };
  search(
    query: string,
    config?: Record<string, unknown>,
  ): Array<{ ref: string; score: number }>;
  pipeline: {
    add(fn: (token: string) => string): void;
    reset(): void;
  };
  index: Record<
    string,
    {
      getDocs(): Record<string, BM25Document>;
      getTermFrequency(term: string, docRef: string): number;
    }
  >;
  idf(term: string, field: string): number;
  getFields(): string[];
}

/**
 * 索引存储结构
 */
interface IndexEntry {
  index: ElasticlunrIndex;
  documentCount: number;
  lastAccessed: number;
  /** BM25 参数 */
  bm25Config: {
    k1: number;
    b: number;
  };
}

@Injectable()
export class BM25IndexService {
  private readonly logger = new Logger(BM25IndexService.name);

  /** 用户索引缓存 Map<userId, IndexEntry> */
  private readonly indexCache = new Map<string, IndexEntry>();

  /** 索引空闲超时时间（毫秒）- 30分钟 */
  private readonly IDLE_TIMEOUT = 30 * 60 * 1000;

  /** 清理任务定时器 */
  private cleanupTimer: NodeJS.Timeout | null = null;

  constructor(private readonly tokenizerService: TokenizerService) {
    this.startCleanupTask();
  }

  /**
   * 构建用户的 BM25 索引
   * @param userId 用户ID
   * @param documents 文档列表
   * @param options 索引配置选项
   */
  async buildIndex(
    userId: number,
    documents: BM25Document[],
    options: BM25IndexOptions = {},
  ): Promise<void> {
    const indexKey = this.getIndexKey(userId);
    const startTime = Date.now();

    const k1 = options.k1 ?? DEFAULT_BM25_K1;
    const b = options.b ?? DEFAULT_BM25_B;

    try {
      // 创建新索引
      const index: ElasticlunrIndex = elasticlunr(function (this: unknown) {
        const self = this as ElasticlunrIndex;
        // 使用分词后的 tokens 字段进行索引
        self.addField("tokens");
        self.addField("fileName");
        self.setRef("id");
      }) as ElasticlunrIndex;

      // 重置 pipeline，移除对中文无效的英文处理函数 (lunr-trimmer, lunr-stemmer)
      index.pipeline.reset();
      // 只添加小写转换
      index.pipeline.add((token: string) => token.toLowerCase());

      // 添加文档
      for (const doc of documents) {
        // 使用 TokenizerService 进行分词（统一参数）
        const tokens = await this.tokenizerService.tokenize(
          doc.content,
          TOKENIZER_CONFIG,
        );

        // 创建带有分词结果的文档
        // 将分词结果用空格连接，便于 elasticlunr 处理
        const indexedDoc: BM25Document & { tokens?: string } = {
          ...doc,
          tokens: tokens.join(" "),
        };

        index.addDoc(indexedDoc);
      }

      // 存储索引
      this.indexCache.set(indexKey, {
        index,
        documentCount: documents.length,
        lastAccessed: Date.now(),
        bm25Config: { k1, b },
      });

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `Built BM25 index for user ${userId}: ${documents.length} documents in ${elapsed}ms (k1=${k1}, b=${b})`,
      );
    } catch (error) {
      this.logger.error(`Failed to build BM25 index for user ${userId}`, error);
      throw error;
    }
  }

  /**
   * 增量添加文档到索引
   * @param userId 用户ID
   * @param document 文档
   */
  async addDocument(userId: number, document: BM25Document): Promise<void> {
    const indexKey = this.getIndexKey(userId);
    const entry = this.indexCache.get(indexKey);

    if (!entry) {
      // 如果索引不存在，创建一个新索引
      await this.buildIndex(userId, [document]);
      return;
    }

    try {
      // 分词（统一参数）
      const tokens = await this.tokenizerService.tokenize(
        document.content,
        TOKENIZER_CONFIG,
      );

      const indexedDoc: BM25Document & { tokens?: string } = {
        ...document,
        tokens: tokens.join(" "),
      };

      entry.index.addDoc(indexedDoc);
      entry.documentCount++;
      entry.lastAccessed = Date.now();

      this.logger.debug(
        `Added document ${document.id} to BM25 index for user ${userId}`,
      );
    } catch (error) {
      this.logger.error(`Failed to add document to BM25 index`, error);
      throw error;
    }
  }

  /**
   * 从索引中删除文档
   * @param userId 用户ID
   * @param documentId 文档ID
   */
  removeDocument(userId: number, documentId: string): void {
    const indexKey = this.getIndexKey(userId);
    const entry = this.indexCache.get(indexKey);

    if (!entry) {
      return;
    }

    try {
      entry.index.removeDocByRef(documentId);
      entry.documentCount--;
      entry.lastAccessed = Date.now();

      this.logger.debug(
        `Removed document ${documentId} from BM25 index for user ${userId}`,
      );
    } catch (error) {
      this.logger.error(`Failed to remove document from BM25 index`, error);
    }
  }

  /**
   * 使用 BM25 搜索
   * @param userId 用户ID
   * @param query 查询文本
   * @param limit 返回结果数量限制
   * @returns 搜索结果
   */
  async search(
    userId: number,
    query: string,
    limit: number = 10,
  ): Promise<BM25SearchResult[]> {
    const indexKey = this.getIndexKey(userId);
    const entry = this.indexCache.get(indexKey);

    if (!entry) {
      this.logger.debug(`No BM25 index found for user ${userId}`);
      return [];
    }

    try {
      // 更新最后访问时间
      entry.lastAccessed = Date.now();

      // 对查询进行分词（统一参数）
      const queryTokens = await this.tokenizerService.tokenize(
        query,
        TOKENIZER_CONFIG,
      );

      if (queryTokens.length === 0) {
        return [];
      }

      // 将分词结果用空格连接，作为 elasticlunr 的查询输入
      const queryString = queryTokens.join(" ");

      // 使用 elasticlunr 内置的搜索
      // 配置查询字段和 boost
      const searchResults = entry.index.search(queryString, {
        fields: {
          tokens: { boost: 1 },
          fileName: { boost: 1 },
        },
        bool: "OR",
        expand: false, // 不使用扩展搜索，保持精确
      });

      // 格式化结果
      const formattedResults: BM25SearchResult[] = [];
      for (const result of searchResults.slice(0, limit)) {
        const doc = entry.index.documentStore.getDoc(result.ref);
        if (doc) {
          formattedResults.push({
            id: doc.id,
            score: result.score,
            content: doc.content,
            fileName: doc.fileName,
            preview: doc.preview,
            metadata: doc.metadata,
          });
        }
      }

      return formattedResults;
    } catch (error) {
      this.logger.error(`BM25 search failed for user ${userId}`, error);
      return [];
    }
  }

  /**
   * 获取指定文档的 BM25 得分（用于重排序）
   * @param userId 用户ID
   * @param query 查询文本
   * @param documentIds 文档ID列表
   * @returns 文档ID到BM25得分的映射
   */
  async getScoresForDocuments(
    userId: number,
    query: string,
    documentIds: string[],
  ): Promise<Map<string, number>> {
    const indexKey = this.getIndexKey(userId);
    const entry = this.indexCache.get(indexKey);

    if (!entry) {
      this.logger.debug(`No BM25 index found for user ${userId}`);
      return new Map();
    }

    try {
      // 更新最后访问时间
      entry.lastAccessed = Date.now();

      // 对查询进行分词
      const queryTokens = await this.tokenizerService.tokenize(
        query,
        TOKENIZER_CONFIG,
      );

      if (queryTokens.length === 0) {
        return new Map();
      }

      const queryString = queryTokens.join(" ");

      // 搜索所有匹配文档 (不设 limit 或设很大)
      // elasticlunr search 返回的是所有匹配结果
      const searchResults = entry.index.search(queryString, {
        fields: {
          tokens: { boost: 1 },
          fileName: { boost: 1 },
        },
        bool: "OR",
        expand: false,
      });

      // 过滤出指定文档的得分
      const scores = new Map<string, number>();
      const targetIds = new Set(documentIds);

      for (const result of searchResults) {
        if (targetIds.has(result.ref)) {
          scores.set(result.ref, result.score);
        }
      }

      // 对于未匹配到的文档，得分默认为 0 (Map 中不存在即为 0/undefined)
      return scores;
    } catch (error) {
      this.logger.error(`BM25 scoring failed for user ${userId}`, error);
      return new Map();
    }
  }

  /**
   * 清除用户的 BM25 索引
   * @param userId 用户ID
   */
  clearIndex(userId: number): void {
    const indexKey = this.getIndexKey(userId);
    const entry = this.indexCache.get(indexKey);

    if (entry) {
      this.indexCache.delete(indexKey);
      this.logger.log(`Cleared BM25 index for user ${userId}`);
    }
  }

  /**
   * 检查用户是否有索引
   * @param userId 用户ID
   */
  hasIndex(userId: number): boolean {
    const indexKey = this.getIndexKey(userId);
    return this.indexCache.has(indexKey);
  }

  /**
   * 获取用户索引的文档数量
   * @param userId 用户ID
   */
  getDocumentCount(userId: number): number {
    const indexKey = this.getIndexKey(userId);
    const entry = this.indexCache.get(indexKey);
    return entry?.documentCount ?? 0;
  }

  /**
   * 获取索引键
   */
  private getIndexKey(userId: number): string {
    return `user_${userId}`;
  }

  /**
   * 启动索引清理任务
   */
  private startCleanupTask(): void {
    // 每5分钟检查一次
    this.cleanupTimer = setInterval(
      () => {
        this.cleanupIdleIndexes();
      },
      5 * 60 * 1000,
    );
  }

  /**
   * 清理空闲索引
   */
  private cleanupIdleIndexes(): void {
    const now = Date.now();
    const keysToDelete: string[] = [];

    for (const [key, entry] of this.indexCache.entries()) {
      if (now - entry.lastAccessed > this.IDLE_TIMEOUT) {
        keysToDelete.push(key);
      }
    }

    if (keysToDelete.length > 0) {
      for (const key of keysToDelete) {
        this.indexCache.delete(key);
        this.logger.log(`Cleaned up idle BM25 index: ${key}`);
      }
    }
  }

  /**
   * 清理资源
   */
  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.indexCache.clear();
  }
}
