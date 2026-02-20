import { Injectable, Logger, OnModuleInit } from "@nestjs/common";

// 中文停用词列表
const CHINESE_STOP_WORDS = new Set([
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
  "之",
  "与",
  "及",
  "等",
  "其",
  "为",
  "以",
  "于",
  "而",
  "或",
  "但",
  "如",
  "若",
  "则",
  "因",
  "故",
  "所",
  "者",
  "也",
  "矣",
  "焉",
  "乎",
  "哉",
  "兮",
  "尔",
  "耳",
  "矣",
  "焉",
  "哉",
]);

// 英文停用词列表
const ENGLISH_STOP_WORDS = new Set([
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

export interface TokenizerOptions {
  /** 是否过滤停用词 */
  filterStopWords?: boolean;
  /** 最小词长度 */
  minWordLength?: number;
  /** 最大词长度 */
  maxWordLength?: number;
}

interface JiebaInstance {
  load?(): Promise<void>;
  cut(text: string, strict?: boolean): string[];
}

@Injectable()
export class TokenizerService implements OnModuleInit {
  private readonly logger = new Logger(TokenizerService.name);
  private jiebaLoaded = false;

  async onModuleInit() {
    await this.initializeJieba();
  }

  /**
   * 初始化 jieba 分词器
   */
  private async initializeJieba(): Promise<void> {
    try {
      // jieba-js 使用动态导入
      const jiebaModule = await import("jieba-js");

      const moduleExport = jiebaModule as unknown as
        | JiebaInstance
        | { default: JiebaInstance };
      const jieba =
        "default" in moduleExport ? moduleExport.default : moduleExport;

      // Check if load exists (some versions might need it)
      if (typeof jieba.load === "function") {
        await jieba.load();
      }

      this.jiebaLoaded = true;
      this.logger.log("Jieba tokenizer initialized successfully");
    } catch (error) {
      this.logger.warn(
        `Failed to load jieba, will use fallback tokenizer: ${error}`,
      );
      this.jiebaLoaded = false;
    }
  }

  /**
   * 对文本进行分词
   * @param text 待分词文本
   * @param options 分词选项
   * @returns 分词结果数组
   */
  async tokenize(
    text: string,
    options: TokenizerOptions = {},
  ): Promise<string[]> {
    const {
      filterStopWords = true,
      minWordLength = 1,
      maxWordLength = 50,
    } = options;

    if (!text || text.trim().length === 0) {
      return [];
    }

    let tokens: string[];

    if (this.jiebaLoaded) {
      tokens = await this.jiebaTokenize(text);
    } else {
      tokens = this.fallbackTokenize(text);
    }

    // 后处理
    return this.postProcess(tokens, {
      filterStopWords,
      minWordLength,
      maxWordLength,
    });
  }

  /**
   * 使用 jieba 进行分词
   */
  private async jiebaTokenize(text: string): Promise<string[]> {
    try {
      const jiebaModule = await import("jieba-js");

      const moduleExport = jiebaModule as unknown as
        | JiebaInstance
        | { default: JiebaInstance };
      const jieba =
        "default" in moduleExport ? moduleExport.default : moduleExport;

      const result = jieba.cut(text, false); // false = 精确模式
      return result;
    } catch (error) {
      this.logger.debug(`Jieba tokenization failed, using fallback: ${error}`);
      return this.fallbackTokenize(text);
    }
  }

  /**
   * 回退分词方案 - 简单的中英文分词
   */
  private fallbackTokenize(text: string): string[] {
    const tokens: string[] = [];

    // 英文单词提取
    const englishWords: string[] = text.match(/[a-zA-Z]+/g) || [];
    tokens.push(...englishWords.map((w) => w.toLowerCase()));

    // 中文分词 - 使用简单的 N-gram 方法
    const chineseSegments: string[] = text.match(/[\u4e00-\u9fa5]+/g) || [];
    for (const segment of chineseSegments) {
      // 添加 1-4 字的 N-gram
      for (let len = 1; len <= Math.min(4, segment.length); len++) {
        for (let i = 0; i <= segment.length - len; i++) {
          tokens.push(segment.slice(i, i + len));
        }
      }
      // 如果片段较短，也添加整个片段
      if (segment.length <= 4 && segment.length >= 1) {
        tokens.push(segment);
      }
    }

    return tokens;
  }

  /**
   * 后处理：过滤停用词、长度限制、去重
   */
  private postProcess(
    tokens: string[],
    options: Required<Omit<TokenizerOptions, "maxWordLength">> & {
      maxWordLength: number;
    },
  ): string[] {
    const { filterStopWords, minWordLength, maxWordLength } = options;

    let processed = tokens;

    // 过滤停用词
    if (filterStopWords) {
      processed = processed.filter((token) => !this.isStopWord(token));
    }

    // 长度过滤
    processed = processed.filter(
      (token) => token.length >= minWordLength && token.length <= maxWordLength,
    );

    // 去重
    return [...new Set(processed)];
  }

  /**
   * 检查是否为停用词
   */
  private isStopWord(word: string): boolean {
    const lowerWord = word.toLowerCase();
    return CHINESE_STOP_WORDS.has(word) || ENGLISH_STOP_WORDS.has(lowerWord);
  }

  /**
   * 检测文本主要语言
   * @returns 'zh' | 'en' | 'mixed'
   */
  detectLanguage(text: string): "zh" | "en" | "mixed" {
    const chineseChars = text.match(/[\u4e00-\u9fa5]/g) || [];
    const englishChars = text.match(/[a-zA-Z]/g) || [];

    const chineseRatio = chineseChars.length / text.length;
    const englishRatio = englishChars.length / text.length;

    if (chineseRatio > 0.3 && englishRatio > 0.1) {
      return "mixed";
    } else if (chineseRatio > englishRatio) {
      return "zh";
    } else {
      return "en";
    }
  }

  /**
   * 提取关键词（用于搜索）
   * @param text 文本
   * @param maxKeywords 最大关键词数
   * @returns 关键词数组
   */
  async extractKeywords(
    text: string,
    maxKeywords: number = 10,
  ): Promise<string[]> {
    const tokens = await this.tokenize(text, {
      filterStopWords: true,
      minWordLength: 2,
    });

    // 简单的关键词提取：按词频排序
    const frequency = new Map<string, number>();
    for (const token of tokens) {
      frequency.set(token, (frequency.get(token) || 0) + 1);
    }

    return Array.from(frequency.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, maxKeywords)
      .map(([word]) => word);
  }

  /**
   * 检查分词器是否已初始化
   */
  isReady(): boolean {
    return this.jiebaLoaded;
  }
}
