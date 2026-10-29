<script setup lang="ts">
import { computed } from 'vue';
import { iconPaths } from './icon-paths';
import { useAppearance } from '../appearance/theme';
const props = withDefaults(
  defineProps<{ name: string; color?: string; size?: number }>(),
  { size: 20 },
);
const { palette } = useAppearance();
const source = computed(() => {
  const body =
    iconPaths[
      props.name === 'chevron-right'
        ? 'chevron'
        : props.name === 'warning'
          ? 'alert'
          : props.name
    ] ?? iconPaths.check;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${props.color ?? palette.value.ink}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
  if (
    typeof uni !== 'undefined' &&
    typeof uni.arrayBufferToBase64 === 'function'
  ) {
    const bytes = Uint8Array.from(svg, (character) => character.charCodeAt(0));
    return 'data:image/svg+xml;base64,' + uni.arrayBufferToBase64(bytes.buffer);
  }
  return 'data:image/svg+xml,' + encodeURIComponent(svg);
});
</script>
<template>
  <image
    class="mini-icon"
    :src="source"
    :style="{ width: size + 'px', height: size + 'px' }"
    aria-hidden="true"
  />
</template>
