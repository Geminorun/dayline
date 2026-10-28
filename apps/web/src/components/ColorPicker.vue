<script setup lang="ts">
import { ref, useId } from 'vue';
import { CATEGORY_PALETTE, nextCategoryColor } from '@dayline/core';
import IconButton from './IconButton.vue';
import PlannerIcon from './PlannerIcon.vue';
const props = withDefaults(
  defineProps<{
    modelValue: string;
    label?: string;
    disabled?: boolean;
    used?: string[];
  }>(),
  { label: '更改颜色', disabled: false, used: () => [] },
);
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const id = useId();
const panel = ref<HTMLElement | null>(null);
const position = ref({ left: '0px', top: '0px' });
function locate(event: MouseEvent) {
  const target = event.currentTarget;
  if (!(target instanceof HTMLElement)) return;
  const rect = target.getBoundingClientRect();
  position.value = {
    left: `${Math.max(12, Math.min(rect.right - 268, window.innerWidth - 280))}px`,
    top: `${Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 290))}px`,
  };
}
function choose(color: string) {
  if (props.disabled) return;
  emit('update:modelValue', color);
  panel.value?.hidePopover?.();
}
function custom(event: Event) {
  if (event.target instanceof HTMLInputElement)
    choose(event.target.value.toUpperCase());
}
</script>
<template>
  <span class="color-picker">
    <IconButton
      icon="palette"
      :label="label"
      :disabled="disabled"
      :popovertarget="id"
      :style="{ '--chosen-color': modelValue }"
      class="color-picker-trigger"
      @click="locate"
    />
    <div :id="id" ref="panel" popover class="color-palette" :style="position">
      <p class="palette-heading">分类颜色</p>
      <div class="color-swatches" role="group" aria-label="选择分类颜色">
        <button
          v-for="color in CATEGORY_PALETTE"
          :key="color"
          type="button"
          class="color-swatch"
          :style="{ backgroundColor: color }"
          :aria-label="`颜色 ${color}`"
          :aria-pressed="modelValue.toUpperCase() === color"
          :title="color"
          :disabled="disabled"
          @click="choose(color)"
        >
          <PlannerIcon v-if="modelValue.toUpperCase() === color" name="check" />
        </button>
      </div>
      <div class="palette-footer">
        <button
          type="button"
          class="button subtle"
          :disabled="disabled"
          @click="choose(nextCategoryColor(used))"
        >
          <PlannerIcon name="wand" />自动推荐
        </button>
        <label class="color-custom"
          >自定义<input
            type="color"
            :value="modelValue"
            :disabled="disabled"
            @change="custom"
        /></label>
      </div>
    </div>
  </span>
</template>
