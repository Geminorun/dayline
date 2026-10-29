<script setup lang="ts">
import { tr, messageRef, renderMessage } from './i18n/index';
import { msg } from '@dayline/locales';
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
  error = messageRef(),
  notice = messageRef(),
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
let commitInFlight = false;
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
        commitInFlight &&
        e instanceof ClientError &&
        (e.code === 'NETWORK_ERROR' ||
          e.code === 'INVALID_RESPONSE' ||
          e.status >= 500);
      notice.value = '';
      error.value = uncertain
        ? msg('data.theSavingResultHasNotBeenConfirmed')
        : e instanceof FileError
          ? `${renderMessage(e.localized ?? e.message)} ${
              e.issues
                .slice(0, 100)
                .map((i) => `${i.path}：${renderMessage(i.message)}`)
                .join('；') +
              (e.issues.length > 100
                ? tr('data.thereAreProblemsPleaseCorrectTheFile', {
                    value0: e.issues.length - 100,
                  })
                : '')
            }`
          : operation.value?.scope === 'guest' &&
              plan.value?.status === 'preview' &&
              !(e instanceof ClientError) &&
              !(e instanceof GuestError)
            ? msg('data.theLocalImportWasNotSavedAnd')
            : errorMessage(e);
    }
  } finally {
    commitInFlight = false;
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
    notice.value = msg('data.queryingTheOriginalFileTaskPleaseWait');
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
      throw new FileError(
        'IMPORT_INVALID',
        tr('data.theLocalSpaceIsNotReadyYet'),
      );
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
      throw new FileError('IMPORT_INVALID', tr('data.fileCannotExceed10Mib'));
    const format = file.name.toLowerCase().endsWith('.csv')
      ? 'csv'
      : file.name.toLowerCase().endsWith('.json')
        ? 'json'
        : null;
    if (!format)
      throw new FileError(
        'IMPORT_INVALID',
        tr('data.pleaseSelectACsvOrJsonFile'),
      );
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(
        await file.arrayBuffer(),
      );
    } catch {
      throw new FileError('IMPORT_INVALID', tr('errors.fileMustBeValidUtf8'));
    }
    if (!valid(c)) return;
    const id = owner();
    if (!id)
      throw new FileError(
        'IMPORT_INVALID',
        tr('data.pleaseReadTheCurrentDataSpaceFirst'),
      );
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
      if (!cloud)
        throw new FileError(
          'IMPORT_INVALID',
          tr('data.unableToReadLocalRecord'),
        );
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
        ? msg('data.theProcessingResultsHaveBeenSavedAnd')
        : msg('data.theProcessingResultsHaveBeenSavedPlease');
      if (next.canCommit) view.value = 'summary';
    }
  });
}
async function commit() {
  await run(async (c) => {
    const p = plan.value,
      op = operation.value;
    if (!p || !op || !p.canCommit || unreviewedSelections.value) return;
    notice.value = msg('data.savingAsAWholeTheResultsCan');
    commitInFlight = true;
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
      throw new FileError(
        'IMPORT_INVALID',
        tr('data.notConfirmedAsCompletedPleaseCheckThe'),
      );
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
    const message = msg('data.importSuccessfulAddedItemsUpdatedItems', {
      value0: result?.created ?? 0,
      value1: result?.updated ?? 0,
      value2: result?.skipped
        ? tr('data.itemsSkipped', { value0: result.skipped })
        : '',
    });
    notice.value = message;
    space.notice.value = message;
    if (receiptWarning)
      space.error.value = msg('data.theRecordHasBeenImportedAndThe');
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
        space.error.value = msg('data.theImportWasSuccessfulButTheRecord');
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
        throw new FileError(
          'IMPORT_INVALID',
          tr('data.unableToReadSavedLocalRecord'),
        );
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
        throw new ClientError(
          'INVALID_RESPONSE',
          msg('common.fileNotGenerated2'),
        );
      text = result.data;
    }
    if (valid(c)) {
      download(text, format);
      notice.value = msg('data.theFileHasBeenGeneratedPleaseSave');
    }
  });
}
onMounted(() => {
  mounted = true;
  void initialize();
});
const actionLabel = (r: ImportRow) =>
  ({
    create_copy: tr('common.newEntry'),
    skip: tr('common.skip'),
    needs_review: tr('common.awaitingVerification'),
    apply_update: tr('common.update'),
    restore: tr('common.restoreAndUpdate'),
    unchanged: tr('common.unchanged'),
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
  get title() {
    return tr('common.name');
  },
  get startDate() {
    return tr('common.startDate');
  },
  get endDate() {
    return tr('common.endDate');
  },
  get categoryId() {
    return tr('common.category');
  },
  get focusDays() {
    return tr('common.focusDates');
  },
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
        :label="tr('common.backToSummary')"
        :disabled="busy"
        @click="view = 'summary'"
      />
      <div>
        <h1>
          {{
            view === 'details'
              ? tr('common.importDetails')
              : action === 'export'
                ? tr('common.exportRecords')
                : action === 'import'
                  ? tr('common.importRecords')
                  : tr('common.importAndExport')
          }}
        </h1>
        <p class="muted">
          {{
            space.mode.value === 'guest'
              ? tr('common.saveToThisDevice')
              : tr('common.saveToCurrentAccount')
          }}
        </p>
      </div>
    </div>
    <p v-if="initializing || recovering" role="status" class="notice">
      {{
        initializing
          ? tr('data.confirmingDataSpace')
          : tr('data.restoringLastImport')
      }}
    </p>
    <div v-else-if="!scopeKey" role="status" class="notice">
      <p>{{ tr('data.theCurrentDataSpaceHasNotBeen') }}</p>
      <button type="button" class="button subtle" @click="initialize">
        {{ tr('common.reload') }}
      </button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <template v-if="view === 'summary'">
      <section
        v-if="action !== 'import'"
        class="record-panel data-file-actions"
      >
        <h2 v-if="!action">{{ tr('common.exportRecords') }}</h2>
        <p>{{ tr('data.csvIsEasyToViewAndEdit') }}</p>
        <div class="action-bar">
          <button
            type="button"
            class="button primary"
            :disabled="blocked"
            @click="exportFile('csv')"
          >
            <PlannerIcon name="download" />{{ tr('common.exportCsv') }}</button
          ><button
            type="button"
            class="button subtle"
            :disabled="blocked"
            @click="exportFile('json')"
          >
            <PlannerIcon name="download" />{{
              tr('accountExports.exportFullJson')
            }}
          </button>
        </div>
        <div v-if="draftWarning" role="status" class="notice">
          <p>{{ tr('data.thereAreLocalModificationsThatHaveNot') }}</p>
          <RouterLink to="/drafts">{{
            tr('common.viewUncommittedChanges')
          }}</RouterLink
          ><button
            type="button"
            class="button subtle"
            :disabled="blocked"
            @click="exportFile(downloadFormat, true)"
          >
            {{ tr('accountExports.continueToExportCloudRecordsOnly') }}
          </button>
        </div>
      </section>
      <section v-if="action !== 'export'" class="import-summary">
        <h2 v-if="!action">{{ tr('common.importRecords') }}</h2>
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
            :aria-label="tr('data.selectCsvJsonFile')"
            :disabled="blocked || space.readonly.value"
            @change="select"
          />
          <PlannerIcon :name="plan ? 'folder' : 'upload'" />
          <strong>{{
            busy
              ? plan?.status === 'preview'
                ? tr('common.importing')
                : tr('common.parsingFile')
              : fileName ||
                (plan
                  ? tr('data.lastSelectedFile', {
                      value0: plan.kind.toUpperCase(),
                    })
                  : tr('data.selectCsvOrJsonFile'))
          }}</strong>
          <span>{{
            plan
              ? tr('common.clickToReplaceFile')
              : tr('data.csvOrJsonMax10Mib')
          }}</span>
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
                  ? tr('data.recordsToBeImported', {
                      value0: plan.sourceSummary.entries,
                    })
                  : plan.status === 'committed'
                    ? tr('common.importCompleted')
                    : plan.status === 'expired'
                      ? tr('common.previewExpired')
                      : tr('common.importCanceled')
              }}
            </h2>
            <div class="import-counts">
              <span
                >{{ tr('common.new')
                }}<strong>{{ plan.counts?.create ?? 0 }}</strong></span
              ><span
                >{{ tr('common.update')
                }}<strong>{{ plan.counts?.update ?? 0 }}</strong></span
              ><span
                >{{ tr('common.unchanged2')
                }}<strong>{{ plan.counts?.unchanged ?? 0 }}</strong></span
              ><span
                >{{ tr('common.skip')
                }}<strong>{{ plan.counts?.skip ?? 0 }}</strong></span
              ><span v-if="plan.counts?.needsReview"
                >{{ tr('common.pending')
                }}<strong>{{ plan.counts.needsReview }}</strong></span
              ><span v-if="plan.counts?.errors"
                >{{ tr('common.error')
                }}<strong>{{ plan.counts.errors }}</strong></span
              >
            </div>
            <p v-if="plan.result" role="status">
              {{
                tr('data.itemsHaveBeenAddedItemsHaveBeen', {
                  value0: plan.result.created,
                  value1: plan.result.updated ?? 0,
                  value2: plan.result.skipped,
                })
              }}
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
                  ? tr('data.pleaseGoToTheDetailsToSave')
                  : tr('data.pleaseResolveCategoryRecordConflictsOrFile')
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
                ? tr('common.processPendingContent')
                : tr('common.viewDetails')
            }}<PlannerIcon name="chevron" />
          </button>
        </template>
        <p v-else class="muted import-help">
          {{ tr('data.automaticallyMatchExistingCategoriesAndAssignColors') }}
        </p>
        <div v-if="operation && !plan" class="notice">
          <p>{{ tr('data.youCanQueryTheLastFileTask') }}</p>
          <div class="action-bar">
            <IconButton
              icon="refresh"
              :label="tr('common.queryOrRestoreOriginalTask')"
              :disabled="blocked"
              @click="recover"
            /><button
              type="button"
              class="button subtle"
              :disabled="blocked"
              @click="retry"
            >
              {{ tr('common.retryPreparationWithOriginalFile') }}</button
            ><button
              type="button"
              class="button subtle"
              :disabled="blocked"
              @click="repreview"
            >
              {{ tr('data.keepOriginalFileAndReCreatePreview') }}
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
            <PlannerIcon name="list" />{{ tr('common.templatesAndFormat') }}
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
                ? tr('common.importing')
                : importCount
                  ? tr('data.importingItems', { value0: importCount })
                  : tr('common.importCompleted2')
            }}
          </button>
          <button
            v-else-if="plan && plan.status !== 'committed'"
            type="button"
            class="button primary"
            :disabled="blocked"
            @click="repreview"
          >
            {{ tr('common.reparseFile') }}
          </button>
        </footer>
      </section>
    </template>
    <template v-else>
      <div class="import-detail-tools">
        <IconButton
          icon="download"
          :label="tr('data.downloadCsvTemplate')"
          @click="download(csvTemplate(), 'csv', true)"
        /><IconButton
          v-if="operation"
          icon="download"
          :label="tr('common.downloadTheOriginalFileOfThisTime')"
          :disabled="blocked"
          @click="download(operation.text, operation.format)"
        /><IconButton
          v-if="operation || hasHistory"
          icon="refresh"
          :label="tr('common.queryOrRestoreOriginalTask')"
          :disabled="blocked"
          @click="recover"
        /><IconButton
          v-if="plan?.status === 'preview'"
          icon="close"
          :label="tr('common.cancelImport')"
          :disabled="blocked"
          @click="cancel"
        />
      </div>
      <details class="import-format" :open="!plan">
        <summary>{{ tr('common.fileFormat') }}</summary>
        <p>{{ tr('data.csvUsesUtf8EncodingAndContains') }}</p>
        <button
          type="button"
          class="button subtle"
          @click="download(csvTemplate(), 'csv', true)"
        >
          <PlannerIcon name="download" />{{ tr('data.downloadCsvTemplate') }}
        </button>
      </details>
      <section v-if="plan" class="record-panel import-details">
        <template v-if="plan.status === 'preview'">
          <h3>{{ tr('common.categoryMapping2') }}</h3>
          <div
            v-for="(c, index) in categories"
            :key="c.sourceId"
            class="file-category"
          >
            <label
              >{{ tr('common.targetCategory')
              }}<select
                :value="c.targetId ?? ''"
                :disabled="blocked"
                @change="mapCategory(index, $event)"
              >
                <option value="">{{ tr('common.addNewCategory') }}</option>
                <option
                  v-for="t in space.snapshot.value?.categories ?? []"
                  :key="t.id"
                  :value="t.id"
                >
                  {{ t.name }}
                </option>
              </select></label
            ><label
              >{{ tr('common.categoryName')
              }}<input v-model="c.name" :disabled="blocked || !!c.targetId"
            /></label>
            <div class="file-category-color">
              <span
                class="category-dot"
                :style="{ backgroundColor: c.color }"
              ></span
              ><ColorPicker
                v-model="c.color"
                :label="tr('data.changeColor', { value0: c.name })"
                :used="categories.map((category) => category.color)"
                :disabled="blocked || !!c.targetId"
              />
            </div>
            <p v-if="plan.categoryMappings[index]?.restoreDefault">
              {{
                tr('data.theDefaultCategoryOfEmptySpaceWill', {
                  value0: plan.categoryMappings[index]?.restoreDefault?.name,
                  value1: plan.categoryMappings[index]?.restoreDefault?.color,
                  value2: c.name,
                  value3: c.color,
                })
              }}
            </p>
            <p v-if="plan.categoryMappings[index]?.action === 'skip'">
              {{ tr('data.keepTheProcessedCategoryThisTimeAnd') }}
            </p>
            <label v-if="!c.targetId && plan.categoryMappings[index]?.seedKey"
              ><input
                v-model="c.asCustom"
                type="checkbox"
                :disabled="blocked"
              />{{ tr('data.explicitlyRetainNameAndColorAsA') }}</label
            >
            <span v-if="plan.categoryMappings[index]?.needsReview">{{
              tr('common.requiresExplicitVerification')
            }}</span>
          </div>
          <div class="detail-section-heading">
            <h3>{{ tr('common.recordDetails') }}</h3>
            <label v-if="problemRows.length" class="inline-check"
              ><input
                v-model="rowFilter"
                type="checkbox"
                true-value="all"
                false-value="problems"
              />{{ tr('common.showAllRecords') }}</label
            >
          </div>
          <article v-for="row in rows" :key="row.sourceKey" class="file-row">
            <h4>
              {{ row.file?.location }} · {{ row.source.title }} ·
              {{ actionLabel(row) }}
            </h4>
            <p>
              {{
                tr('data.fileToEmphasis', {
                  value0: row.source.startDate,
                  value1: row.file?.endPresent
                    ? (row.source.endDate ?? tr('common.notFinished'))
                    : row.file?.current
                      ? tr('common.keepCurrentEndDate')
                      : tr('common.notFinished'),
                  value2: row.file?.focusPresent
                    ? row.focusDays
                        .filter((f) => f.focused)
                        .map((f) => f.date)
                        .join('、') || tr('common.clear')
                    : row.file?.current
                      ? tr('common.maintainCurrentFocus')
                      : tr('common.none'),
                })
              }}
            </p>
            <table v-if="row.file?.current" class="file-diff">
              <caption>
                {{
                  tr('data.checkCurrentRecordsWithProposedApplicationContent')
                }}
              </caption>
              <thead>
                <tr>
                  <th>{{ tr('common.field') }}</th>
                  <th>{{ tr('common.savedValue') }}</th>
                  <th>{{ tr('common.importedValue') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <th>{{ tr('common.name') }}</th>
                  <td>{{ row.file.current.title }}</td>
                  <td>{{ row.source.title }}</td>
                </tr>
                <tr>
                  <th>{{ tr('common.startDate') }}</th>
                  <td>{{ row.file.current.startDate }}</td>
                  <td>{{ row.source.startDate }}</td>
                </tr>
                <tr>
                  <th>{{ tr('common.endDate') }}</th>
                  <td>
                    {{ row.file.current.endDate ?? tr('common.notFinished') }}
                  </td>
                  <td>
                    {{
                      (row.file.endPresent
                        ? row.source.endDate
                        : row.file.current.endDate) ?? tr('common.notFinished')
                    }}{{
                      !row.file.endPresent ? tr('common.remainCurrent') : ''
                    }}
                  </td>
                </tr>
                <tr>
                  <th>{{ tr('common.category') }}</th>
                  <td>
                    <span
                      class="category-dot"
                      :style="{ backgroundColor: currentCategory(row)?.color }"
                    ></span
                    >{{
                      currentCategory(row)?.name ??
                      tr('common.pleaseReadTheCategoryAgain')
                    }}
                  </td>
                  <td>
                    <span
                      class="category-dot"
                      :style="{ backgroundColor: desiredCategory(row)?.color }"
                    ></span
                    >{{
                      desiredCategory(row)?.name ??
                      tr('common.needToSelectMapping')
                    }}{{
                      !row.file.categoryPresent
                        ? tr('common.remainCurrent')
                        : ''
                    }}
                  </td>
                </tr>
                <tr>
                  <th>{{ tr('common.recordStatus') }}</th>
                  <td>
                    {{
                      row.file.current.deletedAt
                        ? tr('common.inTrash')
                        : tr('common.activityRecord')
                    }}
                  </td>
                  <td>
                    {{
                      row.action === 'restore'
                        ? tr('data.explicitlyRevertToActiveRecord')
                        : row.source.deletedAt
                          ? tr('common.sourceInTrash')
                          : tr('data.activeContentWillNotAutomaticallyRestore')
                    }}
                  </td>
                </tr>
                <tr>
                  <th>{{ tr('common.focusDates') }}</th>
                  <td>
                    {{
                      tr('data.days', {
                        value0: focusDates(row, 'current').length,
                      })
                    }}
                  </td>
                  <td>
                    {{
                      tr('data.days2', {
                        value0: focusDates(row, 'desired').length,
                        value1: !row.file.focusPresent
                          ? tr('common.remainCurrent')
                          : '',
                      })
                    }}
                  </td>
                </tr>
              </tbody>
            </table>
            <details v-if="row.file?.current">
              <summary>
                {{ tr('data.viewSpecificFocusDatesCurrentlyAndTo') }}
              </summary>
              <div v-for="side in ['current', 'desired'] as const" :key="side">
                <p>
                  {{
                    tr('data.focusDays', {
                      value0:
                        side === 'current'
                          ? tr('common.savedValue')
                          : tr('common.intendedApplication'),
                      value1: focusDates(row, side).length,
                    })
                  }}
                </p>
                <p>
                  {{
                    focusSlice(row, side).join('、') ||
                    tr('common.noFocusDates')
                  }}
                </p>
                <IconButton
                  icon="chevron"
                  :label="tr('common.first50Dates')"
                  class="chevron-back"
                  :disabled="!(focusPages[row.sourceKey + side] ?? 0)"
                  @click="focusMove(row, side, -1)"
                />
                <IconButton
                  icon="chevron"
                  :label="tr('common.next50Dates')"
                  :disabled="
                    ((focusPages[row.sourceKey + side] ?? 0) + 1) * 50 >=
                    focusDates(row, side).length
                  "
                  @click="focusMove(row, side, 1)"
                />
              </div>
            </details>
            <p v-if="row.file?.differences.length">
              {{
                tr('data.difference', {
                  value0: row.file.differences
                    .map((f) => fieldLabel[f] ?? f)
                    .join('、'),
                })
              }}
            </p>
            <p v-if="row.reason">{{ renderMessage(row.reason) }}</p>
            <p v-for="e in row.file?.errors ?? []" :key="e" class="error">
              {{ renderMessage(e) }}
            </p>
            <template v-if="!row.file?.errors.length"
              ><IconButton
                icon="skip"
                :label="tr('common.skipThis')"
                :disabled="blocked"
                @click="choose(row, 'skip')"
              />
              <IconButton
                icon="copy"
                :label="tr('common.keepAsNewCopy')"
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
                    ? tr('data.currentContentCheckedRestoredAndUpdated')
                    : tr('data.currentContentHasBeenCheckedUpdateThis')
                }}</button
              ><span v-if="choices[row.sourceKey]">{{
                tr('data.selectedNeedToSaveAndCheck')
              }}</span></template
            >
          </article>
          <div class="toolbar">
            <IconButton
              icon="chevron"
              :label="tr('common.previousPage')"
              class="chevron-back"
              :disabled="page === 0"
              @click="page--"
            />
            <span
              >{{ page + 1 }} /
              {{ Math.max(1, Math.ceil(visibleRows.length / 50)) }}</span
            ><IconButton
              icon="chevron"
              :label="tr('common.nextPage')"
              :disabled="(page + 1) * 50 >= visibleRows.length"
              @click="page++"
            />
          </div>
        </template>
        <p v-else>
          {{
            plan.status === 'committed'
              ? tr('common.thisImportHasBeenCompleted')
              : tr('data.thisPreviewHasEndedAndTheOriginal')
          }}
        </p>
        <button
          v-if="plan.status !== 'committed'"
          type="button"
          class="button subtle"
          :disabled="blocked"
          @click="repreview"
        >
          {{ tr('data.keepOriginalFileAndReCreatePreview') }}
        </button>
      </section>
      <footer class="import-footer">
        <button
          type="button"
          class="button subtle"
          :disabled="blocked"
          @click="view = 'summary'"
        >
          {{ tr('common.backToSummary2') }}
        </button>
        <button
          v-if="plan?.status === 'preview'"
          type="button"
          class="button primary"
          :disabled="blocked || space.readonly.value"
          @click="review"
        >
          {{ tr('common.saveProcessingResults') }}
        </button>
      </footer>
      <p v-if="unreviewedSelections" role="status" class="muted">
        {{ tr('data.theSelectionHasNotBeenSavedSave') }}
      </p>
    </template>
  </section>
</template>
