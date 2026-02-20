import { Module, Global } from "@nestjs/common";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeService } from "./knowledge.service";
import { VectorStoreService } from "./vectorstore.service";
import { TokenizerService } from "./tokenizer.service";
import { BM25IndexService } from "./bm25-index.service";
import { PrismaModule } from "../prisma/prisma.module";
import { ConfigModule } from "@nestjs/config";

@Global()
@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, VectorStoreService, TokenizerService, BM25IndexService],
  exports: [KnowledgeService, VectorStoreService, TokenizerService, BM25IndexService],
})
export class KnowledgeModule {}
