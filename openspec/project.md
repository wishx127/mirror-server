# Mirror Server - 项目规范文档

## 📋 项目概述

**项目名称**: Mirror Server  
**项目类型**: NestJS 后端服务  
**主要用途**: 为 Mirror Chat 前端应用提供 API 服务  
**开发语言**: TypeScript  
**Node.js 版本要求**: >= 20

### 核心能力

- 🤖 **智能对话服务**: 支持流式响应、思维链推理、多模态对话
- 📚 **知识库检索 (RAG)**: 混合检索策略（向量+关键词），支持多种文档格式
- 🎨 **AI 图片生成**: 集成阿里云百炼 API，支持文本生成图片
- 🎤 **语音服务**: 语音识别 (ASR) 和语音合成 (TTS)，集成腾讯云
- 🔐 **安全认证**: 双 Token 机制（JWT + Refresh Token），RSA 加密传输
- 👥 **角色管理**: 系统预设角色 + 用户自定义角色
- 💾 **数据存储**: PostgreSQL + pgvector 向量数据库

---

## 🛠️ 技术栈

### 核心框架
- **NestJS** (v11.0+): 企业级 Node.js 框架
- **Prisma** (v6.11+):下一代 ORM
- **TypeScript** (v5.7+): 类型安全的 JavaScript 超集

### 数据库与存储
- **PostgreSQL**: 关系型数据库
- **pgvector**: PostgreSQL 向量扩展（用于向量检索）
- **Supabase Storage**: 文件存储服务（头像、图片）

### AI/ML 服务
- **OpenAI API / LangChain**: 大语言模型集成
  - 模型支持: DeepSeek, Qwen 等兼容 OpenAI API 的模型
  - LangChain 组件: TextSplitter, Embeddings
- **阿里云百炼**: 图片生成服务
  - 模型: wanx-v1, qwen-image-max
- **腾讯云**: 语音识别与合成

### 认证与安全
- **Passport + JWT**: 身份认证
- **bcrypt**: 密码加密
- **Node-RSA**: 数据传输加密

### 其他关键依赖
- **RxJS**: 响应式编程（流式响应）
- **axios**: HTTP 客户端
- **sharp**: 图片处理
- **mammoth**: Word 文档解析
- **pdf-parse**: PDF 解析
- **xlsx**: Excel 文件处理

---

## 🏗️ 架构设计

### 模块化架构

项目采用 NestJS 模块化架构，每个功能域独立成模块：

```
src/
├── modules/
│   ├── prisma/          # 数据库连接服务（全局共享）
│   ├── auth/            # 认证与授权模块
│   ├── user/            # 用户管理模块
│   ├── chat/            # 对话服务模块 ⭐
│   ├── knowledge/       # 知识库模块 ⭐
│   ├── role/            # 角色管理模块
│   ├── conversation/    # 对话历史管理
│   ├── favorite/        # 收藏功能
│   ├── avatar/          # 头像上传与处理
│   ├── tts/             # 文本转语音（腾讯云）
│   ├── asr/             # 语音识别（腾讯云）
│   ├── email/           # 邮件服务
│   └── encryption/      # RSA 加密服务
├── config/              # 配置文件
├── filters/             # 全局异常过滤器
├── interceptors/        # 全局响应拦截器
└── middleware/          # 全局日志中间件
```

**⭐ 核心模块说明**:
- **ChatModule**: 智能对话核心，支持流式输出、思维链、多模态
- **KnowledgeModule**: RAG 知识库，实现向量检索和混合检索

---

## 🔐 认证与授权

### 双 Token 机制

系统使用双 Token 机制，通过 **HttpOnly Cookie** 存储：

| Token 类型 | 有效期 | 存储位置 | 用途 |
|-----------|-------|---------|------|
| Access Token | 12 小时 | `access_token` Cookie | API 认证 |
| Refresh Token | 7 天 | `refresh_token` Cookie | 刷新 Access Token |

### Cookie 安全配置

```typescript
{
  httpOnly: true,      // 防止 XSS 攻击
  secure: true,        // 仅 HTTPS 传输（生产环境）
  sameSite: 'lax',     // 防止 CSRF 攻击
  maxAge: 12 * 60 * 60 * 1000  // 12 小时
}
```

### 认证流程

1. **登录** → 验证用户名密码 → 生成双 Token → 设置 Cookie → 创建 Session
2. **API 请求** → JWT Strategy 验证 Token（优先从 Cookie 读取）
3. **Token 过期** → 使用 Refresh Token 刷新 → 生成新的 Access Token
4. **登出** → 清除 Cookie → 删除 Session 记录

### 关键接口

- `POST /api/v1/user/login`: 登录
- `POST /api/v1/auth/refresh`: 刷新 Token
- `POST /api/v1/auth/logout`: 登出

---

## 💬 对话服务核心流程

### ChatService 核心方法

#### 1. `chatStream()` - 流式对话

**位置**: `src/modules/chat/chat.service.ts:135`

**流程**:
1. **配置加载**: 获取用户模型配置（API Key, Base URL, Model）
2. **上下文构建**:
   - 加载用户选择的角色 prompt
   - 知识库检索（启用时）
   - 加载历史对话
3. **多模态支持**:
   - 图像分析（URL 或 Base64）
   - 文件内容分析
   - 自动整合到 OpenAI 消息格式
4. **流式响应**: RxJS Observable 实现 SSE
5. **对话存储**:
   - 自动生成标题（新对话）
   - 存储思维链内容
   - 结构化消息存储

**消息结构**:
```typescript
interface StoredMessage {
  role: 'user' | 'assistant' | 'system';
  content: MessageContentPart[];  // 支持多内容片段
  key: string;                     // 唯一标识
  time: string;                    // 时间戳
  reasoning_content?: string;      // 思维链内容
}

interface MessageContentPart {
  type: 'thinking' | 'content' | 'image' | 'file';
  data: string | ImageMetadata | FileMetadata;
}
```

#### 2. `generateImage()` - AI 图片生成

**位置**: `src/modules/chat/chat.service.ts:1021`

**流程**:
1. 调用阿里云百炼图片生成 API
2. 支持参数：
   - 模型选择（wanx-v1, qwen-image-max）
   - 图片尺寸（1024×1024, 720×1280, 1280×720）
   - 负面提示词
   - 参考图片（URL 或 Base64）
   - 参考模式（refonly/repaint）
   - 生成数量（1-4 张）
3. 异步任务轮询（最多 30 次，间隔 2 秒）
4. 图片下载并存储到 Supabase

---

## 📚 知识库检索架构 (RAG)

### KnowledgeService 核心方法

**位置**: `src/modules/knowledge/knowledge.service.ts`

### 1. 文档上传与处理 (`uploadFile`)

**支持的文件格式**:
- PDF
- Word 文档（.docx, .doc）
- Excel（.xlsx, .xls）
- 文本文件（.txt）
- Markdown（.md）

**处理流程**:
```typescript
1. 文件解析 → 提取文本内容
2. 文本切片 → RecursiveCharacterTextSplitter
   - chunkSize: 1000
   - chunkOverlap: 150
   - separators: ["\n\n", "\n", "。", "！", "？", ".", "!", "?", " "]
3. 向量生成 → OpenAIEmbeddings
   - 模型: text-embedding-v1 (阿里云通义千问)
   - 批处理: BATCH_SIZE = 10
4. 数据存储 → PostgreSQL + pgvector
   - 字段: embedding Unsupported("vector(1536)")
   - 保留源文件: fileData Bytes
```

### 2. 混合检索 (`search`)

**算法**: RRF (Reciprocal Rank Fusion)

**流程**:
```typescript
// 并行执行两种检索
const [vectorResults, keywordResults] = await Promise.all([
  this.vectorSearch(userId, query, limit * 2, minSimilarity),
  this.keywordSearch(userId, query, limit * 2),
]);

// RRF 算法融合
const mergedResults = this.mergeResultsWithRRF(
  vectorResults,
  keywordResults,
  limit,
  k = 60,              // RRF 参数
  vectorWeight = 0.7,  // 向量检索权重
  keywordWeight = 0.3  // 关键词检索权重
);
```

**向量检索**:
- 使用 pgvector 的 `<=>` 运算符（余弦距离）
- 相似度阈值过滤（默认 0.3）

**关键词检索**:
- 中文分词（N-gram 方法）
- 停用词过滤
- ILIKE 模式匹配

### 3. 关键词提取 (`extractKeywords`)

**策略**:
- 英文: 正则提取单词，过滤停用词
- 中文: 2-4 字 N-gram 提取词组
- 最多返回 10 个关键词

### ⚠️ 当前实现的问题

根据 LangChain 官方最佳实践，当前实现存在以下问题：

1. **未使用 LangChain VectorStore 抽象**
   - 当前: 直接使用 PostgreSQL 原生 SQL
   - 推荐: 使用 `PGVectorStore` 或其他 VectorStore

2. **未使用 Retrieval Chain**
   - 当前: 手动拼接上下文
   - 推荐: 使用 `createRetrievalChain`

3. **未使用 Document Loader**
   - 当前: 手动解析各种文件格式
   - 推荐: 使用 LangChain 的 Document Loaders

4. **缺少 Reranking 机制**
   - 当前: 仅使用 RRF 算法
   - 推荐: 使用 Cohere Rerank 或交叉编码器

**改进建议**: 参见 `/openspec/changes/migrate-to-langchain-vectorstore/`

---

## 🎭 角色管理

### 角色类型

1. **系统预设角色** (`isSystem: true`)
   - 由管理员创建
   - 所有用户可见
   - 不可修改/删除
   - 示例: 专业助手、代码专家、写作助手

2. **用户自定义角色** (`isSystem: false`)
   - 用户自行创建
   - 仅创建者可见
   - 可修改/删除

### 角色数据结构

```prisma
model Role {
  id          Int      @id @default(autoincrement())
  name        String
  description String?  @db.Text
  avatar      String?  // 头像 URL 或图标名称
  avatarColor String?  // 头像背景色
  prompt      String   @db.Text  // 系统提示词
  isSystem    Boolean  @default(false)
  userId      Int?     // 创建者 ID（系统角色为 null）
}
```

### 缓存机制

系统角色使用内存缓存，TTL = 24 小时：
```typescript
private systemRolesCache: Role[] | null = null;
private lastCacheTime: number = 0;
private readonly CACHE_TTL = 1440 * 60 * 1000; // 24 小时
```

---

## 🗄️ 数据库设计

### 核心模型关系

```
User (用户)
├── 1:1 → ModelConfig      // 用户模型配置
├── 1:N → UserConversation  // 用户对话列表
├── 1:N → Knowledge         // 用户知识库
├── 1:N → UserSession       // 用户会话
├── 1:1 → UserRole          // 用户当前角色
└── 1:1 → Avatar            // 用户头像

UserConversation (对话)
└── 1:1 → ConversationDetail  // 对话详情

Role (角色)
└── 1:N → UserRole          // 用户-角色关联
```

### 重要字段说明

#### Knowledge 表

```prisma
model Knowledge {
  id        Int      @id @default(autoincrement())
  userId    Int
  fileName  String
  content   String   @db.Text      // 文档切片内容
  preview   String?  @db.Text      // 预览文本
  size      Int?                    // 文件大小
  type      String?                 // 文件类型
  fileData  Bytes?                  // 源文件二进制数据
  embedding Unsupported("vector(1536)")?  // ⭐ 向量嵌入
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([userId])
  @@index([userId, fileName])
}
```

**注意事项**:
- `embedding` 字段需要 PostgreSQL 安装 `pgvector` 扩展
- `fileData` 仅在第一个 chunk 中保存源文件

#### ConversationDetail 表

```prisma
model ConversationDetail {
  id             Int      @id @default(autoincrement())
  conversationId String
  content        Json     // 存储消息数组
  createdAt      DateTime @default(now())
  updatedAt      DateTime @updatedAt
}
```

**消息存储格式**:
```json
[
  {
    "role": "user",
    "content": [
      { "type": "content", "data": "用户文本" },
      { "type": "image", "data": { "url": "..." } }
    ],
    "key": "abc123",
    "time": "2024-01-01 12:00:00"
  },
  {
    "role": "assistant",
    "content": [
      { "type": "thinking", "data": "推理过程..." },
      { "type": "content", "data": "回答内容..." }
    ],
    "key": "def456",
    "time": "2024-01-01 12:00:05"
  }
]
```

---

## 📡 API 设计规范

### 路由前缀

所有 API 统一前缀: `/api/v1`

### 响应格式

**成功响应**:
```json
{
  "success": true,
  "data": { ... },
  "message": "操作成功"
}
```

**错误响应**:
```json
{
  "success": false,
  "error": "错误类型",
  "message": "详细错误信息",
  "statusCode": 400
}
```

### 主要 API 端点

#### 用户模块
- `POST /api/v1/user/register`: 用户注册（RSA 加密）
- `POST /api/v1/user/login`: 用户登录（RSA 加密）
- `POST /api/v1/user/updatePassword`: 修改密码（RSA 加密）
- `GET /api/v1/user/profile`: 获取用户信息
- `PUT /api/v1/user/model-config`: 更新模型配置

#### 认证模块
- `POST /api/v1/auth/refresh`: 刷新 Token
- `POST /api/v1/auth/logout`: 登出

#### 对话模块
- `POST /api/v1/chat/stream`: 流式对话（SSE）
- `POST /api/v1/chat/generate-image`: AI 图片生成
- `GET /api/v1/conversation/list`: 获取对话列表
- `DELETE /api/v1/conversation/:id`: 删除对话

#### 知识库模块
- `POST /api/v1/knowledge/upload`: 上传文件
- `POST /api/v1/knowledge/search`: 知识库检索
- `GET /api/v1/knowledge/list`: 获取文件列表
- `DELETE /api/v1/knowledge/:id`: 删除文件

#### 角色模块
- `GET /api/v1/role/system`: 获取系统角色
- `GET /api/v1/role/user`: 获取用户自定义角色
- `POST /api/v1/role/create`: 创建角色
- `PUT /api/v1/role/:id`: 更新角色
- `DELETE /api/v1/role/:id`: 删除角色

#### 语音服务
- `POST /api/v1/tts`: 文本转语音
- `POST /api/v1/asr`: 语音识别

---

## 🔧 开发规范

### 代码规范

#### TypeScript 配置
```json
{
  "compilerOptions": {
    "strict": true,
    "strictNullChecks": true,  // 严格空检查
    "noImplicitAny": true      // 隐式 any 检查
  }
}
```

#### ESLint 规则
```javascript
{
  "rules": {
    "@typescript-eslint/no-explicit-any": "off",  // 允许 any 类型
    "@typescript-eslint/no-floating-promises": "warn",
    "@typescript-eslint/no-unsafe-argument": "warn"
  }
}
```

### 命名规范

- **文件命名**: 小写连字符（kebab-case）
  - 示例: `knowledge.service.ts`, `user.controller.ts`
  
- **类命名**: 大驼峰（PascalCase）
  - 示例: `KnowledgeService`, `UserController`
  
- **方法命名**: 小驼峰（camelCase）
  - 示例: `uploadFile()`, `getSystemRoles()`
  
- **常量命名**: 全大写下划线（UPPER_SNAKE_CASE）
  - 示例: `CACHE_TTL`, `BATCH_SIZE`

### 目录结构规范

```
module/
├── module-name.module.ts      # 模块定义
├── module-name.controller.ts  # 控制器
├── module-name.service.ts     # 服务层
├── module-name.dto.ts         # 数据传输对象
└── module-name.spec.ts        # 单元测试
```

### 错误处理

使用 NestJS 内置异常:
```typescript
throw new BadRequestException('错误信息');
throw new NotFoundException('资源不存在');
throw new ForbiddenException('无权访问');
throw new UnauthorizedException('未授权');
```

全局异常过滤器会统一处理并返回标准格式。

---

## 🚀 部署说明

### Docker 部署

**Dockerfile** 已配置，支持多阶段构建：
```bash
# 构建镜像
docker build -t mirror-server .

# 运行容器
docker run -p 3000:3000 mirror-server
```

**docker-compose.yml** 配置:
- 数据库服务: PostgreSQL + pgvector
- 应用服务: mirror-server
- 环境变量: 通过 `.env` 文件配置

### 环境变量配置

创建 `.env` 文件（或使用 `prisma/.env`）：

```bash
# 数据库
DATABASE_URL="postgresql://user:password@host:5432/db?pgbouncer=true"
DIRECT_URL="postgresql://user:password@host:5432/db"

# 认证
JWT_SECRET="your-jwt-secret"
REFRESH_JWT_SECRET="your-refresh-jwt-secret"
FRONTEND_URL="https://your-frontend.com"  # CORS 配置

# OpenAI/阿里云
DEFAULT_API_KEY="your-api-key"
DEFAULT_BASE_URL="https://dashscope.aliyuncs.com/compatible-mode/v1"

# 腾讯云
TENCENT_SECRET_ID="your-secret-id"
TENCENT_SECRET_KEY="your-secret-key"
TENCENT_REGION="ap-beijing"

# 邮件服务
SMTP_HOST="smtp.example.com"
SMTP_PORT="587"
SMTP_USER="your-email"
SMTP_PASS="your-password"

# Supabase（文件存储）
SUPABASE_URL="https://your-project.supabase.co"
SUPABASE_KEY="your-service-role-key"

# 服务器
PORT="3000"
```

### 数据库准备

```bash
# 1. 安装 pgvector 扩展
CREATE EXTENSION IF NOT EXISTS vector;

# 2. 运行迁移
npx prisma migrate deploy

# 3. 生成客户端
npx prisma generate
```

---

## ⚠️ 开发注意事项

### 关键陷阱

#### 1. Prisma 客户端
- ❌ 修改 schema 后忘记运行 `npx prisma generate`
- ✅ 每次 schema 变更后立即生成客户端

#### 2. 加密路由
- ❌ 注册/登录接口发送 `Content-Type: application/json`
- ✅ 这些接口必须发送 `Content-Type: text/plain`

**原因**: `main.ts` 中的 raw body 中间件只处理特定路由的 `text/plain` 请求。

#### 3. Cookie 认证
- ❌ 前端请求未设置 `credentials: 'include'`
- ✅ 所有需要认证的请求必须携带 Cookie

**CORS 配置**:
```typescript
app.enableCors({
  origin: process.env.FRONTEND_URL || true,
  credentials: true,  // 允许携带 Cookie
});
```

#### 4. 依赖安装
- ❌ 直接运行 `npm install`
- ✅ 使用 `npm install --legacy-peer-deps`

**原因**: 部分依赖存在 peer dependency 冲突。

#### 5. 知识库向量
- ❌ PostgreSQL 未安装 pgvector 扩展
- ✅ 确保 PostgreSQL 已安装并启用 pgvector

**检查方法**:
```sql
SELECT * FROM pg_extension WHERE extname = 'vector';
```

#### 6. 文件上传大小
- ❌ 默认 body limit 导致大文件上传失败
- ✅ `main.ts` 已配置 `limit: "50mb"`

### 性能优化

#### 1. 批处理向量生成
```typescript
const BATCH_SIZE = 10;  // 避免 API 限流
for (let i = 0; i < splitDocs.length; i += BATCH_SIZE) {
  const batch = splitDocs.slice(i, i + BATCH_SIZE);
  const batchEmbeddings = await Promise.all(
    batch.map((doc) => this.embeddings.embedQuery(doc.pageContent))
  );
}
```

#### 2. 并行检索
```typescript
const [vectorResults, keywordResults] = await Promise.all([
  this.vectorSearch(userId, query, limit * 2, minSimilarity),
  this.keywordSearch(userId, query, limit * 2),
]);
```

#### 3. 系统角色缓存
```typescript
private systemRolesCache: Role[] | null = null;
private readonly CACHE_TTL = 1440 * 60 * 1000;  // 24 小时
```

### 安全最佳实践

#### 1. SQL 注入防护
- ✅ 使用 Prisma 参数化查询
- ✅ 关键词检索中的特殊字符转义:
```typescript
private escapeSQL(str: string): string {
  return str.replace(/'/g, "''").replace(/%/g, "\\%").replace(/_/g, "\\_");
}
```

#### 2. XSS 防护
- ✅ Cookie 配置 `httpOnly: true`

#### 3. CSRF 防护
- ✅ Cookie 配置 `sameSite: 'lax'`

#### 4. 敏感数据传输
- ✅ 使用 RSA 加密（注册、登录、密码修改）

#### 5. 文件访问控制
- ✅ 静态文件路径遍历防护:
```typescript
if (requestedPath.includes("../") || requestedPath.includes("..\\")) {
  res.status(403).send("Forbidden");
  return;
}
```

---

## 📝 Git 工作流

### 分支管理

- `master`: 生产分支
- `develop`: 开发分支
- `feature/*`: 功能分支
- `hotfix/*`: 紧急修复分支

### 提交信息规范

```
<type>(<scope>): <subject>

<body>

<footer>
```

**Type**:
- `feat`: 新功能
- `fix`: 修复 Bug
- `docs`: 文档更新
- `style`: 代码格式调整
- `refactor`: 重构
- `test`: 测试相关
- `chore`: 构建/工具相关

**示例**:
```
feat(knowledge): 添加混合检索支持

- 实现向量检索和关键词检索
- 使用 RRF 算法融合结果
- 优化中文关键词提取

Closes #123
```

---

## 🧪 测试

### 单元测试

```bash
# 运行所有测试
npm test

# 监听模式
npm run test:watch

# 测试覆盖率
npm run test:cov
```

### E2E 测试

```bash
npm run test:e2e
```

### 测试文件命名

- 单元测试: `*.spec.ts`
- E2E 测试: `*.e2e-spec.ts`

---

## 📚 相关文档

- [NestJS 官方文档](https://docs.nestjs.com/)
- [Prisma 文档](https://www.prisma.io/docs/)
- [LangChain 文档](https://python.langchain.com/docs/)
- [pgvector 文档](https://github.com/pgvector/pgvector)
- [OpenAI API 文档](https://platform.openai.com/docs/)
- [阿里云百炼文档](https://help.aliyun.com/zh/model-studio/)

---

## 🔗 项目关联

- **前端项目**: Mirror Chat（独立仓库）
- **部署平台**: 支持 Docker、传统部署
- **监控**: 可接入日志系统（待实现）

---

## 📞 联系方式

如有问题，请联系项目维护者或提交 Issue。

---

**最后更新**: 2026-02-18  
**文档版本**: 1.0.0
