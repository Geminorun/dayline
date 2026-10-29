<script setup lang="ts">
import MiniIcon from './MiniIcon.vue';
defineProps<{
  icon: string;
  label: string;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
}>();
defineEmits<{ click: [] }>();
</script>
<template>
  <button
    class="icon-button"
    :class="{ selected: active, 'danger-ink': danger }"
    :aria-label="label"
    :aria-pressed="active"
    :disabled="disabled"
    @click.stop="$emit('click')"
  >
    <MiniIcon :name="icon" />
  </button>
</template>
