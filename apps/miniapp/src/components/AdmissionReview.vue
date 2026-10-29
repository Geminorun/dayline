<script setup lang="ts">
import { admissionStatusLabel, tr, renderMessage } from '../i18n/index';

import { reviewSelectionKey } from '@dayline/contracts';
import { computed, ref, watch } from 'vue';
import { useAdmission } from '../admission';
import { useWorkspace } from '../workspace';
const { job, operation, error, busy, begin, action } = useAdmission(),
  workspace = useWorkspace();
const page = ref(0),
  pageSize = 50;
const pageCount = computed(() =>
  Math.max(1, Math.ceil((job.value?.rows.length ?? 0) / pageSize)),
);
const pageRows = computed(
  () =>
    job.value?.rows
      .slice(page.value * pageSize, (page.value + 1) * pageSize)
      .map((row, offset) => ({
        ...row,
        index: page.value * pageSize + offset,
      })) ?? [],
);
const categories = ref<
    { sourceId: string; targetId: string | null; name: string; color: string }[]
  >([]),
  rows = ref<{ sourceKey: string; action: 'create_copy' | 'skip' }[]>([]);
const reviewBaseline = ref('');
const unreviewedSelections = computed(
  () =>
    reviewSelectionKey({ categories: categories.value, rows: rows.value }) !==
    reviewBaseline.value,
);
watch(
  () => `${job.value?.id ?? ''}:${job.value?.planRevision ?? ''}`,
  () => {
    page.value = 0;
    categories.value =
      job.value?.categoryMappings.map((c) => ({
        sourceId: c.sourceId,
        targetId: c.targetId,
        name: c.name,
        color: c.color,
      })) ?? [];
    rows.value =
      job.value?.rows.map((r) => ({
        sourceKey: r.sourceKey,
        action: r.action === 'skip' ? 'skip' : 'create_copy',
      })) ?? [];
    reviewBaseline.value = reviewSelectionKey({
      categories: categories.value,
      rows: rows.value,
    });
  },
  { immediate: true },
);
function target(index: number, event: { detail: { value: string | number } }) {
  if (busy.value) return;
  const c = categories.value[index],
    n = Number(event.detail.value),
    t = workspace.snapshot.value?.categories[n - 1];
  if (c) {
    c.targetId = t?.id ?? null;
    if (t) {
      c.name = t.name;
      c.color = t.color;
    }
  }
}
async function commit() {
  if (busy.value || !job.value?.canCommit || unreviewedSelections.value) return;
  await action('commit');
  if (job.value?.status === 'committed') await workspace.load();
}
async function review() {
  const p = job.value;
  if (!p || busy.value) return;
  await action('review', {
    expectedPlanRevision: p.planRevision,
    categories: categories.value.map((c) => ({ ...c })),
    rows: rows.value.map((r) => ({ ...r })),
  });
}
function restart() {
  uni.showModal({
    title: tr('admissionReview.rePrepareLocalRecordAccess'),
    content: tr('admissionReview.keepAllOriginalFrozenPackagesAndTasks'),
    success: (result) => {
      if (result.confirm) void begin(true, true);
    },
  });
}
function chooseRow(
  index: number,
  event: { detail: { value: string | number } },
) {
  if (busy.value) return;
  const choice = rows.value[index];
  if (choice)
    choice.action = Number(event.detail.value) === 0 ? 'skip' : 'create_copy';
}
</script>
<template>
  <view v-if="job" class="card"
    ><text class="heading">{{ tr('common.localGuestAccess') }}</text
    ><text v-if="job.status === 'committed'" class="text notice">{{
      tr('admissionReview.cloudConfirmedAddedSkippedTheOriginalPackage', {
        value0: job.result?.created,
        value1: job.result?.skipped,
      })
    }}</text
    ><template v-else-if="job.status === 'preview'"
      ><text class="text">{{
        tr('admissionReview.localItemsClassCloudItemsClassBoth', {
          value0: job.sourceSummary.entries,
          value1: job.sourceSummary.categories,
          value2: job.targetSummary.entries,
          value3: job.targetSummary.categories,
        })
      }}</text
      ><view v-for="(c, index) in categories" :key="c.sourceId" class="card"
        ><text class="text">{{ tr('common.categoryNamesAndColors') }}</text
        ><input v-model="c.name" :disabled="busy" :maxlength="24" /><input
          v-model="c.color"
          :disabled="busy"
        /><picker
          :disabled="busy"
          :range="[
            tr('common.createACategory'),
            ...(workspace.snapshot.value?.categories.map(
              (t) => t.name + ' ' + t.color,
            ) ?? []),
          ]"
          @change="target(index, $event)"
          ><view class="picker">{{
            tr('admissionReview.clickHereToSelectMapping', {
              value0: c.targetId
                ? tr('common.reuseExistingCategory')
                : tr('common.keepNewCategories'),
            })
          }}</view></picker
        ></view
      ><view v-for="row in pageRows" :key="row.sourceKey" class="card"
        ><text class="heading">{{ row.source.title }}</text
        ><text class="text"
          >{{ row.source.startDate }} —
          {{ row.source.endDate ?? tr('common.notFinished') }} ·
          {{
            row.source.deletedAt
              ? tr('common.trash')
              : tr('common.activityEntry')
          }}</text
        ><text class="text">{{
          (row.reason ? renderMessage(row.reason) : null) ??
          tr('admissionReview.keepIndependentCopiesAndDoNotDeduplicate')
        }}</text
        ><picker
          v-if="rows[row.index]"
          :disabled="busy"
          :range="[
            tr('common.skipSource'),
            tr('common.explicitlyRetainNewCopy'),
          ]"
          :value="rows[row.index]?.action === 'skip' ? 0 : 1"
          @change="chooseRow(row.index, $event)"
          ><view class="picker">{{
            rows[row.index]?.action === 'skip'
              ? tr('common.skipSource')
              : tr('common.keepNewCopy')
          }}</view></picker
        ></view
      ><view class="actions"
        ><button class="secondary" :disabled="page === 0" @click="page--">
          {{ tr('common.previousRecords') }}</button
        ><text>{{
          tr('admissionReview.pageOfItems', {
            value0: page + 1,
            value1: pageCount,
            value2: job.rows.length,
          })
        }}</text
        ><button
          class="secondary"
          :disabled="page + 1 >= pageCount"
          @click="page++"
        >
          {{ tr('common.nextRecords') }}
        </button></view
      ><button :disabled="busy" @click="review">
        {{ tr('common.reviewUpdatedPlan') }}</button
      ><button
        :disabled="busy || !job.canCommit || unreviewedSelections"
        @click="commit"
      >
        {{ tr('common.confirmAccess') }}</button
      ><button class="secondary" :disabled="busy" @click="action('cancel')">
        {{ tr('common.notNow') }}</button
      ><text v-if="unreviewedSelections" class="text notice">{{
        tr('admissionReview.theCategoryOrSourceSelectionHasNot')
      }}</text
      ><text v-if="!job.canCommit" class="text">{{
        tr('admissionReview.pleaseDealWithTheDuplicateNamesOf')
      }}</text></template
    ><text v-else class="text">{{
      tr('admissionReview.thePlanHasBeenCanceledOrExpired')
    }}</text
    ><button class="secondary" :disabled="busy" @click="action('query')">
      {{ tr('common.queryOriginalTask') }}</button
    ><text v-if="error" class="text error">{{ error }}</text></view
  ><view v-if="operation" class="card"
    ><text class="text">{{
      tr('admissionReview.freezeLocalRevision', {
        value0: operation.package.packageRevision,
        value1: admissionStatusLabel(operation.status),
      })
    }}</text
    ><button class="secondary" :disabled="busy" @click="action('query')">
      {{ tr('common.findAnExistingTask') }}</button
    ><button class="secondary" :disabled="busy" @click="restart">
      {{ tr('admissionReview.explicitlyRePreviewCurrentNativeRevision') }}
    </button></view
  ><text v-if="error && !job" class="text error">{{ error }}</text>
</template>
