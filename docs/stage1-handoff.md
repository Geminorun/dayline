# 阶段 1：身份与双端客户端交接

日期：2026-10-26。实现完成，交由主 Agent 最终评审与提交；实现 Agent 未提交、推送或发布。阶段状态与提交哈希由主 Agent 维护 `implementation-plan.md`。

## 实现范围

- `apps/web`：Vue 3 + TypeScript + Vue Router + Vite 独立工程。邮箱注册、重发验证、验证回调、登录、找回、重置、改密码、退出、最小当前账号页；微信小程序码的创建、两秒轮询、明确领取、取消及失败状态。密码不持久化，敏感 query 进入短期内存后清理，Router history 元数据保留且 URL 字段清理秘密。
- `apps/miniapp`：uni-app Vue 3 + TypeScript，实际构建目标 `mp-weixin`。账号页、主动微信登录、原生请求 / 专用凭据存储、scene 解析和明确确认网页登录页，确认后消费前仍可取消。进入页面不自动创建云账号。没有共享平台 UI。
- `packages/api-client`：纯 Transport / 错误 / 响应解码 / 账号代次屏障。应用拥有 Cookie 或 uni Bearer 适配。类型化请求必须传实际 decoder，畸形 DTO 不接收新凭据；旧账号迟到响应被拒绝，匿名错误密码不撤销既有账号，不自动重试写入，304 不解析空 body。共享源代码无 DOM / Vue / wx / uni / Node 导入，生产 tsconfig 仅 ES2022 且 types=[]。
- 后端：微信 code 生产交换适配器、小程序码真实 API 适配器、统一 AuthAdapter、微信身份与 QR 请求迁移、输入 / 响应 schema 和对应 OpenAPI。未配置微信时清楚失败；没有模拟生产登录接口，没有客户端 OpenID 输入，没有 session_key 输出。
- 微信无邮箱用户使用 internal 标识、emailVerified=false。唯一身份锁与用户创建在同一 PG 事务；Better Auth 的签名 Cookie / Bearer 与邮箱共用认证表、Guard 和 epoch。无邮箱身份不开放会泄漏占位邮箱的原生 `/get-session` 输出，公开身份用 `/me`。
- QR 的浏览器 HttpOnly secret、scene、扫码者 proof 独立生成，仅哈希入库。resolve 不建号、不登录；confirm 锁定请求并在同一事务中找 / 建身份、转 confirmed；consume 先原子消费权利再发会话，失败不恢复。bind_wechat 阶段 1 明确拒绝且无建号副作用。

阶段 1 没有实现分类 / 默认分类初始化、事项、重点、快照、时间轴、业务缓存与草稿、导入导出、绑定合并或注销业务；这些由后续阶段承接。

## 实际检查结果

| 命令 / 检查 | 实际结果 |
| --- | --- |
| `pnpm db:generate` | 通过；Prisma 7.10.1 客户端生成 |
| `pnpm format:check` | 通过 |
| `pnpm lint` | 通过；包含双端 Vue / TS 与测试 |
| `pnpm typecheck` | 通过；API、共享生产代码、API 客户端测试、双端源代码与双端测试全部严格检查 |
| `pnpm build` | 通过；API、Web 和真实 mp-weixin 构建，非仅 H5 |
| `pnpm test` | 38 项通过：API 21、contracts 2、api-client 5、Web 5、miniapp 5；core 当前无测试文件，未计入数量 |
| `pnpm test:integration` | 20 组真实 PostgreSQL + HTTP 测试通过；测试注入微信适配器，无真实微信外调 |
| `pnpm peers check` | 无 peer dependency 问题 |
| `git diff --check` | 通过 |
| 共享包纯度 | 无平台 / Node 导入，types=[] 的 ES2022 独立构建通过 |
| 小程序产物 | app.json 包含 pages/account/index 与 pages/scan/confirm；后者与 WECHAT_MINIAPP_SCAN_PAGE 默认值一致 |

Web 主 JS 产物约 191.6 kB（gzip 约 64.6 kB）；小程序 common/vendor.js 约 251.5 kB。uni 构建对 zod 的第三方 PURE 注释给出移除提示，构建成功。它们不是实际设备性能验收数据。

主 Agent 另用系统 Chromium 与临时 Playwright 做了独立真实网页评审并报告通过：注册 → 本机文件邮件验证 → Cookie 登录 / 退出；找回邮件 → URL token 清理 → 重置密码 → 新密码登录；注入测试微信适配器下的 QR 轮询 → 明确领取 → 同体系 Cookie 会话。没有未处理的页面错误；评审账号与 QR 已清理，3000 / 5173 服务已关闭。这是本地浏览器证据，不代表微信供应商或真实邮件投递通过。

## 评审问题与修复

- R1：QR 确认先建号再更新可能产生孤立用户。现对 QR 行加锁，身份创建与 confirmed 同事务；覆盖处理中到期导致回滚、proof 被替换拒绝，以及 8 轮真实 confirm / cancel 并发竞争。取消获胜时不产生身份。
- R2：待注销账号需要重新登录以便未来撤销。微信会话允许 pending_deletion、拒绝 merged；真实 HTTP 测试验证 `/me` 可读且受限写操作仍被 Guard 拒绝。
- R3：邮箱设置 primitive 先 trim / 小写 / 严格 email schema 校验，禁止大小写或空白包裹的 `.invalid`。用户更新、凭据写入、epoch 与会话撤销同事务，重复凭据与邮箱竞争原子失败；测试证明失败方保持原内部身份和旧会话。
- R4：无效 / 已用 code 与配置 / 上游故障分为 401 和 502 / 503，外部错误脱敏；小程序码支持 PNG / JPEG 并拒绝 JSON 冒充图片，覆盖超时信号、网络、格式与缺配置测试。
- R5：未知响应泛型改为实际 decoder；`/me`、微信、QR 与邮箱关键成功响应运行 schema，解析成功后才接收凭据。匿名登录 401 与私人会话失效区分，补旧响应、304、错误与畸形 DTO 回归。
- R6：小程序 confirmed 后保留内存 proof 和取消入口；已消费后的取消显示请求已结束。账号 UUID 移出用户 UI，测试直接核对 ID。
- R7：移除敏感 query 时保留 Router position / scroll / replaced 元数据，同时清理 current / back / forward 内的 token / error。
- 附加边界：重复 QR ID 返回明确 409；领取会话创建失败后不可再次使用；生产不能注入测试微信适配器；原生 HTTP PATCH 转发只作用于精确 POST /api/v1 请求，保留原鉴权且不改写 /api/auth。

## 数据库与依赖说明

迁移为 `20261026152943_wechat_qr`，在初始认证迁移之后按实际时间命名。试验时旧专用 `dayline_test` 曾应用未来时间名的未提交迁移。Prisma 的 AI 安全保护拒绝 reset，未执行重置或绕过保护，也未手工改迁移历史。按主 Agent 确认的安全替代，保留原测试库（含试验历史，不再作为当前测试目标），新建空 `dayline_stage1_test`，仅修改本机被忽略 `.env` 的 TEST_DATABASE_URL。新空库重放初始认证和微信 QR 两条正确时间迁移成功；开发数据库和任何数据卷没有重置或删除。CI / 新用户的空 dayline_test 可继续使用 `.env.example`。

DCloud 5.33 固定要求 Vite 5.2.8 及 Vue 3.4.21；Web 使用独立 Vue 3.5.44 / Vite 8.3.5。test-utils 2.4.6 的包元数据未声明 Vue peer，Web 测试通过明确应用内 Vue 类型路径、ESM alias 和 Vitest inline / dedupe，使类型和运行时一致；没有通过 any、强行统一运行时版本或移除测试类型检查绕过。新增根 esbuild 0.28.1 满足 Vite 8 的 peer，peer 检查通过。新客户端依赖均固定具体兼容版本。

## 后续承接与待验证

- 真实微信 code、真实 getwxacodeunlimit 返回内容、scene 冷启动与扫描、微信开发者工具、iOS / Android 真机、应用合法域名与 AppID 尚待实际凭据和设备验证。空 AppID 能编译，不表示可真实登录或发布。
- 真实 Resend 调用、收件和投递率尚待真实配置。文件邮件和 SDK 模拟网络测试不替代投递证据。
- 后续阶段 2 的真实受保护业务 PATCH 必须用 uni 的 POST + `X-Dayline-Method-Override: PATCH` 路径追加权限 / 预期账号 HTTP 联验；本阶段已有请求转换、路由边界、原生认证不受影响测试。
- `AuthAdapter.setVerifiedEmailAndPassword` 仅为验证后的服务端 primitive；没有 HTTP 入口。本阶段证明 ID 稳定和库密码兼容，不提供完整邮箱证明、绑定 / 合并或账号接管流程。
- QR 在每次访问 / 状态转移中检查服务器有效期，不依赖清理任务保证安全；过期短期记录的后台物理清理交后续维护阶段。
- 业务完整加载、游客、草稿、跨标签协调和完整体验按后续阶段推进。此阶段最小账号 UI 不代表最终业务或移动端兼容性已验收。
