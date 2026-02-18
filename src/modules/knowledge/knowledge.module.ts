import { Module, Global } from "@nestjs/common";
import { KnowledgeController } from "./knowledge.controller";
import { KnowledgeService } from "./knowledge.service";
import { VectorStoreService } from "./vectorstore.service";
import { PrismaModule } from "../prisma/prisma.module";
import { ConfigModule } from "@nestjs/config";

@Global()
@Module({
  imports: [PrismaModule, ConfigModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, VectorStoreService],
  exports: [KnowledgeService, VectorStoreService],
})
export class KnowledgeModule {}
