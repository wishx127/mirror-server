import { BaseRetriever } from "@langchain/core/retrievers";
import { Document } from "@langchain/core/documents";
import { Logger } from "@nestjs/common";
import { Pool } from "pg";
import { OpenAIEmbeddings } from "@langchain/openai";
import { BM25IndexService } from "../bm25-index.service";
import { TokenizerService } from "../tokenizer.service";

// 安全的 Pool 类型包装，解决 TypeScript ESLint 对 pg 库类型的推断问题
interface SafePool {
  connect(): Promise<SafePoolClient>;
}

interface SafePoolClient {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[] }>;
  release(): void;
}

/**
 * 将原始 Pool 转换为 SafePool
 * 使用类型断言来解决 TypeScript ESLint 对 pg 库类型的推断问题
 */
function toSafePool(pool: Pool): SafePool {
  // 获取 pool.connect 方法的引用并断言类型
  const poolAny = pool as unknown as { connect(): Promise<PoolClient> };
  return {
    connect: async (): Promise<SafePoolClient> => {
      const client = await poolAny.connect();
      return {
        query: async <R extends Record<string, unknown>>(
          text: string,
          values?: unknown[],
        ) => {
          const result = (await client.query(text, values)) as { rows: R[] };
          return result;
        },
        release: () => (client as { release(): void }).release(),
      };
    },
  };
}

// 声明 PoolClient 类型，用于类型断言
type PoolClient = {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
};

export interface HybridRetrieverOptions {
  limit?: number;
  minSimilarity?: number;
  rrfK?: number;
  vectorWeight?: number;
  keywordWeight?: number;
  useBM25Rerank?: boolean;
  /** BM25 在融合得分中的权重（默认 0.3） */
  bm25Weight?: number;
  /** BM25 索引服务（启用 BM25 时必需） */
  bm25IndexService?: BM25IndexService;
  tokenizerService?: TokenizerService;
}

export interface SearchResult {
  id: number;
  fileName: string;
  content: string;
  preview: string;
  size: number;
  type: string;
  similarity: number;
  keywordScore?: number;
  hybridScore?: number;
}

interface VectorSearchResult {
  id: number;
  content: string;
  similarity: number;
}

interface KeywordSearchResult {
  id: number;
  fileName: string;
  content: string;
  preview: string;
  size: number;
  type: string;
  matchCount: number;
}

/**
 * 自定义混合检索器
 * 结合向量检索和关键词检索，使用 RRF 算法融合结果
 * 可选：使用 BM25 进行重排序
 */
export class HybridRetriever extends BaseRetriever {
  lc_namespace = ["mirror", "retrievers"];

  private readonly logger = new Logger(HybridRetriever.name);
  private readonly pool: SafePool;
  private readonly limit: number;
  private readonly minSimilarity: number;
  private readonly vectorWeight: number;
  private readonly keywordWeight: number;
  private readonly useBM25Rerank: boolean;
  private readonly bm25Weight: number;
  private readonly bm25IndexService?: BM25IndexService;
  private readonly tokenizerService?: TokenizerService;

  constructor(
    pool: Pool,
    private readonly embeddings: OpenAIEmbeddings,
    private readonly userId: number,
    options: HybridRetrieverOptions = {},
  ) {
    super();
    this.pool = toSafePool(pool);
    this.limit = options.limit ?? 5;
    this.minSimilarity = options.minSimilarity ?? 0.3;
    this.vectorWeight = options.vectorWeight ?? 0.7;
    this.keywordWeight = options.keywordWeight ?? 0.3;
    this.useBM25Rerank = options.useBM25Rerank ?? false;
    this.bm25Weight = options.bm25Weight ?? 0.3;
    this.bm25IndexService = options.bm25IndexService;
    this.tokenizerService = options.tokenizerService;

    if (this.useBM25Rerank && !this.bm25IndexService) {
      this.logger.warn(
        "BM25 reranking enabled but no BM25IndexService provided",
      );
    }
  }

  /**
   * 实现 BaseRetriever 接口的核心方法
   */
  async _getRelevantDocuments(query: string): Promise<Document[]> {
    const startTime = Date.now();

    try {
      // 并行执行向量检索和关键词检索
      const [vectorResults, keywordResults] = await Promise.all([
        this.vectorSearch(query),
        this.keywordSearch(query),
      ]);

      // 使用 RRF 算法融合结果
      let mergedResults = this.mergeResultsWithRRF(
        vectorResults,
        keywordResults,
      );

      // 如果启用 BM25 重排序，进行二次排序
      if (this.useBM25Rerank && this.bm25IndexService) {
        mergedResults = await this.rerankWithBM25(query, mergedResults);
      }

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `Hybrid search completed in ${elapsed}ms, returned ${mergedResults.length} results` +
          (this.useBM25Rerank ? " (with BM25 rerank)" : ""),
      );

      if (elapsed > 500) {
        this.logger.warn(
          `Hybrid search took ${elapsed}ms, consider optimizing`,
        );
      }

      // 转换为 Document 格式
      const documents = this.convertToDocuments(mergedResults);
      return documents;
    } catch (error) {
      this.logger.error("Hybrid search failed", error);
      throw error;
    }
  }

  /**
   * 使用 BM25 对结果进行重排序
   * 修复：对已有结果计算 BM25 得分，而非重新搜索
   * 修复：得分归一化到同一量级
   */
  private async rerankWithBM25(
    query: string,
    results: SearchResult[],
  ): Promise<SearchResult[]> {
    if (results.length === 0) {
      return results;
    }

    try {
      // 检查是否有 BM25 索引
      if (!this.bm25IndexService?.hasIndex(this.userId)) {
        this.logger.debug(
          `No BM25 index for user ${this.userId}, skipping rerank`,
        );
        return results;
      }

      // 获取结果中的文档 ID 列表
      const resultIds = results.map((r) => String(r.id));

      // 对已有结果计算 BM25 得分（而非重新搜索）
      const bm25Scores = await this.bm25IndexService.getScoresForDocuments(
        this.userId,
        query,
        resultIds,
      );

      // 计算 RRF 得分的最大值，用于归一化
      const maxRRFScore = Math.max(
        ...results.map((r) => r.hybridScore || 0),
        0.001,
      );

      // 计算 BM25 得分的最大值，用于归一化
      const maxBM25Score = Math.max(...Array.from(bm25Scores.values()), 0.001);

      const rerankedResults = results.map((result) => {
        const bm25Score = bm25Scores.get(String(result.id)) ?? 0;

        // 归一化 BM25 得分到 0-1 范围
        const normalizedBM25Score = bm25Score / maxBM25Score;

        // 归一化 RRF 得分到 0-1 范围
        const normalizedRRFScore = (result.hybridScore || 0) / maxRRFScore;

        // 加权融合：两个得分都已归一化到 0-1 范围
        const rrfWeight = 1 - this.bm25Weight;
        const finalScore =
          normalizedRRFScore * rrfWeight +
          normalizedBM25Score * this.bm25Weight;

        return {
          ...result,
          hybridScore: finalScore,
        };
      });

      // 按融合后得分重新排序
      rerankedResults.sort(
        (a, b) => (b.hybridScore || 0) - (a.hybridScore || 0),
      );

      return rerankedResults;
    } catch (error) {
      this.logger.warn(
        "BM25 reranking failed, returning original results",
        error,
      );
      return results;
    }
  }

  /**
   * 向量检索
   */
  private async vectorSearch(query: string): Promise<VectorSearchResult[]> {
    try {
      // 生成查询向量
      const queryEmbedding = await this.embeddings.embedQuery(query);
      const queryEmbeddingString = `[${queryEmbedding.join(",")}]`;

      const client = await this.pool.connect();
      try {
        const result = await client.query<{
          id: number;
          content: string;
          similarity: number;
        }>(
          `SELECT id, content, 
                  1 - (embedding <=> $1::vector) as similarity
           FROM "Knowledge"
           WHERE "userId" = $2 
      const keywords = this.extractKeywords(query);
           ORDER BY embedding <=> $1::vector
           LIMIT $4`,
          [
            queryEmbeddingString,
            this.userId,
            this.minSimilarity,
            this.limit * 2,
          ],
        );

        return result.rows.map((row) => ({
          id: row.id,
          content: row.content,
          similarity: parseFloat(String(row.similarity)),
        }));
      } finally {
        client.release();
      }
    } catch (error) {
      this.logger.warn("Vector search failed, returning empty results", error);
      return [];
    }
  }

  /**
   * 关键词检索
   */
  private async keywordSearch(query: string): Promise<KeywordSearchResult[]> {
    try {
      // 提取关键词
      const keywords = await this.extractKeywords(query);

      if (keywords.length === 0) {
        return [];
      }

      // 构建动态 SQL 条件
      const keywordConditions = keywords
        .map(
          (kw) =>
            `CASE WHEN content ILIKE '%${this.escapeSQL(kw)}%' THEN 1 ELSE 0 END`,
        )
        .join(" + ");

      const keywordWhereClause = keywords
        .map((kw) => `content ILIKE '%${this.escapeSQL(kw)}%'`)
        .join(" OR ");

      const client = await this.pool.connect();
      try {
        const result = await client.query<{
          id: number;
          fileName: string;
          content: string;
          preview: string;
          size: number;
          type: string;
          matchCount: number;
        }>(
          `SELECT id, "fileName", content, preview, size, type,
                  (${keywordConditions}) as "matchCount"
           FROM "Knowledge"
           WHERE "userId" = $1
           AND (${keywordWhereClause})
           ORDER BY "matchCount" DESC, id ASC
           LIMIT $2`,
          [this.userId, this.limit * 2],
        );

        return result.rows.map((row) => ({
          id: row.id,
          fileName: row.fileName,
          content: row.content,
          preview: row.preview,
          size: row.size,
          type: row.type,
          matchCount: parseInt(String(row.matchCount), 10),
        }));
      } finally {
        client.release();
      }
    } catch (error) {
      this.logger.warn("Keyword search failed, returning empty results", error);
      return [];
    }
  }

  /**
   * 从查询中提取关键词
   */
  private extractKeywords(query: string): Promise<string[]> {
    if (this.tokenizerService) {
      return this.tokenizerService.extractKeywords(query, 10);
    }
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
      "our",
      "i",
      "me",
      "they",
      "we",
      "us",
      "him",
      "them",
    ]);

    const words: string[] = [];

    // 英文单词提取
    const englishWords: string[] = query.match(/[a-zA-Z]+/g) || [];
    englishWords.forEach((word) => {
      const lowerWord = word.toLowerCase();
      if (lowerWord.length >= 2 && !stopWords.has(lowerWord)) {
        words.push(lowerWord);
      }
    });

    // 中文词组提取（使用简单的N-gram方法）
    const chineseChars: string[] = query.match(/[\u4e00-\u9fa5]+/g) || [];
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
    return uniqueWords.slice(0, 10);
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
   */
  private mergeResultsWithRRF(
    vectorResults: VectorSearchResult[],
    keywordResults: KeywordSearchResult[],
  ): SearchResult[] {
    const scoreMap = new Map<
      number,
      {
        result: SearchResult;
        vectorRank: number | null;
        keywordRank: number | null;
        vectorScore: number;
        keywordScore: number;
      }
    >();

    // 处理向量检索结果
    vectorResults.forEach((result, index) => {
      const rrfScore = 1 / (this.rrfK + index + 1);
      scoreMap.set(result.id, {
        result: {
          id: result.id,
          fileName: "",
          content: result.content,
          preview: "",
          size: 0,
          type: "",
          similarity: result.similarity,
          keywordScore: 0,
          hybridScore: 0,
        },
        vectorRank: index + 1,
        keywordRank: null,
        vectorScore: rrfScore * this.vectorWeight,
        keywordScore: 0,
      });
    });

    // 处理关键词检索结果
    keywordResults.forEach((result, index) => {
      const rrfScore = 1 / (this.rrfK + index + 1);
      const existing = scoreMap.get(result.id);

      if (existing) {
        // 如果已存在，累加得分
        existing.keywordRank = index + 1;
        existing.keywordScore = rrfScore * this.keywordWeight;
        existing.result.fileName = result.fileName;
        existing.result.preview = result.preview;
        existing.result.size = result.size;
        existing.result.type = result.type;
        existing.result.keywordScore = result.matchCount;
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
          keywordScore: rrfScore * this.keywordWeight,
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
      .slice(0, this.limit);

    return mergedResults;
  }

  /**
   * 将搜索结果转换为 Document 格式
   */
  private convertToDocuments(results: SearchResult[]): Document[] {
    return results.map((result) => {
      return new Document({
        pageContent: result.content,
        metadata: {
          id: result.id,
          fileName: result.fileName,
          similarity: result.similarity,
          keywordScore: result.keywordScore,
          hybridScore: result.hybridScore,
        },
      });
    });
  }

  /**
   * 获取原始搜索结果（包含完整元数据）
   */
  async getSearchResults(query: string): Promise<SearchResult[]> {
    const startTime = Date.now();

    const [vectorResults, keywordResults] = await Promise.all([
      this.vectorSearch(query),
      this.keywordSearch(query),
    ]);

    let mergedResults = this.mergeResultsWithRRF(vectorResults, keywordResults);
    if (this.useBM25Rerank && this.bm25IndexService) {
      mergedResults = await this.rerankWithBM25(query, mergedResults);
    }

    const elapsed = Date.now() - startTime;
    this.logger.log(
      `Search completed in ${elapsed}ms, returned ${mergedResults.length} results`,
    );

    return mergedResults;
  }
}
