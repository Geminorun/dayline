# 阶段 7：注销、维护与最终运行交接

> 本文保留阶段 7 当时的验证记录。当前生产部署已采用 Nginx + Cloudflare Origin 证书，最新步骤见 [部署指南](deployment.md)。

日期：2026-10-26。只实现第七阶段，未 commit / push / 发布，未修改主 Agent 独占的 implementation-plan.md；该文件中的主 Agent 更新不属于本实现 Agent 的编辑。两个前端继续独立 Vue / Vite 版本，一个 Nest 单体、PostgreSQL；未引入 Redis、离线队列、自动补传或额外后台服务。

## 账号注销与双端交互

新增 `POST /me/deletion` / `DELETE /me/deletion` 的严格共享输入 / 结果 DTO 与 OpenAPI。fresh action proof 精确绑定 purpose、operationId、真实 UUID、SID 和 epoch；事务先用户锁，再检查当前会话、状态、服务器最终时间及证明。申请连续 7×24 小时，重复申请不延长；真正申请 / 撤销增加 epoch 并撤销全部旧会话，成功在 commit 后返回。取消严格 `now < dueAt`；等待锁时跨到期也拒绝。到期即拒绝旧会话 / 新受限会话 / 撤销，不等下一次分钟扫描；清理后相同邮箱 / 微信只能建立新 UUID。

pending 登录仍保留申请，不自动撤销。可读取 /me、重新验证、明确撤销、导出与退出；普通 snapshot / category / entry / trash GET 和普通写、导入、绑定、合并均拒绝，导出仅在服务内部读取一致快照。两端冷启动和重登录不读 / 挂私人缓存、不发普通快照请求或轮询，直接进入状态页；Web 数据页导出不依赖完整快照。微信独有 Web 用户可使用 purpose=reauth 的专用 QR 取得 cancel_deletion 证明，pending 不被 active-only 判断挡住；其他重新验证用途继续受限。

Web `/account-deletion` 与小程序 `pages/account/deletion` 有清理范围、服务器到期北京时间、确认、密码 / fresh 微信验证、申请 / 撤销、重新登录、结果不明后查询入口。冻结本次 proof / operation / owner 后排空既有读取，actor + space + intent 变化阻止迟到成功 / 错误 / finally 写回；同 UID 普通资料刷新保留本次操作。注销页及 pending 数据页可直接导出服务器正式记录，先提示本机草稿，下载不依赖完整缓存 / snapshot 就绪；原草稿不混入导出，不挂到新 UUID。

## 维护与最终归属

维护在同一应用内启动并逐批 drain 所有到期目标后才 ready；第八迁移新字段缺失会在启动闸门失败。分钟处理注销 / trash，小时处理 QR / 邮箱绑定 / import input-plan / merge context，日处理七天 merge 恢复副本及过期认证。每批 100，周期有积压时下分钟继续，不为每条记录建 timer。多次 tick 合并，独立实例通过固定用户锁序和状态复核幂等，异常由受控重试处理。

trash 清理与 dataVersion 原子提交，真正变化才递增。导入过期同时删除 input、rows 和分类私人副本，保留 committed 最小摘要 / result / source mappings。合并同时清 recoverySnapshot 和 plan 的双方 entries / targetEntries / focus / 类别 / 姓名 / 邮箱，包含 recoverySnapshot 已先为空的历史状态；最小结果和映射继续可用。

注销以最终 target 和递归来源壳为完整归属，按 UUID 固定锁序；业务、凭据、会话、微信、绑定、QR 的敏感身份、import 回执与私密输入、merge 历史 / 映射在可回滚事务中清理。其他独立用户业务不受影响。维护日志只含固定任务类型、内部目标 ID、最近成功、失败数和积压数，不含记录 / SQL / 证明；失败保留数据库定位状态并可重试。

正式新迁移 `20261026211018_account_deletion` 增加 requestedAt，并检查非空窗口为 pending 且精确七天。原七条迁移未修改。当前专用 `_test` 正常升级八条；维护时钟专项每轮另外新建 `dayline_maintenance_*_test` 并从空库 deploy 全八条，以免受控时间清理影响其他测试 / 浏览器 fixture。保留全部旧库、新库和卷，未 reset / drop / truncate，也未改忽略 `.env` 的 TEST_DATABASE_URL。

## 安全、限制与恢复语义

- 原始 JSON / 批量入口大小保持精确路由限制；普通 64 KiB、重点确认 / trash / raw 文件 / review 的原有边界全部保留。单进程计数与失败桶固定容量，有到期回收；满失败桶不会永久锁住，最早到期前不逐次全表扫描，避免 O(n²) 失败处理。密码 / reauth 成功不消耗五次失败额度，同时保留 IP 总量 / 分层请求上限。
- 所有 429，包括 Better Auth native TOO_MANY_REQUESTS，客户端统一安全文案，解析 0–86400 秒数值 Retry-After；邮箱重发 / 找回等按服务器秒数等待并禁重复发送，卸载 / 身份变化清 timer，不能固定猜一个等待时间。
- 配置外部 8 秒、普通 15 秒、批量 60 秒预算；业务事务有 Prisma / PostgreSQL 超时和 commit 前预算复核。PG 池显式 10 连接 / 有界连接等待。HTTP 不提前回复超时后继续未知事务。Web 20 / 65 秒 AbortController 覆盖 fetch 和 body 读取，小程序同预算；客户端失去回执仍按既有当前记录 / 原任务查询确认，零自动重发写入。下载网络异常与纯 UTF-8 解码失败分开。
- TRUST_PROXY 只接受显式代理地址 / CIDR，默认忽略伪造转发 IP。Nest / HTTP 按 LOG_LEVEL 输出，日志只含 requestId / 路由模板 / 状态 / 耗时；邮件失败有固定用途和 MAIL_DELIVERY_FAILED 事件，仍保持找回通用响应。邮件文案不把供应商接受或通用 200 宣称成实际送达。
- Better Auth 标准验证 JWT 另存 token hash→原 UUID 绑定；最终 adapter UPDATE 同时约束原 UUID / email / active。即使前置检查后释放邮箱并新建同邮箱账号，旧链接也不能验证新 UUID，返回受控 TOKEN_INVALID；真正数据库失败不冒充过期。旧的无 UUID 绑定验证链接需要重发。

## UI / 兼容性收尾

分类原生 UTF-16 上限放到至少 24 单元，标题 / 昵称覆盖 100 / 40 码点的合法 emoji；最终校验仍按共享码点规则，超一个明确拒绝。原有 api.onIdentityChange 的页面 unsubscribe 已核对卸载，未增加常驻页面监听。游客冻结任务使用对应中文状态及下一步，绑定结果后刷新 owned 申请避免“双方已验证 / 等待验证”矛盾，任务按时间 / 中文状态识别。操作时刻统一共享北京时间格式并标注时区；API / JSON 仍 UTC，日历算法未改。

完整快照保持 RepeatableRead、先鉴权 / 就绪后 304、完整 categories / active / trash / true-false focus 图和 bigint 字符串。容量实测发现 ORM 逐字段 Date / 无用 updatedAt 物化成本，改用 PostgreSQL 公共 DTO JSON 聚合（参数化 userId、UTC 操作时刻、YYYY-MM-DD 日期），未截断、未新增缓存伪完整状态；原权限 / 日期 / 并发全套 PG 保留。

## 检查与运行证据

最终 R10 源码已实际通过格式 / lint、严格 source / tests 类型、146 项单元组件（API 23、core 8、contracts 18、api-client 22、Web 56、mini 19），全部八迁移、API / Web / mp-weixin 构建、完整 88 组真实 PG（86.66 秒）、peer 依赖与 diff 检查，整链 exit 0。真实供应商 / 真机和主 Agent 独立复验仍按各自边界记录。

新 PG 覆盖 proof purpose / operation / expected user、exact 7 天、全部旧 session、重复不延时、普通登录 pending、业务拒写 / 允许导出、pending 微信 QR、到期与锁等待边界、205 trash / 205 user 有界启动 drain、独立 scanner 并发、失败回滚 / 重试、递归 source 壳 / QR / verification 清理与独立用户、超时 rollback、最终 BA 邮箱 UUID 竞争、成功不耗失败额度 / 伪 XFF / Retry-After、import 与 merge 双私密副本清理而最小 receipt / mapping 保留。UI 新回归覆盖同 UID 刷新、排空读取期间切游客、旧响应跨账号、mini fresh code 迟到、12 emoji 分类与超一个拒绝、native 429 等待和 fetch / 下载 body 超时。

最后一轮 PG 包含 pending 四类普通 GET 明确 403、服务内导出仍可用；新增双端冷启动测试验证不读取私人缓存 / snapshot，Web 从普通路由进入状态页且实际导出可用，小程序保留明确扫码重新验证路由。uni 构建保留第三方 zod PURE 注释提示，未以排除源 / 测试或统一双端版本绕过。

## 运维演练与容量限制

`Dockerfile`、production Compose、Caddy 与三条 verify 脚本可复跑，命令见 self-hosting.md。容器镜像保留迁移 CLI / 工作区依赖，不伪称最小镜像；COPY 明确 node 归属，支持原文件 0600。容器入口合并大小写 NO_PROXY 的原并集，仅追加内部 api / db / loopback，保留所有代理和只读 CA。Caddy URI 整体脱敏且删除 headers；静态 no-cache 不覆盖 API private / no-store。

实际前两次独立容器演练发现并修复：USER node 读取 root-owned 0600 package.json 的 EACCES；云默认 HTTP_PROXY 把内部 api:3000 送出后返回 Loopback targets forbidden。修复后实际 Caddy→API 200；随后完整独立项目验证通过，见下方记录。

真实 pg_dump 已在私目录 0600 保存并恢复新隔离 `_test`，八迁移 deploy、撤旧 session / verification 和 epoch 更新后，先 startup 维护再核对六分类、活动 / trash、true-false focus、邮箱 credential / 微信、source 壳、import receipt、merge mapping 和过期私密副本 / 到期账号。最终独立重跑通过，报告与恢复库见下方；旧库与所有卷保留，仅清本次 fixture。最早一轮与容量短暂重叠，恢复库中的本次容量 fixture 后来按自己的 appId 清理，数据库本身保留。

容量脚本为 20 个独立用户，每个 1000 事项 / 10000 重点状态，100 完整读 + 100 CAS 保存；回环 HTTP / 本会话 5 CPU、17.59 GiB，不等于目标 2C4G 生产 SLA。首轮 P95 读取 2913 ms / 保存 1624 ms（与备份短暂重叠）；仅重点聚合后 1639 / 816 ms，约 1.29 MB 原文 / 80 KB gzip。中间与受控时钟维护专项相交导致 401 的容量轮作废，已改隔离专项数据库。最终独立采样见下方；不通过删数据 / 缩功能达标，一秒读取目标仍未达到。

## 最终结果补记

- 21:56:18 UTC，本机独立 Compose project `dayline-stage7-00e6f428` 从镜像安装 / 构建、八迁移、readiness、SPA 深链 / 静态资源、Caddy API 代理、no-store / Referrer-Policy / 查询脱敏到仅重建自身 PostgreSQL 容器全部通过。同卷标记仍在，测试容器已 down；其三个新卷保留，原 `dayline-db-1` 与全部旧卷未动。报告 `.local/stage7/container-check.json`。这是本机 file 邮件测试，无实际发布 / 外部投递。
- 21:57:00 UTC，容器清理后独立容量测试 20 个账号 × 每个 1000 / 10000，100 读 / 100 保存：读取 P50 833.32 ms、P95 **1697.41 ms**；保存 P95 **847.24 ms**。读取未达到 requirements 的一秒目标。完整快照 1,288,342 字节 / gzip 81,006 字节；解析 5.08 ms、契约 37.76 ms、筛选 / 轴初算 33.64 ms；初始有界 21 行 / 9 刻度，1000 重点聚合，进程实测峰值 RSS 873 MiB。环境 Node 24.19.0、5 可见 CPU / 17.59 GiB、回环未压缩 HTTP，运行器与 API 同进程；不等同 2C4G 生产 SLA。报告 `.local/stage7/capacity.json`，历史保留于 `capacity-runs.jsonl`。
- 21:57:07 UTC，真实 pg_dump / pg_restore 串行成功。私有 0600 dump 46,945 字节：`.local/stage7/backups/20261026215702-90898954-9189-449d-af4a-ea8ff9d0ba1e.dump`；新库 `dayline_restore_20261026215702_90898954_test`。八迁移、撤恢复 session / verification、epoch 更新、到期清理启动闸门，以及六分类 / 两事项 / true-false / trash / 邮箱 / 微信 / source 壳 / receipt / mapping / 私密到期清理均核对通过。原库、新库与全部卷保留。报告 `.local/stage7/backup-restore.json`。
- 最终 R10 完整检查结束后冻结 source / dist（哈希见 `.local/stage7/freeze-source.sha256` / `freeze-dist.sha256`）。首次第七阶段浏览器发现 pending 普通快照 200 的真实缺口；保持原 403 断言，修正服务策略与双端冷启动后重跑。最新版 `stage7-smoke.mjs` exit 0 / 0 pageerror：实际 40 / 12 / 100 emoji 输入与 101 标题拒写、双旧 session 撤销、exact 七天、普通登录保留 pending、普通 snapshot 403 / 拒写、正式数据导出不带原草稿、密码撤销原稿保留、微信独有 Web fresh QR 申请 / pending QR 撤销、strict 到期拒会话、清理幂等、同微信新 UUID 空空间、独立账号保留。
- 同一次冻结后最新版 `stage7-capacity-smoke.mjs` exit 0 / 0 pageerror：真实 IndexedDB 1000 事项 / 10000 重点、0001–9999 极长轴、19 初始可见行 / 302 DOM 节点、真实深滚动、完整统计 / 聚合重点日期、768 基本访问及 1280 / 1440 / 1920 三桌面宽度、键盘输入筛选与 Tab / Shift+Tab 往返均通过，游客云端私人写入为 0。本次脚本报告初始化用时 1252 ms，不能替代公网 SLA。两条自测已按 finally 清自身 fixture / 浏览器 / API / Vite，端口交还主 Agent。主 Agent 的 stage5 / stage6 / stage7 / capacity 四条独立复验、阶段状态、commit / push 由主 Agent 处理。

主 Agent 最终独立复验：在上述冻结源 / dist 上串行执行 stage5-smoke、stage6-smoke、stage7-smoke、stage7-capacity-smoke，四链完整 exit 0 / 0 pageerror。分别覆盖游客与云端文件往返 / 幂等、受验证绑定合并和来源草稿显式恢复后手动保存、注销与所有 Unicode / pending / 微信重新验证 / 到期重建边界，以及 19 行 / 302 DOM / 1255 ms 的完整容量页面、768–1920 布局与键盘。游客私人写为 0，各自 finally 清理结束。第 7 阶段 review 已通过；读取 P95 未达一秒和外部待验仍按上文保留，提交及推送见主 Agent 交付说明与 Git 历史。

## 人工与外部待验

全部 34 AC 逐项真实实现 / 测试链接见 final-acceptance.md，统一手测步骤见 final-manual-testing.md。未部署 / 发布。真实微信 code / 小程序码 / scene、Resend 收件与投递率、开发者工具、iOS / Android 前后台 / 网络 / 返回 / 安全区 / 低空间 / 存储耐久、WebKit / Safari、表格软件、完整无障碍审计和目标服务器压测仍 pending。不能把注入适配器、file 邮件、Chromium 或 mp-weixin 编译写成这些外部证据。

旧备份无法推知备份之后的注销 / 撤销事实；运维恢复必须在服务关闭时核对最新可信记录 / 状态并处理已关闭 UUID，撤销恢复会话和跑完维护后再开放。没有以一个启动扫描承诺任意旧备份能自动重建之后的事实；运行指南明确这个闸门。
