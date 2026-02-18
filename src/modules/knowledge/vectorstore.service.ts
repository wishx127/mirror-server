import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PGVectorStore } from "@langchain/community/vectorstores/pgvector";
import { OpenAIEmbeddings } from "@langchain/openai";
import { Document } from "@langchain/core/documents";
import { Pool as PgPool } from "pg";

// 导出 Pool 类型供其他模块使用
export type { Pool } from "pg";

// 安全的 Pool 类型包装，解决 TypeScript ESLint 对 pg 库类型的推断问题
interface SafePoolClient {
  query<R extends Record<string, unknown>>(
    text: string,
    values?: unknown[]
  ): Promise<{ rows: R[] }>;
  release(): void;
}

interface SafePool {
  end(): Promise<void>;
  connect(): Promise<SafePoolClient>;
}

// 内部使用的 PoolClient 类型
type InternalPoolClient = {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
  release(): void;
};

// 将原始 Pool 转换为 SafePool
function toSafePool(pool: PgPool): SafePool {
  // 使用类型断言来绕过 TypeScript ESLint 对 pg 库类型的检查
  const poolAny = pool as unknown as {
    end(): Promise<void>;
    connect(): Promise<InternalPoolClient>;
  };
  return {
    end: () => poolAny.end(),
    connect: async () => {
      const client = await poolAny.connect();
      return {
        query: async <R extends Record<string, unknown>>(text: string, values?: unknown[]) => {
          const result = await client.query(text, values);
          return result as { rows: R[] };
        },
        release: () => client.release(),
      };
    },
  };
}

export interface VectorStoreConfig {
  tableName: string;
  vectorColumnName: string;
  contentColumnName: string;
  idColumnName: string;
}

export interface AddDocumentsOptions {
  userId: number;
  fileName: string;
  fileSize: number;
  fileType: string;
  preview: string;
  fileData?: Buffer;
  isFirstChunk?: boolean;
}

export interface SearchResult {
  id: number;
  content: string;
  metadata: Record<string, unknown>;
  similarity: number;
}

@Injectable()
export class VectorStoreService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VectorStoreService.name);
  private vectorStore: PGVectorStore | null = null;
  private pool: SafePool | null = null;
  private rawPool: unknown = null;
  private embeddings: OpenAIEmbeddings;

  private readonly config: VectorStoreConfig = {
    tableName: "Knowledge",
    vectorColumnName: "embedding",
    contentColumnName: "content",
    idColumnName: "id",
  };

  constructor(private readonly configService: ConfigService) {
    // 使用与 KnowledgeService 相同的 embedding 配置（通义千问）
    const openaiApiKey = this.configService.get<string>("DASHSCOPE_API_KEY");

    this.embeddings = new OpenAIEmbeddings({
      apiKey: openaiApiKey,
      configuration: {
        baseURL: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      },
      modelName: "text-embedding-v1",
    });
  }

  async onModuleInit() {
    try {
      await this.initialize();
      this.logger.log("VectorStore initialized successfully");
    } catch (error) {
      this.logger.error("Failed to initialize VectorStore", error);
      // 不抛出异常，允许服务启动，后续操作会重试初始化
    }
  }

  async onModuleDestroy() {
    if (this.rawPool) {
      await (this.rawPool as { end(): Promise<void> }).end();
      this.logger.log("Database pool closed");
    }
  }

  /**
   * 初始化 PGVectorStore
   */
  async initialize(): Promise<PGVectorStore> {
    if (this.vectorStore) {
      return this.vectorStore;
    }

    const databaseUrl = this.configService.get<string>("DATABASE_URL");
    if (!databaseUrl) {
      throw new Error("DATABASE_URL is not configured");
    }

    // 解析数据库连接信息
    const url = new URL(databaseUrl);
    const connectionConfig = {
      host: url.hostname,
      port: parseInt(url.port) || 5432,
      database: url.pathname.slice(1),
      user: url.username,
      password: decodeURIComponent(url.password),
    };

    // 创建连接池
    // 使用类型断言绕过 TypeScript ESLint 对 pg 库类型的检查
    const rawPool = new (PgPool as unknown as new (config: {
      host: string;
      port: number;
      database: string;
      user: string;
      password: string;
      max?: number;
      idleTimeoutMillis?: number;
      connectionTimeoutMillis?: number;
    }) => unknown)({
      ...connectionConfig,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    this.pool = toSafePool(rawPool as PgPool);

    // 保存原始 pool 引用供 getPool() 使用
    this.rawPool = rawPool;

    // 初始化 PGVectorStore
    // 注意：我们使用现有的 Knowledge 表，不使用 PGVectorStore 的默认表创建逻辑
    this.vectorStore = await PGVectorStore.initialize(this.embeddings, {
      pool: rawPool as PgPool,
      tableName: this.config.tableName,
      columns: {
        idColumnName: this.config.idColumnName,
        vectorColumnName: this.config.vectorColumnName,
        contentColumnName: this.config.contentColumnName,
        // 不使用 metadata 列，因为我们没有这个字段
      },
    });

    return this.vectorStore;
  }

  /**
   * 确保 VectorStore 已初始化
   */
  private async ensureInitialized(): Promise<PGVectorStore> {
    if (!this.vectorStore) {
      return await this.initialize();
    }
    return this.vectorStore;
  }

  /**
   * 添加文档到向量存储
   * 注意：由于我们的表结构没有 metadata 字段，这里使用自定义插入逻辑
   */
  async addDocuments(
    documents: Document[],
    options: AddDocumentsOptions
  ): Promise<void> {
    await this.ensureInitialized();

    const startTime = Date.now();

    // 为每个文档添加 metadata
    const docsWithMetadata = documents.map((doc, index) => ({
      ...doc,
      metadata: {
        ...doc.metadata,
        userId: options.userId,
        fileName: options.fileName,
        fileSize: options.fileSize,
        fileType: options.fileType,
        preview: options.preview,
        isFirstChunk: index === 0,
      },
    }));

    // 使用 PGVectorStore 的 addDocuments 方法
    // 注意：PGVectorStore 需要 metadata 列，我们需要使用自定义插入
    // 由于我们的表结构没有 metadata 字段，我们使用直接的 SQL 插入
    
    // 获取 embedding 向量
    const embeddings = await this.embeddings.embedDocuments(
      docsWithMetadata.map((d) => d.pageContent)
    );

    // 使用连接池直接插入
    const client = await this.pool!.connect();
    try {
      await client.query("BEGIN");

      for (let i = 0; i < docsWithMetadata.length; i++) {
        const doc = docsWithMetadata[i];
        const embedding = embeddings[i];
        const embeddingString = `[${embedding.join(",")}]`;
        const isFirstChunk = doc.metadata.isFirstChunk as boolean | undefined;

        if (isFirstChunk && options.fileData) {
          // 第一个 chunk 包含源文件数据
          await client.query(
            `INSERT INTO "Knowledge" ("userId", "fileName", "content", "preview", "size", "type", "fileData", "embedding", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::vector, NOW())`,
            [
              options.userId,
              options.fileName,
              doc.pageContent,
              options.preview,
              options.fileSize,
              options.fileType,
              options.fileData,
              embeddingString,
            ]
          );
        } else {
          // 其他 chunks 不包含源文件数据
          await client.query(
            `INSERT INTO "Knowledge" ("userId", "fileName", "content", "preview", "size", "type", "embedding", "updatedAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7::vector, NOW())`,
            [
              options.userId,
              options.fileName,
              doc.pageContent,
              options.preview,
              options.fileSize,
              options.fileType,
              embeddingString,
            ]
          );
        }
      }

      await client.query("COMMIT");

      const elapsed = Date.now() - startTime;
      this.logger.log(
        `Added ${documents.length} documents in ${elapsed}ms (avg ${Math.round(elapsed / documents.length)}ms per doc)`
      );

      if (elapsed > 10000) {
        this.logger.warn(
          `Document insertion took ${elapsed}ms for ${documents.length} chunks, consider optimizing`
        );
      }
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * 相似度搜索
   * 使用 PGVectorStore 的 similaritySearchWithScore 方法
   */
  async similaritySearch(
    query: string,
    userId: number,
    k: number = 5,
    minSimilarity: number = 0.3
  ): Promise<SearchResult[]> {
    await this.ensureInitialized();

    const startTime = Date.now();

    // 生成查询向量
    const queryEmbedding = await this.embeddings.embedQuery(query);
    const queryEmbeddingString = `[${queryEmbedding.join(",")}]`;

    // 直接使用 SQL 查询,因为我们没有 metadata 列来使用 PGVectorStore 的 filter 功能
    const client = await this.pool!.connect();
    try {
      const result = await client.query(
        `SELECT id, content, 
                1 - (embedding <=> $1::vector) as similarity
         FROM "Knowledge"
         WHERE "userId" = $2 
         AND 1 - (embedding <=> $1::vector) >= $3
         ORDER BY embedding <=> $1::vector
         LIMIT $4`,
        [queryEmbeddingString, userId, minSimilarity, k]
      );

      const elapsed = Date.now() - startTime;
      this.logger.log(`Vector search completed in ${elapsed}ms`);

      if (elapsed > 500) {
        this.logger.warn(`Vector search took ${elapsed}ms, consider optimizing`);
      }

      interface QueryResultRow {
        id: number;
        content: string;
        similarity: string;
      }
      return (result.rows as unknown as QueryResultRow[]).map((row) => ({
        id: row.id,
        content: row.content,
        metadata: { userId },
        similarity: parseFloat(row.similarity),
      }));
    } finally {
      client.release();
    }
  }

  /**
   * 获取 Embeddings 实例
   */
  getEmbeddings(): OpenAIEmbeddings {
    return this.embeddings;
  }

  /**
   * 获取底层数据库连接池
   */
  getPool(): unknown {
    return this.rawPool;
  }
}
