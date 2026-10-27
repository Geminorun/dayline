# 自托管、备份与恢复

本文件提供可复跑的本机 / 自有服务器操作，不代表已经发布。当前生产为一个提供 Web + Nest API 的容器，连接已有 PostgreSQL 17 / 18 容器，默认复用服务器本机 Nginx 与证书，入口容器仅为可选项；小程序独立构建上传，日常业务不依赖 ChatGPT。原始数据库与任何已有卷都不得用 reset、drop 或 `down -v` 处理。

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

## 生产发布

生产流程、默认六项 GitHub Secrets、现有 PG 容器初始化及 HTTPS 入口要求以 [部署指南](deployment.md) 为准。`compose.production.yaml` 已改为独立生产文件，默认只包含 app；NGINX_MODE=container 才叠加独立入口文件；不要再与开发 `compose.yaml` 叠加，也不要创建第二个生产数据库或将 localhost 当作容器内的数据库。

容器应用直接提供 Web / SPA 深链接，保留 API 的 no-store、安全响应头及不记录敏感 query 的日志。本机 Nginx 通过宿主回环端口转发至应用，API 仅信任宿主网关及回环地址。可选入口容器通过专用 proxy 网段连接，API 仅信任该网段。入口应仅信任 Cloudflare 官方网段提供的访客 IP，并覆盖转发头。应用诊断端口仅绑定宿主 `127.0.0.1:13000`，既有 PG 的端口和防火墙由原配置管理。

受管理云环境本机构建仍需使用 `--secret id=proxy_ca,src="$CODEX_PROXY_CERT"` 提供环境公开 CA。运行需要外部 HTTPS 的测试容器时同样挂载 CA 并设置 NODE_EXTRA_CA_CERTS；不要关闭 TLS 校验。GitHub 托管 runner 和普通服务器使用自己的正常系统信任，无需复制当前会话 CA 或代理凭据。

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
docker exec postgres17 pg_dump -U postgres -d dayline -Fc > /private/dayline-backups/dayline.dump
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

`verify:backup-restore` 与 `verify:capacity` 必须有安全的 `TEST_DATABASE_URL` 且库名以 `_test` 结尾。恢复脚本只创建新的 `dayline_restore_*_test`，真实 pg_dump / pg_restore，重放迁移、撤旧会话、启动维护后验证类别 / 事项 / true-false 重点 / 回收站 / 身份 / 幂等 / 清理；原库与所有新旧库均保留。脚本仅清理自己的 fixture，不改 `.env`，结果与备份留在 `.local/stage7` 私目录。运行真实数据库脚本时串行，避免人为时钟测试与容量采样相互干扰。

容器演练创建独立 PG17 和Web / API 容器和真实 Nginx TLS 入口，实际执行首次初始化、备份、迁移、重复部署及失败恢复。使用随机 project / 回环端口，不碰已有 PG 容器和卷；结束删除自己的测试容器与网络，保留新卷及 `.local/deployment` 私有报告。GitHub 镜像发布也执行这一演练。本机证据不等于生产发布。

邮箱标准验证链接增加服务器保存的 token 摘要 → 原 UUID 绑定，最终 Better Auth 更新同时约束 UUID / active；升级前尚未完成、没有该绑定的旧验证链接应重新申请，不根据同邮箱新注册自动接受旧链接。密码和验证仍由 Better Auth 处理。
