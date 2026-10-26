<script setup lang="ts">
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
watch(
  () => [job.value?.id, job.value?.planRevision],
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
  },
  { immediate: true },
);
async function commit() {
  await action('commit');
  if (job.value?.status === 'committed') await workspace.load();
}
function target(index: number, event: Event) {
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
function restart() {
  if (
    window.confirm(
      '保留原冻结包和任务；请先核对云端。将当前本机修订创建为新的接入预览？',
    )
  )
    void begin(true, true);
}
function chooseRow(index: number, event: Event) {
  const value = (event.target as HTMLSelectElement).value,
    choice = rows.value[index];
  if (choice && (value === 'skip' || value === 'create_copy'))
    choice.action = value;
}
</script>
<template>
  <section v-if="job" class="record-panel" aria-label="游客接入预览">
    <h2>本机游客记录接入</h2>
    <p v-if="job.status === 'committed'" class="notice">
      云端已确认：新增 {{ job.result?.created }} 条，跳过
      {{ job.result?.skipped }} 条。确认只对应这次冻结修订，原本机包仍保留。
    </p>
    <template v-else-if="job.status === 'preview'"
      ><p>
        本机 {{ job.sourceSummary.entries }} 条 /
        {{ job.sourceSummary.categories }} 类；云端
        {{ job.targetSummary.entries }} 条 /
        {{ job.targetSummary.categories }}
        类。默认保留双方，同名事项不合并。过期 {{ job.expiresAt }}
      </p>
      <h3>逐项分类映射</h3>
      <div v-for="(c, index) in categories" :key="c.sourceId" class="form-grid">
        <label>分类名称<input v-model="c.name" maxlength="12" /></label
        ><label>颜色<input v-model="c.color" type="color" /></label
        ><label
          >目标<select
            :value="c.targetId ?? ''"
            @change="target(index, $event)"
          >
            <option value="">保留为新分类</option>
            <option
              v-for="t in workspace.snapshot.value?.categories"
              :key="t.id"
              :value="t.id"
            >
              复用 {{ t.name }} {{ t.color }}
            </option>
          </select></label
        >
      </div>
      <h3>记录计划与来源</h3>
      <details v-for="row in pageRows" :key="row.sourceKey">
        <summary>
          {{ row.source.title }} ·
          {{
            row.action === 'skip'
              ? '跳过'
              : row.action === 'needs_review'
                ? '需要核对'
                : '保留副本'
          }}
        </summary>
        <p>
          {{ row.source.startDate }} — {{ row.source.endDate ?? '未结束' }} ·
          {{ row.source.deletedAt ? '保留回收站状态' : '活动事项' }} ·
          {{ row.focusDays.filter((f) => f.focused).length }} 重点日
        </p>
        <p>{{ row.reason }}</p>
        <label
          >处理<select
            v-if="rows[row.index]"
            :value="rows[row.index]?.action"
            @change="chooseRow(row.index, $event)"
          >
            <option value="skip">跳过此来源</option>
            <option value="create_copy">明确保留为新副本</option>
          </select></label
        >
      </details>
      <div class="actions">
        <button class="secondary" :disabled="page === 0" @click="page--">
          上一页记录</button
        ><span
          >第 {{ page + 1 }} / {{ pageCount }} 页，共
          {{ job.rows.length }} 条</span
        ><button
          class="secondary"
          :disabled="page + 1 >= pageCount"
          @click="page++"
        >
          下一页记录
        </button>
      </div>
      <button
        :disabled="busy"
        @click="
          action('review', {
            expectedPlanRevision: job.planRevision,
            categories,
            rows,
          })
        "
      >
        更新并核对计划</button
      ><button :disabled="busy || !job.canCommit" @click="commit">
        确认接入此计划</button
      ><button class="secondary" :disabled="busy" @click="action('cancel')">
        暂不导入
      </button>
      <p v-if="!job.canCommit">
        请处理分类名称、20 类上限及需要核对的记录后更新计划。
      </p></template
    >
    <p v-else>本次计划已取消或过期，原本机记录保留，可重新准备。</p>
    <button class="secondary" :disabled="busy" @click="action('query')">
      查询原任务状态
    </button>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
  </section>
  <section v-if="operation" class="record-panel">
    <p>
      冻结本机修订 {{ operation.package.packageRevision }} ·
      {{ operation.status }}
    </p>
    <button class="secondary" :disabled="busy" @click="action('query')">
      查询保留的原任务</button
    ><button class="secondary" :disabled="busy" @click="restart">
      明确重新预览当前本机修订
    </button>
  </section>
  <p v-if="error && !job" class="error" role="alert">{{ error }}</p>
</template>
