# 日序 Dayline

当前已实现统一邮箱 / 微信认证、网页登录扫码、分类、事项、每日重点、30 天回收站和一致完整快照；网页与微信小程序均可完整回看、编辑、搜索筛选、统计及浏览月 / 季度 / 年 / 全部时间轴。两端游客记录独立持久保存在本机，账号在线保存，设置可按版本修改显示名。

当前账号编辑仍需手动在线提交：Web 输入仅在页面内存，小程序没有离线账号写队列。账号缓存 / Web 持久草稿 / 全量刷新生命周期与游客登录接入由阶段 4 承接，CSV / JSON 文件、绑定合并及注销维护随后实现。游客和云端空间明确分开；登录不会自动导入或清空游客包，退出返回旧游客空间。

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
packages/contracts/      跨端公开 DTO、业务输入与响应校验
packages/core/           纯日历 / 区间 / 状态 / 统计规则及默认分类
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

普通 API 使用 `{ data, meta }` / `{ error, meta }` 包装，原生认证路径保持 Better Auth 协议。普通 JSON 解析限制为 64 KiB；事项 PATCH 的精确重点移除确认最高 1 MiB / 20,000 日期，无确认列表仍保持 64 KiB；回收站部分清理独立限制为 128 KiB / 1,000 项。内存限流是单进程的，不提供多副本共享或重启后的计数保留。

原生更新资料、即时删号、修改邮箱及社交身份绑定等未实现的操作返回 404。业务 `PATCH /api/v1/me` 仅接受显示名与 `expectedProfileVersion`，在用户锁后复核会话 epoch、状态及资料版本；资料变更不增加业务 dataVersion。除四张认证表外已有 `wechat_identities`、`qr_requests` 及记录业务表。新用户的六个默认分类与 initialized_at 由数据库 INSERT 触发器在用户创建的同一事务中初始化；迁移一次性初始化已有账号。登录不补齐分类，也不覆盖用户改名 / 删除。保留的状态和 epoch 用于会话限制，不代表注销或合并业务已实现。无邮箱微信身份不开放原生 SDK `/get-session` 用户输出（返回 403），防止内部占位邮箱泄漏；两端账号界面始终读取公开 `/me`。

## 记录与每日回看

网页默认 `/day`，侧栏提供 `/entries`、`/timeline`、`/categories`、`/trash` 和 `/settings`；旧 `/review` 与 `/account` 保留兼容跳转。可直接打开 `/entries/new` 或 `/entries/:id`。小程序四 tab 为回看、记录、时间轴和我的，另有独立编辑、分类及回收站页；真实扫码路径仍为 `pages/scan/confirm`。

两端均支持新建 / 编辑、指定日期重点、今天结束、删除确认、恢复 / 永久清理、分类增改与原子转移删除。日期覆盖、搜索筛选、排序、统计和四尺度时间轴使用共享纯规则；正常记录与统计排除回收站，重点只计 true。时间轴固定名称和日期头、横向滚动、有界刻度与虚拟行，重点聚合可查看分页的真实日期。

游客首次仅初始化一次 UUID 数据集及六分类。Web 使用 Dexie / IndexedDB 事务完成及修订 CAS；小程序采用每片低于单键限制的不可变代次与最后 manifest 提交。损坏 / 未知 schema / 不完整分片停止覆盖并显示恢复提示；容量或写入失败保留上一份完整数据和当前输入。没有全局 clearStorage，凭据不在游客包中。Web 同设备多标签冲突须重新读取并核对，不能静默覆盖。

账号保存等待服务器确认；失败保留编辑输入和稳定 ID。缩短范围先展示受影响的精确重点日期，再由用户确认；当前没有持久草稿或自动补传。设置中的文件、绑定 / 合并、注销说明明确标注尚未开放。

| 方法                 | 地址                                   | 用途                                                                         |
| -------------------- | -------------------------------------- | ---------------------------------------------------------------------------- |
| GET                  | `/api/v1/snapshot`                     | 一致完整读取；按账号 / bigint 版本 / 北京业务日期生成 ETag，支持先鉴权后 304 |
| GET / POST           | `/api/v1/categories`                   | 读取 / 新建分类                                                              |
| PATCH / DELETE       | `/api/v1/categories/:id`               | 按版本修改 / 原子转移正常与回收站事项后删除                                  |
| POST                 | `/api/v1/entries`                      | 稳定 UUID 新建，重试不覆盖                                                   |
| GET / PATCH / DELETE | `/api/v1/entries/:id`                  | 详情和重点 / 按版本修改 / 移入回收站                                         |
| POST                 | `/api/v1/entries/:id/finish`           | 以北京时间今天结束                                                           |
| PUT                  | `/api/v1/entries/:id/focus-days/:date` | 明确设置重点，独立比较事项与单日重点版本                                     |
| GET                  | `/api/v1/trash`                        | 仍可恢复的记录；完整快照另保留待物理清理的到期项                             |
| POST                 | `/api/v1/trash/:id/restore`            | 服务器时间严格早于到期时恢复                                                 |
| POST                 | `/api/v1/trash/purge`                  | 按选中 ID / 版本，或 expectedDataVersion 永久清理                            |

所有业务写先锁可信 Actor 所属用户，再复核 epoch、active 状态、归属及版本，在同一事务内提交内容和 dataVersion。每日重点仅改变单日版本与事项 focusVersion，不改变内容 version。成功写响应 meta.dataVersion 是十进制字符串；共享客户端保留验证后的完整 meta 和结构化冲突依据。待注销账号可读取，不能写入。未初始化标记的异常账号由业务接口返回受控 503，不构造 complete:true 的空或半份快照；认证账号读取仍保留。回收站到期立即拒绝恢复；后台到期物理清理任务留待阶段 7，不依赖任务及时运行保障 30 天边界。

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

微信原生 request 不支持 PATCH。小程序传输层把 PATCH 封装为 POST + `X-Dayline-Method-Override: PATCH`；API 仅对 `/api/v1/` 的 POST 精确识别这个值，正常执行原路由与鉴权、Origin、预期账号检查，不影响 `/api/auth`。本阶段已用真实受保护事项 PATCH 验证正常保存、缺预期账号、错账号、无 Origin 的 Cookie 写入和跨用户越权；原生认证路径回归仍通过。

共享 API 客户端不依赖 DOM / wx / uni / Node：应用传入传输和实际响应 decoder。账号代次变化后丢弃旧响应，验证成功前不接收刷新凭据，匿名登录失败不撤销另一个已知账号。小程序签名凭据仅存于专用平台键；网页仅使用 HttpOnly Cookie。密码不持久化；邮件 query 在首次读取后清理，同时保留并清理 Vue Router 的导航 state。

## 验证

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
```

阶段 3 检查为 70 项单元 / 组件与 36 组真实 PostgreSQL HTTP，包含 API、Web 和 mp-weixin 构建；实际范围与限制见 [阶段 3 交接](docs/stage3-handoff.md)。

阶段 2 建立、阶段 3 继续使用的最终专用库为 `dayline_stage2_final_test`，被忽略 `.env` 的 TEST_DATABASE_URL 已指向它；`dayline_stage2_final_empty_test` 完成空库三迁移重放，旧测试库和数据卷全部保留。正式记录迁移为 `20261026162718_record_core`，使用显式 BEGIN / COMMIT 保障已有账号回填原子性；新环境仍可使用示例的独立 `_test` 库名。

集成测试要求真实 PostgreSQL。`TEST_DATABASE_URL` 必须明确指向名称以 `_test` 结尾的专用数据库；未设置或名称不符时直接拒绝执行，不退回开发库。`pnpm test:integration` 依次构建、向测试库应用迁移，再运行 HTTP 测试。测试只清理本次生成的用户和对应凭据，不 truncate 整库。

覆盖注册 / 验证 / 重发、Cookie / 签名 Bearer、重置与改密码、退出、跨账号上下文、过期 / epoch 撤销、会话续期、普通 JSON 解析与认证原始请求体共存。开发文件邮件验证了端到端链接流程；真实 Resend 发信及完整微信 Gate-A 仍待后续验证。

GitHub Actions 中提供同一套检查配置，但远端工作流是否执行成功应以实际运行结果为准。

认证基础证据见 [阶段 1 交接](docs/stage1-handoff.md)；记录核心及迁移见 [阶段 2 交接](docs/stage2-handoff.md)；完整双端业务、游客事务与时间轴证据见 [阶段 3 交接](docs/stage3-handoff.md)。真实微信 code、小程序码扫码、真实 Resend 投递、开发者工具以及 iOS / Android 真机尚无凭据或设备验证；注入测试适配器不表示这些外部能力通过。

完整产品目标见 [需求](docs/requirements.md)、[后端 Spec](docs/backend-spec.md) 和 [前端 Spec](docs/frontend-spec.md)。历史恢复记录见 [交接说明](docs/handoff.md) 和 [恢复说明](docs/recovery.md)；当前实现范围以本 README 和代码为准。
