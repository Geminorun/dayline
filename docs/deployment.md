# GitHub Actions 部署

当前生产结构是 Cloudflare 橙云 → Nginx HTTPS 入口 → Web + Nest API 应用 → 已有 PostgreSQL 17 / 18。Web 和 API 仍打包在同一个应用镜像；Nginx 作为独立入口容器由同一份生产 Compose 自动管理。不会创建第二个生产 PostgreSQL 容器、重启原数据库或删除其卷。小程序独立构建并上传微信，本 workflow 不负责小程序上传 / 审核 / 发布。

## 一次准备

服务器要求 Ubuntu / Linux amd64、Docker Engine、Docker Compose >= 2.30.0，以及 bash、curl、tar、flock、ss（iproute2）。Compose 的 raw env-file 保留密码中的 `$`、`#`、引号和空格，不使用 shell 执行配置。应用运行镜像仅包含后端生产依赖、固定迁移 CLI 和网页产物，不包含前端编译器或测试依赖。当前构建目标为 linux/amd64；ARM 服务器须先增加对应镜像构建目标。

1. 创建或选定 `DEPLOY_USER`，给予 Docker 使用权限、可写的 HOME，并将部署专用 SSH 公钥加入其 `~/.ssh/authorized_keys`。SSH 默认 22。部署路径为该用户的 `~/dayline`，不要求安装 Node / pnpm 或手动安装 Nginx。
2. 在可信服务器控制台查看 `/etc/ssh/ssh_host_ed25519_key.pub`，组合成 `<DEPLOY_HOST> ssh-ed25519 <公钥内容>`，填入 `DEPLOY_KNOWN_HOSTS`。填写完整 known_hosts 行，包含与 DEPLOY_HOST 相同的主机名 / IP；不要填服务器私钥。Actions 严格校验主机公钥，不自动接受未知公钥。
3. 确认现有 PG 容器正在运行，将准确容器名写入 APP_ENV 的 `POSTGRES_CONTAINER`。现有管理员默认为 `postgres`；若原容器用了其他 POSTGRES_USER，设置 `POSTGRES_ADMIN_USER`。脚本在容器内部通过本地 socket 调用 psql；如该 socket 要求密码，再加 `POSTGRES_ADMIN_PASSWORD`。管理员需要建角色和建库权限；脚本不会读取或猜测原密码。PG 应允许专用 Docker 内网的 TCP 连接；自定义 listen_addresses / pg_hba.conf 时，需允许目标库及应用账号访问。
4. Cloudflare 中保持站点 DNS 橙云开启，A 记录指向服务器 IPv4。允许 Cloudflare 访问服务器的 80 / 443，并确保这两个端口可供本项目使用。已有服务占用时，部署会在停止应用、备份和迁移之前报错，不自动停止其他 PM2 / Nginx / Docker 服务。
5. 按下一节创建 Cloudflare Origin 证书，填写 TLS_CERT / TLS_KEY，并将 Cloudflare SSL/TLS 加密模式设为 **Full (strict)**。不使用 Flexible。无需预先配置另一个反向代理，workflow 会启动 Nginx 并应用 TLS 配置。
6. 在 GitHub Settings → Environments 创建 `production`，填写下表。确保 Actions 可以推送 Packages，GHCR 包关联本仓库，允许该仓库 GITHUB_TOKEN 读取。无需长期 GHCR PAT 或 Cloudflare DNS API Token。

## Cloudflare Origin 证书

在 Cloudflare 控制台选择域名 → SSL/TLS → Origin Server → Create Certificate：

1. 选择由 Cloudflare 生成私钥及 CSR，使用 RSA 2048 即可。
2. 证书主机名包含实际站点，例如 `dayline.mindreview.me`。`*.mindreview.me` 也覆盖它；只包含根域名 `mindreview.me` 不覆盖子域名。
3. 创建后，将证书的完整 PEM 内容填入 GitHub Secret `TLS_CERT`，将完整私钥 PEM 填入 `TLS_KEY`。保留真实换行，不需要 Base64 编码，不要写入 APP_ENV。
4. 私钥只在创建时展示，应在自己的安全位置保存；证书到期前重新签发并更新 Secrets，再重新部署。本方案不运行自动签发 / 续期服务。

Origin 证书用于 Cloudflare 到源站的 HTTPS，由 Cloudflare 信任；用户和小程序访问橙云域名时看到的是 Cloudflare 边缘证书。直接绕过 Cloudflare 访问源站，普通浏览器不一定信任 Origin 证书，不能将其当作公网通用证书使用。

每次部署都会检查 PEM 格式、证书域名、有效期和私钥匹配，再运行 `nginx -t`；不匹配时保留正在运行的上一版。证书和私钥通过 SSH 传输到私有发布目录，只读挂载到 Nginx，不放进镜像或应用运行环境。

## 八项 GitHub Secrets

| 名称 | 内容 |
| --- | --- |
| SITE_URL | 精确 HTTPS origin，例如 `https://dayline.mindreview.me`，末尾不带 `/`，不带路径 |
| DEPLOY_HOST | 服务器公网 IP，或仅 DNS（灰云）的 SSH 域名；普通橙云不代理 SSH |
| DEPLOY_USER | 部署用户名，支持 root 或普通 Linux 用户 |
| DEPLOY_SSH_KEY | 部署专用 OpenSSH 私钥完整内容 |
| DEPLOY_KNOWN_HOSTS | 可信的完整 SSH known_hosts 记录 |
| APP_ENV | [生产配置模板](../infra/production.env.example) 的多行内容 |
| TLS_CERT | Cloudflare Origin 证书，完整 PEM，可包含证书链 |
| TLS_KEY | 对应未加密私钥，完整 PEM |

APP_ENV 必填字段为 `POSTGRES_CONTAINER`、`POSTGRES_PASSWORD`、`BETTER_AUTH_SECRET`、`ACTION_PROOF_SECRET`、`RESEND_API_KEY`、`MAIL_FROM`。数据库密码由运营者提供；两个应用密钥各使用独立的至少 32 字符随机值，首次生成后固定保存。可在可信本机使用 `openssl rand -hex 32` 分别生成，不在每次 workflow 运行时重新生成。

数据库名 / 应用账号默认都是 `dayline`，与现有管理员账号分开；新角色不授予 SUPERUSER、CREATEDB、CREATEROLE、REPLICATION 或 BYPASSRLS。密码包含 `#`、空格或引号时使用适当的 dotenv 引号；支持用反引号包裹不含反引号的单行值。禁止未知 APP_ENV 项、多行字段和直接覆盖 DATABASE_URL。管理员密码不进入应用运行环境。

默认入口 80 / 443，应用诊断端口仅宿主 `127.0.0.1:13000`；可选端口配置见模板，本机演练使用随机回环端口。生产保留 `NGINX_BIND_ADDRESS=0.0.0.0`，更改入口端口还需要同步 Cloudflare 源站路由。微信 AppID / AppSecret 必须成对填写，未配置时网页邮箱功能可用。

## Nginx 与网络

[Nginx 模板](../infra/nginx/default.conf.template) 在部署时生成本站配置：HTTP 跳转到配置的 HTTPS origin，HTTPS 转发至应用；导入请求上限 16 MiB、代理读取超时 75 秒。Nginx 使用 Docker DNS 解析应用容器，重建应用后可以重新解析新地址；API 的 no-store、安全响应头和公开发布 SHA 原样保留。

应用加入专用 proxy 和 database 网络，Nginx 只加入 proxy 网络，已有 PG 只增加 database 网络连接。API 仅信任专用 proxy 网段的转发头。Nginx 覆盖 X-Forwarded-For，并且仅信任 [Cloudflare 官方地址段](../infra/nginx/cloudflare-real-ip.conf) 提供的 CF-Connecting-IP；直接连源站伪造该 header 不会成为可信客户端地址。地址段来自公开 Cloudflare API，更新模板时应与官方清单核对。

入口不记录原始访问及代理错误日志，避免验证 / 重置链接中的 query 或路径凭据进入日志；诊断使用应用的安全结构化日志和私有 Nginx 校验日志。证书 / 私钥文件 0600、目录 0700，仅 Nginx 主进程读取，API 容器不挂载 TLS 文件。

## 发布入口与执行顺序

将 workflow 合入默认分支后，进入 Actions → Deploy Dayline → Run workflow，选择要发布的可信分支 / 标签。没有 push 自动生产发布，也不会从 PR 读取生产 Secrets。

1. 复用 Dayline checks，分别以 PostgreSQL 17 / 18 跑格式、lint、类型、单元 / 配置测试及真实数据库集成测试。
2. 在 GitHub 构建 Web + API 镜像、推送 GHCR；使用 SHA 标签并以不可变 digest 部署。Nginx 也固定镜像 digest。发布前用该应用镜像和独立 PG17 执行真实 Nginx TLS 容器演练。
3. production job 通过严格 SSH 校验传输私有临时包；密钥通过文件 / 标准输入传递，不拼入远程 shell。服务端仅临时使用本轮 GITHUB_TOKEN 拉取应用镜像，随后清除 registry 登录与 token 文件。
4. Actions concurrency 和服务端 flock 串行化部署。在 `~/dayline/releases/<SHA>.<随机后缀>` 生成配置与 TLS 文件；创建专用网络并为已有 PG 增加 `dayline-postgres` 别名，不改其原端口、已有网络或运行状态。证书、Nginx 配置和端口检查均在停止应用前完成。
5. psql 通过会话 advisory lock 检查专用角色 / 库。不存在才创建；已有角色必须非特权且可登录，已有库必须属于该角色。不修改已有角色密码、数据库 owner 或其他库。使用实际应用连接验证密码和网络，失败不进入停机步骤。
6. 停止上一版应用写入，用原 PG 容器的 pg_dump 备份目标库至 `~/dayline/backups/*.dump`。备份失败停止发布；只有迁移尚未开始时，才尝试重新启动上一版。
7. 新镜像运行 `prisma migrate deploy`，不执行 reset、drop 或 db push。启动应用和 Nginx，检查各自健康状态，再通过公共 HTTPS 域名验证 ready 的发布 SHA 和 `/day` 页面。通过后才切换 `current` 链接、写入 `deployed-revision`。

第一次无需手动建库。后续部署保留原数据，仅应用未执行迁移。更改 Secret 中密码不会自动修改既有角色密码；需要显式完成数据库密码轮换后同步 Secret。

PG 容器以后被其他 Compose 重建时，需要重新部署以补回专用网络连接；长期可在原 PG 的 Compose 中显式声明同一外部网络。运行仍依赖 PG 原有自动重启策略，workflow 不接管其生命周期。

## 失败、恢复和备份

迁移开始后发生失败，保留备份与私有日志，不自动降级数据库或自动启动不确定兼容的旧镜像；已启动的新应用和入口会停止，`current` / `deployed-revision` 保留上次成功记录。先检查迁移状态和失败原因，再修复重发；确认数据库兼容时才重新发布旧版。重发旧镜像不等于数据库回滚。

发布目录保存 `.runtime.env`、`.database.env`、`.deploy.env`、TLS、Nginx 配置、校验 / 迁移 / 备份日志及公共健康检查证据，目录 0700、文件 0600。日志不会自动展示在 Actions；传输临时目录结束时删除。网络中断遗留的 `~/.dayline-incoming.*` 可通过控制台清理，不要打包分享私有目录。

发布前备份不代替每日备份。上线前配置服务器每日任务、至少七天保留、受控异地副本并定期在新库恢复。工作流不上传私人数据到 Actions artifact，不自动删除历史发布、镜像或备份；保留策略由运营者配置。完整恢复闸门见 [自托管与恢复](self-hosting.md)。

## 本机验证

```bash
pnpm test:deployment
pnpm verify:containers
```

配置测试覆盖 TLS 域名 / 有效期 / 私钥匹配及入口端口。容器演练使用独立 PG17、随机回环端口和临时测试证书，验证实际 Nginx TLS 转发 / HTTP 跳转、首次初始化和八迁移、重复部署保留数据、错误证书 / 密码保留旧版、错误公共入口拒绝及显式重发恢复。只清理本轮容器与网络，保留新卷和 `.local/deployment` 私有报告；不操作原有数据库。

本机证据不等于真实 Cloudflare / 生产 SSH / GHCR 发布、真实邮件或微信验收。实际配置待运营者提供后再执行首次生产发布。

## 本次验证记录（2026-10-27）

- 10 项部署配置测试、格式、ESLint、ShellCheck、actionlint 通过；实际 Dockerfile 构建通过。应用业务代码与数据库迁移未改变。
- 使用独立 PG17、最终应用镜像和固定 digest 的 Nginx 1.30.6，通过实际 TLS 转发、HTTP 308、SPA / 资源 / API 与安全缓存头检查；首次初始化八条迁移、重复发布保留数据。
- 同一身份更换伪造 CF-Connecting-IP / X-Forwarded-For 仍触发真实来源的失败限制；错误 TLS 私钥和错误数据库密码在停机前拒绝，上一版仍可访问。
- 错误公共入口拒绝发布，显式重发恢复成功；四份非空 0600 备份，其他库标记保留。仅清理本轮应用 / Nginx / PG17 测试容器和网络，保留新卷及私有报告。
- 未修改 Cloudflare 账号配置，也未调用真实 Resend 或微信，未执行生产服务器部署；Cloudflare Origin 实际接入仍待运营者提供证书和配置后验收。
