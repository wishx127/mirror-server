import { config } from "dotenv";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { GlobalExceptionFilter } from "./filters/error.filter";
import { ResponseInterceptor } from "./interceptors/response.interceptor";
import { join } from "path";
import { NestExpressApplication } from "@nestjs/platform-express";
import { readdirSync, unlinkSync } from "fs";
import { Request, Response, NextFunction, json, urlencoded } from "express";
import cookieParser from "cookie-parser";
import serverless from "serverless-http";

// 扩展 Request 类型以包含 rawBody
interface RawBodyRequest extends Request {
  rawBody?: string;
}

config();
function clearCacheDirectory() {
  const cacheRootDir = join(__dirname, "..", "cache");

  try {
    function clearDirectoryRecursively(dirPath: string) {
      const items = readdirSync(dirPath, { withFileTypes: true });

      items.forEach((item) => {
        const fullPath = join(dirPath, item.name);

        if (item.isDirectory()) {
          clearDirectoryRecursively(fullPath);
        } else {
          unlinkSync(fullPath);
        }
      });
    }

    clearDirectoryRecursively(cacheRootDir);
    console.log("头像缓存目录已清空");
  } catch (error) {
    console.error("清空头像缓存目录失败:", error);
  }
}

async function createApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);

  // 增大 Payload 限制，支持大文件上传
  app.use(json({ limit: "50mb" }));
  app.use(urlencoded({ limit: "50mb", extended: true }));

  // 使用 cookie-parser 中间件
  app.use(cookieParser());

  // 配置raw body中间件，用于处理加密数据的用户相关接口
  const routesNeedingRawBody = new Set([
    "/register",
    "/login",
    "/updatePassword",
    "/resetPassword",
  ]);
  app.use(
    "/api/v1/user",
    (req: RawBodyRequest, res: Response, next: NextFunction) => {
      if (
        routesNeedingRawBody.has(req.path) &&
        req.headers["content-type"] === "text/plain"
      ) {
        req.setEncoding("utf8");
        let data = "";
        req.on("data", (chunk: string) => {
          data += chunk;
        });
        req.on("end", () => {
          req.rawBody = data;
          next();
        });
      } else {
        next();
      }
    },
  );

  // 配置静态文件服务
  app.use(
    "/uploads",
    (req: Request, res: Response, next: NextFunction): void => {
      const requestedPath = req.path;
      if (requestedPath.includes("../") || requestedPath.includes("..\\")) {
        res.status(403).send("Forbidden");
        return;
      }
      next();
    },
  );

  app.use(
    "/cache/thumbnails",
    (req: Request, res: Response, next: NextFunction): void => {
      const requestedPath = req.path;
      if (requestedPath.includes("../") || requestedPath.includes("..\\")) {
        res.status(403).send("Forbidden");
        return;
      }
      next();
    },
  );

  // 提供静态文件服务
  app.useStaticAssets(join(__dirname, "..", "uploads"), {
    prefix: "/uploads",
  });

  app.useStaticAssets(join(__dirname, "..", "cache"), {
    prefix: "/cache",
  });

  app.useGlobalFilters(new GlobalExceptionFilter());
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.setGlobalPrefix("api/v1");
  // 启用CORS
  app.enableCors({
    origin: process.env.FRONTEND_URL || true, // 生产环境指定具体的前端 URL
    methods: "GET,HEAD,PUT,PATCH,POST,DELETE",
    allowedHeaders: "Content-Type,Authorization",
    credentials: true, // 允许携带 Cookie
  });

  process.on("SIGINT", () => {
    clearCacheDirectory();
    void app.close().then(() => {
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    clearCacheDirectory();
    void app.close().then(() => {
      process.exit(0);
    });
  });

  return app;
}
const isServerless =
  process.env.VERCEL === "1" || process.env.SERVERLESS === "1";

async function bootstrap() {
  const app = await createApp();

  process.on("SIGINT", () => {
    clearCacheDirectory();
    void app.close().then(() => {
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    clearCacheDirectory();
    void app.close().then(() => {
      process.exit(0);
    });
  });

  await app.listen(process.env.PORT ?? 3000, "0.0.0.0");
}

let cachedHandler: ((req: Request, res: Response) => Promise<void>) | null =
  null;

export default async function handler(req: Request, res: Response) {
  if (!cachedHandler) {
    const app = await createApp();
    await app.init();
    const instance = app.getHttpAdapter().getInstance();
    cachedHandler = serverless(instance);
  }

  return cachedHandler(req, res);
}

if (!isServerless) {
  void bootstrap();
}
