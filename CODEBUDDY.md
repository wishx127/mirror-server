# CODEBUDDY.md This file provides guidance to CodeBuddy when working with code in this repository.

## Project Overview

Mirror Server is a NestJS backend service for Mirror Chat, providing intelligent conversation, knowledge base retrieval (RAG), AI image generation, and voice services. Built with TypeScript, PostgreSQL + pgvector, and OpenAI/LangChain.

## Common Commands

### Development
```bash
# Install dependencies (must use legacy-peer-deps flag)
npm install --legacy-peer-deps

# Generate Prisma client (required before first run and after schema changes)
npx prisma generate

# Development mode with hot reload
npm run start:dev

# Build for production
npm run build

# Production mode
npm run start:prod
```

### Database Management
```bash
# Open Prisma Studio (database GUI)
npx prisma studio

# Apply schema migrations
npx prisma migrate dev

# Reset database (clear all data)
npx prisma migrate reset
```

### Code Quality
```bash
# Run ESLint with auto-fix
npm run lint

# Format code with Prettier
npm run format

# Run unit tests
npm test

# Run E2E tests
npm run test:e2e

# Test coverage report
npm run test:cov
```

### Docker
```bash
# Build Docker image
docker build -t mirror-server .

# Run container
docker run -p 3000:3000 mirror-server
```

## Architecture Overview

### Modular Architecture

The project follows NestJS modular architecture with 12 feature modules under `src/modules/`:

**Core Infrastructure:**
- `PrismaModule`: Database connection service (global singleton)
- `AuthModule`: JWT authentication with dual-token mechanism (Access Token + Refresh Token) stored in HttpOnly cookies
- `EncryptionModule`: RSA encryption for sensitive data transmission

**Business Features:**
- `ChatModule`: Stream-based conversation service with multi-modal support (text, images, files) and chain-of-thought reasoning. Integrates with OpenAI-compatible APIs (DeepSeek, Qwen) and Alibaba Cloud image generation.
- `KnowledgeModule`: RAG implementation with hybrid retrieval (vector + keyword search) using RRF algorithm. Supports PDF, Word, Excel, TXT, MD. Uses LangChain text splitter and OpenAI embeddings. Stores vectors in PostgreSQL pgvector.
- `RoleModule`: AI character management with system presets and user-customizable roles. Implements memory-based caching for system roles (24h TTL).
- `ConversationModule`: Conversation history management with JSON-structured message storage.
- `AvatarModule`: Avatar upload and processing with Supabase Storage integration.
- `TTSModule`: Text-to-speech via Tencent Cloud.
- `AsrModule`: Speech recognition via Tencent Cloud.
- `EmailModule`: Email verification service.
- `FavoriteModule`: Bookmark functionality for conversations.

### Authentication Flow

Uses dual-token JWT mechanism with HttpOnly cookies:
1. **Access Token** (12h expiry): Primary authentication, stored in `access_token` cookie
2. **Refresh Token** (7d expiry): Token refresh mechanism, stored in `refresh_token` cookie
3. Session management via `UserSession` table in database
4. Cookie security: `httpOnly: true`, `secure: true` (production), `sameSite: 'lax'`
5. JWT Strategy (`src/config/jwt.strategy.ts`) prioritizes cookie extraction over Authorization header

**Important:** Encrypted routes (register, login, password update) must send `Content-Type: text/plain` because `main.ts` raw body middleware only processes these routes. Regular JSON APIs use standard `application/json`.

### Chat Service Core Flow

`ChatService.chatStream()` (`src/modules/chat/chat.service.ts:135`) implements:

1. **Configuration Loading**: Fetches user's model config (API key, base URL, model name) from `ModelConfig` table
2. **Context Building**:
   - Loads selected role's system prompt via `RoleService`
   - If knowledge base enabled: performs vector retrieval and injects context
   - Loads conversation history if chatId exists
3. **Multi-modal Support**:
   - Image analysis (URL or Base64 format)
   - File content analysis (text files direct read, binary files Base64 encoded)
   - Automatic integration into OpenAI message format
4. **Streaming Response**: RxJS Observable for SSE implementation
5. **Storage**:
   - Auto-generates title for new conversations
   - Stores chain-of-thought content
   - Structured message storage as `MessageContentPart[]` array

**Message Structure:**
```typescript
interface StoredMessage {
  role: 'user' | 'assistant' | 'system';
  content: MessageContentPart[];  // Supports multiple content parts
  key: string;                     // Unique identifier
  time: string;                    // Timestamp
  reasoning_content?: string;      // Chain-of-thought
}

interface MessageContentPart {
  type: 'thinking' | 'content' | 'image' | 'file';
  data: string | ImageMetadata | FileMetadata;
}
```

### Knowledge Base RAG Architecture

`KnowledgeService` (`src/modules/knowledge/knowledge.service.ts`) implements:

**Document Upload (`uploadFile`):**
1. File parsing (PDF, DOCX, DOC, XLSX, XLS, TXT, MD)
2. Text splitting: `RecursiveCharacterTextSplitter` (chunkSize: 1000, overlap: 150, Chinese-optimized separators)
3. Embedding generation: `OpenAIEmbeddings` with batch processing (BATCH_SIZE=10 to avoid rate limits)
4. Storage: PostgreSQL pgvector `vector(1536)` field, preserves source file in `fileData` Bytes field

**Hybrid Retrieval (`search`):**
- Parallel execution of vector search and keyword search
- Vector search: pgvector `<=>` operator (cosine distance) with similarity threshold
- Keyword search: N-gram extraction (2-4 chars for Chinese) with stopword filtering, ILIKE matching
- RRF (Reciprocal Rank Fusion) algorithm merges results: score = Σ 1/(k + rank_i), where k=60
- Weights: vector=0.7, keyword=0.3

**Known Issues:** Current implementation doesn't use LangChain VectorStore abstraction or RetrievalChain. Consider migrating to `PGVectorStore` and `createRetrievalChain` for better maintainability.

### Database Design

**Key Relationships:**
- `User` 1:1 `ModelConfig` (personalized model settings)
- `User` 1:N `UserConversation` (conversation list)
- `UserConversation` 1:1 `ConversationDetail` (message history as JSON)
- `User` 1:N `Knowledge` (knowledge base chunks with vectors)
- `User` 1:N `UserSession` (active sessions)
- `User` 1:1 `UserRole` (current selected role)
- `Role` supports system presets (`isSystem=true`) and user custom roles

**Important Fields:**
- `Knowledge.embedding`: PostgreSQL `vector(1536)` type (requires pgvector extension)
- `Knowledge.fileData`: Source file binary data (Bytes type, only in first chunk)
- `ConversationDetail.content`: JSON type storing message array with structured content parts

### Global Configuration

- API prefix: `/api/v1`
- CORS enabled with `credentials: true` for cookie support
- Global exception filter: `GlobalExceptionFilter` (standardizes error responses)
- Global response interceptor: `ResponseInterceptor` (wraps success responses)
- Global logging middleware: `LoggingMiddleware`
- Body limit: 50MB (configured in `main.ts` for file uploads)

### Static File Serving

- `/uploads`: User uploaded files (avatars, knowledge base files)
- `/cache/thumbnails`: Image thumbnail cache (cleared on server start/shutdown)
- Path traversal protection implemented for security

## Critical Development Notes

### Prisma Client
**MUST** run `npx prisma generate` after any schema changes. The generated client is not committed to version control.

### Encrypted Routes
Routes `/register`, `/login`, `/updatePassword`, `/resetPassword` under `/api/v1/user` expect `Content-Type: text/plain` (RSA encrypted data). Do NOT send `application/json` to these endpoints.

### Cookie Authentication
Frontend requests MUST set `credentials: 'include'` to send/receive cookies. CORS is configured with `credentials: true` and origin based on `FRONTEND_URL` environment variable.

### Dependency Installation
Always use `npm install --legacy-peer-deps` due to peer dependency conflicts in the dependency tree.

### pgvector Extension
PostgreSQL MUST have pgvector extension installed before running migrations. Verify with: `SELECT * FROM pg_extension WHERE extname = 'vector';`

### File Upload Size
Default body limit is 50MB. Configure in `main.ts` if larger uploads needed.

### Environment Variables
Required variables are defined in `prisma/.env` and project root `.env`. See `openspec/project.md` for complete list. Critical ones:
- `DATABASE_URL` / `DIRECT_URL`: PostgreSQL connection
- `JWT_SECRET` / `REFRESH_JWT_SECRET`: Token secrets
- `FRONTEND_URL`: CORS origin (required for production)
- `DEFAULT_API_KEY` / `DEFAULT_BASE_URL`: OpenAI-compatible API
- `TENCENT_SECRET_ID` / `TENCENT_SECRET_KEY`: Voice services
- `SUPABASE_URL` / `SUPABASE_KEY`: File storage

## Testing

- Unit tests: `*.spec.ts` files alongside source files
- E2E tests: `test/` directory with `*.e2e-spec.ts` files
- Jest configuration in `package.json` uses `ts-jest` transformer
- Run specific test file: `npm test -- <filename>`

## API Response Format

**Success:**
```json
{
  "success": true,
  "data": { ... },
  "message": "Operation successful"
}
```

**Error:**
```json
{
  "success": false,
  "error": "ErrorType",
  "message": "Detailed error message",
  "statusCode": 400
}
```

Global exception filter ensures consistent format across all endpoints.

## Performance Optimizations

- **Batch embedding generation**: Process 10 documents at a time to avoid API rate limits
- **Parallel retrieval**: Vector and keyword searches run concurrently
- **Role caching**: System roles cached in memory for 24 hours
- **Database indexing**: Key fields indexed (userId, fileName, conversationId, etc.)
