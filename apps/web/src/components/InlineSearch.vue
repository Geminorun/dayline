<script setup lang="ts">
import { nextTick, ref } from 'vue';
import PlannerIcon from './PlannerIcon.vue';
const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const opened = ref(false),
  input = ref<HTMLInputElement | null>(null);
const trigger = ref<HTMLButtonElement | null>(null);
async function open() {
  opened.value = true;
  await nextTick();
  input.value?.focus();
}
function update(event: Event) {
  if (event.target instanceof HTMLInputElement)
    emit('update:modelValue', event.target.value);
}
function close() {
  if (!props.modelValue) opened.value = false;
}
async function escape() {
  emit('update:modelValue', '');
  opened.value = false;
  await nextTick();
  trigger.value?.focus();
}
</script>
<template>
  <div class="inline-search" :class="{ 'is-expanded': opened || modelValue }">
    <button
      ref="trigger"
      type="button"
      class="icon-btn"
      aria-label="搜索事项"
      title="搜索事项"
      :aria-expanded="Boolean(opened || modelValue)"
      @click="open"
    >
      <PlannerIcon name="search" />
    </button>
    <input
      v-if="opened || modelValue"
      ref="input"
      :value="modelValue"
      type="search"
      aria-label="搜索事项名称"
      placeholder="搜索事项…"
      @input="update"
      @blur="close"
      @keydown.esc.prevent="escape"
    />
  </div>
</template>
