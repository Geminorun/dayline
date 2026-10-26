# 阶段 2：记录核心与网页最小闭环交接

日期：2026-10-26。实现 Agent 未提交、推送或发布，也未推进其他阶段；最终评审、阶段状态和提交由主 Agent 维护 `implementation-plan.md`。

## 已实现范围

- 正式迁移 `20261026162718_record_core`（显式 BEGIN / COMMIT）：用户 `data_version` bigint / `initialized_at`，分类、事项、每日重点及归属复合外键、日期 / 删除 / 版本检查和读取 / 清理索引。没有修改已应用的历史迁移。
- 六默认分类与用户初始化标记是跨邮箱 / 微信创建路径的数据库不变量：users AFTER INSERT 触发器在原用户创建事务内完成，失败一起回滚。避免 Better Auth adapter 事务内从根 Prisma hook 查询未提交用户；没有嵌套根客户端初始化。已有账号由迁移一次性初始化；登录和 GET 不按分类数量补齐、不改名、不补回用户主动删除的默认分类。业务接口统一拒绝初始化标记异常的账号，保留 `/me` 等认证恢复通道。
- 第 9.1 节全部分类 / 事项 / 重点 / 回收站路由，第 10 节完整快照。业务写先锁可信 Actor 所属 users 行，再验证状态、epoch、归属和基准；内容和 dataVersion 同事务，成功响应在提交之后返回。新增稳定 UUID 重试不覆盖，所有者不符的读取 / 修改返回统一 404。
- 每日重点保留 false 状态，使用独立单日版本，改变事项 focusVersion 而不改变内容 version。缩短范围先返回准确日期 / 版本列表；确认列表变化时重新拒绝，修改范围和取消重点同事务。
- 回收站删除使用服务器时间 30 × 24 小时；到期即拒绝恢复。恢复保留重点；单项 / 多项清理整体成功或整体失败；清空需要 expectedDataVersion，期间新删除或其他业务变更会使确认失效。
- 完整快照在 PostgreSQL RepeatableRead 事务中读取所有类别、活动事项、未物理清理回收站和 true / false 重点，无分页截断。ETag 隔离用户、schema、bigint 版本和北京时间业务日期，先鉴权 / 就绪检查后 304。私人 Cache-Control 与合并后的 Vary 保留 Origin、Cookie、Authorization。
- `packages/core`：纯 Gregorian 日期、北京时间今天、区间、包含首尾跨度、状态、统计和默认分类常量。`contracts`：严格输入、DTO、确认与错误详情 schema。`api-client`：实际 decoder、验证后的 ApiMeta（含十进制 dataVersion / serverTime）及结构化版本 / 重点冲突信息；保留账号代次屏障，未引入 DOM / uni / Node 服务依赖。
- 网页 `/review`：独立 records 服务与编辑器 / 行 / 分类组件，真实登录后新建、改、今天结束、每日重点、删除确认、恢复、单项永久清理 / 清空、每日回看、分类新建改名改色与转移删除。保存等待服务器确认，失败保留编辑输入和稳定 ID；成功但刷新失败单独提示，不谎称保存失败或空数据。

网页和小程序仍是独立工程与各自 Vue 版本，严格 source / test 检查、Vitest alias / dedupe 保持。阶段 1 邮箱与 QR 页面仍可用。小程序本阶段新增业务通过共享客户端 / HTTP 联验，不提供全量业务页面。

## 请求体与容量边界

普通 JSON 仍为 64 KiB。只对精确 `PATCH /api/v1/entries/:uuid`（包括 uni 的 POST method override）使用独立 Express JSON 解析：有精确重点确认列表时最高 1 MiB，确认数组最多 20,000 项；无确认列表超过 64 KiB 仍拒绝。部分回收站清理的精确 POST /trash/purge 独立支持 128 KiB / 1,000 项，归属 / 版本在用户锁下批量读取并整体比较；无列表仍 64 KiB。超体积 413，超项数在 schema 深度处理前受控 422；其他路由和 `/api/auth` 原始体处理不扩大。后续文件 / 批量入口仍须按各自协议配置，不默认沿用无限大请求。

真实 HTTP 用例预置单事项 10,000 个重点，缩短后需确认 9,999 项，序列化超过 64 KiB。初次只预览、不改内容；另一端改变单日版本后旧列表被拒绝；最新完整列表通过原生 uni override 成功提交，内容 version、focusVersion、重点状态和用户 dataVersion 一致。同组另以超过 64 KiB 的 1,000 项回收站目标验证部分清理成功，1,001 项受控拒绝。

## 实际检查

| 检查 | 结果 |
| --- | --- |
| `pnpm db:generate` / Prisma schema format | 通过 |
| 迁移升级与空库重放 | 真实 Prisma migrate deploy 通过，见下节 |
| `pnpm format:check` / `pnpm lint` | 通过 |
| `pnpm typecheck` | 通过；包括 API 与三个共享包、双端源代码和全部测试 |
| `pnpm test` | 48 项通过：API 21、core 3、contracts 3、api-client 7、Web 9、miniapp 5 |
| `pnpm test:integration` | 34 组真实 PostgreSQL HTTP 通过：认证 10、微信 / QR 11、记录核心 13 |
| 根构建（含 Web 与 mp-weixin） | 通过；由 test:integration 入口重新执行 |
| `pnpm peers check` / `git diff --check` | 通过 |
| Chromium 实际网页 | 邮箱注册 → 本机文件邮件验证 → Cookie 登录 → 新建 → 重点 → 编辑 → 今天结束 → 删除 → 恢复 → 历史回看 → 缩短范围的重点确认 → 新建分类通过；核对真实快照及数据库，无未处理页面异常 |

单元 / 组件用例覆盖 Gregorian 年份 0001 / 0099 / 9999、闰日和上海跨日、Unicode 码点、真实响应解码与 metadata、失败后稳定 ID / 输入保留、显式重点确认、等待保存后更新、删除确认和恢复。core / contracts 新增独立严格测试 tsconfig，没有通过忽略测试或统一双端 Vue 版本绕过类型问题。

真实数据库 HTTP 用例覆盖两个用户隔离、额外所有者字段拒绝、跨用户分类引用和复合外键、内容 CAS 竞争、单日重点竞争及不同日期并存、缩短范围确认变化、类别归属 / 重名 / 20 上限 / 最后一个、分类正常与回收站项原子迁移、迁移中途数据库失败整体回滚、删除旧编辑不复活、恢复 / 永久清理竞争、30 天精确边界、清空前新数据冲突、bigint 超出 JS 安全整数的字符串表示、一致快照引用、私有 ETag / Origin Vary / 304 / 午夜变化、epoch 撤销、待注销只读、异常初始化拒绝以及稳定 ID 重试。所有测试只清理本次账号及其关联数据。

uni 真实受保护 PATCH 联验包括成功、缺 X-Dayline-Expected-User、错账号、无 Origin 的 Cookie 写入、跨用户越权以及大重点确认。原生 `/api/auth` 及既有邮箱 / 微信 / QR 回归均通过。

## 数据库验证与评审修复

- 首次实现曾把未发布迁移命名为将来的 `20261026190000_record_core`，且已应用到原专用测试库。主 Agent 指出后，读取实际 UTC 并将未发布源码改为 `20261026160441_record_core`；没有 reset、修改 Prisma 迁移历史或删除旧数据库 / 数据卷。
- 最终新建 `dayline_stage2_final_test`，先用前两条真实 Prisma 迁移建立阶段 1 结构，插入本次专用旧用户样本，再升级第三条迁移；断言旧用户得到六分类、initialized_at 和初始 dataVersion=1。样本随后清理。最终记录迁移加入显式 BEGIN / COMMIT，DDL、旧用户六分类与 initialized_at 回填共同提交 / 回滚；迁移名采用当时实际 UTC 的 `20261026162718_record_core`。之前试验使用的 `dayline_stage2_test` / `dayline_stage2_empty_test` 也完整保留，没有改写其迁移记录。
- 另建 `dayline_stage2_final_empty_test`，从空库用正式三条迁移重放成功。旧 `dayline_stage1_test` 及其他旧库全部保留。只把本机被忽略 `.env` 的 TEST_DATABASE_URL 改为新 `dayline_stage2_final_test`，未改其他环境项；既有 `_test` guard 保持。
- S2-R1：修复未来迁移命名，并在明确迁移事务边界后使用最终实际时间名和上述新独立库重新验证。
- S2-R2：对齐 RESOURCE_NOT_FOUND、CATEGORY_NAME_EXISTS、CATEGORY_LIMIT_EXCEEDED、LAST_CATEGORY=409 与语义校验 VALIDATION_ERROR=422；真正路径 / JSON 语法仍 400。
- S2-R3：非 native 2xx 必须包含合法 ApiMeta，204 / 304 单列无体契约；记录服务所有写入启用 requireDataVersion，缺元数据或写入版本在接收凭据 / 确认保存前拒绝。OpenAPI 声明 dataVersion；合并 Vary 而不覆盖 Origin，并补缺失 / 畸形 / bodyless / native 回归。
- S2-R4：修复超过普通 JSON 限制的大型精确重点确认，保持有界解析与普通限制，补 10,000 重点真实 HTTP。
- S2-R5：所有记录读写增加 initialized_at 就绪检查，异常时受控拒绝而不伪装完整快照；账号恢复读通道不受影响。

## 限制与后续承接

- 本阶段仅网页最小闭环；全量双端 UI、搜索筛选 / 时间轴 / 完整统计呈现归阶段 3。本机缓存、持久草稿、游客数据接入、生命周期轮询与完整冲突协调归后续阶段；当前编辑器明确提示输入只留页面内存，离开前需保存，不承诺断网保存或自动补传。
- 文件、绑定合并和注销 / 到期维护仍未开放。回收站到期已立即不可恢复，但后台物理清理任务属阶段 7，完整快照暂可包含等待清理的到期项。没有部署或发布。
- 无真实微信 / Resend 凭据和设备，真实 code / 小程序码 / 扫码、真实投递、微信开发者工具和 iOS / Android 真机仍待统一验收。注入适配器、文件邮件、Chromium 和 mp-weixin 编译不替代供应商与设备验证。
- 当前业务单用户写串行、完整读取；未做容量性能 SLA 或生产压测。10,000 重点用例证明合法操作及版本协议能够完成，不等于最终 UI / 小程序性能验收。
