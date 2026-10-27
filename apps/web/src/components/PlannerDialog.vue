<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue';
defineProps<{ label: string }>();
const emit = defineEmits<{ close: [] }>();
const dialog = ref<HTMLDialogElement | null>(null);
onMounted(() => {
  if (typeof dialog.value?.showModal === 'function') dialog.value.showModal();
  else dialog.value?.setAttribute('open', '');
  dialog.value
    ?.querySelector<HTMLInputElement>('input:not([type=hidden])')
    ?.focus();
});
onBeforeUnmount(() => {
  if (typeof dialog.value?.close === 'function') dialog.value.close();
});
</script>
<template>
  <dialog
    ref="dialog"
    class="modal planner-dialog"
    :aria-label="label"
    @cancel.prevent="emit('close')"
    @click="
      (event) => {
        if (event.target === dialog) emit('close');
      }
    "
  >
    <div class="planner-dialog-content"><slot /></div>
  </dialog>
</template>
