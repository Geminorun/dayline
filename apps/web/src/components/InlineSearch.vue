<script setup lang="ts">
import { tr } from '../i18n/index';
import { nextTick, ref, watch, onBeforeUnmount } from 'vue';
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
const query = ref(props.modelValue),
  composing = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  () => props.modelValue,
  (value) => {
    if (!composing.value) query.value = value;
  },
);
function update(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  query.value = event.target.value;
  clearTimeout(timer);
  if (composing.value || (event instanceof InputEvent && event.isComposing))
    return;
  timer = setTimeout(() => emit('update:modelValue', query.value), 150);
}
function compositionStart() {
  composing.value = true;
  clearTimeout(timer);
}
function compositionEnd(event: CompositionEvent) {
  composing.value = false;
  update(event);
  clearTimeout(timer);
  emit('update:modelValue', query.value);
}
function keydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.isComposing || composing.value) return;
  event.preventDefault();
  clearTimeout(timer);
  query.value = '';
  void escape();
}
onBeforeUnmount(() => clearTimeout(timer));
function close() {
  if (!query.value) opened.value = false;
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
      :aria-label="tr('common.searchEntry')"
      :title="tr('common.searchEntry')"
      :aria-expanded="Boolean(opened || modelValue)"
      @click="open"
    >
      <PlannerIcon name="search" />
    </button>
    <input
      v-if="opened || modelValue"
      ref="input"
      :value="query"
      type="search"
      :aria-label="tr('common.searchEntryName')"
      :placeholder="tr('common.searchEntry2')"
      @input="update"
      @blur="close"
      @compositionstart="compositionStart"
      @compositionend="compositionEnd"
      @keydown="keydown"
    />
  </div>
</template>
