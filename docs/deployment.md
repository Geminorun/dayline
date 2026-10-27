# GitHub Actions 部署

默认复用服务器已有的本机 Nginx：Cloudflare 橙云 → 本机 Nginx / HTTPS → `127.0.0.1:13000` → Web + API 应用容器 → 已有 PostgreSQL 17 / 18。Web 与 API 共用一个镜像，数据库保持独立。

只支持服务器本机 Nginx。Workflow 只更新应用，不安装、启动、停止或重载生产服务器的 Nginx，不写 `/etc/nginx`，不管理证书或其他站点，不占用 80 / 443。Nginx 容器、对应 Compose 文件、TLS Secrets 和相关演练已移除。

## 一次准备

服务器要求 Linux amd64、Docker Engine、Docker Compose >= 2.30.0，以及 bash、curl、tar、flock、ss。当前镜像构建为 linux/amd64；ARM 需先增加对应构建目标。raw env-file 保留密码中的 `$`、`#`、引号和空格，不执行配置里的 shell 语法。

1. 选定 `DEPLOY_USER`，给予 Docker 权限及可写 HOME，将部署专用 SSH 公钥加入其 `~/.ssh/authorized_keys`。SSH 默认 22；部署目录为该用户的 `~/dayline`，无需安装 Node / pnpm。
2. 在可信服务器控制台取得 `/etc/ssh/ssh_host_ed25519_key.pub`，组合为 `<DEPLOY_HOST> ssh-ed25519 <公钥内容>`，填入 `DEPLOY_KNOWN_HOSTS`。它是完整 known_hosts 记录，不是私钥。
3. 确认已有 PG17 / 18 容器运行，APP_ENV 填写准确的 `POSTGRES_CONTAINER`。现有数据库管理员默认 `postgres`，如不同则设置 `POSTGRES_ADMIN_USER`；本地 socket 需要密码时设置 `POSTGRES_ADMIN_PASSWORD`。管理员需建角色 / 建库权限，PG 还需允许专用 Docker 网段的应用连接。脚本不读取原容器密码，不重启、删卷或改原端口。
4. 在现有 Nginx 中为本站配置 HTTPS，并将本站所有路径转发到 `http://127.0.0.1:13000`。沿用已有证书；若证书不包含本站域名，先增加或重新签发。Cloudflare 保持橙云，SSL/TLS 使用 **Full (strict)**。
5. GitHub Settings → Environments 创建 `production`，填写下列六项 Secrets。确保仓库可以推送 GHCR Packages，包关联本仓库并允许 GITHUB_TOKEN 读取；无需长期 GHCR PAT 或 Cloudflare DNS API Token。

## 本机 Nginx：只需配置本站一次

若本机尚无覆盖本站的证书，可在 Cloudflare 的 SSL/TLS → Origin Server 创建此前选定的 Origin 证书，将证书 / 私钥保存到本机 Nginx 使用的私有目录，并在本站 server 块引用；不需要将它们填入 GitHub。保持橙云及 Full (strict)，证书到期前由本机现有流程更新。

已有 HTTPS `server` 块时，可以沿用证书和监听端口，将本站的 location 调整为：

```nginx
location / {
    access_log off;
    error_log /dev/null;
    proxy_pass http://127.0.0.1:13000;
    proxy_http_version 1.1;
    proxy_set_header Host $http_host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 16m;
    proxy_read_timeout 75s;
    proxy_send_timeout 75s;
    proxy_request_buffering off;
    proxy_buffering off;
}
```

确保 `/api/`、`/health/` 等更具体的 location 也转发到同一应用，避免只改首页而接口仍指向旧程序。完整新站点示例见 [host.conf.template](../infra/nginx/host.conf.template)，替换域名、证书路径及端口即可；不需要替换整份 nginx.conf 或修改其他站点。

如果已有可信 Cloudflare 访客 IP 配置，可以沿用；否则将 [官方 IP 清单](../infra/nginx/cloudflare-real-ip.conf) 保存为 `/etc/nginx/snippets/dayline-cloudflare-real-ip.conf`，在本站 HTTPS server 块 include 一次。这样仅 Cloudflare 官方网段提供的 CF-Connecting-IP 会被信任，Nginx 再覆盖转发头；直接连接源站伪造该 header 无法变成可信客户端 IP。

配置检查通过后，手动重载一次：

```bash
sudo nginx -t
sudo systemctl reload nginx
```

重载前确认检查成功。之后应用发布不需要再改动或重载 Nginx。修改 APP_PORT 时，才需同步其 upstream。首次应用尚未启动时，本站出现 502 属于预期；发布后的公共 HTTPS 检查会确认入口指向当前版本。

## 六项 GitHub Secrets

| 名称 | 内容 |
| --- | --- |
| SITE_URL | 精确 HTTPS origin，例如 `https://dayline.mindreview.me`，末尾不带 `/` 或路径 |
| DEPLOY_HOST | 服务器公网 IP 或仅 DNS（灰云）的 SSH 域名；普通橙云不代理 SSH |
| DEPLOY_USER | 有 Docker 权限的部署用户 |
| DEPLOY_SSH_KEY | 部署专用 OpenSSH 私钥完整内容 |
| DEPLOY_KNOWN_HOSTS | 可信的完整 SSH known_hosts 记录 |
| APP_ENV | [生产配置模板](../infra/production.env.example) 的多行内容 |

APP_ENV 必填字段：`POSTGRES_CONTAINER`、`POSTGRES_PASSWORD`、`BETTER_AUTH_SECRET`、`ACTION_PROOF_SECRET`、`RESEND_API_KEY`、`MAIL_FROM`。不再需要 NGINX_MODE 或 Nginx 端口参数；已有的 `NGINX_MODE=host` 兼容保留，不影响发布。TLS_CERT / TLS_KEY 不再读取或传输，GitHub 中的旧值可以删除；证书由本机 Nginx 管理。

数据库密码由运营者提供；两个应用密钥分别用独立的至少 32 字符随机值，生成后固定保存。可在可信本机分别执行 `openssl rand -hex 32`，不在每次发布时重新生成。数据库 / 应用角色默认 `dayline`，与数据库管理员分开，新角色不授予超级用户等管理权限。密码含 `#`、空格或引号时使用适当 dotenv 引号；禁止未知项、多行值或直接覆盖 DATABASE_URL。管理员密码不进入应用环境。

## 发布过程

保留两个 workflow，不增加 Secrets，也不自动发布生产环境：

| Workflow | 触发方式 | 工作 |
| --- | --- | --- |
| Dayline checks（backend.yml） | 推送 main、PR、手动运行 | main 并行执行代码 / PG17 / 18 检查与镜像构建 / 本机 Nginx 演练，保存镜像 digest；整次 CI 全部成功后才允许发布 |
| Deploy Dayline（deploy.yml） | 手动运行，选择 main | 查找同一提交成功 CI 的发布清单，复用镜像；SSH 备份、迁移、启动应用和验证公共 HTTPS |

PR 和其他分支的手动 CI 只运行检查，不推送镜像或产生可发布清单。main 的 CI、演练均不读取生产 Secrets，不访问生产服务器；原生 Nginx 仅安装在临时 CI runner 中。

日常发布只需：

1. 推送或合并到 main，等待 **Dayline checks** 成功；这一步自动完成测试、构建与演练。
2. Actions → **Deploy Dayline** → **Run workflow**，选择 main。发布不重新测试、构建或演练。
3. 查看发布任务结果；公共 readiness、版本 SHA 和网页都通过才记为成功。

需要先确认发布清单时，勾选 `verify_only`；只查询和校验已准备的清单，不连接服务器、不读取生产 Secrets。发布清单是普通 JSON，只含仓库、提交 SHA、镜像 digest 和 CI run / attempt，不含配置或凭据，保留 90 天。

只接受 main 上 **相同 SHA** 的成功 CI 产物，不按“最近一次成功”退回旧版本，不使用可变 latest tag。若 CI 仍在运行、失败、没有发布清单或清单过期，发布会提前停止，提示等待或手动运行 **Dayline checks** 一次；需要重新运行旧任务时，也应从 main 新开发布任务，旧任务仍引用其原提交的 workflow。

服务器执行过程保留这些步骤：

1. 严格 SSH 主机校验后传输私有临时包；临时 GITHUB_TOKEN 拉取固定 digest 后清理 registry 登录和 token。
2. Actions concurrency / 服务端 flock 串行发布，在 `~/dayline/releases/<SHA>.<随机后缀>` 生成配置。只生成本站 Nginx 配置示例，不应用到本机；应用端口占用时提前报错。
3. 创建专用数据库网络，为原 PG 增加 `dayline-postgres` 别名。专用角色 / 数据库不存在才创建；已有值先核对归属和实际连接，不改密码、owner 或其他数据库。
4. 仅停止上一版应用写入，备份目标库，再执行 Prisma migrate deploy。备份失败且迁移未开始时，尝试恢复上一版应用；不重启 Nginx。禁止 reset、drop 或 db push。
5. 启动应用、检查 readiness，再从公共 HTTPS 验证 SHA 和网页；通过后更新 `current` 和 `deployed-revision`。

检查与镜像准备并行，耗时不再简单累加；只有整次 CI 成功的清单才可复用，构建先结束不代表已获准发布。总体验证和镜像准备仍需时间，但每个 main 提交只做一次；后续发布复用结果。Docker 构建只编译共享包、API 和 Web，小程序由 CI 独立验证；文档、workflow 与部署脚本修改不再使应用编译层失效。实际发布耗时仍取决于镜像下载、数据库备份和迁移，不承诺固定两分钟。

首次不必手动建库。更新只补未执行的迁移，密码轮换需先在数据库显式完成再同步 Secret。PG 被其原 Compose 重建后，需要重新补回专用网络连接；长期可在原 PG 配置声明同一外部网络，自动重启策略也由原服务管理。

## 失败与恢复

迁移开始后失败，保留数据库、备份、私有日志和上一版成功记录，不自动降级数据库或启动兼容性未知的旧版。已启动的新应用会停止，本机 Nginx 始终保持运行。修正配置 / 迁移后重发；确认数据库兼容时才选择旧版。重发镜像不等于数据库回滚。

首次发布的公共检查失败时尚无 `current`，重试会核对遗留应用已停止、Compose 配置位于本部署目录的历史发布内、有迁移日志且数据库目标完全一致，再允许重新发布。运行中的无记录应用或不同数据库目标仍拒绝接管。公共检查前显示实际使用的 SITE_URL，便于区分同名 Secret 覆盖与源站入口错误。

运行配置、备份文件 0600，私有目录 0700；不自动展示私人日志或上传 Actions artifact。入口应避免记录包含验证 / 重置凭据的原始 URL，示例关闭对应日志，诊断使用应用安全结构化记录。传输目录结束清理，断网遗留 `~/.dayline-incoming.*` 可由运营者通过控制台清理。

应用日志带 UTC 时间、INFO / WARN / ERROR、模块名和 requestId；成功健康检查不记录请求日志，失败仍记录。排查邮件时查找 MAIL_ACCEPTED / MAIL_DELIVERY_FAILED；前者只代表传输受理，最终送达仍以 Resend 状态为准。LOG_LEVEL 默认 info，warn 隐藏成功业务请求，error 只保留错误。

代码修改必须提交并推送 main，等待 Dayline checks 成功后，新建一次 Deploy Dayline 才会更新服务器；重启旧容器或重跑旧版本任务不会带入新代码。可用 `docker exec dayline-app-1 printenv RELEASE_REVISION` 核对运行版本，用 `docker logs --follow --since 5m dayline-app-1` 查看最近日志；旧日志会保留，不能仅凭历史健康检查记录判断新版本是否生效。

发布前备份不代替每日备份。上线前设置每日任务、至少七天保留、受控异地副本并定期在新库恢复。脚本不自动删除历史发布、镜像或备份，恢复闸门见 [自托管与恢复](self-hosting.md)。

## 本机验证

```bash
pnpm test:deployment
pnpm verify:containers
```

演练需要本机已安装 Nginx；非标准路径可设置 `DAYLINE_TEST_HOST_NGINX=/path/to/nginx`。CI 在临时 runner 安装原生 Nginx，不使用 Nginx 镜像；生产服务器始终使用已有 Nginx。

演练通过独立原生 Nginx 进程转发实际应用，验证 PG17 八条迁移、Web / API / TLS、真实来源 IP 与伪造转发头、重复部署保留数据、错误密码提前拒绝、错误公共版本拒绝以及恢复重发。测试确认 Nginx 主进程及配置未被部署修改，其他数据库标记、四份 0600 备份和数据库卷保留。失败时在 Actions 显示阶段和脱敏测试日志，生产私人日志、配置和备份不上传。

本机构建与演练只创建随机命名的测试 PG / 应用容器、回环端口、测试证书及私有目录，不改 `/etc/nginx`。真实 SSH / GHCR、Cloudflare 和邮件 / 微信仍需提供实际配置后验收。
