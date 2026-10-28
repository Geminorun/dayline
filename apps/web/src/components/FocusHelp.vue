<script setup lang="ts">
import { useId } from 'vue';
import PlannerIcon from './PlannerIcon.vue';
defineProps<{
  date: string;
  count: number;
  future: boolean;
  selected?: boolean;
}>();
const emit = defineEmits<{ toggle: [] }>();
const id = useId();
</script>
<template>
  <span class="focus-help">
    <button
      type="button"
      class="icon-btn"
      :aria-describedby="id"
      :class="{ 'is-active': selected }"
      :aria-pressed="!!selected"
      @click="emit('toggle')"
      :aria-label="`${date}的重点：${count}项，${selected ? '显示全部事项' : '只看重点'}`"
    >
      <PlannerIcon name="star" /><span v-if="count" class="focus-help-count">{{
        count
      }}</span>
    </button>
    <span :id="id" role="tooltip" class="focus-help-tooltip"
      ><strong>{{ date }}的重点 · {{ count }} 项</strong
      ><span>{{
        future
          ? '可以记录今天及过去日期的重点。'
          : '点击只看当天重点。建议每天选择 1–2 项，可切换日期补记。'
      }}</span></span
    >
  </span>
</template>
