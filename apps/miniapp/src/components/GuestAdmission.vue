<script setup lang="ts">
import { ref } from 'vue';
import { useAdmission } from '../admission';
import { useWorkspace } from '../workspace';
import AdmissionReview from './AdmissionReview.vue';
const a = useAdmission(),
  w = useWorkspace(),
  details = ref(false);
async function commit() {
  if (!a.job.value?.canCommit || a.busy.value) return;
  const generation = w.generation();
  await a.action('commit');
  if (generation !== w.generation()) return;
  if (a.job.value?.status === 'committed') {
    await w.load();
    if (generation === w.generation())
      w.notice.value = '本机记录已同步到账号，原本机记录仍保留。';
  }
}
</script>
<template>
  <view v-if="a.operation.value?.status === 'pending'" class="card"
    ><text class="heading">同步本机记录</text
    ><template v-if="a.job.value?.status === 'preview' && !details"
      ><text class="text muted"
        >本机有 {{ a.job.value.sourceSummary.entries }} 条记录，账号已有
        {{ a.job.value.targetSummary.entries }}
        条记录。同步会保留原本机记录，不覆盖账号已有事项。</text
      ><button
        :disabled="a.busy.value || !a.job.value.canCommit"
        @click="commit"
      >
        同步到当前账号</button
      ><button class="text-button" @click="details = true">
        {{
          a.job.value.canCommit ? '查看详情' : '需要核对分类，查看详情'
        }}</button
      ><button
        class="text-button"
        :disabled="a.busy.value"
        @click="a.action('cancel')"
      >
        暂不同步
      </button></template
    ><template v-else-if="!details"
      ><text class="text muted">上次同步结果待确认，可查询原任务继续处理。</text
      ><button
        class="secondary"
        :disabled="a.busy.value"
        @click="a.action('query')"
      >
        查询同步状态</button
      ><button class="text-button" @click="details = true">
        查看详情
      </button></template
    ><AdmissionReview v-if="details" /><text
      v-if="a.error.value"
      class="text error"
      >{{ a.error.value }}</text
    ></view
  >
</template>
