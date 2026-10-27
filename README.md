# 日序 Dayline

当前已实现统一邮箱 / 微信认证、网页登录扫码、分类、事项、每日重点、30 天回收站和一致完整快照；网页与微信小程序均可完整回看、编辑、搜索筛选、统计及浏览月 / 季度 / 年 / 全部时间轴。两端游客记录独立持久保存在本机，账号在线保存，设置可按版本修改显示名。

账号编辑手动在线提交；Web 输入约 300 ms 后尝试持久暂存为独立草稿，保存期间的新输入、原始版本与冲突核对均保留。两端按可信身份隔离完整缓存，前台约 30 秒全量刷新，回前台 / 恢复网络立即读取，后台停止；联网不会自动提交草稿或重放写入。

游客登录时冻结完整本机包：云端真正空白时直接接入，已有业务内容时先预览并逐项核对分类及来源。服务器确认只标记冻结修订，原包和较新游客修改始终保留；未知结果、过期与原任务查询均有恢复入口。网页数据管理已开放 CSV / 完整 JSON 文件导入导出；设置已开放重新验证、邮箱 / 微信绑定、双账号预览与原子合并；已开放两端七天注销申请 / 明确撤销与到期维护。游客和账号空间明确分开；恢复已有会话只读取，不自动发起新接入。

## 技术与目录

- Node.js 24.19.0、pnpm 11.25.0、TypeScript 严格模式。
- NestJS 11 + Express，PostgreSQL 17 / 18 + Prisma 7。
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
test -e .env || cp .env.example .env
pnpm install --frozen-lockfile --prod=false
docker compose up -d --wait db
pnpm db:generate
pnpm db:deploy
pnpm dev
```

已有 `.env` 时保留自己的配置。示例中的密码和认证 secret 仅供本机开发。PostgreSQL 只向本机开放端口；Compose 的命名卷保留数据，不需要删除卷来重启服务。

另开终端运行 `pnpm dev:web`，网页为 `http://localhost:5173`，开发代理把 `/api` 转至本机 API。生产使用同一个 Docker 镜像提供 Web 与 API，应用内处理 SPA 深链接，服务器 HTTPS 入口统一反代。

小程序复制 `apps/miniapp/.env.example` 至同目录 `.env`，设置 `VITE_API_BASE_URL` 为自己的 HTTPS API origin；在 `src/manifest.json` 中填写自己的 `mp-weixin.appid`。运行 `pnpm dev:miniapp`，或 `pnpm --filter @dayline/miniapp build`；开发者工具导入 `apps/miniapp/dist/build/mp-weixin`。空 AppID 可编译，但不能代表真实登录或上传已验收。Web 和小程序分别构建，未共享平台 UI。

- API：`http://localhost:3000`
- 开发 OpenAPI：`http://localhost:3000/api/docs`，JSON 为 `/api/docs-json`；生产模式关闭。
- 存活检查：`GET /health/live`；数据库及基础认证模型检查：`GET /health/ready`。

如果云环境写入的 SQL 文件权限为 0600，首次启动前执行 `chmod 644 infra/postgres/init-test-db.sql`，让容器内的 PostgreSQL 用户可以读取它。初始化 SQL 仅在空数据卷首次启动时执行；已有卷缺少测试库时，通过 PostgreSQL 管理工具创建专用的 `dayline_test` 数据库。

新增模型后使用 `pnpm db:migrate --name <migration_name>`，审阅生成的 SQL 再保存迁移。`pnpm db:deploy` 只应用现有迁移，不负责生成新迁移。`prisma/auth.generated.prisma` 是认证库参考文件，实际迁移使用 `prisma/schema.prisma`。

## 生产部署

生产复用服务器已有 PostgreSQL 17 / 18 容器，缺少专用账号 / 数据库时自动创建；Web 与 API 共用一个镜像，默认复用本机 Nginx / HTTPS，显式设置 NGINX_MODE=container 才部署入口容器。GitHub Actions 手动触发，检查后构建、推送 GHCR、SSH 发布、备份与迁移、验证公共入口。默认只需六项 GitHub Secrets；容器入口模式额外需要 TLS_CERT / TLS_KEY，具体见 [部署指南](docs/deployment.md) 和 [APP_ENV 模板](infra/production.env.example)。`compose.production.yaml` 是独立文件，不再与开发用 `compose.yaml` 叠加。

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

普通 API 使用 `{ data, meta }` / `{ error, meta }` 包装，原生认证路径保持 Better Auth 协议。游客接入 prepare 独立支持 10 MiB / 10,000 事项 / 100,000 重点，精确 import review 独立支持 4 MiB / 10,000 来源选择（每键最高 160 字符，含当前事项 / 重点集合版本核对）。文件预览使用精确 raw UTF-8 上传路由，实际文件上限 10 MiB，不经过 JSON 包裹；CSV / JSON 单次导入各限 10,000 事项、100,000 重点状态。普通 JSON 解析限制为 64 KiB；事项 PATCH 的精确重点移除确认最高 1 MiB / 20,000 日期，无确认列表仍保持 64 KiB；回收站部分清理独立限制为 128 KiB / 1,000 项。内存限流是单进程的，不提供多副本共享或重启后的计数保留。

原生更新资料、即时删号、修改邮箱及社交身份绑定等未实现的操作返回 404。业务 `PATCH /api/v1/me` 仅接受显示名与 `expectedProfileVersion`，在用户锁后复核会话 epoch、状态及资料版本；资料变更不增加业务 dataVersion。除四张认证表外已有微信 / 扫码、业务、导入及绑定 / 合并任务与映射表。新用户的六个默认分类与 initialized_at 由数据库 INSERT 触发器在用户创建的同一事务中初始化；迁移一次性初始化已有账号。登录不补齐分类，也不覆盖用户改名 / 删除。状态和 epoch 用于会话限制及已实现的绑定 / 合并撤销；注销申请 / 撤销在专用重新验证及用户锁下完成，更新 epoch 并撤销旧会话。无邮箱微信身份不开放原生 SDK `/get-session` 用户输出（返回 403），防止内部占位邮箱泄漏；两端账号界面始终读取公开 `/me`。

## 记录与每日回看

网页默认 `/day`，侧栏提供 `/entries`、`/timeline`、`/categories`、`/trash` 和 `/settings`；旧 `/review` 与 `/account` 保留兼容跳转。可直接打开 `/entries/new` 或 `/entries/:id`。小程序四 tab 为回看、记录、时间轴和我的，另有独立编辑、分类及回收站页；真实扫码路径仍为 `pages/scan/confirm`。

两端均支持新建 / 编辑、指定日期重点、今天结束、删除确认、恢复 / 永久清理、分类增改与原子转移删除。日期覆盖、搜索筛选、排序、统计和四尺度时间轴使用共享纯规则；正常记录与统计排除回收站，重点只计 true。时间轴固定名称和日期头、横向滚动、有界刻度与虚拟行，重点聚合可查看分页的真实日期。

游客首次仅初始化一次 UUID 数据集及六分类。Web 使用 Dexie / IndexedDB 事务完成及修订 CAS；小程序采用每片低于单键限制的不可变代次与最后 manifest 提交。损坏 / 未知 schema / 不完整分片停止覆盖并显示恢复提示；容量或写入失败保留上一份完整数据和当前输入。没有全局 clearStorage，凭据不在游客包中。Web 同设备多标签冲突须重新读取并核对，不能静默覆盖。

账号保存等待服务器确认；失败保留编辑输入和稳定 ID。缩短范围先展示受影响的精确重点日期，再由用户确认。Web 草稿在 `/drafts` 继续 / 复制 / 下载 / 放弃，冲突展示服务器字段与草稿，核对后按版本保存或明确另存副本；没有自动补传。设置的数据管理可下载模板、预览及核对 CSV / JSON 并整体导入，或导出本机 / 云端已保存记录；登录方式与合并从设置进入 `/identity`，注销入口为 `/account-deletion`，两端均显示服务器七天期限并可明确撤销。

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

所有业务写先锁可信 Actor 所属用户，再复核 epoch、active 状态、归属及版本，在同一事务内提交内容和 dataVersion。每日重点仅改变单日版本与事项 focusVersion，不改变内容 version。成功写响应 meta.dataVersion 是十进制字符串；共享客户端保留验证后的完整 meta 和结构化冲突依据。待注销账号只可读取 /me、导出、重新验证、明确撤销或退出，普通记录读取与业务写入、绑定、导入、合并均受限；到期立即拒绝会话和撤销，不等待清理 tick。未初始化标记的异常账号由业务接口返回受控 503，不构造 complete:true 的空或半份快照；认证账号读取仍保留。回收站到期立即拒绝恢复；后台每分钟分批清理到期事项并递增业务版本；不依赖任务及时运行保障 30 天边界。

## 完整缓存、草稿与游客接入

启动先探测现有会话，明确游客偏好优先；未知身份时隐藏私人内容，不用旧邮箱或本机账号 ID 充当授权。Web 使用 IndexedDB 的账号独立仓库，小程序账号缓存 / 冻结包采用不可变分片和最后 manifest 提交，凭据仍用单独平台键。损坏、未知 schema、错环境 / 所属账号 / 键内 ID 的信封保留原始内容，拒绝覆盖；本机失败与云端保存结果分别显示。

ETag 只搭配已验证完整快照；304 没有 body，缺快照时重新读取。自己的写回执建立十进制版本下界并更新可见字段，但不会把局部补丁标成新的完整缓存；只有完整 GET 才能持久化新版本。重新认证允许采用新的可信服务器基线；“今天”由服务器时间与经过时间校准。

| 方法   | 地址                                        | 用途                                                        |
| ------ | ------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/v1/guest-admissions/prepare`          | 持久冻结来源、判定空账号并直接接入，或创建零业务写入预览    |
| GET    | `/api/v1/imports/by-operation/:operationId` | 按原操作标识查找准备 / 完成结果                             |
| GET    | `/api/v1/imports/:id`                       | 读取有归属校验的预览、过期或持久回执                        |
| POST   | `/api/v1/imports/:id/review`                | 核对分类映射 / 来源副本或跳过，产生新修订与摘要             |
| POST   | `/api/v1/imports/:id/commit`                | 锁用户及任务后再次核对版本、epoch、计划修订和摘要，原子提交 |
| DELETE | `/api/v1/imports/:id`                       | 取消未完成任务，保留本机原包                                |

分类 seed / 名称 / 颜色一致时复用，同名异色要求明确映射或改名；20 类上限不通过丢弃解决。连续游客修订使用来源 ID 与内容摘要：未变的已处理来源跳过，改过的来源须明确保留副本或跳过，不静默覆盖云端。两端预览每页 50 条，完整选择与计数不截断。完成回执和来源映射保留，预览输入及计划私人副本已由维护任务到期清理，保留最小回执。

## Web 文件导入与备份

从设置进入 `/data`。游客文件完全在本机解析和预览，不调用私人云端上传；账号文件经认证后创建持久任务。两种模式均先展示每页 50 项的来源位置、当前 / 拟应用字段和重点日期差异，再明确保存核对及整体确认。错误行不能静默跳过；缺行从不删除现有记录。大于 256 KiB 的浏览器文件使用 Worker 解析，文件模块通过 `@dayline/contracts/files` 子路径供 API / Web 使用，不进入小程序文件流程。

CSV v1 固定十二列，UTF-8 / BOM、CRLF、逗号 / 引号 / 换行及中文均按 CSV 规则解析。导出文本使用 `text_escape=apostrophe-v1` 可逆保护公式前缀和原有单引号。缺可选列保持当前值；空结束日期清空，空重点集合清空。已有 ID 的内容 / 集合更新分别核对版本；旧文件须明确核对当前内容后生成新修订，无强制覆盖入口。

完整 JSON v1 保留分类配色与默认分类身份、真假重点和仍保留的回收站，拒绝私密凭据 / 未知格式 / 损坏引用，不信任文件 owner。恢复到真正空白且默认结构未改的目标时，预览明确恢复默认分类的备份名称 / 颜色；同一事务安全处理交换名称。其他目标必须明确映射或作为自定义分类保留。原删除时刻及连续 30 天期限保持，已到期来源跳过。

同任务保持原文件与操作 ID；结果不明先查询原任务。完成回执含事项及分类来源映射，重复已处理来源不重建已清理目标，也不因用户后来改过分类而重建旧分类。游客包、来源回执和任务结果在同一 IndexedDB 事务提交，冻结修订变化或容量失败保留旧包及原输入。云端仅在持久 `committed` 后确认成功并完整刷新；导出草稿前会提示先手动保存或继续只导出云端记录。

| 方法 | 地址                            | 协议                                                                                                                                                         |
| ---- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GET  | `/api/v1/exports/csv-template`  | 公开十二列模板                                                                                                                                               |
| GET  | `/api/v1/exports/csv` / `/json` | 当前已验证账号的附件；CSV 仅活动事项，JSON 含回收站与 false 重点                                                                                             |
| POST | `/api/v1/imports/preview`       | raw UTF-8 文件；`Content-Type: application/octet-stream`，`X-Dayline-File-Format: csv\|json`，`X-Dayline-Operation-ID: UUID`；沿用可信 Origin 与预期账号保护 |

通用查询、review、commit 和取消复用游客接入的 `import_jobs`，没有第二套文件提交事务。生产预览按账号每分钟 5 次限流；单实例内存桶不作为幂等依据。真实 Excel / Numbers / LibreOffice 交互、WebKit 和设备兼容性仍需人工验证；纯解析、Chromium 和 mp-weixin 构建不替代这些证据。

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

扫码目的支持 `login`、`bind_wechat` 与 `reauth`。绑定和重新验证需要当前真实会话，并固定当前会话、操作与目的；未知微信在绑定解析 / 确认中不建号。其他未知目的返回 400。扫码 proof、scene、浏览器 secret 不可互换。仅凭 ID、扫描动作或确认链接不会登录网页。扫码后仍可取消，领取完成后再取消会提示请求已结束。

无真实邮箱用户使用内部 `.invalid` 标识，`emailVerified=false`，公开邮箱为 null；不把 `session_key`、OpenID、UnionID、内部邮箱或原始会话 token 返回业务 DTO。阶段 6 已提供受重新验证保护的绑定 / 合并 HTTP 流程，同一个内部用户后续可通过 Better Auth 哈希设置真实邮箱 / 密码，邮箱和微信登录仍取得统一 UUID；底层 primitive 不直接向客户端开放。

微信原生 request 不支持 PATCH。小程序传输层把 PATCH 封装为 POST + `X-Dayline-Method-Override: PATCH`；API 仅对 `/api/v1/` 的 POST 精确识别这个值，正常执行原路由与鉴权、Origin、预期账号检查，不影响 `/api/auth`。本阶段已用真实受保护事项 PATCH 验证正常保存、缺预期账号、错账号、无 Origin 的 Cookie 写入和跨用户越权；原生认证路径回归仍通过。

共享 API 客户端不依赖 DOM / wx / uni / Node：应用传入传输和实际响应 decoder。账号代次变化后丢弃旧响应，验证成功前不接收刷新凭据，匿名登录失败不撤销另一个已知账号。小程序签名凭据仅存于专用平台键；网页仅使用 HttpOnly Cookie。密码不持久化；邮件 query 在首次读取后清理，同时保留并清理 Vue Router 的导航 state。

## 重新验证、绑定与合并

Web 设置的登录方式入口为 `/identity`，小程序为 `pages/account/identity`。密码或新微信 code 重新验证后签发独立用途的五分钟 JOSE proof；网页微信账号使用专用 `reauth` 扫码，仍需原会话、原浏览器 secret、新 code 和明确确认。错误密码 / 过期或错用途 proof 返回 403，当前会话保留；真实失效会话才返回 401。生产必须配置独立且非示例的 `ACTION_PROOF_SECRET`。

添加邮箱的邮件申请不区分已注册 / 未使用地址，匿名邮件链接只标记邮箱控制权。原账号提供当前 proof 后，未知邮箱设置 Better Auth 密码并保留原 UUID；已占用邮箱还须验证该账号当前密码，再产生短期双方受验证上下文。原邮箱账号尚未验证时，本次精确绑定邮件证据只在最终合并事务中使迁移后的邮箱成为已验证，不提前登录或改绑。微信绑定同样只在明确确认后关联未知身份；已有 B 时只进入合并，绝不切换为 B 会话。

合并默认统一到当前发起账号，固定双方 epoch / 数据版本、15 分钟预览、计划修订和摘要。双方事项、false 重点和回收站期限保留，同标题默认两条；同名同色分类复用，同名异色给出唯一且不超过 12 字的建议名，用户可明确改名或映射，超过 20 分类先解决。取消不移动任何业务或登录方式。proof 到期可重新验证双方并恢复同操作已核对计划。

提交按 UUID 顺序锁两账号，在同一事务迁移分类 / 事项、微信、Better Auth credential 的 userId 与 accountId、邮箱及显示名选择，保存最小映射 / 结果和七天恢复快照，将来源变为不可登录壳并撤销双方旧会话。结果不明先在重新登录后查询原任务；不另造一次合并。旧来源的 import_jobs 保留原归属和幂等键，目标仅经服务器完成合并关系继承其最小来源回执，重复旧文件 / 游客来源不会新增副本；目标不能读取来源私密导入计划。

Web 草稿页只有在重新验证统一账号、取得后端映射后才读取本机来源草稿。复制保留原稿和可靠原始版本；缺少可靠基准则明确作为新建草稿重审，不自动提交。普通账号切换没有此授权映射，不迁移草稿。两端身份写入前暂停新读取并排空已有快照 / 身份探测，防止自己的会话撤销使成功结果误报失效。

| 方法          | 地址                                                         | 用途                                                  |
| ------------- | ------------------------------------------------------------ | ----------------------------------------------------- |
| POST          | `/api/v1/auth/reauth`                                        | purpose、operationId、target 与当前密码或新 code      |
| GET / POST    | `/api/v1/me/email-binding-requests`                          | 恢复本账号申请 / 通用发信申请                         |
| POST          | `/api/v1/me/email-binding-requests/verify`                   | 匿名标记邮件已验证                                    |
| POST / DELETE | `/api/v1/me/email-binding-requests/:id/complete` / `.../:id` | 原账号完成或取消                                      |
| POST          | `/api/v1/me/wechat-binding`                                  | 小程序当前会话经 proof + fresh code 明确绑定          |
| POST          | `/api/v1/account-merges/preview`                             | 仅接受服务器受证 context 和原操作                     |
| GET           | `/api/v1/account-merges` / `.../:id`                         | 最小任务句柄列表 / 已授权任务                         |
| POST / DELETE | `/api/v1/account-merges/:id/review`、`/commit` / `.../:id`   | 核对 / 原子提交 / 取消                                |
| POST          | `/api/v1/account-merges/:id/mappings`                        | 新 proof 放 body，不把 proof 放 URL，取得授权草稿映射 |

阶段 6 证据及维护接口见 [阶段 6 交接](docs/stage6-handoff.md)。尚未部署或发布；真实微信、Resend、微信开发者工具和 iOS / Android 仍待外部条件验收。

## 验证

```bash
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm test:integration
```

最终检查见 [阶段 7 交接](docs/stage7-handoff.md)，保留阶段 1–6 全部回归及严格的源 / 测试类型检查。API、Web 和 mp-weixin 分别构建，编译不替代真机验证。

阶段 2 建立、阶段 3 继续使用的最终专用库为 `dayline_stage2_final_test`，被忽略 `.env` 的 TEST_DATABASE_URL 已指向它；`dayline_stage2_final_empty_test` 完成空库三迁移重放，旧测试库和数据卷全部保留。正式记录迁移为 `20261026162718_record_core`，使用显式 BEGIN / COMMIT 保障已有账号回填原子性；新环境仍可使用示例的独立 `_test` 库名。

集成测试要求真实 PostgreSQL。`TEST_DATABASE_URL` 必须明确指向名称以 `_test` 结尾的专用数据库；未设置或名称不符时直接拒绝执行，不退回开发库。`pnpm test:integration` 依次构建、向测试库应用迁移，再运行 HTTP 测试。测试只清理本次生成的用户和对应凭据，不 truncate 整库。

覆盖注册 / 验证 / 重发、Cookie / 签名 Bearer、重置与改密码、退出、跨账号上下文、过期 / epoch 撤销、会话续期、普通 JSON 解析与认证原始请求体共存。开发文件邮件验证了端到端链接流程；真实 Resend 发信及完整微信 Gate-A 仍待后续验证。

GitHub Actions 中提供同一套检查配置，但远端工作流是否执行成功应以实际运行结果为准。

认证基础证据见 [阶段 1 交接](docs/stage1-handoff.md)；记录核心及迁移见 [阶段 2 交接](docs/stage2-handoff.md)；完整双端业务、游客事务与时间轴证据见 [阶段 3 交接](docs/stage3-handoff.md)。真实微信 code、小程序码扫码、真实 Resend 投递、开发者工具以及 iOS / Android 真机尚无凭据或设备验证；注入测试适配器不表示这些外部能力通过。

完整产品目标见 [需求](docs/requirements.md)、[后端 Spec](docs/backend-spec.md) 和 [前端 Spec](docs/frontend-spec.md)。历史恢复记录见 [交接说明](docs/handoff.md) 和 [恢复说明](docs/recovery.md)；当前实现范围以本 README 和代码为准。

## 第七阶段与最终交接

两端设置已开放七天注销，申请和明确撤销都需本次用途 / 操作 / 会话的 fresh proof，撤销全部旧会话后重新登录；普通登录保留 pending 状态。注销页可直接导出服务器已保存记录，不依赖本机完整快照，未提交草稿另行保留。

同一后端启动时逐批完成到期维护才 ready；之后每分钟处理 trash / 注销，小时处理 QR / 邮箱 / 导入私密输入，日清七天合并恢复副本和认证过期数据。每批最多 100，统一先用户锁，保留最小回执 / 映射，最终账号清理包含历史来源壳。内存限流、显式可信代理、8 / 15 / 60 秒外部 / 普通 / 批量预算、安全日志及邮件失败事件见配置示例；没有 Redis、离线队列或自动补传。

- [自托管、同源代理、备份恢复闸门与可复跑脚本](docs/self-hosting.md)
- [全部 34 项验收证据与待验边界](docs/final-acceptance.md)
- [统一人工测试指南](docs/final-manual-testing.md)
- [第七阶段交接与最终实测](docs/stage7-handoff.md)

真实 PostgreSQL 备份恢复与容量脚本只操作专用 `_test`，不改既有开发库 / 卷或 `.env`，保留新旧数据库。容器演练使用独立 project / 新卷及回环端口；这些本机证据不等于生产发布。微信 / Resend 凭据、开发者工具与 iOS / Android 真机尚缺条件，仍按人工指南 pending；浏览器 / 编译不替代真实外部证据。
