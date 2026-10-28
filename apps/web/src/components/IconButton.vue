<script setup lang="ts">
import PlannerIcon from './PlannerIcon.vue';
withDefaults(defineProps<{ icon: string; label: string; danger?: boolean }>(), {
  danger: false,
});
</script>
<template>
  <button
    type="button"
    class="icon-btn tool-button"
    :class="{ 'tool-danger': danger }"
    :aria-label="label"
    :title="label"
  >
    <PlannerIcon :name="icon" />
  </button>
</template>
