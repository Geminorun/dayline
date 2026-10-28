<script setup lang="ts">
import AccountExports from './AccountExports.vue';
import IconButton from './components/IconButton.vue';
import PlannerIcon from './components/PlannerIcon.vue';
import ColorPicker from './components/ColorPicker.vue';
import { useAccount } from './account';
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
const account = useAccount();
const props = defineProps<{ action?: 'import' | 'export' }>();
const emit = defineEmits<{
  viewChange: [view: 'summary' | 'details'];
  imported: [];
  close: [];
}>();
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
const view = ref<'summary' | 'details'>('summary');
watch(view, (next) => emit('viewChange', next), { immediate: true });
const fileName = ref('');
const hasHistory = ref(false);
const rowFilter = ref<'problems' | 'all'>('problems');
const problemRows = computed(
  () =>
    plan.value?.rows.filter(
      (r) => r.action === 'needs_review' || r.file?.errors.length,
    ) ?? [],
);
const visibleRows = computed(() =>
  rowFilter.value === 'problems' && problemRows.value.length
    ? problemRows.value
    : (plan.value?.rows ?? []),
);
const rows = computed(() =>
  visibleRows.value.slice(page.value * 50, page.value * 50 + 50),
);
const importCount = computed(
  () => (plan.value?.counts?.create ?? 0) + (plan.value?.counts?.update ?? 0),
);
watch(rowFilter, () => {
  page.value = 0;
});
function details() {
  view.value = 'details';
  page.value = 0;
}

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
  view.value = 'summary';
  fileName.value = '';
  hasHistory.value = false;
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
    const restored =
      props.action === 'export' ? null : await recoverFor(c, true);
    if (valid(c) && scopeKey.value === key && restored?.status === 'preview')
      show(restored);
    else if (valid(c)) operation.value = null;
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
  activeOnly = false,
): Promise<ImportJobDto | null> {
  const id = owner();
  if (!id) return null;
  let op =
    space.mode.value === 'guest'
      ? await guestRepository.fileOperation(id)
      : await localRepository.fileOperation(id);
  if (!valid(c) || !op) return null;
  hasHistory.value = true;
  if (activeOnly && op.status !== 'pending') return null;
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
  await loadFile(file);
  target.value = '';
}
async function drop(event: DragEvent) {
  const file = event.dataTransfer?.files[0];
  if (file && !blocked.value && !space.readonly.value) await loadFile(file);
}
async function loadFile(file: File) {
  await run(async (c) => {
    plan.value = null;
    choices.value = {};
    categories.value = [];
    fileName.value = file.name;
    view.value = 'summary';
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
    fileName.value = file.name;
    view.value = 'summary';
    await prepare(c, op);
  });
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
      notice.value = next.canCommit
        ? '已保存处理结果，可以导入。'
        : '处理结果已保存，请继续解决剩余问题。';
      if (next.canCommit) view.value = 'summary';
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
    let receiptWarning = false;
    try {
      await persist(operation.value);
    } catch {
      receiptWarning = true;
    }
    if (!valid(c)) return;
    if (next.result && op.scope === 'account')
      api.acknowledgeWrite(next, next.result.dataVersion);
    const result = next.result;
    const message = `导入成功：新增 ${result?.created ?? 0} 条，更新 ${result?.updated ?? 0} 条${result?.skipped ? `，跳过 ${result.skipped} 条` : ''}。`;
    notice.value = message;
    space.notice.value = message;
    if (receiptWarning)
      space.error.value =
        '记录已导入，本机任务状态未能保存；原文件仍在，请刷新后核对。';
    const generation = space.generation(),
      accountGeneration = api.getGeneration();
    emit('imported');
    try {
      await space.reload();
    } catch {
      if (
        generation === space.generation() &&
        accountGeneration === api.getGeneration()
      )
        space.error.value = '导入已成功，记录刷新失败，请点击刷新重试。';
    }
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
    create_copy: '新增记录',
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
  <AccountExports
    v-if="
      account.current.value?.status === 'pending_deletion' &&
      space.mode.value === 'account'
    "
  />
  <section v-else class="records-page data-page themed-form">
    <div class="data-heading">
      <IconButton
        v-if="view === 'details'"
        icon="back"
        label="返回导入摘要"
        :disabled="busy"
        @click="view = 'summary'"
      />
      <div>
        <h1>
          {{
            view === 'details'
              ? '导入详情'
              : action === 'export'
                ? '导出记录'
                : action === 'import'
                  ? '导入记录'
                  : '导入与导出'
          }}
        </h1>
        <p class="muted">
          {{ space.mode.value === 'guest' ? '保存到此设备' : '保存到当前账号' }}
        </p>
      </div>
    </div>
    <p v-if="initializing || recovering" role="status" class="notice">
      {{ initializing ? '正在确认数据空间…' : '正在恢复上次导入…' }}
    </p>
    <div v-else-if="!scopeKey" role="status" class="notice">
      <p>当前数据空间尚未准备完成。</p>
      <button type="button" class="button subtle" @click="initialize">
        重新读取
      </button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <template v-if="view === 'summary'">
      <section
        v-if="action !== 'import'"
        class="record-panel data-file-actions"
      >
        <h2 v-if="!action">导出记录</h2>
        <p>CSV 便于查看与编辑；完整 JSON 同时保留分类、重点和回收站。</p>
        <div class="action-bar">
          <button
            type="button"
            class="button primary"
            :disabled="blocked"
            @click="exportFile('csv')"
          >
            <PlannerIcon name="download" />导出 CSV</button
          ><button
            type="button"
            class="button subtle"
            :disabled="blocked"
            @click="exportFile('json')"
          >
            <PlannerIcon name="download" />导出完整 JSON
          </button>
        </div>
        <div v-if="draftWarning" role="status" class="notice">
          <p>有尚未提交的本机修改，可先继续编辑，或只导出云端已保存记录。</p>
          <RouterLink to="/drafts">查看未提交修改</RouterLink
          ><button
            type="button"
            class="button subtle"
            :disabled="blocked"
            @click="exportFile(downloadFormat, true)"
          >
            继续只导出云端记录
          </button>
        </div>
      </section>
      <section v-if="action !== 'export'" class="import-summary">
        <h2 v-if="!action">导入记录</h2>
        <label
          class="file-drop"
          :class="{
            'file-drop-disabled': blocked || space.readonly.value,
            'file-selected': !!plan,
          }"
          @dragover.prevent
          @drop.prevent="drop"
        >
          <input
            class="file-input"
            type="file"
            accept=".csv,.json,text/csv,application/json"
            aria-label="选择 CSV / JSON 文件"
            :disabled="blocked || space.readonly.value"
            @change="select"
          />
          <PlannerIcon :name="plan ? 'folder' : 'upload'" />
          <strong>{{
            busy
              ? plan?.status === 'preview'
                ? '正在导入…'
                : '正在分析文件…'
              : fileName ||
                (plan
                  ? `上次选择的 ${plan.kind.toUpperCase()} 文件`
                  : '选择 CSV 或 JSON 文件')
          }}</strong>
          <span>{{ plan ? '点击更换文件' : 'CSV 或 JSON，最大 10 MiB' }}</span>
        </label>
        <template v-if="plan">
          <div
            class="import-result"
            :class="{
              'import-has-problems':
                (!plan.canCommit || unreviewedSelections) &&
                plan.status === 'preview',
            }"
          >
            <h2>
              {{
                plan.status === 'preview'
                  ? `${plan.sourceSummary.entries} 条记录待导入`
                  : plan.status === 'committed'
                    ? '导入完成'
                    : plan.status === 'expired'
                      ? '预览已过期'
                      : '导入已取消'
              }}
            </h2>
            <div class="import-counts">
              <span
                >新增 <strong>{{ plan.counts?.create ?? 0 }}</strong></span
              ><span
                >更新 <strong>{{ plan.counts?.update ?? 0 }}</strong></span
              ><span
                >不变 <strong>{{ plan.counts?.unchanged ?? 0 }}</strong></span
              ><span
                >跳过 <strong>{{ plan.counts?.skip ?? 0 }}</strong></span
              ><span v-if="plan.counts?.needsReview"
                >待处理 <strong>{{ plan.counts.needsReview }}</strong></span
              ><span v-if="plan.counts?.errors"
                >错误 <strong>{{ plan.counts.errors }}</strong></span
              >
            </div>
            <p v-if="plan.result" role="status">
              已新增 {{ plan.result.created }} 条，更新
              {{ plan.result.updated ?? 0 }} 条，跳过
              {{ plan.result.skipped }} 条。
            </p>
            <p
              v-if="
                plan.status === 'preview' &&
                (!plan.canCommit || unreviewedSelections)
              "
              class="muted"
            >
              {{
                unreviewedSelections
                  ? '请到详情保存处理结果后导入。'
                  : '请在详情中处理分类、记录冲突或文件错误后继续。'
              }}
            </p>
          </div>
          <button
            type="button"
            class="import-details-link"
            :disabled="blocked"
            @click="details"
          >
            <PlannerIcon name="list" />{{
              plan.status === 'preview' && !plan.canCommit
                ? '处理待确认内容'
                : '查看详情'
            }}<PlannerIcon name="chevron" />
          </button>
        </template>
        <p v-else class="muted import-help">
          自动匹配已有分类，为新分类分配颜色。已有记录会保留。
        </p>
        <div v-if="operation && !plan" class="notice">
          <p>可以查询上次文件任务，或使用原文件重试。</p>
          <div class="action-bar">
            <IconButton
              icon="refresh"
              label="查询或恢复原任务"
              :disabled="blocked"
              @click="recover"
            /><button
              type="button"
              class="button subtle"
              :disabled="blocked"
              @click="retry"
            >
              用原文件重试准备</button
            ><button
              type="button"
              class="button subtle"
              :disabled="blocked"
              @click="repreview"
            >
              保留原文件，重新建立预览
            </button>
          </div>
        </div>
        <footer class="import-footer">
          <button
            type="button"
            class="import-template-link"
            :disabled="blocked"
            @click="details"
          >
            <PlannerIcon name="list" />模板与说明
          </button>
          <button
            v-if="plan?.status === 'preview'"
            type="button"
            class="button primary"
            :disabled="
              blocked ||
              !plan.canCommit ||
              unreviewedSelections ||
              space.readonly.value
            "
            @click="commit"
          >
            {{
              busy
                ? '正在导入…'
                : importCount
                  ? `导入 ${importCount} 条`
                  : '完成导入'
            }}
          </button>
          <button
            v-else-if="plan && plan.status !== 'committed'"
            type="button"
            class="button primary"
            :disabled="blocked"
            @click="repreview"
          >
            重新分析文件
          </button>
        </footer>
      </section>
    </template>
    <template v-else>
      <div class="import-detail-tools">
        <IconButton
          icon="download"
          label="下载 CSV 模板"
          @click="download(csvTemplate(), 'csv', true)"
        /><IconButton
          v-if="operation"
          icon="download"
          label="下载本次原文件"
          :disabled="blocked"
          @click="download(operation.text, operation.format)"
        /><IconButton
          v-if="operation || hasHistory"
          icon="refresh"
          label="查询或恢复原任务"
          :disabled="blocked"
          @click="recover"
        /><IconButton
          v-if="plan?.status === 'preview'"
          icon="close"
          label="取消本次导入"
          :disabled="blocked"
          @click="cancel"
        />
      </div>
      <details class="import-format" :open="!plan">
        <summary>文件格式说明</summary>
        <p>
          CSV 使用 UTF-8 编码，至少包含 title、start_date。日期填写
          YYYY-MM-DD，多个重点日用分号隔开。新记录需提供分类名称；未提供颜色时自动分配。JSON
          使用日序完整备份文件。
        </p>
        <button
          type="button"
          class="button subtle"
          @click="download(csvTemplate(), 'csv', true)"
        >
          <PlannerIcon name="download" />下载 CSV 模板
        </button>
      </details>
      <section v-if="plan" class="record-panel import-details">
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
                :disabled="blocked || !!c.targetId"
            /></label>
            <div class="file-category-color">
              <span
                class="category-dot"
                :style="{ backgroundColor: c.color }"
              ></span
              ><ColorPicker
                v-model="c.color"
                :label="`更改${c.name}颜色`"
                :used="categories.map((category) => category.color)"
                :disabled="blocked || !!c.targetId"
              />
            </div>
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
          <div class="detail-section-heading">
            <h3>记录详情</h3>
            <label v-if="problemRows.length" class="inline-check"
              ><input
                v-model="rowFilter"
                type="checkbox"
                true-value="all"
                false-value="problems"
              />显示全部记录</label
            >
          </div>
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
                  : row.file?.current
                    ? '保持当前结束日期'
                    : '未结束'
              }}；重点
              {{
                row.file?.focusPresent
                  ? row.focusDays
                      .filter((f) => f.focused)
                      .map((f) => f.date)
                      .join('、') || '清空'
                  : row.file?.current
                    ? '保持当前重点'
                    : '无'
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
                <IconButton
                  icon="chevron"
                  label="前 50 个日期"
                  class="chevron-back"
                  :disabled="!(focusPages[row.sourceKey + side] ?? 0)"
                  @click="focusMove(row, side, -1)"
                />
                <IconButton
                  icon="chevron"
                  label="后 50 个日期"
                  :disabled="
                    ((focusPages[row.sourceKey + side] ?? 0) + 1) * 50 >=
                    focusDates(row, side).length
                  "
                  @click="focusMove(row, side, 1)"
                />
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
              ><IconButton
                icon="skip"
                label="跳过此项"
                :disabled="blocked"
                @click="choose(row, 'skip')"
              />
              <IconButton
                icon="copy"
                label="保留为新副本"
                :disabled="blocked"
                @click="choose(row, 'create_copy')"
              />
              <button
                class="button primary"
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
            <IconButton
              icon="chevron"
              label="上一页"
              class="chevron-back"
              :disabled="page === 0"
              @click="page--"
            />
            <span
              >{{ page + 1 }} /
              {{ Math.max(1, Math.ceil(visibleRows.length / 50)) }}</span
            ><IconButton
              icon="chevron"
              label="下一页"
              :disabled="(page + 1) * 50 >= visibleRows.length"
              @click="page++"
            />
          </div>
        </template>
        <p v-else>
          {{
            plan.status === 'committed'
              ? '本次导入已完成。'
              : '本次预览已结束，可用原文件重新分析。'
          }}
        </p>
        <button
          v-if="plan.status !== 'committed'"
          type="button"
          class="button subtle"
          :disabled="blocked"
          @click="repreview"
        >
          保留原文件，重新建立预览
        </button>
      </section>
      <footer class="import-footer">
        <button
          type="button"
          class="button subtle"
          :disabled="blocked"
          @click="view = 'summary'"
        >
          返回摘要
        </button>
        <button
          v-if="plan?.status === 'preview'"
          type="button"
          class="button primary"
          :disabled="blocked || space.readonly.value"
          @click="review"
        >
          保存处理结果
        </button>
      </footer>
      <p v-if="unreviewedSelections" role="status" class="muted">
        选择尚未保存，保存核对后再导入。
      </p>
    </template>
  </section>
</template>
