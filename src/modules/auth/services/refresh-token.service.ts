import {
  Injectable,
  UnauthorizedException,
  Inject,
  OnModuleInit,
} from "@nestjs/common";
import { ModuleRef } from "@nestjs/core";
import { JwtService } from "@nestjs/jwt";
import { UserService } from "../../user/user.service";
import { SessionService } from "./session.service";
import { JwtPayload } from "../../../config/jwt.strategy";

// Refresh token 过期时间（7天）
const REFRESH_TOKEN_EXPIRES_IN_DAYS = 7;

@Injectable()
export class RefreshTokenService implements OnModuleInit {
  private userService: UserService;

  constructor(
    @Inject("REFRESH_JWT_SERVICE")
    private readonly refreshJwtService: JwtService,
    private readonly moduleRef: ModuleRef,
    private readonly jwtService: JwtService,
    private readonly sessionService: SessionService,
  ) {}

  onModuleInit() {
    this.userService = this.moduleRef.get(UserService, { strict: false });
  }

  /**
   * 生成refresh token
   * @param payload JWT载荷
   * @returns refresh token
   */
  generateRefreshToken(payload: JwtPayload): string {
    return this.refreshJwtService.sign(payload);
  }

  /**
   * 验证refresh token
   * @param refreshToken refresh token
   * @returns JWT载荷
   */
  validateRefreshToken(refreshToken: string): JwtPayload {
    try {
      const payload = this.refreshJwtService.verify<JwtPayload>(refreshToken);
      return payload;
    } catch {
      throw new UnauthorizedException("无效的refresh token");
    }
  }

  /**
   * 使用refresh token刷新访问令牌
   * @param refreshToken refresh token
   * @returns 新的访问令牌和refresh token
   */
  async refreshAccessToken(
    refreshToken: string,
  ): Promise<{ token: string; newRefreshToken: string }> {
    try {
      // 验证refresh token的JWT签名
      const payload = this.validateRefreshToken(refreshToken);

      // 验证会话是否有效
      const session = await this.sessionService.validateSession(refreshToken);
      if (!session) {
        throw new UnauthorizedException("会话已失效，请重新登录");
      }

      // 检查用户是否存在
      const user = await this.userService.findById(payload.sub);
      if (!user) {
        throw new UnauthorizedException("用户不存在");
      }

      // 创建一个新的载荷对象用于生成新的令牌，避免exp属性冲突
      const newPayload = {
        sub: payload.sub,
        username: payload.username,
        email: payload.email,
        iat: Math.floor(Date.now() / 1000), // 添加签发时间
      };

      // 生成新的访问令牌和refresh token
      const newAccessToken = this.generateAccessToken(newPayload);
      const newRefreshToken = this.generateRefreshToken(newPayload);

      // 更新会话中的refreshToken
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRES_IN_DAYS);
      await this.sessionService.updateSession(
        refreshToken,
        newRefreshToken,
        expiresAt,
      );

      return {
        token: newAccessToken,
        newRefreshToken: newRefreshToken,
      };
    } catch (error) {
      console.error("刷新访问令牌时发生错误:", error);
      throw error;
    }
  }

  /**
   * 生成访问令牌
   * @param payload JWT载荷
   * @returns 访问令牌
   */
  private generateAccessToken(payload: JwtPayload): string {
    // 创建一个新的载荷对象，排除exp属性以避免与expiresIn选项冲突
    const payloadWithoutExp: Partial<JwtPayload> & { [key: string]: any } = {
      ...payload,
    };
    delete payloadWithoutExp.exp;
    // 使用主jwtService生成访问令牌
    return this.jwtService.sign(payloadWithoutExp);
  }
}
