<script setup lang="ts">
import { ref } from 'vue';
import { CATEGORY_PALETTE } from '@dayline/core';
import { useAppearance, themePresets } from './theme';
import type { AppearanceMode } from '@dayline/core';
import BottomSheet from '../components/BottomSheet.vue';
import MiniIcon from '../components/MiniIcon.vue';
const a = useAppearance(),
  colorsOpen = ref(false),
  custom = ref(''),
  invalid = ref(false);
const modes: { id: AppearanceMode; name: string }[] = [
  { id: 'system', name: '跟随系统' },
  { id: 'light', name: '浅色' },
  { id: 'dark', name: '深色' },
];
function color(value: string | null) {
  if (a.setAccent(value)) {
    invalid.value = false;
    colorsOpen.value = false;
  } else invalid.value = true;
}
</script>
<template>
  <view class="section-heading"><text class="heading">外观</text></view
  ><view class="segmented"
    ><button
      v-for="mode in modes"
      :key="mode.id"
      :class="{ selected: a.preferences.mode === mode.id }"
      @click="a.setMode(mode.id)"
    >
      {{ mode.name }}
    </button></view
  ><view class="theme-grid"
    ><button
      v-for="theme in themePresets"
      :key="theme.id"
      class="theme-choice"
      :class="{ selected: a.preferences.theme === theme.id }"
      :aria-label="theme.name"
      @click="a.setTheme(theme.id)"
    >
      <view
        class="theme-swatch"
        :style="{
          backgroundColor: theme[a.resolvedMode.value].canvas,
          borderColor: theme[a.resolvedMode.value].line,
        }"
        ><view
          :style="{
            backgroundColor: theme[a.resolvedMode.value].accent,
          }" /></view
      ><text>{{ theme.name }}</text>
    </button></view
  ><button
    class="menu-row"
    @click="
      colorsOpen = true;
      custom = a.preferences.accent ?? a.palette.value.accent;
    "
  >
    <text>主题色</text><text :style="{ color: a.tokens.value.accent }">●</text
    ><MiniIcon name="palette" /></button
  ><text v-if="a.storageError.value" class="text error">{{
    a.storageError.value
  }}</text
  ><BottomSheet v-if="colorsOpen" title="主题色" @close="colorsOpen = false"
    ><view class="accent-swatches"
      ><button
        v-for="value in CATEGORY_PALETTE"
        :key="value"
        :style="{ backgroundColor: value }"
        :aria-label="'使用主题色 ' + value"
        @click="color(value)" /></view
    ><text class="text muted">自定义颜色</text
    ><input
      v-model="custom"
      :maxlength="7"
      placeholder="#315C4D"
      aria-label="自定义主题色"
    /><text v-if="invalid" class="text error"
      >请输入有效颜色，例如 #315C4D。</text
    ><button @click="color(custom)">应用</button
    ><button class="secondary" @click="color(null)">
      恢复主题默认色
    </button></BottomSheet
  >
</template>
<style scoped>
.accent-swatches {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 16rpx;
  margin: 20rpx 0;
}
.accent-swatches button {
  width: 44px;
  height: 44px;
  padding: 0;
  margin: 0;
  border: 1px solid var(--line);
  border-radius: 50%;
}
</style>
