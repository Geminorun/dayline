# 日序 Dayline

当前已实现后端认证、独立 Vue 网页与 uni-app 微信小程序的最小账号界面、纯共享 API 客户端、无邮箱微信会话及网页登录扫码确认。事项、分类、重点、回收站、绑定合并、导入导出和注销业务由后续阶段实现。

## 技术与目录

- Node.js 24.19.0、pnpm 11.25.0、TypeScript 严格模式。
- NestJS 11 + Express，PostgreSQL 18 + Prisma 7。
- Better Auth 1.7.13，社区 Nest 适配器 2.8.0，Resend 6.34.1。
- Web：Vue 3.5.44 + Vue Router 4.6.4 + Vite 8.3.5；小程序：DCloud 5.33 对应固定包 3.0.0-5030320261023001 + Vue 3.4.21 + Vite 5.2.8，遵循 DCloud 的兼容依赖。
- 单个后端、独立前端工程；当前没有 Redis、消息队列或离线同步引擎。

```text
apps/web/                 Vue 网页；独立页面、Cookie 请求适配
apps/miniapp/             uni-app Vue 小程序；原生请求、受控 Bearer 存储
apps/api/                 NestJS 应用、认证适配、配置、数据库、邮件、健康检查
apps/api/prisma/          官方认证参考模型、Prisma schema 和迁移
apps/api/test/            单元测试和真实 PostgreSQL HTTP 集成测试
packages/api-client/     平台无关传输、错误规范化、响应解码与账号代次隔离
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

另开终端运行 `pnpm dev:web`，网页为 `http://localhost:5173`，开发代理把 `/api` 转至本机 API。生产网页需配置同源反向代理和 SPA 路由回退，避免验证 / 重置回调路径返回 404。

小程序复制 `apps/miniapp/.env.example` 至同目录 `.env`，设置 `VITE_API_BASE_URL` 为自己的 HTTPS API origin；在 `src/manifest.json` 中填写自己的 `mp-weixin.appid`。运行 `pnpm dev:miniapp`，或 `pnpm --filter @dayline/miniapp build`；开发者工具导入 `apps/miniapp/dist/build/mp-weixin`。空 AppID 可编译，但不能代表真实登录或上传已验收。Web 和小程序分别构建，未共享平台 UI。

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

网页使用 HttpOnly / SameSite=Lax Cookie，生产 HTTPS 下使用 Secure Cookie。非浏览器客户端使用登录响应头 `set-auth-token` 返回的签名凭据，以 `Authorization: Bearer ...` 发送；不要使用响应体中的未签名 token 替代它。当前已在真实 PostgreSQL HTTP 测试、uni 请求适配器测试及 mp-weixin 编译中验证；微信开发者工具与真机仍待验证。

会话有效期 7 天，24 小时后活跃请求可触发续期，适配器将刷新后的 Cookie 和 Bearer 响应头传回客户端。密码重置撤销旧会话；改密码并撤销其他会话时，Better Auth 会轮换当前凭据，客户端须接收新的 Cookie / `set-auth-token`。

有会话的写操作（包括原生修改密码和退出）须携带 `X-Dayline-Expected-User: <当前用户ID>`。缺失返回 400，不匹配返回 409。Cookie 写操作还须提供配置中的可信 Origin。该 header 只防账号上下文混淆，不能作为登录凭据。首次 `/me` 探测和匿名注册、登录、邮件验证、密码重置不要求该 header。

普通 API 使用 `{ data, meta }` / `{ error, meta }` 包装，原生认证路径保持 Better Auth 协议。普通 JSON 解析限制为 64 KiB。内存限流是单进程的，不提供多副本共享或重启后的计数保留。

原生更新资料、即时删号、修改邮箱及社交身份绑定等未实现的操作返回 404。`/me` 当前只读；除四张认证表外新增 `wechat_identities`、`qr_requests`。没有默认分类初始化或其他业务写入。保留的状态和 epoch 用于会话限制，不代表注销或合并业务已实现。无邮箱微信身份不开放原生 SDK `/get-session` 用户输出（返回 403），防止内部占位邮箱泄漏；两端账号界面始终读取公开 `/me`。

## 微信与网页登录扫码

配置服务端 `WECHAT_APP_ID`、`WECHAT_APP_SECRET`，以及 `WECHAT_MINIAPP_SCAN_PAGE=pages/scan/confirm`、`WECHAT_MINIAPP_ENV=release`（也支持 `develop` / `trial`）。缺少凭据时只有微信相关操作明确返回 `WECHAT_NOT_CONFIGURED`，不会发起外调、创建模拟账号或展示假二维码。小程序码由微信 `getwxacodeunlimit` 接口生成，scene 仅是随机扫码 token；必须使用相应 AppID 已存在的页面和正确环境。

| 方法   | 地址                                   | 用途                                                                                                   |
| ------ | -------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| POST   | `/api/v1/auth/wechat/login`            | 仅接收临时 `code`，服务端交换真实身份并建立签名会话                                                    |
| POST   | `/api/v1/auth/qr-requests`             | 浏览器生成 `id`、`purpose=login`；返回真实小程序码及两分钟有效期，浏览器 secret 为专用 HttpOnly Cookie |
| POST   | `/api/v1/auth/qr-requests/resolve`     | 小程序以 scene + 新 code 解析，返回内存扫码证明；不会建号或登录网页                                    |
| POST   | `/api/v1/auth/qr-requests/:id/confirm` | 用户明确确认后，在事务中找 / 建身份并确认；证明只适用于该请求                                          |
| GET    | `/api/v1/auth/qr-requests/:id`         | 原浏览器 secret 查询有限状态，网页约两秒轮询，离开页面即停止                                           |
| POST   | `/api/v1/auth/qr-requests/:id/consume` | 原浏览器明确点击完成后一次性领取会话；失败也不恢复领取权                                               |
| DELETE | `/api/v1/auth/qr-requests/:id`         | 原浏览器或扫码者取消未消费的 pending / scanned / confirmed 请求                                        |

绑定目的 `bind_wechat` 明确返回 409，不交换身份或先造空账号；其他未知目的返回 400。扫码 proof、scene、浏览器 secret 不可互换。仅凭 ID、扫描动作或确认链接不会登录网页。扫码后仍可取消，领取完成后再取消会提示请求已结束。

无真实邮箱用户使用内部 `.invalid` 标识，`emailVerified=false`，公开邮箱为 null；不把 `session_key`、OpenID、UnionID、内部邮箱或原始会话 token 返回业务 DTO。技术验证已证明同一个内部用户后续可使用 Better Auth 哈希设置真实邮箱 / 密码，邮箱和微信登录仍取得同一 ID；服务端 primitive 没有 HTTP 入口，完整绑定 / 合并产品流程留待阶段 6。

微信原生 request 不支持 PATCH。小程序传输层把 PATCH 封装为 POST + `X-Dayline-Method-Override: PATCH`；API 仅对 `/api/v1/` 的 POST 精确识别这个值，正常执行原路由与鉴权、Origin、预期账号检查，不影响 `/api/auth`。后续阶段的真实业务 PATCH 还需联验。

共享 API 客户端不依赖 DOM / wx / uni / Node：应用传入传输和实际响应 decoder。账号代次变化后丢弃旧响应，验证成功前不接收刷新凭据，匿名登录失败不撤销另一个已知账号。小程序签名凭据仅存于专用平台键；网页仅使用 HttpOnly Cookie。密码不持久化；邮件 query 在首次读取后清理，同时保留并清理 Vue Router 的导航 state。

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

阶段 1 验证证据、评审修复和待验收项见 [阶段 1 交接](docs/stage1-handoff.md)。真实微信 code、小程序码扫码、真实 Resend 投递、开发者工具以及 iOS / Android 真机尚无凭据或设备验证；注入测试适配器不表示这些外部能力通过。

完整产品目标见 [需求](docs/requirements.md)、[后端 Spec](docs/backend-spec.md) 和 [前端 Spec](docs/frontend-spec.md)。历史恢复记录见 [交接说明](docs/handoff.md) 和 [恢复说明](docs/recovery.md)；当前实现范围以本 README 和代码为准。
