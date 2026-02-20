## 1. 基础依赖和环境配置

- [x] 1.1 安装 elasticlunr 依赖 (`npm install elasticlunr --legacy-peer-deps`)
- [x] 1.2 安装 TypeScript 类型定义 (`npm install @types/elasticlunr --save-dev --legacy-peer-deps`)
- [x] 1.3 安装 nodejieba 中文分词库 (`npm install nodejieba --legacy-peer-deps`), 安装失败时改为使用jieba-js (`npm install jieba-js --legacy-peer-deps`)

## 2. 分词器实现

- [x] 2.1 创建 `TokenizerService` 服务类，封装分词逻辑
- [x] 2.2 集成 nodejieba 实现中文分词
- [x] 2.3 实现中英文混合文本处理
- [x] 2.4 添加停用词过滤功能
- [x] 2.5 提供 fallback 分词方案（当nodejieba 不可用时）

## 3. BM25 索引服务实现

- [x] 3.1 创建 `BM25IndexService` 服务类
- [x] 3.2 实现 `buildIndex(userId, documents)` 构建索引方法
- [x] 3.3 实现 `addDocument(userId, document)` 增量添加文档
- [x] 3.4 实现 `removeDocument(userId, documentId)` 删除文档
- [x] 3.5 实现 `search(userId, query, limit)` 搜索方法
- [x] 3.6 实现 `clearIndex(userId)` 清除索引方法
- [x] 3.7 集成 TokenizerService 进行文本预处理

## 4. 与 HybridRetriever 集成

- [x] 4.1 扩展 `HybridRetrieverOptions` 接口，添加 BM25 重排序相关选项
- [x] 4.2 在 HybridRetriever 中注入 BM25IndexService
- [x] 4.3 在 `_getRelevantDocuments` 方法中添加 BM25 重排序逻辑
- [x] 4.4 实现向量得分与 BM25 得分的加权融合算法
- [x] 4.5 确保不启用 BM25 时保持原有行为（向后兼容）

## 5. 配置和 API 扩展

- [x] 5.1 在知识库设置中添加 BM25 重排序开关
- [x] 5.2 添加 BM25 权重配置参数
- [x] 5.3 确保现有 API 接口保持兼容
