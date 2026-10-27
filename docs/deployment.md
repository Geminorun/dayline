# GitHub Actions 部署

当前生产方案：一个 Docker 镜像包含编译后的 Web 和 Nest API，由同一个 Node 进程提供网页、SPA 深链接及接口；复用服务器已运行的 PostgreSQL 17 / 18 容器。不会创建第二个生产 PostgreSQL 容器、重启原数据库或删除其卷。小程序独立构建并上传微信，本 workflow 不负责小程序上传 / 审核 / 发布。

## 一次准备

服务器要求 Ubuntu / Linux amd64、Docker Engine、Docker Compose >= 2.30.0，以及 bash、curl、tar、flock。Compose 的 raw env-file 保留密码中的 `$`、`#`、引号和空格，不使用 shell 执行配置。运行镜像仅包含后端生产依赖、固定迁移 CLI 和网页产物，不包含前端编译器或测试依赖。当前镜像构建目标为 linux/amd64；ARM 服务器须先增加对应镜像构建目标。

1. 创建或选定 `DEPLOY_USER`，给予 Docker 使用权限、可写的 HOME，并将部署专用 SSH 公钥加入其 `~/.ssh/authorized_keys`。SSH 默认 22。部署路径固定为该用户的 `~/dayline`，不要求预先创建 `/opt` 目录或安装 Node / pnpm。
2. 在可信服务器控制台查看 `/etc/ssh/ssh_host_ed25519_key.pub`，组合成 `<DEPLOY_HOST> ssh-ed25519 <公钥内容>`，填入 `DEPLOY_KNOWN_HOSTS`。填写的是完整 known_hosts 行，包含与 DEPLOY_HOST 相同的主机名 / IP；不要把服务器私钥放进去。Actions 严格校验主机公钥，不自动接受扫描得到的未知公钥。
3. 确认现有 PG 容器正在运行。将准确容器名写入 APP_ENV 的 `POSTGRES_CONTAINER`。现有数据库管理员默认为 `postgres`；若原容器初始化用了其他 POSTGRES_USER，设置 `POSTGRES_ADMIN_USER`。脚本在容器内部通过本地 socket 调用 psql；如该 socket 要求密码，再加 `POSTGRES_ADMIN_PASSWORD`。管理员需要建角色和建库权限。不会从容器环境中读取或猜测原密码。PG 还需允许专用 Docker 内网的 TCP 连接；若自行限制了 listen_addresses / pg_hba.conf，应为目标数据库和应用账号配置对应网段访问。
4. 配好站点 HTTPS 入口，反代到 `http://127.0.0.1:13000`。可以沿用已有 Nginx / Caddy；镜像自身提供 HTTP，不申请证书、不占用 80 / 443。所有路径原样转发，入口覆盖转发的来源 / 协议头。设置合适的导入请求上限（例如 16 MiB）与大于 65 秒的读取超时。发布前入口已可用；首次 API 尚未启动时出现 502 属于预期。
5. 在 GitHub 仓库 Settings → Environments 创建 `production`，填写下表。确保 Actions 可以推送 Packages，GHCR 包关联本仓库，允许该仓库的 GITHUB_TOKEN 读取。首次发布会创建包，无须长期 PAT。

Nginx 站点示例（HTTPS 证书沿用自己的配置；这里只展示 location）：

```nginx
location / {
    # Verification/reset links may contain credentials in the query or path.
    access_log off;
    error_log /dev/null;
    proxy_pass http://127.0.0.1:13000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $remote_addr;
    proxy_set_header X-Real-IP $remote_addr;
    client_max_body_size 16m;
    proxy_read_timeout 75s;
}
```

示例关闭该入口的原始请求与代理错误日志，诊断使用应用的安全结构化日志。使用宿主 Caddy 时可参考 [配置模板](../infra/Caddyfile)，原样反代即可；它不是新增 Docker 服务。

## 六项 GitHub Secrets

| 名称 | 内容 |
| --- | --- |
| SITE_URL | 精确 HTTPS origin，例如 `https://dayline.example.com`，末尾不带 `/`，不带路径 |
| DEPLOY_HOST | SSH 主机名或 IP |
| DEPLOY_USER | 部署用户名，支持 root 或普通 Linux 用户 |
| DEPLOY_SSH_KEY | 部署专用 OpenSSH 私钥的完整多行内容 |
| DEPLOY_KNOWN_HOSTS | 可信的完整 SSH known_hosts 记录 |
| APP_ENV | [生产配置模板](../infra/production.env.example) 的多行内容 |

APP_ENV 必填字段：`POSTGRES_CONTAINER`、`POSTGRES_PASSWORD`、`BETTER_AUTH_SECRET`、`ACTION_PROOF_SECRET`、`RESEND_API_KEY`、`MAIL_FROM`。数据库密码由运营者提供；两个应用密钥各用独立的至少 32 字符随机值，首次生成后固定保存。可在可信本机使用 `openssl rand -hex 32` 分别生成，不在每次 workflow 运行时重新生成。

数据库名 / 应用账号默认都是 `dayline`，与现有管理员账号分开；新角色不授予 SUPERUSER、CREATEDB、CREATEROLE、REPLICATION 或 BYPASSRLS。密码包含 `#`、空格或引号时使用合适的 dotenv 引号；也支持用反引号包裹不含反引号的单行值。禁止多行字段、未知配置项和直接覆盖 DATABASE_URL。管理员密码不会写入应用运行环境。

可选字段见模板：改端口时也修改服务器反代；微信 AppID / AppSecret 必须成对填写，未配置时网页邮箱功能可用。不得将 APP_ENV、私钥、服务器生成的运行文件或备份提交 Git。

## 发布入口与执行顺序

将 workflow 提交到远程；GitHub 的 Run workflow 入口通常要求 workflow 已存在于默认分支。进入 Actions → Deploy Dayline → Run workflow，选择要发布的可信分支 / 标签。没有 push 自动生产部署，也不会从 PR 读取生产 Secrets。

1. 复用 Dayline checks，分别以 PostgreSQL 17 / 18 跑格式、lint、类型、单元 / 配置测试和真实数据库集成测试。
2. 在 GitHub 构建一个 Web + API 镜像，推送 GHCR；使用 SHA 标签并以不可变 digest 部署。用该镜像和独立 PG17 再执行容器发布演练，通过后才进入生产 job。
3. production job 通过严格 SSH 校验传输私有临时包；密钥作为文件 / 标准输入传递，不拼进远程 shell 代码。服务端仅临时使用本轮 GITHUB_TOKEN 拉取镜像，随后清除 registry 登录和 token 文件；无需额外 GHCR_READ_TOKEN。
4. 服务端 flock 与 Actions concurrency 串行化部署。在 `~/dayline/releases/<SHA>.<随机后缀>` 生成 0600 配置。创建专用 Docker 网络，将原 PG 容器额外接入并赋予 `dayline-postgres` 别名；应用只监听宿主回环地址。不会改原 PG 端口或断开其已有网络。
5. 容器内 psql 使用会话 advisory lock 检查角色 / 库。不存在才创建；已有角色必须非特权且可登录，已有库必须属于该角色。不修改已有角色密码、数据库 owner 或其他库。应用使用实际连接验证密码和网络，失败时不进入停机步骤。
6. 停止上一版应用写入，使用原 PG 容器的 pg_dump 备份目标库到 `~/dayline/backups/*.dump`。备份失败停止发布；只有迁移尚未开始时，才尝试重新启动上一版。
7. 使用新镜像运行 `prisma migrate deploy`，不执行 reset、drop 或 db push。启动应用，等待 `/health/ready`，再从公共 HTTPS 入口检查 ready 的发布 SHA 和 `/day` 页面。全部通过才切换 `current` 链接、写入 `deployed-revision`。

第一次无需手动建库。新建数据库先备份其初始空状态，再应用所有迁移；后续部署保留原数据，只补未执行迁移。修改 APP_ENV 中密码不会自动给既有角色改密码；需要显式轮换数据库密码后再同步 Secret。

如果 PG 容器以后被其他 Compose 重建，需要重新部署以补回专用网络连接；更长期可以在该 PG 的原 Compose 中显式声明同一外部网络。运行服务也依赖 PG 容器原有的自动重启策略。部署 workflow 不接管其他服务的生命周期。

## 失败、恢复和备份

迁移开始之后，失败会保留备份与本轮私有日志，不自动降级数据库，不保证旧镜像兼容迁移后的结构。新应用若已启动则停止；`current` 和 `deployed-revision` 仍保留上次成功记录。先检查失败原因和迁移状态，按需修复迁移再重发；只有确认数据库兼容时，才选择旧版本重新发布。不能把“重发旧镜像”等同于“数据库回滚”。

服务端发布目录保留 `.runtime.env`、`.database.env`、`.deploy.env`、迁移 / 初始化 / 备份日志以及公共健康检查证据；目录 0700、文件 0600。日志不通过 Actions 自动展示。传输临时目录在结束时删除；网络中断导致的遗留 `~/.dayline-incoming.*` 可通过控制台清理。不要把这些目录打包分享。

发布前备份不代替每日备份。上线前配置服务器每日任务、至少七天保留和受控异地副本，并定期在新库实际恢复。工作流不上传私人数据到 Actions artifact，不删除历史发布 / 镜像 / 备份，保留策略由运营者设置。完整恢复闸门见 [自托管与恢复](self-hosting.md)。

## 本机验证

```bash
pnpm test:deployment
pnpm verify:containers
```

容器演练只创建本轮独立 PG17 容器、卷、数据库和应用项目；验证首次建库、八条迁移、网页 / API、重复部署保留数据、错误密码保留旧版、公共入口错版本拒绝、显式重发恢复、其他库不受影响及 0600 备份。清理本轮容器 / 网络，保留新卷和私有报告于 `.local/deployment`；不操作原有数据库。

本机容器验证不等于已在你的服务器完成 SSH、GHCR、公共证书、真实邮件或真实微信验收。首次生产发布前仍需提供上述配置和完成入口准备。

## 本次验证记录（2026-10-27）

- 严格源 / 测试类型、格式、ESLint、ShellCheck、actionlint 均通过；149 项单元 / 组件测试与 6 项部署配置测试通过。
- 独立 PostgreSQL 17 上八条迁移及 88 项真实数据库 HTTP 集成测试通过。
- 实际多阶段 Dockerfile 构建通过，最终镜像约 650 MiB；后端生产依赖与既定 lockfile 对比，没有新增外部包版本，仅有工作区包的部署副本。
- 以最终运行镜像通过独立 PG17 发布演练：首次初始化、重复部署保留数据、密码错误保持上一版运行、公共入口错版本拒绝及显式重发恢复；四份非空 0600 备份，其他库和已有数据库卷保留。
- 宿主 Caddy 示例配置校验通过。未配置真实生产 Secrets，未执行真实服务器 SSH / GHCR 发布、真实 Resend 或微信调用。
