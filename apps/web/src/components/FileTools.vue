<script setup lang="ts">
import { defineAsyncComponent, ref } from 'vue';
import PlannerIcon from './PlannerIcon.vue';
import PlannerDialog from './PlannerDialog.vue';
import { useWorkspace } from '../records/workspace';
const workspace = useWorkspace();
const DataPage = defineAsyncComponent(() => import('../DataPage.vue'));
const action = ref<'import' | 'export' | null>(null);
</script>
<template>
  <div class="file-tools" role="group" aria-label="导入与导出">
    <button
      class="icon-btn"
      type="button"
      aria-label="导入记录"
      :disabled="workspace.readonly.value"
      title="导入 CSV / JSON"
      @click="action = 'import'"
    >
      <PlannerIcon name="upload" />
    </button>
    <button
      class="icon-btn"
      type="button"
      aria-label="导出记录"
      title="导出 CSV / JSON"
      @click="action = 'export'"
    >
      <PlannerIcon name="download" />
    </button>
    <PlannerDialog
      v-if="action"
      :label="action === 'import' ? '导入记录' : '导出记录'"
      class="data-dialog"
      :class="{ 'data-export-dialog': action === 'export' }"
      @close="action = null"
    >
      <button
        class="icon-btn manager-close"
        aria-label="关闭数据工具"
        @click="action = null"
      >
        ×
      </button>
      <DataPage :action="action" />
    </PlannerDialog>
  </div>
</template>
