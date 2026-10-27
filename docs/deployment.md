# GitHub Actions 部署

默认复用服务器已有的本机 Nginx：Cloudflare 橙云 → 本机 Nginx / HTTPS → `127.0.0.1:13000` → Web + API 应用容器 → 已有 PostgreSQL 17 / 18。Web 与 API 共用一个镜像，数据库保持独立。

`NGINX_MODE=host` 为默认模式。Workflow 只更新应用，不安装、启动、停止或重载本机 Nginx，不写 `/etc/nginx`，不管理本机证书或其他站点。也不会启动 Nginx 容器或占用 80 / 443。空服务器仍可显式选择 `NGINX_MODE=container`，见后文。

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

APP_ENV 必填字段：`POSTGRES_CONTAINER`、`POSTGRES_PASSWORD`、`BETTER_AUTH_SECRET`、`ACTION_PROOF_SECRET`、`RESEND_API_KEY`、`MAIL_FROM`。使用 `NGINX_MODE=host`（省略时也默认 host）。TLS_CERT / TLS_KEY 在此模式不要求填写，已配置的旧 Secrets 不参与本机证书管理。

数据库密码由运营者提供；两个应用密钥分别用独立的至少 32 字符随机值，生成后固定保存。可在可信本机分别执行 `openssl rand -hex 32`，不在每次发布时重新生成。数据库 / 应用角色默认 `dayline`，与数据库管理员分开，新角色不授予超级用户等管理权限。密码含 `#`、空格或引号时使用适当 dotenv 引号；禁止未知项、多行值或直接覆盖 DATABASE_URL。管理员密码不进入应用环境。

## 可选：由 Compose 管理 Nginx 容器

只有显式设置 `NGINX_MODE=container`，才叠加 [compose.nginx.yaml](../compose.nginx.yaml)，启动 Nginx 并绑定入口端口。此时需要额外 GitHub Secrets `TLS_CERT`、`TLS_KEY`（完整 PEM），总计八项；默认要求 80 / 443 空闲。已有本机 Nginx 的服务器应使用 host 模式。

Cloudflare SSL/TLS → Origin Server → Create Certificate，可生成包含本站域名或相应通配符的 Origin 证书及未加密私钥，分别填入 TLS_CERT / TLS_KEY。保留真实换行，无需 Base64；证书到期前更新 Secrets 并重新发布。Origin 证书由 Cloudflare 信任，适合橙云；普通浏览器直接绕过 Cloudflare 访问源站可能不信任它。本模式不自动续期。

容器模式在停机前检查证书域名、有效期、私钥匹配、Nginx 配置及端口。TLS 只读挂载入口容器，不放进镜像或应用环境。Nginx 通过专用 proxy 网段连接应用，API 仅信任该网段；宿主模式则只信任 Docker 宿主网关及回环地址。Nginx / 应用版本、端口等其他选项见模板。

如果以前已经成功部署了受管 Nginx 容器，切换到 host 前需显式迁移入口并停用项目自己的 gateway；脚本发现仍运行的受管 gateway 会提前拒绝，不会自动停止它、删容器或接管本机 Nginx。由 host 切换为容器时，同样不会自动停止占用端口的本机服务。

## 发布过程

Workflow 合入默认分支后，Actions → Deploy Dayline → Run workflow，选择可信分支 / 标签。推送仅触发检查，不自动生产发布；PR 不读取生产 Secrets。

只排查构建或演练问题时，勾选 `verify_only`：仍构建镜像并验证两种入口，但跳过服务器部署，不读取生产 Secrets。演练失败会在 Actions 输出检查阶段及脱敏测试日志；这些日志只来自临时测试数据库和生成的测试凭据，不上传生产配置或备份。

1. PostgreSQL 17 / 18 分别执行格式、lint、类型、单元 / 配置和真实数据库接口测试。
2. GitHub 构建 Web + API 镜像、推送 GHCR，以不可变 digest 部署；分别演练本机入口和可选容器入口。
3. 严格 SSH 校验后传输私有临时包；GITHUB_TOKEN 只临时拉取镜像，随后清理 registry 登录和 token。
4. Actions concurrency / 服务端 flock 串行发布，在 `~/dayline/releases/<SHA>.<随机后缀>` 生成配置。host 模式只生成 Nginx 配置示例，不触碰实际 Nginx / TLS；container 模式才检查并生成入口文件。应用端口若被其他程序占用，提前报错。
5. 创建专用 Docker 数据库网络，为原 PG 增加 `dayline-postgres` 别名；角色 / 数据库不存在才创建，已有角色及库先核对归属和实际连接。不改已有密码、owner 或其他数据库。
6. 仅停止上一版应用写入，备份目标库，再执行 Prisma migrate deploy。备份失败且迁移未开始时，尝试恢复上一版应用；不重启外部 Nginx。禁止 reset、drop 或 db push。
7. 启动所选模式的应用服务，检查 readiness，再从公共 HTTPS 验证发布 SHA 和网页；通过后才更新 `current` 和 `deployed-revision`。

首次不必手动建库。更新只补未执行的迁移，密码轮换需先在数据库显式完成再同步 Secret。PG 被其原 Compose 重建后，需要重新补回专用网络连接；长期可在原 PG 配置声明同一外部网络，自动重启策略也由原服务管理。

## 失败与恢复

迁移开始后失败，保留数据库、备份、私有日志和上一版成功记录，不自动降级数据库或启动兼容性未知的旧版。已启动的新应用会停止；host 模式始终保留外部 Nginx 运行，container 模式才停止本轮受管入口。修正配置 / 迁移后重发；确认数据库兼容时才选择旧版。重发镜像不等于数据库回滚。

运行配置、备份文件 0600，私有目录 0700；不自动展示私人日志或上传 Actions artifact。入口应避免记录包含验证 / 重置凭据的原始 URL，示例关闭对应日志，诊断使用应用安全结构化记录。传输目录结束清理，断网遗留 `~/.dayline-incoming.*` 可由运营者通过控制台清理。

发布前备份不代替每日备份。上线前设置每日任务、至少七天保留、受控异地副本并定期在新库恢复。脚本不自动删除历史发布、镜像或备份，恢复闸门见 [自托管与恢复](self-hosting.md)。

## 本机验证

```bash
pnpm test:deployment
pnpm verify:containers
DAYLINE_TEST_NGINX_MODE=container pnpm verify:containers
```

默认演练使用独立本机 Nginx 进程，通过宿主回环端口连接实际应用，并确认部署和失败恢复不停止或改写该进程；可选模式验证受管入口。测试只创建本轮隔离 PG17、随机回环端口、临时证书及私有目录，不安装系统服务或改 `/etc/nginx`，保留新卷和 `.local/deployment` 报告。真实生产 SSH / GHCR、Cloudflare 及邮件 / 微信仍需实际配置后验收。

## 本次验证记录（2026-10-27）

- 12 项部署配置测试及格式、ESLint、ShellCheck、actionlint 通过；实际 Dockerfile 构建通过，应用业务代码与迁移未改变。
- host 模式在独立本机 Nginx 进程后完成 PG17 八迁移、实际 TLS / HTTP 308 / Web / API / 资源检查、重复更新、错误密码拦截、公共入口错版本拒绝及修复重发。未提供 TLS 文件，未创建 gateway 容器；Nginx 主进程 PID 与配置内容全程保持不变。
- 同一身份更换伪造 CF / XFF 头仍触发失败限制；使用不同真实回环来源地址的请求保持独立，验证了本机 Nginx → Docker 的访客 IP 信任配置。
- container 模式通过同样的完整部署 / 恢复演练，并验证 TLS 私钥错误时保留旧版；两种模式分别保留四份非空 0600 备份及其他库的标记。
- 两轮仅清理本轮测试进程、容器和网络，保留新旧数据库卷；未接触生产服务器、系统 Nginx 配置或真实 Cloudflare / 邮件 / 微信配置。
