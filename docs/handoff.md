# Dayline 会话交接

更新日期：2026-10-26。

本文件已在新环境从会话历史恢复。恢复范围、锁文件和 Git 历史差异见 [源码恢复说明](recovery.md)。以下验证结果是旧环境的历史结果，本次只恢复和打包，没有继续开发或重新验证后端。

## 1. 当前目标与暂停原因

用户已完成需求及前后端 Spec 讨论，要求先提交已有文档，然后开始后端开发。本阶段只搭建基本框架、数据库及邮箱认证组件，不要求一次实现所有业务功能。

旧环境按用户要求暂停开发：当时实际 HTTP 策略为 restricted，binaries.prisma.sh 不在允许列表，代理 CONNECT 返回 403。用户随后切换了运行环境。

当前新环境的 environment_status 已确认 HTTP 策略为 unrestricted / enforced，且 observations_current 为 true；Prisma 下载尚未重新验证。旧环境 unavailable，文件没有自动迁移。下一会话仍须检查自己实际绑定的策略和请求结果，不复用旧实例 ID。

## 2. 仓库与保存状态

- 当前项目：`/workspace/dayline`，分支 `work`，远端名称 `origin`。
- 旧环境曾提交 `4d1ffad docs: 确认需求规格与项目开发规范`，但没有 push；该提交对象无法从新环境和远端找回。
- 新环境及远端原先只有 `c22019c Initial commit`。文档和后端源码已从完整历史修改记录恢复，恢复后的快照单独保存，不能沿用旧提交哈希。
- 按用户最新要求，当前提交范围仅限 AGENTS.md 和 docs/ 下的文档；后端源码、工程配置、锁文件及 .gitignore 修改保留在工作区，不纳入本次提交。
- 远端推送目标为 origin/work；全量源码恢复快照另存于本机交接 ZIP。只拉取文档分支不能取得尚未提交的代码。
- 本阶段只保存文档并验证远端推送，不部署、运行数据库或修复业务代码。
- 原 pnpm-lock.yaml 没有可恢复的完整内容，已使用原 package.json / pnpm-workspace.yaml 重新解析生成；不保证与旧锁文件逐字一致。
- 不恢复或打包 .env、密钥、邮件预览、node_modules 和构建产物。后续开发按 .env.example 创建自己的本地配置。

如使用恢复后的交接 ZIP：`dayline/` 是恢复的源码快照，`git-baseline.bundle` 保存新环境实际可用的提交历史，不包含原 4d1ffad 提交对象。包不含 .env、.git 配置、node_modules、dist、生成客户端和邮件预览。若新工作区已经有更新内容，先比较再恢复，不直接覆盖。工作区链接不是持久附件，切换环境前须下载交接包或把源码推送到自己的 Git 远端。

## 3. 先阅读的文件

1. `AGENTS.md`：代码风格、分层、复用、验证及 Conventional Commits。
2. `docs/requirements.md` v1.0：产品基线及 28 条决策、34 项验收。
3. `docs/backend-spec.md` v0.1：后端模型、认证、接口、导入与合并等完整目标。
4. `docs/frontend-spec.md` v0.1：两个前端及对接契约，尚未开始前端代码。

Spec 中的“当前交付为文档 / 未初始化”等早期状态尚未统一更新；实际实现进度以本交接记录和代码为准，不能据此宣称全部 Spec 已实现。

## 4. 必须保留的最终决定

- 一个 pnpm workspace；两个独立前端（Vue 网页、uni-app 微信小程序）；一个 NestJS 后端。
- PostgreSQL + Prisma、Better Auth、Resend；首版不加 Redis、微服务、实时推送或离线增量同步。
- 邮箱使用密码注册、验证邮件、登录及密码重置。本阶段的验证是邮件链接，不另行引入免密码 Email OTP 流程。
- 登录账号在线保存；Web 可暂存本机草稿，恢复网络后手动提交；不能自动补传。
- 首次完整加载，之后前台约每 30 秒全量刷新；返回前台 / 恢复网络立即读取，不能因此提交草稿。
- 游客在两端完整使用本机功能；登录后云端为空则直接接入，已有数据先预览合并；确认成功前保留原包。
- 邮箱和微信关联同一内部用户；登录 / 切换、绑定、账号合并分开。双账号验证后预览并默认保留双方。
- 固定北京时间；事项回收站 30 天；账号自助注销 7 天内可撤销；网页 CSV / JSON 导入导出为首版功能。
- 保留原站配色及完整小程序横向时间轴；域名和服务器可更换，不再围绕它们做需求访谈。

## 5. 已写入的后端基础

### 工程和依赖

- 根 package.json、pnpm-workspace.yaml、pnpm-lock.yaml、TypeScript、ESLint / Prettier、Vitest 配置。
- `apps/api`：NestJS Express 项目，严格 TypeScript、ESM、开发 / 构建 / 类型检查 / 数据库命令。
- `packages/core`：时区和默认分类常量。
- `packages/contracts`：显示名 / 资料输入 schema、公开用户 DTO 类型、API 包装类型和预期账号 header 常量。
- `.env.example`、开发用 compose.yaml、PostgreSQL 初始化测试数据库 SQL。

当前锁定的主要版本：Node 24.19.0、pnpm 11.25.0、TypeScript 5.9.3、NestJS 11.2.8、Nest CLI 11.0.24、Better Auth / auth CLI / Prisma adapter 1.7.13、社区 Nest 认证适配 2.8.0、Prisma / adapter-pg 7.10.1、Resend 6.34.1、Vitest 5.0.5、ESLint 10。

Prisma 的 npm latest 当时是 8.0 RC，所以刻意使用 7.10.1。pnpm 配置中禁用 scarf 安装统计脚本，并覆盖 webpack 到兼容 peer 的版本；`pnpm peers check` 最后一次通过。

### 数据库

- `apps/api/prisma/auth.generated.prisma`：Better Auth 官方 CLI 成功生成的参考模型。
- `schema.prisma`：在参考模型基础上加入 snake_case 表 / 列映射、用户状态 / epoch / 初始化标记、Category 和 WechatIdentity。
- 已有 User、Session、Account、Verification、Category、WechatIdentity 模型；不是全部业务表。
- **还没有 migration 文件，Prisma Client 未成功生成，数据库尚未建表。**
- 不要用参考 auth.generated.prisma 覆盖扩展后的 schema.prisma。新环境先 format / validate / generate，再创建首个正式迁移。

### 应用和认证代码

- AppModule / createApp / main，配置校验、Prisma 生命周期、CORS、Helmet、请求 ID、统一响应和异常过滤。
- 健康检查 `/health/live`、`/health/ready`，开发 Swagger 入口 `/api/docs`。
- Better Auth 邮箱密码、验证邮件、重置、签名 Bearer 及原生路由允许列表。
- 全局业务 SessionGuard，原生认证策略中间件，epoch / 状态及 Cookie / Bearer 一致性检查。
- `/api/v1/me` GET / PATCH、资料版本检查、`/api/v1/auth/logout`。
- 默认六分类初始化服务；需验证它与 Better Auth 事务及 session.create hook 的实际交互。
- `X-Dayline-Expected-User` 用于防跨标签页 Cookie 切换串号，只与可信会话比较，不能作为授权依据。两份 Spec 已同步该契约。
- Resend transport 和开发专用 file transport。file 模式将邮件写入忽略的 .local/mail，文件权限 0600，不打印验证链接；生产配置禁止 file 模式。

以上表示代码已写入，不表示已编译、启动或完成认证联调。

## 6. 验证结果与已知失败

| 项目 | 结果 |
| --- | --- |
| 文档与 Spec 格式 / 示例 / 验收映射检查 | 之前通过 |
| pnpm install、peer 检查 | 最后一次通过，lockfile 已生成 |
| Better Auth 官方 auth schema 生成 | 通过，不需要数据库引擎 |
| pnpm build:shared | core / contracts 构建通过 |
| contracts 测试 | 3 项通过 |
| API 单元测试 | 7 项通过、1 项失败 |
| pnpm test 整体 | 失败，不能宣称通过 |
| Prisma generate / --no-engine | 均因 binaries.prisma.sh 代理 403 失败 |
| 后端 build / 完整 typecheck / lint / format 检查 | 尚未完成 |
| HTTP / PostgreSQL / 真实邮件 / 微信集成 | 尚未验证 |

明确的单元测试失败：`apps/api/test/environment.test.ts` 中 `rejects wildcard or path-based trusted origins`，期待受控的 trusted-origins 错误，实际收到 `Invalid URL`。

可能原因：`src/config/environment.ts` 的 `z.url().refine(...)` 在 refine 内直接 `new URL(value)`，对 `*` 等非法输入仍可能抛异常。数据库 URL validator 也要检查同类问题。应修正安全解析，不是改测试让异常静默通过。暂停后尚未修复。

Docker 守护进程可用，曾成功拉取 postgres:18-alpine，但没有启动数据库容器。没有 API 服务在运行。集成测试配置已存在，**集成测试用例尚未编写**。

## 7. 下一步顺序

1. 先读取 docs/recovery.md，确认源码快照完整，再读取 AGENTS.md。不要继续重复需求访谈，也不要初始化工具覆盖现有文件。
2. 在新版运行环境读取当前 environment_status，实际验证 binaries.prisma.sh 出站。不要只看已编辑 / 已发布的模板；不要关闭 TLS / checksum 校验或绕过代理。
3. 按需 `pnpm install --frozen-lockfile`；如无 .env，从 .env.example 创建开发配置，不要求用户立刻提供生产密钥。
4. 修复配置校验失败；执行 Prisma format / validate / generate，生成并审阅首个迁移。
5. 启动开发数据库，执行迁移，确认真实 PostgreSQL 和生成客户端可用。
6. 执行 format、lint、typecheck、build，修复尚未暴露的编译 / Nest 模块及请求解析问题。
7. 编写真实 PostgreSQL HTTP 集成测试，用开发文件邮件或注入 transport 获取测试验证链接：注册 → 未验证不能登录 → 邮箱验证 → Cookie / 签名 Bearer → /me → 原生 / 业务写入上下文及版本 → 重置 → 旧会话失效 → 退出。
8. 测试防串号、受限状态、普通 JSON 解析与认证 raw body 共存，以及默认分类初始化 / 幂等；不要只用内存数据库替代。
9. 完善 README 启动步骤、当前实现范围与 Gate-A 未完成项，再保存后端的独立提交。

常用命令已在根 scripts 中：`pnpm db:generate`、`pnpm db:migrate`、`pnpm db:deploy`、`pnpm build:shared`、`pnpm test`、`pnpm lint`、`pnpm typecheck`、`pnpm build`、`pnpm test:integration`、`pnpm dev`。

## 8. 当前没有完成的功能

微信真实登录 / 无邮箱身份会话、扫码、绑定与账号合并、业务事项 / 重点 / 回收站 API、快照刷新、导入导出、注销任务、全部前端工程，均未实现或未验证，不得把 Spec 当成已交付代码。真实 Resend 发信及微信凭据仍未配置，Gate-A 没有整体通过。

用户目前希望先移交到正确网络环境，再继续后端基础和邮箱认证闭环；没有要求发布站点、提交 PR 或部署正式服务器。
