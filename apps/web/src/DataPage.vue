<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import { createImportsClient, ClientError } from '@dayline/api-client';
import {
  csvTemplate,
  exportCsv,
  exportJson,
  createLocalFilePlan,
  reviewLocalFilePlan,
  MAX_FILE_BYTES,
  FileError,
} from '@dayline/contracts/files';
import type {
  FileOperation,
  ImportJobDto,
  ImportReviewInput,
  ImportRow,
} from '@dayline/contracts';
import {
  GuestError,
  importJobSchema,
  reviewSelectionKey,
} from '@dayline/contracts';
import { api } from './api';
import { parseWebFile } from './adapters/file-parser';
import { useWorkspace } from './records/workspace';
import { guestRepository } from './adapters/guest-repository';
import { localRepository, localEnvironment } from './adapters/local-repository';
import { errorMessage } from './records/record-service';
const space = useWorkspace(),
  client = createImportsClient(api),
  operation = ref<FileOperation | null>(null),
  plan = ref<ImportJobDto | null>(null),
  busy = ref(false),
  bootstrapped = ref(false),
  initializing = ref(true),
  recovering = ref(false),
  readyScope = ref<string | null>(null),
  identityRevision = ref(0),
  error = ref(''),
  notice = ref(''),
  page = ref(0),
  draftWarning = ref(false),
  downloadFormat = ref<'csv' | 'json'>('json');
const rows = computed(
  () => plan.value?.rows.slice(page.value * 50, page.value * 50 + 50) ?? [],
);
const choices = ref<Record<string, ImportReviewInput['rows'][number]>>({});
const categories = ref<ImportReviewInput['categories']>([]);
const categoryReviewBaseline = ref('');
const unreviewedSelections = computed(() =>
  Boolean(
    plan.value?.status === 'preview' &&
    (Object.keys(choices.value).length > 0 ||
      reviewSelectionKey(categories.value) !== categoryReviewBaseline.value),
  ),
);
let intent = 0;
function owner() {
  return space.mode.value === 'account'
    ? api.getAccount()
    : (space.guest.value?.guestDatasetId ?? null);
}
function capture() {
  return {
    generation: api.getGeneration(),
    scope: space.generation(),
    owner: owner(),
    intent,
  };
}
function valid(c: ReturnType<typeof capture>) {
  return (
    c.generation === api.getGeneration() &&
    c.scope === space.generation() &&
    c.owner === owner() &&
    c.intent === intent
  );
}
function clear() {
  intent++;
  operation.value = null;
  plan.value = null;
  choices.value = {};
  categories.value = [];
  categoryReviewBaseline.value = '';
  busy.value = false;
  error.value = '';
  notice.value = '';
  draftWarning.value = false;
}
let mounted = false,
  initializationIntent = 0;
const scopeKey = computed(() => {
  void identityRevision.value;
  if (!bootstrapped.value) return null;
  const id = owner(),
    snapshot = space.snapshot.value;
  const trusted =
    space.mode.value === 'account'
      ? space.identityState.value === 'verified' && api.getAccount() === id
      : space.identityState.value === 'guest' &&
        space.guest.value?.guestDatasetId === id;
  return trusted && id && snapshot?.userId === id
    ? `${api.getGeneration()}:${space.generation()}:${space.mode.value}:${id}`
    : null;
});
const ready = computed(
  () =>
    scopeKey.value !== null &&
    readyScope.value === scopeKey.value &&
    !initializing.value &&
    !recovering.value,
);
const blocked = computed(() => !ready.value || busy.value);
const stop = watch(
  scopeKey,
  (key) => {
    clear();
    readyScope.value = null;
    recovering.value = false;
    if (key && mounted) void restoreScope(key);
  },
  { flush: 'sync' },
);
const unsubscribe = api.onIdentityChange(() => {
  identityRevision.value++;
});
onUnmounted(() => {
  mounted = false;
  initializationIntent++;
  stop();
  unsubscribe();
  intent++;
});
async function initialize() {
  const ticket = ++initializationIntent;
  initializing.value = true;
  try {
    await space.ensure();
    if (!mounted || ticket !== initializationIntent) return;
    bootstrapped.value = true;
  } catch (cause) {
    if (mounted && ticket === initializationIntent)
      error.value = errorMessage(cause);
  } finally {
    if (mounted && ticket === initializationIntent) initializing.value = false;
  }
}
async function restoreScope(key: string) {
  const c = capture();
  recovering.value = true;
  try {
    const restored = await recoverFor(c);
    if (valid(c) && scopeKey.value === key && restored) show(restored);
  } catch (cause) {
    if (valid(c)) error.value = errorMessage(cause);
  } finally {
    if (valid(c) && scopeKey.value === key) {
      recovering.value = false;
      readyScope.value = key;
    }
  }
}
async function persist(op: FileOperation) {
  if (op.scope === 'guest') await guestRepository.putFileOperation(op);
  else await localRepository.putFileOperation(op);
}
function show(p: ImportJobDto) {
  plan.value = p;
  page.value = 0;
  choices.value = {};
  categories.value = p.categoryMappings.map((c) => ({
    sourceId: c.sourceId,
    targetId: c.targetId,
    name: c.name,
    color: c.color,
    asCustom: c.asCustom ?? false,
  }));
  categoryReviewBaseline.value = reviewSelectionKey(categories.value);
}
async function run(work: (c: ReturnType<typeof capture>) => Promise<void>) {
  if (blocked.value) return;
  const c = capture();
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await work(c);
  } catch (e) {
    if (valid(c)) {
      const uncertain =
        notice.value === '正在整体保存，结果可查询。' &&
        e instanceof ClientError &&
        (e.code === 'NETWORK_ERROR' ||
          e.code === 'INVALID_RESPONSE' ||
          e.status >= 500);
      notice.value = '';
      error.value = uncertain
        ? '保存结果尚未确认，请查询或恢复原任务后继续，原文件已保留。'
        : e instanceof FileError
          ? `${e.message} ${
              e.issues
                .slice(0, 100)
                .map((i) => `${i.path}：${i.message}`)
                .join('；') +
              (e.issues.length > 100
                ? `；另有 ${e.issues.length - 100} 个问题，请修正文件后重试。`
                : '')
            }`
          : operation.value?.scope === 'guest' &&
              plan.value?.status === 'preview' &&
              !(e instanceof ClientError) &&
              !(e instanceof GuestError)
            ? '本机导入未保存，原记录与文件已保留。请检查存储权限与空间后重试。'
            : errorMessage(e);
    }
  } finally {
    if (valid(c)) busy.value = false;
  }
}
async function recoverFor(
  c: ReturnType<typeof capture>,
): Promise<ImportJobDto | null> {
  const id = owner();
  if (!id) return null;
  let op =
    space.mode.value === 'guest'
      ? await guestRepository.fileOperation(id)
      : await localRepository.fileOperation(id);
  if (!valid(c) || !op) return null;
  operation.value = op;
  if (op.scope === 'guest') {
    if (
      op.status === 'pending' &&
      op.localPlan &&
      Date.parse(op.localPlan.expiresAt) <= Date.now()
    ) {
      op = {
        ...op,
        status: 'expired',
        localPlan: { ...op.localPlan, status: 'expired', canCommit: false },
      };
      await persist(op);
      if (!valid(c)) return null;
      operation.value = op;
    }
    return op.localPlan;
  }
  const response = op.jobId
    ? await client.get(op.jobId)
    : await client.byOperation(op.clientOperationId);
  if (!valid(c) || !response.data) return null;
  const next = {
    ...op,
    jobId: response.data.id,
    status:
      response.data.status === 'preview'
        ? ('pending' as const)
        : response.data.status,
  };
  await persist(next);
  if (!valid(c)) return null;
  operation.value = next;
  return response.data;
}
async function recover() {
  await run(async (c) => {
    plan.value = null;
    notice.value = '正在查询原文件任务，请稍候。';
    const restored = await recoverFor(c);
    if (valid(c)) {
      notice.value = '';
      if (restored) show(restored);
    }
  });
}
async function prepare(c: ReturnType<typeof capture>, op: FileOperation) {
  if (op.scope === 'guest') {
    const current = await guestRepository.read();
    if (!current || current.guestDatasetId !== op.ownerId)
      throw new FileError('IMPORT_INVALID', '本机空间尚未准备完成。');
    const source = await parseWebFile(
      op.text,
      op.format,
      new Date().toISOString(),
    );
    const p = createLocalFilePlan(
      source,
      current,
      String(current.packageRevision),
      () => crypto.randomUUID(),
      new Date().toISOString(),
      await guestRepository.fileMappings(op.ownerId),
    );
    p.clientOperationId = op.clientOperationId;
    op = { ...op, jobId: p.id, localPlan: p };
    await persist(op);
    if (valid(c)) {
      operation.value = op;
      show(p);
    }
  } else {
    const r = await api.request('/api/v1/imports/preview', {
      method: 'POST',
      account: true,
      headers: {
        'X-Dayline-File-Format': op.format,
        'X-Dayline-Operation-ID': op.clientOperationId,
      },
      body: op.text,
      decode: importJobSchema.parse,
    });
    if (valid(c) && r.data) {
      show(r.data);
      op = { ...op, jobId: r.data.id };
      await persist(op);
      if (valid(c)) operation.value = op;
    }
  }
}
async function select(event: Event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  const file = target.files?.[0];
  if (!file) return;
  await run(async (c) => {
    if (file.size > MAX_FILE_BYTES)
      throw new FileError('IMPORT_INVALID', '文件不能超过 10 MiB。');
    const format = file.name.toLowerCase().endsWith('.csv')
      ? 'csv'
      : file.name.toLowerCase().endsWith('.json')
        ? 'json'
        : null;
    if (!format)
      throw new FileError(
        'IMPORT_INVALID',
        '请选择 CSV 或 JSON 文件，不支持压缩包。',
      );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        await file.arrayBuffer(),
      );
    } catch {
      throw new FileError('IMPORT_INVALID', '文件必须是有效 UTF-8。');
    }
    if (!valid(c)) return;
    await parseWebFile(text, format, new Date().toISOString());
    const id = owner();
    if (!id) throw new FileError('IMPORT_INVALID', '请先读取当前数据空间。');
    const op: FileOperation = {
      environment: localEnvironment,
      scope: space.mode.value,
      ownerId: id,
      clientOperationId: crypto.randomUUID(),
      jobId: null,
      format,
      text,
      status: 'pending',
      localPlan: null,
    };
    await persist(op);
    if (!valid(c)) return;
    operation.value = op;
    await prepare(c, op);
  });
  target.value = '';
}
function choose(
  row: ImportRow,
  action: ImportReviewInput['rows'][number]['action'],
) {
  choices.value[row.sourceKey] = {
    sourceKey: row.sourceKey,
    action,
    ...((action === 'apply_update' || action === 'restore') && row.file?.current
      ? {
          expectedEntryVersion: row.file.current.version,
          expectedFocusVersion: row.file.current.focusVersion,
        }
      : {}),
  };
}
function mapCategory(index: number, event: Event) {
  const el = event.target;
  if (!(el instanceof HTMLSelectElement)) return;
  const c = categories.value[index];
  if (!c) return;
  const target = space.snapshot.value?.categories.find(
    (v) => v.id === el.value,
  );
  c.targetId = target?.id ?? null;
  c.asCustom = false;
  if (target) {
    c.name = target.name;
    c.color = target.color;
  }
}
async function review() {
  await run(async (c) => {
    const p = plan.value,
      op = operation.value;
    if (!p || !op) return;
    const input: ImportReviewInput = {
      expectedPlanRevision: p.planRevision,
      categories: categories.value,
      rows: Object.values(choices.value),
    };
    let next: ImportJobDto | undefined;
    if (op.scope === 'account') next = (await client.review(p.id, input)).data;
    else {
      const cloud = await guestRepository.read();
      if (!cloud) throw new FileError('IMPORT_INVALID', '无法读取本机记录。');
      next = reviewLocalFilePlan(
        p,
        cloud,
        input,
        String(cloud.packageRevision),
        new Date().toISOString(),
      );
      await persist({ ...op, localPlan: next });
    }
    if (valid(c) && next) {
      show(next);
      if (op.scope === 'guest') operation.value = { ...op, localPlan: next };
      notice.value = '核对已保存，请检查新摘要后确认导入。';
    }
  });
}
async function commit() {
  await run(async (c) => {
    const p = plan.value,
      op = operation.value;
    if (!p || !op || !p.canCommit || unreviewedSelections.value) return;
    notice.value = '正在整体保存，结果可查询。';
    const next =
      op.scope === 'account'
        ? (
            await client.commit(p.id, {
              expectedPlanRevision: p.planRevision,
              planDigest: p.planDigest,
            })
          ).data
        : await guestRepository.commitFile(op, p, new Date().toISOString());
    if (!valid(c) || !next) return;
    if (next.status !== 'committed')
      throw new FileError('IMPORT_INVALID', '尚未确认完成，请查询原任务。');
    show(next);
    operation.value = {
      ...op,
      status: 'committed',
      localPlan: op.scope === 'guest' ? next : null,
    };
    await persist(operation.value);
    if (!valid(c)) return;
    if (next.result && op.scope === 'account')
      api.acknowledgeWrite(next, next.result.dataVersion);
    await space.reload();
    if (valid(c))
      notice.value =
        op.scope === 'account'
          ? '已保存到云端，原文件保留。'
          : '已保存到本机，原文件保留。';
  });
}
async function cancel() {
  await run(async (c) => {
    const p = plan.value,
      op = operation.value;
    if (!p || !op) return;
    const next =
      op.scope === 'account'
        ? (await client.cancel(p.id)).data
        : { ...p, status: 'cancelled' as const, canCommit: false };
    if (valid(c) && next) {
      show(next);
      operation.value = {
        ...op,
        status: 'cancelled',
        localPlan: op.scope === 'guest' ? next : null,
      };
      await persist(operation.value);
    }
  });
}
async function retry() {
  await run(async (c) => {
    if (operation.value) await prepare(c, operation.value);
  });
}
async function repreview() {
  await run(async (c) => {
    const op = operation.value;
    if (!op) return;
    const next = {
      ...op,
      clientOperationId: crypto.randomUUID(),
      jobId: null,
      status: 'pending' as const,
      localPlan: null,
    };
    await persist(next);
    if (!valid(c)) return;
    operation.value = next;
    await prepare(c, next);
  });
}
function download(text: string, format: 'csv' | 'json', template = false) {
  const url = URL.createObjectURL(
    new Blob([text], {
      type:
        format === 'csv'
          ? 'text/csv;charset=utf-8'
          : 'application/json;charset=utf-8',
    }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = `dayline-${template ? 'template' : new Date().toISOString().slice(0, 10)}.${format}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function exportFile(format: 'csv' | 'json', confirmed = false) {
  await run(async (c) => {
    if (space.mode.value === 'account' && !confirmed) {
      const id = api.getAccount();
      if (!id) return;
      const drafts = await localRepository.drafts(id);
      if (!valid(c)) return;
      if (drafts.length) {
        downloadFormat.value = format;
        draftWarning.value = true;
        return;
      }
    }
    draftWarning.value = false;
    let text: string;
    if (space.mode.value === 'guest') {
      const cloud = await guestRepository.read();
      if (!cloud)
        throw new FileError('IMPORT_INVALID', '无法读取已保存的本机记录。');
      text =
        format === 'csv'
          ? exportCsv(cloud)
          : exportJson(cloud, new Date().toISOString());
    } else {
      const result = await api.request(`/api/v1/exports/${format}`, {
        account: true,
        native: true,
        decode: (value: unknown) => {
          if (typeof value !== 'string')
            throw new FileError('IMPORT_INVALID', 'invalid download');
          return value;
        },
      });
      if (!result.data)
        throw new ClientError('INVALID_RESPONSE', '文件未生成。');
      text = result.data;
    }
    if (valid(c)) {
      download(text, format);
      notice.value = '文件已生成，请在下载位置妥善保存。';
    }
  });
}
onMounted(() => {
  mounted = true;
  void initialize();
});
const actionLabel = (r: ImportRow) =>
  ({
    create_copy: '新增副本',
    skip: '跳过',
    needs_review: '等待核对',
    apply_update: '更新',
    restore: '恢复并更新',
    unchanged: '无变化',
  })[r.action];
const focusPages = ref<Record<string, number>>({});
function currentCategory(row: ImportRow) {
  return row.file?.currentCategory;
}
const focusedBySource = computed(
  () =>
    new Map(
      (plan.value?.rows ?? []).map((row) => {
        const current = (row.file?.currentFocusDays ?? [])
          .filter((f) => f.focused)
          .map((f) => f.date)
          .sort();
        const desired = row.file?.focusPresent
          ? row.focusDays
              .filter((f) => f.focused)
              .map((f) => f.date)
              .sort()
          : current;
        return [row.sourceKey, { current, desired }];
      }),
    ),
);
function desiredCategory(row: ImportRow) {
  return row.file?.categoryPresent
    ? plan.value?.categoryMappings.find(
        (c) => c.sourceId === row.source.categoryId,
      )
    : currentCategory(row);
}
function focusDates(row: ImportRow, side: 'current' | 'desired') {
  return focusedBySource.value.get(row.sourceKey)?.[side] ?? [];
}
function focusSlice(row: ImportRow, side: 'current' | 'desired') {
  const key = row.sourceKey + side;
  return focusDates(row, side).slice(
    (focusPages.value[key] ?? 0) * 50,
    ((focusPages.value[key] ?? 0) + 1) * 50,
  );
}
function focusMove(row: ImportRow, side: 'current' | 'desired', delta: number) {
  const key = row.sourceKey + side;
  focusPages.value[key] = Math.max(0, (focusPages.value[key] ?? 0) + delta);
}
const fieldLabel: Record<string, string> = {
  title: '名称',
  startDate: '开始日期',
  endDate: '结束日期',
  categoryId: '分类',
  focusDays: '重点日期',
};
</script>
<template>
  <section class="records-page">
    <p class="eyebrow">DAYLINE · 数据管理</p>
    <h1>导入与导出</h1>
    <p v-if="scopeKey">
      {{
        space.mode.value === 'guest'
          ? '游客 · 仅本机保存'
          : '当前已验证账号 · 云端记录'
      }}
    </p>
    <p v-if="initializing || recovering" role="status" class="notice">
      {{
        initializing
          ? '正在确认数据空间，请稍候。'
          : '正在恢复本空间的文件任务，请稍候。'
      }}
    </p>
    <div v-else-if="!scopeKey" role="status" class="notice">
      <p>当前数据空间尚未准备完成。请先确认身份或重新读取记录。</p>
      <button class="secondary" @click="initialize">重新准备数据管理</button>
    </div>
    <p>
      CSV 包含全部活动事项；完整 JSON
      包含分类配色、重点及仍保留的回收站。缺少文件行不会删除现有记录。
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <section class="record-panel">
      <h2>文件</h2>
      <button class="secondary" @click="download(csvTemplate(), 'csv', true)">
        下载 CSV 模板
      </button>
      <button :disabled="blocked" @click="exportFile('csv')">导出 CSV</button
      ><button :disabled="blocked" @click="exportFile('json')">
        导出完整 JSON
      </button>
      <label
        >选择 CSV / JSON 文件（UTF-8，最多 10 MiB）<input
          type="file"
          accept=".csv,.json,text/csv,application/json"
          :disabled="blocked || space.readonly.value"
          @change="select"
      /></label>
      <p>
        日期填写
        YYYY-MM-DD，多重点日用分号隔开。先预览并处理所有错误与冲突，确认后整笔保存。
      </p>
      <div v-if="draftWarning" role="status">
        <p>
          有尚未提交的本机草稿。可先去草稿页手动保存，或继续只导出云端已保存记录。
        </p>
        <RouterLink to="/drafts">查看草稿</RouterLink
        ><button :disabled="blocked" @click="exportFile(downloadFormat, true)">
          继续只导出云端记录
        </button>
      </div>
      <button class="secondary" :disabled="blocked" @click="recover">
        查询或恢复原任务
      </button>
      <button v-if="operation && !plan" :disabled="blocked" @click="retry">
        用原文件重试准备
      </button>
      <button
        v-if="operation && !plan"
        class="secondary"
        :disabled="blocked"
        @click="repreview"
      >
        保留原文件，重新建立预览
      </button>
    </section>
    <section v-if="plan" class="record-panel">
      <h2>
        {{
          plan.status === 'committed'
            ? '导入完成'
            : plan.status === 'preview'
              ? '核对导入预览'
              : plan.status === 'expired'
                ? '预览已过期'
                : '任务已取消'
        }}
      </h2>
      <button
        v-if="operation"
        class="secondary"
        :disabled="blocked"
        @click="download(operation.text, operation.format)"
      >
        下载本次原文件
      </button>
      <p>
        共 {{ plan.sourceSummary.entries }} 条；新增
        {{ plan.counts?.create ?? 0 }}、更新
        {{ plan.counts?.update ?? 0 }}、不变
        {{ plan.counts?.unchanged ?? 0 }}、待核对
        {{ plan.counts?.needsReview ?? 0 }}、错误
        {{ plan.counts?.errors ?? 0 }}、跳过 {{ plan.counts?.skip ?? 0 }}。
      </p>
      <p v-if="plan.result">
        已新增 {{ plan.result.created }} 条，更新
        {{ plan.result.updated ?? 0 }} 条，跳过
        {{ plan.result.skipped }} 条。原始文件及未出现在文件中的记录均保留。
      </p>
      <template v-if="plan.status === 'preview'">
        <h3>分类映射</h3>
        <div
          v-for="(c, index) in categories"
          :key="c.sourceId"
          class="file-category"
        >
          <label
            >目标分类<select
              :value="c.targetId ?? ''"
              :disabled="blocked"
              @change="mapCategory(index, $event)"
            >
              <option value="">新增分类</option>
              <option
                v-for="t in space.snapshot.value?.categories ?? []"
                :key="t.id"
                :value="t.id"
              >
                {{ t.name }}
              </option>
            </select></label
          ><label
            >分类名称<input
              v-model="c.name"
              :disabled="blocked || !!c.targetId" /></label
          ><label
            >颜色<input
              v-model="c.color"
              type="color"
              :disabled="blocked || !!c.targetId"
          /></label>
          <p v-if="plan.categoryMappings[index]?.restoreDefault">
            空白空间的默认分类将按备份恢复：{{
              plan.categoryMappings[index]?.restoreDefault?.name
            }}
            / {{ plan.categoryMappings[index]?.restoreDefault?.color }} →
            {{ c.name }} / {{ c.color }}。默认分类身份保留。
          </p>
          <p v-if="plan.categoryMappings[index]?.action === 'skip'">
            本次保持已处理的分类，不重建或覆盖当前分类。
          </p>
          <label v-if="!c.targetId && plan.categoryMappings[index]?.seedKey"
            ><input
              v-model="c.asCustom"
              type="checkbox"
              :disabled="blocked"
            />明确作为自定义分类保留名称与颜色（不迁移默认分类身份）</label
          >
          <span v-if="plan.categoryMappings[index]?.needsReview"
            >需要明确核对</span
          >
        </div>
        <h3>逐项差异</h3>
        <article v-for="row in rows" :key="row.sourceKey" class="file-row">
          <h4>
            {{ row.file?.location }} · {{ row.source.title }} ·
            {{ actionLabel(row) }}
          </h4>
          <p>
            文件：{{ row.source.startDate }} 至
            {{
              row.file?.endPresent
                ? (row.source.endDate ?? '未结束')
                : '保持当前结束日期'
            }}；重点
            {{
              row.file?.focusPresent
                ? row.focusDays
                    .filter((f) => f.focused)
                    .map((f) => f.date)
                    .join('、') || '清空'
                : '保持当前重点'
            }}
          </p>
          <table v-if="row.file?.current" class="file-diff">
            <caption>
              核对当前记录与拟应用内容
            </caption>
            <thead>
              <tr>
                <th>字段</th>
                <th>当前已保存</th>
                <th>拟应用文件内容</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>名称</th>
                <td>{{ row.file.current.title }}</td>
                <td>{{ row.source.title }}</td>
              </tr>
              <tr>
                <th>开始日期</th>
                <td>{{ row.file.current.startDate }}</td>
                <td>{{ row.source.startDate }}</td>
              </tr>
              <tr>
                <th>结束日期</th>
                <td>{{ row.file.current.endDate ?? '未结束' }}</td>
                <td>
                  {{
                    (row.file.endPresent
                      ? row.source.endDate
                      : row.file.current.endDate) ?? '未结束'
                  }}{{ !row.file.endPresent ? '（保持当前）' : '' }}
                </td>
              </tr>
              <tr>
                <th>分类</th>
                <td>
                  <span
                    class="category-dot"
                    :style="{ backgroundColor: currentCategory(row)?.color }"
                  ></span
                  >{{ currentCategory(row)?.name ?? '请重新读取分类' }}
                </td>
                <td>
                  <span
                    class="category-dot"
                    :style="{ backgroundColor: desiredCategory(row)?.color }"
                  ></span
                  >{{ desiredCategory(row)?.name ?? '需要选择映射'
                  }}{{ !row.file.categoryPresent ? '（保持当前）' : '' }}
                </td>
              </tr>
              <tr>
                <th>记录状态</th>
                <td>
                  {{ row.file.current.deletedAt ? '在回收站' : '活动记录' }}
                </td>
                <td>
                  {{
                    row.action === 'restore'
                      ? '明确恢复为活动记录'
                      : row.source.deletedAt
                        ? '来源在回收站'
                        : '活动内容；不会自动恢复'
                  }}
                </td>
              </tr>
              <tr>
                <th>重点日期</th>
                <td>{{ focusDates(row, 'current').length }} 天</td>
                <td>
                  {{ focusDates(row, 'desired').length }} 天{{
                    !row.file.focusPresent ? '（保持当前）' : ''
                  }}
                </td>
              </tr>
            </tbody>
          </table>
          <details v-if="row.file?.current">
            <summary>查看当前与拟应用的具体重点日期</summary>
            <div v-for="side in ['current', 'desired'] as const" :key="side">
              <p>
                {{ side === 'current' ? '当前已保存' : '拟应用' }}：{{
                  focusDates(row, side).length
                }}
                个重点日
              </p>
              <p>{{ focusSlice(row, side).join('、') || '无重点日期' }}</p>
              <button
                class="secondary"
                :disabled="!(focusPages[row.sourceKey + side] ?? 0)"
                @click="focusMove(row, side, -1)"
              >
                前 50 个日期</button
              ><button
                class="secondary"
                :disabled="
                  ((focusPages[row.sourceKey + side] ?? 0) + 1) * 50 >=
                  focusDates(row, side).length
                "
                @click="focusMove(row, side, 1)"
              >
                后 50 个日期
              </button>
            </div>
          </details>
          <p v-if="row.file?.differences.length">
            差异：{{
              row.file.differences.map((f) => fieldLabel[f] ?? f).join('、')
            }}
          </p>
          <p v-if="row.reason">{{ row.reason }}</p>
          <p v-for="e in row.file?.errors ?? []" :key="e" class="error">
            {{ e }}
          </p>
          <template v-if="!row.file?.errors.length"
            ><button
              class="secondary"
              :disabled="blocked"
              @click="choose(row, 'skip')"
            >
              跳过此项</button
            ><button
              class="secondary"
              :disabled="blocked"
              @click="choose(row, 'create_copy')"
            >
              保留为新副本</button
            ><button
              v-if="row.file?.current && !row.source.deletedAt"
              :disabled="blocked"
              @click="
                choose(
                  row,
                  row.file.current.deletedAt ? 'restore' : 'apply_update',
                )
              "
            >
              {{
                row.file.current.deletedAt
                  ? '已核对当前内容，恢复并更新'
                  : '已核对当前内容，更新此项'
              }}</button
            ><span v-if="choices[row.sourceKey]"
              >已选择，需保存核对</span
            ></template
          >
        </article>
        <div class="toolbar">
          <button class="secondary" :disabled="page === 0" @click="page--">
            上一页</button
          ><span
            >{{ page + 1 }} /
            {{ Math.max(1, Math.ceil(plan.rows.length / 50)) }}</span
          ><button
            class="secondary"
            :disabled="(page + 1) * 50 >= plan.rows.length"
            @click="page++"
          >
            下一页
          </button>
        </div>
        <button :disabled="blocked || space.readonly.value" @click="review">
          保存核对并更新预览</button
        ><button
          :disabled="
            blocked ||
            !plan.canCommit ||
            unreviewedSelections ||
            space.readonly.value
          "
          @click="commit"
        >
          确认整体导入</button
        ><button class="secondary" :disabled="blocked" @click="cancel">
          取消本次导入
        </button>
        <p v-if="unreviewedSelections" role="status">
          分类或逐项选择尚未保存核对，请先保存核对并更新预览。
        </p>
        <p v-if="!plan.canCommit">
          请先修正文件错误、分类映射或逐项冲突。错误行不能静默跳过。
        </p>
      </template>
      <button
        v-if="plan.status !== 'committed'"
        class="secondary"
        :disabled="blocked"
        @click="repreview"
      >
        保留原文件，重新建立预览
      </button>
    </section>
  </section>
</template>
