<script setup lang="ts">
import { tr } from '../i18n/index';
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import { useWorkspace } from '../records/workspace';
import PlannerIcon from './PlannerIcon.vue';
const workspace = useWorkspace();
const phase = ref<'idle' | 'working' | 'done' | 'error'>('idle');
const toast = ref<{ text: string; error: boolean } | null>(null);
const manual = ref(false);
const working = computed(() => workspace.loading.value || workspace.busy.value);
let startTimer: ReturnType<typeof setTimeout> | undefined;
let finishTimer: ReturnType<typeof setTimeout> | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
function clearTimers() {
  clearTimeout(startTimer);
  clearTimeout(finishTimer);
}
watch(
  [working, workspace.error],
  ([active, error], previous) => {
    clearTimers();
    if (error) {
      phase.value = 'error';
      return;
    }
    if (active) {
      if (phase.value !== 'working') phase.value = 'idle';
      startTimer = setTimeout(() => {
        phase.value = 'working';
      }, 150);
    } else if (previous?.[0] && (phase.value === 'working' || manual.value)) {
      phase.value = 'done';
      finishTimer = setTimeout(() => {
        phase.value = 'idle';
        manual.value = false;
      }, 1200);
    } else {
      phase.value = 'idle';
      manual.value = false;
    }
  },
  { immediate: true },
);
watch(workspace.notice, (text) => {
  if (!text || workspace.error.value) return;
  clearTimeout(toastTimer);
  toast.value = { text, error: false };
  toastTimer = setTimeout(() => {
    toast.value = null;
  }, 3000);
});
watch(
  workspace.error,
  (text) => {
    if (text) {
      clearTimeout(toastTimer);
      toast.value = { text, error: true };
    } else if (toast.value?.error) toast.value = null;
  },
  { immediate: true },
);
const label = computed(
  () =>
    workspace.error.value ||
    (working.value
      ? workspace.busy.value
        ? tr('common.savingChanges')
        : tr('common.updatingRecord')
      : phase.value === 'done'
        ? tr('common.recordUpdated')
        : workspace.mode.value === 'guest'
          ? tr('syncStatus.recordsAreSavedOnThisDeviceClick')
          : tr('common.clickToUpdateCloudRecords')),
);
function refresh() {
  if (workspace.retrySeconds.value > 0) return;
  manual.value = true;
  void workspace.load();
}
onBeforeUnmount(() => {
  clearTimers();
  clearTimeout(toastTimer);
});
</script>
<template>
  <div class="sync-status">
    <button
      class="sync-button"
      :class="`sync-${phase}`"
      :aria-label="tr('common.refreshRecord')"
      :title="label"
      :aria-busy="working"
      :disabled="working || workspace.retrySeconds.value > 0"
      @click="refresh"
    >
      <PlannerIcon v-if="phase === 'error'" name="alert" />
      <PlannerIcon v-else-if="phase === 'done'" name="check" />
      <svg v-else class="sync-ring" viewBox="0 0 24 24" aria-hidden="true">
        <circle class="sync-ring-track" cx="12" cy="12" r="8.5" />
        <path d="M12 3.5a8.5 8.5 0 0 1 8.5 8.5M12 20.5A8.5 8.5 0 0 1 3.5 12" />
        <circle class="sync-ring-center" cx="12" cy="12" r="1.4" />
      </svg>
    </button>
    <span class="sr-only" role="status" aria-live="polite">{{
      manual || phase === 'error' ? label : ''
    }}</span>
    <Teleport to="body"
      ><div
        v-if="toast"
        class="workspace-toast"
        :class="{ 'toast-error': toast.error }"
        :role="toast.error ? 'alert' : 'status'"
      >
        <PlannerIcon :name="toast.error ? 'alert' : 'check'" /><span>{{
          toast.text
        }}</span>
        <button
          v-if="toast.error"
          class="toast-retry"
          :disabled="working || workspace.retrySeconds.value > 0"
          @click="refresh"
        >
          {{
            workspace.retrySeconds.value
              ? tr('syncStatus.retryInSeconds', {
                  value0: workspace.retrySeconds.value,
                })
              : tr('common.tryAgain')
          }}</button
        ><button
          class="icon-btn"
          :aria-label="tr('common.closePrompt')"
          @click="toast = null"
        >
          ×
        </button>
      </div></Teleport
    >
  </div>
</template>
