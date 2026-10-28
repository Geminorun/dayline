# 只读 SSH 诊断

通过专用 SSH 密钥读取 Dayline 诊断摘要，不公开日志 URL，不开放 Docker socket，不复用部署私钥。当前脚本针对默认应用容器 `dayline-app-1`，只读最近 15 分钟、最多 1000 行日志和运行配置摘要。

## 一次安装

在服务器取出本仓库源码，将诊断用 **Ed25519 公钥**保存为 `/tmp/dayline-log-reader.pub`，再执行：

```bash
sudo bash scripts/diagnostics/install.sh /tmp/dayline-log-reader.pub
```

安装脚本创建专用 `dayline-log-reader` 账号；公钥通过 `restrict` 和固定 forced command 绑定到只读采集器。账号不加入 docker / sudo 组，sudoers 只允许执行无参数的采集器。采集器及 authorized_keys 均由 root 管理。它不更改应用、Nginx、数据库、部署账号和其他 SSH 密钥；重复安装会替换这个专用账号的诊断公钥。

依赖 Ubuntu 常见的 bash、Python 3、OpenSSH、sudo 和 `/usr/bin/docker`。若 sshd 使用 AllowUsers / AllowGroups，运营者需允许这个专用账号；不要因此关闭既有 SSH 策略。

## 连接

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
