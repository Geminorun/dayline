<script setup lang="ts">
import {
  admissionStatusLabel,
  formatBeijingTime,
  tr,
  renderMessage,
} from './i18n/index';

import IconButton from './components/IconButton.vue';
import ColorPicker from './components/ColorPicker.vue';

import { reviewSelectionKey } from '@dayline/contracts';
import { computed, ref, watch } from 'vue';
import { useAdmission } from './admission';
import { useWorkspace } from './records/workspace';
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
async function commit() {
  if (busy.value || !job.value?.canCommit || unreviewedSelections.value) return;
  await action('commit');
  if (job.value?.status === 'committed') await workspace.load();
}
function target(index: number, event: Event) {
  if (busy.value) return;
  const selected = (event.target as HTMLSelectElement).value,
    c = categories.value[index];
  if (!c) return;
  const t = workspace.snapshot.value?.categories.find((v) => v.id === selected);
  c.targetId = t?.id ?? null;
  if (t) {
    c.name = t.name;
    c.color = t.color;
  }
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
  if (
    window.confirm(tr('admissionReview.keepTheOriginalFrozenPackagesAndTasks'))
  )
    void begin(true, true);
}
function chooseRow(index: number, event: Event) {
  if (busy.value) return;
  const value = (event.target as HTMLSelectElement).value,
    choice = rows.value[index];
  if (choice && (value === 'skip' || value === 'create_copy'))
    choice.action = value;
}
</script>
<template>
  <section
    v-if="job"
    class="record-panel"
    :aria-label="tr('common.guestImportPreview')"
  >
    <h2>{{ tr('common.importGuestRecords') }}</h2>
    <p v-if="job.status === 'committed'" class="notice">
      {{
        tr('admissionReview.cloudConfirmedItemsAddedItemsSkippedThe', {
          value0: job.result?.created,
          value1: job.result?.skipped,
        })
      }}
    </p>
    <template v-else-if="job.status === 'preview'"
      ><p>
        {{
          tr('admissionReview.localItemsClassCloudItemsClassBy', {
            value0: job.sourceSummary.entries,
            value1: job.sourceSummary.categories,
            value2: job.targetSummary.entries,
            value3: job.targetSummary.categories,
            value4: formatBeijingTime(job.expiresAt),
          })
        }}
      </p>
      <h3>{{ tr('common.categoryMapping') }}</h3>
      <div v-for="(c, index) in categories" :key="c.sourceId" class="form-grid">
        <label
          >{{ tr('common.categoryName')
          }}<input v-model="c.name" :disabled="busy" maxlength="24"
        /></label>
        <div class="mapping-color">
          <ColorPicker
            v-model="c.color"
            :disabled="busy"
            :label="tr('common.changeCategoryColor')"
          />
        </div>
        <label
          >{{ tr('common.target')
          }}<select
            :value="c.targetId ?? ''"
            :disabled="busy"
            @change="target(index, $event)"
          >
            <option value="">{{ tr('common.createACategory') }}</option>
            <option
              v-for="t in workspace.snapshot.value?.categories"
              :key="t.id"
              :value="t.id"
            >
              {{
                tr('admissionReview.multiplexing', {
                  value0: t.name,
                  value1: t.color,
                })
              }}
            </option>
          </select></label
        >
      </div>
      <h3>{{ tr('common.importPlanAndSources') }}</h3>
      <details v-for="row in pageRows" :key="row.sourceKey">
        <summary>
          {{ row.source.title }} ·
          {{
            row.action === 'skip'
              ? tr('common.skip')
              : row.action === 'needs_review'
                ? tr('common.needToCheck')
                : tr('common.keepACopy')
          }}
        </summary>
        <p>
          {{
            tr('admissionReview.focusDay', {
              value0: row.source.startDate,
              value1: row.source.endDate ?? tr('common.notFinished'),
              value2: row.source.deletedAt
                ? tr('common.keepTrashStatus')
                : tr('common.activityEntry'),
              value3: row.focusDays.filter((f) => f.focused).length,
            })
          }}
        </p>
        <p>{{ row.reason ? renderMessage(row.reason) : '' }}</p>
        <label
          >{{ tr('common.process')
          }}<select
            v-if="rows[row.index]"
            :disabled="busy"
            :value="rows[row.index]?.action"
            @change="chooseRow(row.index, $event)"
          >
            <option value="skip">{{ tr('common.skipThisSource') }}</option>
            <option value="create_copy">
              {{ tr('common.keepAsANewCopy') }}
            </option>
          </select></label
        >
      </details>
      <div class="actions">
        <IconButton
          icon="chevron"
          :label="tr('common.previousRecords')"
          class="chevron-back"
          :disabled="page === 0"
          @click="page--"
        />
        <span>{{
          tr('admissionReview.pageOfItems', {
            value0: page + 1,
            value1: pageCount,
            value2: job.rows.length,
          })
        }}</span
        ><IconButton
          icon="chevron"
          :label="tr('common.nextRecords')"
          :disabled="page + 1 >= pageCount"
          @click="page++"
        />
      </div>
      <button class="button primary" :disabled="busy" @click="review">
        {{ tr('common.reviewUpdatedPlan') }}</button
      ><button
        class="button primary"
        :disabled="busy || !job.canCommit || unreviewedSelections"
        @click="commit"
      >
        {{ tr('common.importThisPlan') }}</button
      ><button class="button subtle" :disabled="busy" @click="action('cancel')">
        {{ tr('common.notNow') }}
      </button>
      <p v-if="unreviewedSelections" role="status">
        {{ tr('admissionReview.theCategoryOrSourceSelectionHasNot') }}
      </p>
      <p v-if="!job.canCommit">
        {{ tr('admissionReview.pleaseUpdateThePlanAfterProcessingThe') }}
      </p></template
    >
    <p v-else>{{ tr('admissionReview.thisPlanHasBeenCanceledOrExpired') }}</p>
    <button class="button subtle" :disabled="busy" @click="action('query')">
      {{ tr('common.checkTaskStatus') }}
    </button>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
  <section v-if="operation" class="record-panel">
    <p>
      {{
        tr('admissionReview.freezeLocalRevision', {
          value0: operation.package.packageRevision,
          value1: admissionStatusLabel(operation.status),
        })
      }}
    </p>
    <button class="button subtle" :disabled="busy" @click="action('query')">
      {{ tr('common.findAnExistingTask') }}</button
    ><button class="button subtle" :disabled="busy" @click="restart">
      {{ tr('admissionReview.explicitlyRePreviewCurrentNativeRevision') }}
    </button>
  </section>
  <p v-if="error && !job" class="error" role="alert">{{ error }}</p>
</template>
