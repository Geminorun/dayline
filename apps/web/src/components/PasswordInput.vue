<script setup lang="ts">
import { ref, watch } from 'vue';
import IconButton from './IconButton.vue';
defineOptions({ inheritAttrs: false });
const props = defineProps<{ modelValue: string }>();
const emit = defineEmits<{ 'update:modelValue': [value: string] }>();
const visible = ref(false);
watch(
  () => props.modelValue,
  (value) => {
    if (!value) visible.value = false;
  },
);
function input(event: Event) {
  if (event.target instanceof HTMLInputElement)
    emit('update:modelValue', event.target.value);
}
</script>
<template>
  <span class="password-control">
    <input
      v-bind="$attrs"
      :type="visible ? 'text' : 'password'"
      :value="modelValue"
      @input="input"
    />
    <IconButton
      :icon="visible ? 'eye-off' : 'eye'"
      :label="visible ? '隐藏密码' : '显示密码'"
      :disabled="$attrs.disabled !== undefined && $attrs.disabled !== false"
      :aria-pressed="visible"
      @click.prevent="visible = !visible"
    />
  </span>
</template>
