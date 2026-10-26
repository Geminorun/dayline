# 阶段 5：Web CSV / 完整 JSON 文件往返交接

日期：2026-10-26。实现 Agent 未提交、推送或发布，未修改主 Agent 独占的 implementation-plan.md。本阶段没有数据库 schema / 迁移变更；既有四条迁移、专用 dayline_stage2_final_test、旧空库及全部历史数据库 / 卷保留，没有 reset / drop 或更改迁移历史，也没有改动 .env。

## 交付范围

- Web `/data` 从设置进入，明确当前游客 / 云端空间，提供十二列 CSV 模板、原生文件选择、逐项预览、分类映射、明确核对、整体确认、取消、恢复原任务 / 原操作、重新预览及真实 CSV / JSON 下载。每页 50 项，切页保留选择；字段表显示当前 / 拟应用名称、日期、分类名色，重点显示数量及每页 50 个真实日期。确认前不写业务；处理中没有伪造行进度；持久 committed 后才显示保存成功并完整刷新。
- `packages/contracts/files` 为 API / Web 共用的纯文件模块，使用 PapaParse 5.5.3 与 noble hashes 2.0.1；主 contracts barrel 只导出 DTO / 任务契约，miniapp 不导入文件子路径。文件模块无 DOM、Vue、wx / uni、Node 或密钥依赖。Web 大于 256 KiB 的文件在独立 Worker 解析，平台文件读取 / UTF-8 fatal 解码 / Blob 下载留在 Web 适配层。
- CSV UTF-8 / BOM、CRLF、逗号、引号、单元格换行、中文、emoji 和合法 U+FFFD 往返。十二列可调整顺序，未知 / 重复表头明确拒绝；缺可选列保持当前字段，空结束日清空，空重点集合清空。`text_escape=apostrophe-v1` 对公式前缀及原有单引号仅解一层，普通文件不猜测删除用户引号。已有 ID 的内容 / 集合更新分别需要版本或明确核对当前版本；外部 ID 只作来源，不查询他人内容。当前分类 ID 可安全匹配，ID / 名称矛盾须核对；新分类缺色须映射。
- JSON `dayline-backup` v1 严格验证结构、版本、引用、重复 ID / seed、日期范围、重点、来源时间、连续 30 天删除期限和嵌套。保留分类配色 / 默认 seed、事项 ID 与来源版本、true / false 重点及仍保留回收站；权限只取 Actor，文件 owner 不授权，凭据 / 草稿 / 未知字段拒绝。日期时间规范化为 ISO，并按 Date.parse 比较真实时刻，支持无毫秒 Z。新候选按剩余保留期留在回收站，到期来源跳过，不续期。完整导出不按单次导入条数限制截断账号内容。
- JSON 恢复到真正空白且完整默认结构未改的目标：计划明确显示现有默认分类 → 备份名称 / 颜色，确认后保留目标 seed 身份、按实际改动递增分类版本；同事务临时唯一占位名处理合法名称交换。非空 / 改过默认结构时不自动修改默认分类，要求显式复用或勾选作为自定义分类保留名色（不迁移 seed）。CSV 不批量修改既有分类；JSON 无事项分类可独立导入。

## 协议、事务与幂等

上传采用精确 `POST /api/v1/imports/preview` raw UTF-8 文件，实际字节最多 10 MiB，header 为 `X-Dayline-File-Format: csv|json`、`X-Dayline-Operation-ID: UUID`，Content-Type 为 application/octet-stream。会话 / Cookie Origin / 预期账号保护保留，CORS 显式允许两 header。普通 JSON 64 KiB、事项精确重点确认 1 MiB / 20,000、部分 purge 128 KiB / 1,000 均不放宽；精确 import review 支持 4 MiB / 10,000 选择 / 160 字符来源键及两个版本确认。单次导入 10,000 事项、100,000 重点状态，JSON 嵌套最多 12 层，不支持压缩包或远程 URL。生产预览每账号每分钟 5 次，内存桶不替代事务幂等。

`ImportsService.prepareNormalized` / 同一 import_jobs / review / commit / apply 为唯一云端执行核心。任务原输入摘要不变，候选 ID 跨 review 稳定；错误行不能选择 skip 以绕过整笔校验。用户明确核对当前内容和重点集合版本，才允许 apply_update / restore 形成新修订和摘要，无 force。缺行不删除，当前 trash 不因旧活动文件静默恢复。保留字段后的最终日期 / 重点也在预览按行验证，并在纯 apply 后再次验证完整业务图。

提交先锁 user 再锁 job，复核 epoch / 状态 / expiry / dataVersion / 修订 / digest，并在写入前再次读取完成来源回执。其他任务已完成相同新增来源时返回 PREVIEW_STALE，不把已确认 create 静默改成 skip 成功。分类、批量新增 / 版本更新、重点、恢复、dataVersion 和任务结果在同一事务提交；分类 / 事项 / 重点失败整笔回滚。事项更新用参数化批量 SQL，重点按受影响事项批量替换其已计算完整状态，保留单日 / 集合版本，没有无限逐重点查询或独立批量 upsert 入口。

`importReceiptIndex` 同时索引 sourceKey 和 sourceKey+digest 的全部已完成内容修订，不把 completedAt 当成可靠总序。guest 连续修订继续对未知新摘要要求明确副本 / skip，旧已接入冻结版本精确命中；文件无 ID 行以归一化内容 + 出现序号形成来源键，同文件两条相同内容仍可各自保留，修改无 ID 行成为新候选。文件及分类最小来源回执一起保存：重复旧版本也不会重建后来清理的目标，用户改过分类后重导旧文件不重建旧分类或增加 dataVersion。相同操作换输入 409，同任务重试返回持久结果。

游客使用相同解析 / 计划 / apply 规则，WebGuestRepository 在同一 IndexedDB 事务 CAS 当前 packageRevision，并提交包、文件回执及结果。失败或配额不足保留旧完整包、原文件和输入；冻结修订改变拒绝旧计划。文件操作 / 回执检查环境、scope、owner、键内计划 / 操作 ID；旧损坏信封停止覆盖。同操作原文本 / 格式不可替换，提交读取已持久的冻结计划。账号原文件先持久于所属账号仓库才发送；恢复任务重新请求服务器授权，迟到请求 / 下载以 ApiClient 和空间代次拦截，不把 A 文件交给 B。

当前有效新 epoch 会话读取旧 epoch 任务返回 PREVIEW_STALE（409），只让计划失效；真实失效会话仍由 Guard / user 校验返回 401。文件页保留新会话和原文件，在无可读计划时也可显式生成新操作 ID 重新预览，不拿原操作换输入；真实 PG、纯客户端和组件均有回归。

导出账号记录提示本机未提交草稿，可去草稿页手动保存或只导出云端已保存记录，不自动提交。下载检查状态 / MIME / attachment；UTF-8 字节解码显式保留 CSV BOM（fetch.text 会吞 BOM）。游客导出只读已持久包。对象 URL 使用后清理，CSV 不含 trash，JSON 含 trash / false focus；文件不含认证凭据。

## 实际验证

| 检查                                               | 结果                                                                                           |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| 全仓严格 source / tests 类型                       | 通过                                                                                           |
| 单元 / 组件                                        | 118 项通过：API 21、core 8、contracts 18、api-client 20、Web 37、miniapp 14                    |
| 完整 API / Web / mp-weixin 构建与既有四迁移 deploy | 通过；没有待应用迁移                                                                           |
| 真实 PostgreSQL HTTP                               | 58 组全部通过，其中新增文件 14 组；既有 guest / 认证 / 记录全部保留                            |
| 格式 / lint / peer / diff                          | 通过；最终整链 exit 0 后已再次核对                                                             |
| Chromium 原生文件上传 / 下载                       | 实现 Agent 与主 Agent 对最终冻结版各完整通过；主 Agent 独立 exit 0 / 0 pageerror，正式评审通过 |

新增纯规则覆盖转义 / Unicode、缺列 vs 空值、保留日期后的重点范围、缺版本 / focus 集合冲突、已删显式恢复、30 天边界及无毫秒时刻、错误定位、格式 / 嵌套 / 文件 / 条数限制、相同无 ID 两行稳定来源、JSON 分类 / false / trash、默认 seed 名色恢复及来源分类后改名重放。Web 覆盖 10,000 行仅渲染 50、跨页选择、实际当前 / 拟应用值、显式核对后 CAS 失败保留原包、草稿提示零自动写、迟到下载隔离及 BOM / 错误响应；IndexedDB 覆盖包写入后回执失败回滚、重复任务、本机冻结冲突与归属 / 原文本 / 损坏保留。

真实 PG 文件用例验证：归属 / Origin / expected-user、实际 10 MiB raw 文件（10,485,760 字节）通过且超 1 字节拒绝；最坏 10,000 项 review 实际 2,680,051 字节（超过旧 2 MiB），4 MiB 有界入口通过，普通 64 KiB 保持。CSV / JSON 附件、真假重点 / 回收站恢复、未知 / 文件 owner 不越权、相同及修改文件、旧版本 review / focus 竞争、缺行不删、保留字段范围错误、取消 / 过期、数据库中途失败回滚、同任务竞争、默认分类交换名称 / 回滚 / stale、分类后改名重放和无事项 JSON 分类均有实际 HTTP 回归；另验证旧 JSON → 修改版 → 清理原目标 → 旧 JSON 重放，以及不同预建任务 review 后仍不能重复 copy。

首轮完整 PG 的 guest 连续修订用例因相同 completedAt 下最新回执排序不确定而失败；上述全历史精确摘要索引修复该实际缺陷，不靠修改时钟或删掉既有断言。最终全部 58 组真实 PG HTTP 在本环境约 48.88 秒通过（仅该完整测试阶段，不是单请求性能 SLA）。新增历史清理用例曾把既有 purge 的 201 误断言为 200，现已校正测试断言；新增客户端测试曾误放在另一 it 内，现为独立用例；没有以删除覆盖或降低严格类型来掩盖失败。新增依赖固定版本，mp-weixin 产物未发现 PapaParse / 文件解析器标记；uni 构建仍仅有既有 zod PURE 注释提示。

## 主 Agent 浏览器评审与启动竞态修复

首轮主 Agent 真实 Chromium 的游客全闭环及云端首次 CSV 已过；云端已有 durable 草稿后冷进入 /data，导出按钮曾在身份 / 空间初始化结束前就可点击，迟到初始化 clear / run 使这次可操作动作丢失，草稿提示没有出现。因此该首轮不能标为通过。

现将初次 ensure、可信身份、完整快照所属空间及本空间任务恢复区分为明确就绪状态。依赖空间的导出、选择文件、查询和提交控件，在该空间恢复完成前禁用；页面显示正在确认空间 / 恢复文件任务，初始化与后台恢复不再占用一个已对用户开放的 run 槽。同步 scope 变化立即隐藏旧计划 / 草稿提示并禁用动作，恢复只作用于捕获的代次；后台正常全量刷新不重开文件操作。手动查询显示处理中并隐藏旧计划，结果完成后再发布，没有增加动作队列，也不执行 disabled 期间的程序注入 change。

新增 data-startup.test.ts 使用真实 RouterView 和实际 workspace，受控延迟 /me 及所属任务仓库读取，验证两段等待期间导出 / 文件 / 查询不可操作；就绪后第一次导出即显示 durable 草稿提示，只有明确继续才产生附件下载。离开设置再回到数据页同样先恢复再开放，旧恢复不能吞掉该次用户动作。既有账号隔离组件夹具同时补齐匹配账号的完整 snapshot，遵循真实就绪条件。

实现 Agent 另用原脚本实际跑到最后的查询 / 上传交界：Playwright.setInputFiles 可绕过 disabled，而旧完成标题已存在，不能把该脚本时序当作真实用户可选择文件的证据；主 Agent 将上传 helper 改为等待 input.isEnabled()，生产实现没有为该情况接收额外队列。修复后实现 Agent 实际完整运行更新后的仓库外 stage5-smoke：300 KiB Worker 游客上传、公式 / 引号 / 换行 / Unicode 下载、默认阅读改阅览 / #123456、false focus 与 trash 完整 JSON 到独立空游客恢复、旧 CSV 不重建分类全部通过；云端真实 CSV 预览 / 提交、草稿提示与只导出云端、带 ID 更新 / 清重点 / 缺行保留、原任务查询及重复无变化也全部通过，exit 0 / 0 pageerror。该脚本自启服务及 fixtures 已 finally 清理。

S5-R1 后 Web 37 项、最终完整 118 项单元组件、Web 严格源 / 测试类型、Web 构建、全仓 lint / format 与 diff 再次通过。仅 Web 页面与测试修改，API / 共享 / mini 源码不变，此前 58 组真实 PG 和完整构建证据继续有效；没有把组件或编译当作新的独立浏览器证据。源码 / dist 再冻结后，主 Agent 已对该最终版本完整独立复验，实际 exit 0 / 0 pageerror，并正式确认第五阶段评审通过。根最终浏览器覆盖游客及云端全部段：300 KiB Worker、Unicode / 公式 / 引号换行、默认 seed 改名色到空目标 JSON 恢复、false / trash、旧 CSV 分类重放、云端预览零业务写、草稿 warning 且不混入云端导出、ID 版本更新与清重点、缺行保留、原任务查询，以及重复文件不增加 dataVersion。实现 Agent 未在冻结后修改源码 / dist 或重新构建；本交接仅补该实际证据，最终根计划、commit / push 由主 Agent 处理。

## 后续接口与限制

- 阶段 6 沿用 import / guest 的用户锁、最小回执与完整快照不变量，不引入另一套账号文件写入或用文件 owner 当授权。importResult 新增可选 updated / unchanged / categoryMappings，旧 guest / mini DTO 保持兼容。
- 阶段 7 清理过期任务时须清理 input 及 plan 中的私密 source / current / focus 内容，保留最小 inputDigest、来源映射与 committed 回执；只把 input 置空并不等于已清完 plan。完成回执不能随预览到期删除。
- 不部署或发布。真实微信 / Resend / 微信开发者工具、iOS / Android 真机、WebKit、Excel / Numbers / LibreOffice、低空间真实设备、完整无障碍审计及生产压测仍待外部环境验证；自动化 / Chromium / mp-weixin 编译不替代这些证据。
