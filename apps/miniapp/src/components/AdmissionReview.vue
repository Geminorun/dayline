<script setup lang="ts">
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
    title: '重新准备本机记录接入',
    content:
      '保留所有原冻结包和任务。将当前本机修订创建为新的预览，请先核对云端记录。',
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
    ><text class="heading">本机游客接入</text
    ><text v-if="job.status === 'committed'" class="text notice"
      >云端已确认：新增 {{ job.result?.created }} 条、跳过
      {{ job.result?.skipped }} 条。原包保留，确认只对应被冻结修订。</text
    ><template v-else-if="job.status === 'preview'"
      ><text class="text"
        >本机 {{ job.sourceSummary.entries }} 条 /
        {{ job.sourceSummary.categories }} 类；云端
        {{ job.targetSummary.entries }} 条 /
        {{ job.targetSummary.categories }} 类。默认保留双方。</text
      ><view v-for="(c, index) in categories" :key="c.sourceId" class="card"
        ><text class="text">分类名称与颜色</text
        ><input v-model="c.name" :disabled="busy" :maxlength="12" /><input
          v-model="c.color"
          :disabled="busy"
        /><picker
          :disabled="busy"
          :range="[
            '保留为新分类',
            ...(workspace.snapshot.value?.categories.map(
              (t) => t.name + ' ' + t.color,
            ) ?? []),
          ]"
          @change="target(index, $event)"
          ><view class="picker"
            >{{ c.targetId ? '复用已有分类' : '保留新分类' }} ·
            点此选择映射</view
          ></picker
        ></view
      ><view v-for="row in pageRows" :key="row.sourceKey" class="card"
        ><text class="heading">{{ row.source.title }}</text
        ><text class="text"
          >{{ row.source.startDate }} — {{ row.source.endDate ?? '未结束' }} ·
          {{ row.source.deletedAt ? '回收站' : '活动事项' }}</text
        ><text class="text">{{
          row.reason ?? '保留独立副本，不按同名去重'
        }}</text
        ><picker
          v-if="rows[row.index]"
          :disabled="busy"
          :range="['跳过来源', '明确保留新副本']"
          :value="rows[row.index]?.action === 'skip' ? 0 : 1"
          @change="chooseRow(row.index, $event)"
          ><view class="picker">{{
            rows[row.index]?.action === 'skip' ? '跳过来源' : '保留新副本'
          }}</view></picker
        ></view
      ><view class="actions"
        ><button class="secondary" :disabled="page === 0" @click="page--">
          上一页记录</button
        ><text
          >第 {{ page + 1 }} / {{ pageCount }} 页，共
          {{ job.rows.length }} 条</text
        ><button
          class="secondary"
          :disabled="page + 1 >= pageCount"
          @click="page++"
        >
          下一页记录
        </button></view
      ><button :disabled="busy" @click="review">更新并核对计划</button
      ><button
        :disabled="busy || !job.canCommit || unreviewedSelections"
        @click="commit"
      >
        确认接入</button
      ><button class="secondary" :disabled="busy" @click="action('cancel')">
        暂不导入</button
      ><text v-if="unreviewedSelections" class="text notice"
        >分类或来源选择尚未保存核对，请先更新并核对计划。</text
      ><text v-if="!job.canCommit" class="text"
        >请处理分类重名、20 类上限及需要核对的来源后更新计划。</text
      ></template
    ><text v-else class="text">计划已取消或过期，原游客记录保留。</text
    ><button class="secondary" :disabled="busy" @click="action('query')">
      查询原任务</button
    ><text v-if="error" class="text error">{{ error }}</text></view
  ><view v-if="operation" class="card"
    ><text class="text"
      >冻结本机修订 {{ operation.package.packageRevision }} ·
      {{ operation.status }}</text
    ><button class="secondary" :disabled="busy" @click="action('query')">
      查询保留的原任务</button
    ><button class="secondary" :disabled="busy" @click="restart">
      明确重新预览当前本机修订
    </button></view
  ><text v-if="error && !job" class="text error">{{ error }}</text>
</template>
