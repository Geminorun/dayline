# 运维诊断

通过 HTTPS Basic Auth 或专用只读 SSH 密钥读取 Dayline 诊断摘要，不公开原始日志或 Docker socket，不复用部署私钥。当前脚本针对默认应用容器 `dayline-app-1`，只读最近 15 分钟、最多 1000 行日志和运行配置摘要。

## HTTPS 入口（工作区无法连接 SSH 时使用）

复用已有 Nginx / HTTPS，公开路径固定为 `/internal/diagnostics`。Nginx 只读取 root 每分钟生成的脱敏文件，不执行命令，也不接触 Docker socket；无需更新应用镜像或开新端口。此入口不属于业务账号系统，账号固定为 `dayline-diag`。

### 服务器安装

1. 已有 Nginx、Docker、Python 3、systemd；安装密码工具：`sudo apt-get install -y apache2-utils`。
2. 将以下 `COMMIT_SHA` 替换成已审核的 40 位提交 SHA，分别执行。安装时输入两次独立的 24–72 位 ASCII 诊断密码，密码不回显、不会打印或写入脚本，仅保存 bcrypt hash；重复安装保留已有密码。

```bash
curl -fsSL https://raw.githubusercontent.com/Geminorun/dayline/COMMIT_SHA/scripts/diagnostics/setup-https.sh -o setup-dayline-https.sh
bash setup-dayline-https.sh COMMIT_SHA
```

3. 在 **Dayline 的 `listen 443 ssl` server 块**里加入下面一行（和 `location /` 同级），再测试并重载 Nginx。安装脚本只写独立 snippet，不编辑已有站点、TLS 证书或自动重载 Nginx。

```nginx
include /etc/nginx/snippets/dayline-diagnostics.conf;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
```

匿名访问应为 401；浏览器打开 `https://dayline.mindreview.me/internal/diagnostics`，使用 `dayline-diag` 和刚设置的密码可看到 NDJSON。HTTP 不提供摘要，写入方法被拒绝，响应禁止缓存；若自行配置了 Cloudflare 强制缓存规则，为这个路径设置 Bypass。

### 给工作区读取权限

在 **Codex / ChatGPT 云工作区环境配置**中新增 Secret `DAYLINE_DIAGNOSTICS_PASSWORD`，值为刚设置的密码，使它在当前执行环境生效；不是 GitHub Actions Secret，也不要在聊天或命令行参数里粘贴密码。域名变更时可额外配置非秘密的 `DAYLINE_DIAGNOSTICS_URL`，默认值如上。

```bash
python3 scripts/diagnostics/fetch.py
```

若云环境发布不可用，也可按用户授权将同名配置保存在仓库根目录的 `.env.diagnostics`（Git 忽略，权限 `0600`），包含 `DAYLINE_DIAGNOSTICS_PASSWORD` 和可选的 `DAYLINE_DIAGNOSTICS_URL`。从可信的本地文件加载后执行：

```bash
set -a
. ./.env.diagnostics
set +a
python3 scripts/diagnostics/fetch.py
```

该文件只随当前工作区保留，重建后需要重新提供；密码不要写进交接文档或提交到 Git。读取工具使用明确的 `DaylineDiagnostics/1.0` 标识，避免默认 Python 客户端标识被 Cloudflare Browser Integrity Check 误判；不冒充浏览器、不关闭 TLS 校验。

客户端保留环境的 HTTP 代理与证书校验，不跟随重定向转发凭据，并拒绝超过 3 分钟或采集失败的摘要。输出首行带 `generatedAt` 和 `collectionStatus`；采集失败会发布新的失败标记，不保留看起来仍成功的旧数据。读取现有摘要不会触发新的采集或发送邮件。

### 管理入口

- 查看定时器：`systemctl status dayline-diagnostics.timer`。
- 手动刷新：`sudo systemctl start dayline-diagnostics.service`。
- 修改密码：`sudo htpasswd -B /etc/dayline-diagnostics/htpasswd dayline-diag`，同时更新工作区 Secret。
- 撤销 HTTPS 入口：移除站点内的 include，测试并重载 Nginx；再执行 `sudo systemctl disable --now dayline-diagnostics.timer`。SSH 入口不受影响。

摘要和密码文件均由 root 管理、仅 `www-data` 组可读。适用于 Ubuntu 默认的 Nginx worker `www-data`；使用自定义 worker 用户时，先调整目录与文件的读取组，不要扩大为全局可读。

## 只读 SSH 入口

### 一次安装

在服务器取出本仓库源码，将诊断用 **Ed25519 公钥**保存为 `/tmp/dayline-log-reader.pub`，再执行：

```bash
sudo bash scripts/diagnostics/install.sh /tmp/dayline-log-reader.pub
```

安装脚本创建专用 `dayline-log-reader` 账号；公钥通过 `restrict` 和固定 forced command 绑定到只读采集器。账号不加入 docker / sudo 组，sudoers 只允许执行无参数的采集器。采集器及 authorized_keys 均由 root 管理。它不更改应用、Nginx、数据库、部署账号和其他 SSH 密钥；重复安装会替换这个专用账号的诊断公钥。

依赖 Ubuntu 常见的 bash、Python 3、OpenSSH、sudo 和 `/usr/bin/docker`。若 sshd 使用 AllowUsers / AllowGroups，运营者需允许这个专用账号；不要因此关闭既有 SSH 策略。

### 连接

客户端保存专用私钥，权限 0600；根据服务器控制台的 `/etc/ssh/ssh_host_ed25519_key.pub` 创建 known_hosts，不关闭主机密钥验证。自定义 SSH 端口时，known_hosts 使用 `[主机]:端口`。

```bash
ssh -T -F /dev/null -i /path/to/diagnostic-key \
  -o IdentitiesOnly=yes -o BatchMode=yes \
  -o StrictHostKeyChecking=yes -o UserKnownHostsFile=/path/to/known_hosts \
  -p 22 dayline-log-reader@SERVER
```

这个密钥不能执行任意命令、交互 shell、端口转发或写文件；提供任意远程命令也只会执行固定诊断摘要。当前执行环境也必须具备到目标 SSH 端口的网络访问；TCP 拒绝连接发生在密钥认证之前。

## 返回内容

- 容器运行状态、健康状态、发布 SHA。
- 邮件传输方式、发件地址格式是否正确、发件域名、Resend key 是否存在及不可逆指纹。不会输出 key 原文或全部环境变量。
- 应用日志只保留时间、级别、模块、requestId、固定错误码、状态码、耗时及邮件流程枚举等白名单字段。可保留最多 8 个应用代码栈位置；丢弃消息正文、请求体、邮箱、Cookie、token、SQL 和未知原始行。

排查邮件顺序：`AUTH_EMAIL_FLOW` 确认是创建、继续验证还是已有账号直接登录；`MAIL_ACCEPTED` 表示 Resend 已受理；`MAIL_DELIVERY_FAILED` / `EMAIL_FLOW_FAILED` 表示失败。`registered + login + not_sent` 是已验证账号引导登录，不应出现新的 Resend 发送记录。即使使用旧版本，采集器也不会把未知原始日志直接透传。

## 撤销与验证

删除 `/var/lib/dayline-log-reader/.ssh/authorized_keys` 即可撤销这个入口；部署密钥不受影响。

```bash
python3 -m unittest discover -s scripts/diagnostics -p 'test_*.py'
bash -n scripts/diagnostics/read.sh scripts/diagnostics/install.sh
```
