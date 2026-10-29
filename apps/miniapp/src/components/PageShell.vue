<script setup lang="ts">
import { onMounted } from 'vue';
import { useAppearance } from '../appearance/theme';
const { themeStyle, applyNativeTheme } = useAppearance();
onMounted(applyNativeTheme);
</script>
<template>
  <view class="page" :style="themeStyle"><slot /></view>
</template>
