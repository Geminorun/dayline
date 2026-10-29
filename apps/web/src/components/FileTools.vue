<script setup lang="ts">
import { tr } from '../i18n/index';
import { defineAsyncComponent, onMounted, ref } from 'vue';
import PlannerIcon from './PlannerIcon.vue';
import FileToolLoading from './FileToolLoading.vue';
import type DataPageComponent from '../DataPage.vue';
import PlannerDialog from './PlannerDialog.vue';
import { useWorkspace } from '../records/workspace';
const workspace = useWorkspace();
let pendingPage: Promise<{ default: typeof DataPageComponent }> | null = null;
function preload() {
  pendingPage ??= import('../DataPage.vue').catch((cause: unknown) => {
    pendingPage = null;
    throw cause;
  });
  return pendingPage;
}
function warm() {
  void preload().catch(() => {});
}
const DataPage = defineAsyncComponent({
  loader: preload,
  delay: 0,
  loadingComponent: FileToolLoading,
});
onMounted(warm);
const action = ref<'import' | 'export' | null>(null);
const detailed = ref(false);
</script>
<template>
  <div
    class="file-tools"
    role="group"
    :aria-label="tr('common.importAndExport')"
  >
    <button
      class="icon-btn"
      type="button"
      :aria-label="tr('common.importRecords')"
      :disabled="workspace.readonly.value"
      :title="tr('fileTools.importCsvJson')"
      @pointerenter="warm"
      @focus="warm"
      @click="action = 'import'"
    >
      <PlannerIcon name="upload" />
    </button>
    <button
      class="icon-btn"
      type="button"
      :aria-label="tr('common.exportRecords')"
      :title="tr('fileTools.exportCsvJson')"
      @pointerenter="warm"
      @focus="warm"
      @click="action = 'export'"
    >
      <PlannerIcon name="download" />
    </button>
    <PlannerDialog
      v-if="action"
      :label="
        action === 'import'
          ? tr('common.importRecords')
          : tr('common.exportRecords')
      "
      class="data-dialog"
      :class="{ 'data-detail-dialog': action === 'import' && detailed }"
      @close="action = null"
    >
      <button
        class="icon-btn manager-close"
        :aria-label="tr('common.closeDataTools')"
        @click="action = null"
      >
        <PlannerIcon name="close" />
      </button>
      <DataPage
        :action="action"
        @imported="action = null"
        @close="action = null"
        @view-change="detailed = $event === 'details'"
      />
    </PlannerDialog>
  </div>
</template>
