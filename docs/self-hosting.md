# 自托管、备份与恢复

本文件提供可复跑的本机 / 自有服务器操作，不代表已经发布。运行时是一套 Nest API、PostgreSQL 18 和 Caddy 静态网页；小程序独立构建上传，日常业务不依赖 ChatGPT。原始数据库与任何已有卷都不得用 reset、drop 或 `down -v` 处理。

## 固定安装与本机启动

需要 Node 24.19.0、pnpm 11.25.0、Docker Compose。已有 `.env` 先保留，在副本上比对 `.env.example` 新配置，不能直接覆盖。

```bash
test -e .env || cp .env.example .env
pnpm install --frozen-lockfile --prod=false
pnpm db:generate
docker compose up -d --wait db
pnpm db:deploy
pnpm build
pnpm dev
```

另开终端 `pnpm dev:web`。API 3000，Web 5173；`/health/live` 检查进程，`/health/ready` 只有数据库和启动维护成功后才返回成功。六个默认分类由建号同事务触发器创建；没有公开 seed 密码或演示账号，不需另跑 seed。迁移从初始认证到第八条注销迁移按顺序 deploy；不使用 schema push 或 migrate reset。

## 同源反向代理运行

先在自己的 `.env` 中填写生产配置：`NODE_ENV=production`、独立随机 `BETTER_AUTH_SECRET` / `ACTION_PROOF_SECRET`、HTTPS `AUTH_BASE_URL` / `WEB_BASE_URL`、精确 `AUTH_TRUSTED_ORIGINS`、真实 Resend 已验证发件人和密钥。示例 origin 必须替换。`API_DATABASE_URL` 是容器内 `db:5432` 的数据库 URL，密码须 URL 编码；`DATABASE_URL` 用于你实际执行迁移的环境。不要把 `.env`、邮件、备份或代理凭据复制进镜像。

```bash
pnpm install --frozen-lockfile --prod=false
pnpm db:generate
pnpm build
docker compose -f compose.yaml -f compose.production.yaml build api
docker compose -f compose.yaml -f compose.production.yaml up -d --wait db
docker compose -f compose.yaml -f compose.production.yaml run --rm api pnpm db:deploy
docker compose -f compose.yaml -f compose.production.yaml up -d --wait api web
```

`compose.production.yaml` 显式固定生产模式。Caddy 通过宿主 `apps/web/dist` 提供静态文件，因此上面的宿主 Web 构建是必要步骤；镜像中的 dist 不会自动穿过 bind mount。API 镜像保留固定依赖与迁移 CLI，便于一次性部署迁移；首次版本没有为了缩小镜像剔除编译工具。构建可放在独立 CI 机器，运行不要求安装编译工具。

Caddy `/api/*` 和 `/health/*` 反代 API，其他路径回退 `index.html`，包括 `/entries/:id`、邮件回调和 `/account-deletion`。生产 Cookie 为 HttpOnly / SameSite=Lax / Secure，API 不发布公网端口，PostgreSQL 保持宿主回环地址。配置 `DAYLINE_HOST` 为自己的 HTTPS 站点；Caddy 的证书数据卷也应保留。仅本机演练使用 HTTP 及测试模式，不能把它等同于生产 TLS / Cookie 已验收。

`TRUST_PROXY` 仅接受明确 IP 或 CIDR，默认空值忽略客户端转发 IP。反代运行时应填入受控 Caddy 的地址或仅受控代理所在专用网段，不能用 `true`、任意跳数或整个公网；代理后 IP 来源未经验证时宁可共享更严格限流。公网只允许经该反代访问 API，不能另开绕过代理的入口。

代理访问日志不能记录完整 query 或 Referer：附带的 Caddy 配置将 URI 整体替换成 `/redacted`，删除请求与响应 headers，并为 Web 静态响应设置 `Referrer-Policy: no-referrer`。API 仅记录 requestId、方法、路由模板、状态、耗时，不输出请求 / 响应体、SQL、私人记录、邮箱链接、OpenID 或凭据。`LOG_LEVEL=error|warn|info` 同时控制 Nest 与 HTTP info；邮件投递失败有固定用途 / 错误码事件，找回密码仍保持通用响应。

受管理云环境构建时，通过 BuildKit secret 提供该环境公开 CA：`DAYLINE_BUILD_CA_FILE` 指向受信 CA 文件；网络步骤挂载该 CA 并启用 TLS 校验。不要关闭证书校验。该文件不进入镜像层，运行 API 时也通过只读 secret 提供给 NODE_EXTRA_CA_CERTS；普通服务器可使用系统 CA 路径默认值。公共入口包装保留 HTTP(S)_PROXY、原 NO_PROXY / no_proxy 与 CA 配置，仅追加 api / db / loopback 到免代理列表，避免内部反代被外部代理拒绝；Node 24 按环境代理设置发起外部 HTTP。

## 运行边界

- 外部调用默认 8 秒、普通请求预算 15 秒、导入 / 合并 60 秒，可用示例中的配置调整。数据库事务同时有 Prisma / PostgreSQL 超时，提交前再次核对请求预算；HTTP 不用 Promise.race 提前回复后继续未知写入。客户端网络中断仍可能错过已经提交的回执，应读取当前事项、`/me` 或原任务状态，业务写不自动重放。
- 单进程内存限流有固定容量及过期回收。密码 / 重新验证按失败计数，成功不消耗五次失败额度；同时有 IP 总量、邮件 60 秒间隔、微信 / QR / 快照 / 用户写 / 导入限制，429 返回 Retry-After。重启不保留内存计数，多实例不共享计数；业务一次性效果仍由数据库保证。没有 Redis。
- 每 60 秒处理回收站和注销；小时处理过期 QR、邮箱绑定、导入输入 / 计划和 context；每日清七天合并恢复副本和过期认证。每批最多 100 目标，先用户锁再业务行。启动逐批 drain 完全部到期积压才 ready；即便周期关闭仍执行启动闸门。后台失败有安全目标 ID / 固定错误码并可重试，维护成功事件带最近成功时间与到期用户 / 回收站积压数。
- 到期有效性在读取和状态转移时校验，不依赖计时器准时。注销旧会话不能在下一次分钟扫描前继续用；撤销严格早于服务器到期时刻。已完成导入的最小摘要、映射和结果保留，过期私人 input / rows / 分类副本删除；合并的 recoverySnapshot 和 plan 中双方私人副本同时清理。

## 备份与恢复闸门

建议每天一次 PostgreSQL custom dump，至少保留七天，另存一份受访问控制的异地副本。备份含身份及私人数据，不入 Git；目录 0700、文件 0600，传输和异地存储加密。保留周期到期后由运营者删除对应备份，不承诺注销到期时所有历史备份同时消失。备份成功应检查命令退出码、大小和定期实际恢复。

运行自托管 Compose 时，可在私目录执行：

```bash
umask 077
mkdir -p /private/dayline-backups
docker compose exec -T db pg_dump -U dayline -d dayline -Fc > /private/dayline-backups/dayline.dump
```

实际用户 / 数据库名以自己的配置为准。异地复制及轮换应由自己服务器的调度配置管理；本仓库没有替你安装系统 cron 或对外上传备份。

恢复始终先停止对外 API / Web，保留当前数据库和卷，创建**新库**，将 dump 恢复到新库并 deploy 迁移。核对恢复点、较新的注销 / 撤销 / 合并事实；从备份之后发生的操作无法凭旧备份猜出。必须取得可信的最新运维记录或最新可用状态，把已关闭 UUID 对应账号标为到期注销 / 清除，不能只因旧备份显示 active 就开放。无法核对时保持服务关闭，先人工核实；不能宣称任意旧备份可自动重建之后的事实。

开放前在恢复库撤销全部旧 session / verification，递增用户 epoch，处理已知到期注销和来源壳，运行启动维护直至 ready，核对身份归属与导入 / 合并最小回执，再在隔离环境验证登录和数据。申请 / 撤销的安全结构化事件可辅助核对内部 UUID 与时间；它们的日志保留和异地可信副本由运营者配置，不把普通可丢失日志冒充完整持久审计账本。恢复前后的客户端缓存版本可不同，重新登录从服务器建立新基线；不上传旧完整缓存或自动提交草稿。

## 可复跑工程演练

```bash
pnpm verify:backup-restore
pnpm verify:capacity
pnpm verify:containers
```

前两项必须有安全的 `TEST_DATABASE_URL` 且库名以 `_test` 结尾。恢复脚本只创建新的 `dayline_restore_*_test`，真实 pg_dump / pg_restore，重放迁移、撤旧会话、启动维护后验证类别 / 事项 / true-false 重点 / 回收站 / 身份 / 幂等 / 清理；原库与所有新旧库均保留。脚本仅清理自己的 fixture，不改 `.env`，结果与备份留在 `.local/stage7` 私目录。运行真实数据库脚本时串行，避免人为时钟测试与容量采样相互干扰。

容器演练在独立 Compose project、新命名卷和 127.0.0.1:18080 / 15437 上执行，不占 3000 / 5173，不碰已有 `dayline-db-1`。测试秘密随机生成并只写私目录；构建镜像、全迁移、健康、SPA 深链、静态资产、API 代理与日志 query 脱敏，再 force-recreate 该测试 PG 容器验证同卷样本仍在。结束仅 down 容器，不加 -v；新卷保留以便复核。本机演练不发布、不对外部署，也不调用真实微信 / Resend。

邮箱标准验证链接增加服务器保存的 token 摘要 → 原 UUID 绑定，最终 Better Auth 更新同时约束 UUID / active；升级前尚未完成、没有该绑定的旧验证链接应重新申请，不根据同邮箱新注册自动接受旧链接。密码和验证仍由 Better Auth 处理。
