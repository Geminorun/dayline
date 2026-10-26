# 阶段 6：受验证身份绑定、原子合并与来源草稿恢复

日期：2026-10-26。实现 Agent 未提交、推送或发布，未编辑主 Agent 独占的 implementation-plan.md。普通登录 / 切换、绑定和双账号合并始终分开；没有加入 Redis、离线队列或自动补传。

## 身份与证明

- `ActionProofService` 使用固定 JOSE 6.2.13，独立 typ / issuer / audience / HS256 密钥，五分钟有效，绑定真实 userId / sessionId / authEpoch / purpose / operationId / target。只显式签发这些字段，不把 password / code 混入 JWT。生产要求独立且替换过示例的 ACTION_PROOF_SECRET；开发 / 测试的缺省派生值不作为生产配置。全模块共用单实例 Clock，JWT 验证、会话业务检查、QR / 邮件 / context / preview 有效期可受控测试。
- `/auth/reauth` 通过 AuthAdapter 的 Better Auth 密码验证，或服务器交换 fresh 微信 code 并匹配当前账号。Web 微信账号有独立 `purpose=reauth` 小程序码：新 code、当前微信匹配、明确确认、原 SID / epoch / 浏览器 secret / 两分钟期限全部通过后，只签操作 proof，不新建用户、不登录另一账号。小程序每次显式取 fresh code。
- 错误密码、错微信或过期 / 跨用途 / 跨操作 / 跨目标 / 跨 SID proof 返回 403 REAUTH_REQUIRED；失效任务上下文返回 409 PREVIEW_STALE；当前真实会话失效才 401。匿名扫码确认若发起网页的会话失效，返回请求过时 409，不把扫码者有效会话当成失效。验证失败有账号 / IP 退避，错误不回显提供商原文或凭据。
- 微信添加邮箱：发信路径不查询或泄露地址是否已注册，匿名 link 仅标记邮件已验证。complete 需原账号、原操作 / epoch、精确邮箱及当前 SID fresh proof；退出后同身份新 SID 可在锁内重新绑定申请会话，旧 SID proof 不能复用，不必重发已验证邮件。未知邮箱委托 AuthAdapter 哈希 / 建 credential，保留 UUID 并撤旧会话；占用邮箱还需对方 fresh 当前密码，只产生受验证 merge_context。已有真实邮箱不覆盖。发信按账号及规范化邮箱至少 60 秒，邮箱 advisory lock 防并发绕过；失败保留申请并明确可重发，取消不复活原操作。
- 微信绑定有 Web 专用 bind QR 和小程序 `/me/wechat-binding` fresh code 路径。resolve / confirm 不为未知微信造空 B，确认及原浏览器消费重查发起 A / epoch / proof 期限 / scene / secret。未知身份只绑定 A；已有 A 幂等；已有 B 仅建立双方受证上下文。绑定不会发放 B 登录会话；取消 / 到期 / 重复消费不移动身份。

## 预览与原子提交

- merge_context 只能由服务器受证绑定流程建立：固定 A、B、A 的真实 SID、双方 epoch、原操作和五分钟期限。客户端 source / target / userId 不授权。核心支持一个真实邮箱和一个微信；两个邮箱 / 两个微信 / 非预期 provider 明确拒绝并保留双方。
- 默认 target 为发起当前账号 A。持久 account_merges 固定双方 dataVersion / epoch、15 分钟期限、context、planRevision / digest、双方概要及具体条目 / 重点、分类映射及显示名选择。不同 / 同标题事项全部保留；同名同色分类复用；同名异色给出对双方及本计划唯一、12 码点内的默认区分名，用户明确 review 改名 / 映射，超过 20 分类先解决。目标 / 来源双方事项、日期、回收站期限与 true / false 重点均可每页 50 核对。
- 五分钟授权过期不会替用户改写计划。在同 SID / 双方 / 操作 / epoch / 数据未变且十五分钟内，重新证明双方后替换原任务 contextId，保留已保存修订 / 摘要 / 分类选择。数据或资料名称已变、授权 epoch 已变时拒绝旧计划。取消零业务变化，不承诺撤销已完成合并。
- commit 按 UUID 固定顺序锁两个 users，再锁任务，重复验证会话 / context / 组合 / 数据版本 / 修订 / 摘要 / 期限。在同一 PG 事务创建 / 复用分类、移动事项及 false / trash 关联、迁移微信与 Better Auth credential 的 userId + accountId、释放 source 真实邮箱、处理 emailKind / verified、按选择显示名、保存恢复快照与最小映射、source merged shell、双方 epoch 和会话撤销、target dataVersion 及持久结果。提交成功后才返回确认；重试已完成任务返回持久结果，撤销的旧会话仍严格 401。
- 原邮箱账号尚未标准验证的占用场景：匿名 link 和 preview 不改变 B 用户。只有本次精确邮箱绑定邮件仍有效且 B 密码已验证，最终事务才由 AuthAdapter 使迁移后邮箱 verified=true；合并后真实邮箱和微信均实际登录到 target UUID。旧 source reset verification 在同事务撤销，source 无剩余 credential / 微信 / session，不提供壳登录入口。
- 恢复快照七天保留；最小 merge_record_mappings 与结果保留至统一账号清理。事务显式 maxWait 10 秒、timeout 60 秒，避免把正常用户锁等待误报成身份过期；没有在锁内等待微信 / 邮件。

## 历史任务及本机恢复

- 不搬运 import_jobs，保留双方原 `(user_id,client_operation_id)`，避免同操作 UUID 唯一冲突或对任意 target 开放来源私密计划。目标仅按服务器已完成来源壳关系读取所有 committed 最小 receipt，继续索引 sourceKey + digest 全历史；旧文件 / 游客来源不会因合并丢回执而重复新增。来源任务的私密 GET 对 target 仍 404。
- 两端设置从 Web `/identity`、mini `pages/account/identity` 操作；启动先确认当前身份 / 空间及恢复任务，密码 / proof / QR scanner proof 只留短期内存。任务用时间及中文状态显示，内部自动携带 UUID，不让用户手填任务标识。
- 身份写入暂停新快照和 /me，排空已有读取；Web focus / reprobe 与 mini onShow / restoreSession 均不能在提交撤销会话后抢先 401，误丢自己的成功结果。失败恢复普通读取，成功按持久结果清身份并要求重新登录。普通 GET 及网络恢复不产生业务写。
- 身份 / 空间 / 意图改变同步清全部私有 plan、邮箱申请、密码及 proof，旧成功 / 错误 / finally 受 actor / 空间 / 意图屏障。Web 切意图先取消旧 bind / reauth QR，迟到创建结果也取消；邮件结果页清 URL 及 Vue history current / back / forward 的 token，并与正常绑定表单隔离。
- Web `/drafts` 普通切换不读取 source 草稿。只有重新验证 target 的 recover_drafts proof，POST body 送后端取得已完成关系的 mapping，才读本机 source 仓库。每个 await 后核对 actor / 空间 / 选中 merge / 操作，旧成功和旧错误都不填回新选择。恢复只本机复制新分支，保留原稿；可靠 base 翻译 ID / 分类而保留原版本，缺少可靠 base / 分类需明确重审 / 另存，绝不自动 POST。之后由原编辑器读取最新事项和手动保存 / 处理冲突。

## 迁移与依赖

新增三条实际 UTC 迁移：20261026195554_identity_merge、20261026200453_identity_constraints、20261026202946_identity_relationships，均显式 BEGIN / COMMIT。前四条历史未修改，前两条阶段 6 已 deploy 后仍保持原文；后续 CHECK / FK 用新迁移追加。原 dayline_stage2_final_test 已升级；新建 dayline_stage6_empty_test 从空库真实 deploy 全七迁移成功。旧数据库与卷完整保留，无 reset / drop，忽略的 .env 未改变。

JOSE 复用锁内既有 6.2.13，新增直接依赖。固定 DCloud uni-mp-vite 的 independentMain.js 实际 require estree-walker 却漏声明，补精确版本 packageExtension → 2.0.2，避免 fresh install 由 hoist 偶然解析到 ESM 3。没有改 node_modules 补丁或统一双端 Vue / Vite；冻结锁 install 与真实 mp-weixin 已验证。

## 检查与证据

- 最终适用检查已实际通过：严格 source / tests 类型、lint、133 项单元组件（API 21 / core 8 / contracts 18 / api-client 21 / Web 48 / mini 17）、API / Web / mp-weixin 构建、七迁移 deploy、冻结锁 install、格式 / peer / diff，以及完整 76 组真实 PG HTTP（本阶段 18 组，最新五处 UI 修复后的最终完整 87.37 秒；本环境工程证据，不是生产 SLA）。最新 Swagger 的 login / reauth / bind oneOf、邮件新 SID 恢复及扫码竞争均包含在最终构建 / PG 中。
- 本阶段 PG 覆盖双向未占用绑定、双方受证前不泄漏、Web 微信重新验证、purpose / SID / epoch / operation / target / expiry、扫码者变化及失效发起方、取消 / 过期 / 重复、20 类与同名异色 / 同标题、false / trash、dataVersion 变旧、续证保留 review、数据库中途失败回滚、同任务竞争与双方向并发 merge 固定锁序、旧 session / reset verification、邮箱和微信迁移后真实 BA 登录及 import 回执继承。
- 本轮 review 同时修复五处同型预览一致性：双端合并、Web 文件导入、双端游客接入。共享纯选择签名只作本地 dirty 基准，不替代服务端摘要；分类 / 行 / 显示名变动立即禁提交旧计划，review 成功才更新基准，失败保留选择，review / commit 中锁定控件。游客接入同任务同修订查询保留选择。身份 / 草稿页使用稳定 primitive watch，正常同 UID /me 刷新保留操作，真实新 UID / 游客切换清私有内容。
- 组件 / 客户端覆盖五处选择变动后提交门槛、失败保留与 busy 锁定、同 UID 刷新保留与真实身份变化清除，以及错误重新验证不退出当前会话、purpose-only Web QR、完成私密 plan 在身份 / 游客变化后清除、邮件 URL / history 清理、已有 /me 排空与写中 focus / onShow 零新身份 GET、source 草稿映射后可靠基准及缺基准另存、选另一合并后旧本机读取成功 / 失败均不回填。
- Chromium：五处预览门槛与稳定 watcher 修复后，最终冻结源码 / dist 上的仓库外 stage6-smoke.mjs 整链 exit 0 / 0 pageerror，专用 fixture 清理和自启服务 cleanup 均完成。实测 purpose=reauth 新微信扫码、匿名第三设备邮件验证与 URL / history token 清理、邮件验证后原 A 退出再以同 UID 新 SID 登录并 fresh proof 继续原申请（不重发）、未占用邮箱保 UUID 和真实双登录。占用邮箱 B 的错密码不退出 A；preview 零业务写、同名异色分类明确 review、同标题保留两条、false / trash 状态保留；原子提交撤两旧 session，原邮箱和微信都真实登录 target。普通 target 登录不展示 source 草稿；fresh target proof + 后端 mappings 后仅本机复制、原稿保留、零业务自动写，最后手动保存到映射事项。截图 /tmp/dayline-browser-review/stage6-merge-preview.png。主 Agent 随后在最终冻结版独立串行复核同一完整链，亦 exit 0 / 0 pageerror，独立结果见 implementation-plan.md。
- 实际首次浏览器发现匿名邮件页启动 /me 401 抢先清验证结果：公用邮件回调改用隔离 ApiClient，仅其自身生命周期控制结果，不接受账号身份或进入私有空间；新增真实 App + RouterView 的启动 401 / 邮件验证并发回归。之后最终完整浏览器与上述全部检查通过。源码 / dist 自最后构建起保持冻结，未在浏览器期间修改或重建。

## 阶段 7 接口与限制

- 注销 / 撤销可复用 ActionProofService 对应 purpose，但本阶段未开放注销接口。维护时按统一用户锁，清目标及其 source shells；FK 提供归属与 cascade，仍应按最终目标关系明确清完整业务 / 认证 / 任务数据，不能清独立其他账号。
- 到期清理需同时清 email_binding_requests、merge_contexts、QR 的 actionContext / result / 扫描身份，及合并 recoverySnapshot 和 plan 的双方私人条目 / 重点副本；仅置 recoverySnapshot 空不等于清完私人快照。保留最小完成结果、映射及 import receipts 至统一账号清理。
- 无真实微信 / Resend 凭据或设备，没有发布。真实 code / 小程序码 / scene、外部邮件投递、微信开发者工具、iOS / Android 的前后台 / 网络 / 返回 / 低空间 / 安全区仍待人工验收；受控适配器、file 邮件、Chromium 和 mp-weixin 编译不替代这些证据。
