<script setup lang="ts">
import { computed } from 'vue';
import { useWorkspace } from '../workspace';
import MiniIcon from './MiniIcon.vue';
const w = useWorkspace();
const label = computed(() =>
  w.retrySeconds.value > 0
    ? `请等待 ${w.retrySeconds.value} 秒后重试`
    : w.error.value ||
      w.notice.value ||
      (w.loading.value
        ? '正在更新'
        : w.busy.value
          ? '正在保存'
          : w.mode.value === 'guest'
            ? '仅本机保存'
            : '云端记录'),
);
function refresh() {
  if (w.identityState.value === 'unknown') return w.restoreSession();
  return w.load();
}
</script>
<template>
  <view class="sync-status"
    ><button
      class="sync-trigger"
      :disabled="w.loading.value || w.busy.value || w.retrySeconds.value > 0"
      :aria-label="label"
      @click="refresh"
    >
      <view
        v-if="w.loading.value || w.busy.value"
        class="sync-spinner"
      /><MiniIcon
        v-else
        :name="w.error.value ? 'warning' : 'check'"
        :size="14"
      /><text>{{ label }}</text></button
    ><view
      v-if="w.error.value || w.notice.value"
      class="sync-toast"
      :class="{ error: !!w.error.value }"
      role="status"
      ><text>{{
        w.retrySeconds.value
          ? `操作过于频繁，请等待 ${w.retrySeconds.value} 秒后重试。`
          : w.error.value || w.notice.value
      }}</text
      ><button
        class="text-button"
        :disabled="w.loading.value || w.retrySeconds.value > 0"
        @click="w.error.value ? refresh() : w.dismissNotice()"
      >
        {{ w.error.value ? '重试' : '关闭' }}
      </button></view
    ></view
  >
</template>
