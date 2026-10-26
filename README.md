# 日序 Dayline

当前阶段只交付后端框架和标准邮箱认证组件。事项、分类、重点、回收站、微信登录、扫码、绑定、账号合并、导入导出和前端均待后续实现。

## 技术与目录

- Node.js 24.19.0、pnpm 11.25.0、TypeScript 严格模式。
- NestJS 11 + Express，PostgreSQL 18 + Prisma 7。
- Better Auth 1.7.13，社区 Nest 适配器 2.8.0，Resend 6.34.1。
- 单个后端、独立前端工程；当前没有 Redis、消息队列或离线同步引擎。

```text
apps/api/                 NestJS 应用、认证适配、配置、数据库、邮件、健康检查
apps/api/prisma/          官方认证参考模型、Prisma schema 和迁移
apps/api/test/            单元测试和真实 PostgreSQL HTTP 集成测试
packages/contracts/      跨端公开类型及注册输入校验
packages/core/           跨端纯常量；当前只有固定时区
infra/postgres/          开发测试数据库初始化
docs/                    已确认需求、前后端 Spec、历史交接记录
```

## 本地启动

在项目根目录执行，需要 Node、pnpm 和 Docker Compose：

```bash
cp .env.example .env
pnpm install --frozen-lockfile
docker compose up -d --wait db
pnpm db:generate
pnpm db:deploy
pnpm dev
```

已有 `.env` 时保留自己的配置。示例中的密码和认证 secret 仅供本机开发。PostgreSQL 只向本机开放端口；Compose 的命名卷保留数据，不需要删除卷来重启服务。

- API：`http://localhost:3000`
- 开发 OpenAPI：`http://localhost:3000/api/docs`，JSON 为 `/api/docs-json`；生产模式关闭。
- 存活检查：`GET /health/live`；数据库及基础认证模型检查：`GET /health/ready`。

如果云环境写入的 SQL 文件权限为 0600，首次启动前执行 `chmod 644 infra/postgres/init-test-db.sql`，让容器内的 PostgreSQL 用户可以读取它。初始化 SQL 仅在空数据卷首次启动时执行；已有卷缺少测试库时，通过 PostgreSQL 管理工具创建专用的 `dayline_test` 数据库。

新增模型后使用 `pnpm db:migrate --name <migration_name>`，审阅生成的 SQL 再保存迁移。`pnpm db:deploy` 只应用现有迁移，不负责生成新迁移。`prisma/auth.generated.prisma` 是认证库参考文件，实际迁移使用 `prisma/schema.prisma`。

## 邮件配置

默认 `MAIL_TRANSPORT=file`：验证与重置邮件写入项目 `.local/mail/*.json`，不会对外发信。目录和文件权限分别为 0700 / 0600，已被 Git 忽略。查看 JSON 的 `text` 字段可取得开发验证链接，请勿把包含链接的文件提交或分享。

切换 Resend 时配置：

```dotenv
MAIL_TRANSPORT=resend
RESEND_API_KEY=your_resend_key
MAIL_FROM=Dayline <your_verified_sender>
```

生产配置要求 Resend、HTTPS 公共地址和替换后的认证 secret；不允许 file 邮件模式。Resend 使用官方 SDK、8 秒超时，并隐藏提供商错误中的私人信息。本阶段未配置真实密钥，因此实际收件、投递率及真实供应商调用尚未验证；SDK 请求与失败处理已通过模拟网络测试。

## 已接入的认证能力

邮箱采用密码注册、邮件链接验证、密码登录和密码重置，沿用 Better Auth 原生协议。没有另行启用免密码 Email OTP。注册后不能直接进入私人接口，验证成功后仍需登录。

| 方法 | 地址                                | 用途                                                                       |
| ---- | ----------------------------------- | -------------------------------------------------------------------------- |
| POST | `/api/auth/sign-up/email`           | 注册；显示名 `name`、邮箱 `email`、密码 `password`，可传可信 `callbackURL` |
| POST | `/api/auth/send-verification-email` | 重发验证邮件                                                               |
| GET  | `/api/auth/verify-email`            | 打开验证链接；有 callbackURL 时跳转回前端                                  |
| POST | `/api/auth/sign-in/email`           | 已验证邮箱登录                                                             |
| POST | `/api/auth/request-password-reset`  | 申请重置，前端地址使用 `redirectTo`                                        |
| GET  | `/api/auth/reset-password/:token`   | 邮件入口，跳转至可信前端并携带重置凭据                                     |
| POST | `/api/auth/reset-password`          | 消费凭据并重置密码                                                         |
| POST | `/api/auth/change-password`         | 当前密码与新密码；支持撤销其他会话                                         |
| GET  | `/api/auth/get-session`             | 原生会话读取                                                               |
| POST | `/api/auth/sign-out`                | 原生退出                                                                   |
| GET  | `/api/v1/me`                        | 读取当前会话的公开账号信息                                                 |
| POST | `/api/v1/auth/logout`               | 包装后的统一退出入口，返回 200                                             |

网页使用 HttpOnly / SameSite=Lax Cookie，生产 HTTPS 下使用 Secure Cookie。非浏览器客户端使用登录响应头 `set-auth-token` 返回的签名凭据，以 `Authorization: Bearer ...` 发送；不要使用响应体中的未签名 token 替代它。当前已在 HTTP 层验证 Bearer，尚未开发或实测微信小程序。

会话有效期 7 天，24 小时后活跃请求可触发续期，适配器将刷新后的 Cookie 和 Bearer 响应头传回客户端。密码重置撤销旧会话；改密码并撤销其他会话时，Better Auth 会轮换当前凭据，客户端须接收新的 Cookie / `set-auth-token`。

有会话的写操作（包括原生修改密码和退出）须携带 `X-Dayline-Expected-User: <当前用户ID>`。缺失返回 400，不匹配返回 409。Cookie 写操作还须提供配置中的可信 Origin。该 header 只防账号上下文混淆，不能作为登录凭据。首次 `/me` 探测和匿名注册、登录、邮件验证、密码重置不要求该 header。

普通 API 使用 `{ data, meta }` / `{ error, meta }` 包装，原生认证路径保持 Better Auth 协议。普通 JSON 解析限制为 64 KiB。内存限流是单进程的，不提供多副本共享或重启后的计数保留。

原生更新资料、即时删号、修改邮箱及社交身份绑定等未实现的操作返回 404。`/me` 当前只读；只建 `users`、`auth_sessions`、`auth_accounts`、`auth_verifications` 四张认证表，没有默认分类初始化或其他业务写入。保留的状态、epoch 及公开 DTO 字段用于基础鉴权和后续契约，不代表注销、合并或微信功能已实现。

## 验证

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
```

集成测试要求真实 PostgreSQL。`TEST_DATABASE_URL` 必须明确指向名称以 `_test` 结尾的专用数据库；未设置或名称不符时直接拒绝执行，不退回开发库。`pnpm test:integration` 依次构建、向测试库应用迁移，再运行 HTTP 测试。测试只清理本次生成的用户和对应凭据，不 truncate 整库。

覆盖注册 / 验证 / 重发、Cookie / 签名 Bearer、重置与改密码、退出、跨账号上下文、过期 / epoch 撤销、会话续期、普通 JSON 解析与认证原始请求体共存。开发文件邮件验证了端到端链接流程；真实 Resend 发信及完整微信 Gate-A 仍待后续验证。

GitHub Actions 中提供同一套检查配置，但远端工作流是否执行成功应以实际运行结果为准。

本地验证记录（2026-10-26）：格式、lint、完整类型检查与构建通过；12 项单元测试、8 组真实数据库 HTTP 集成测试通过；编译产物已单独启动，验证健康检查、原生会话读取、OpenAPI 和私有接口鉴权后正常关闭。

完整产品目标见 [需求](docs/requirements.md)、[后端 Spec](docs/backend-spec.md) 和 [前端 Spec](docs/frontend-spec.md)。历史恢复记录见 [交接说明](docs/handoff.md) 和 [恢复说明](docs/recovery.md)；当前实现范围以本 README 和代码为准。
