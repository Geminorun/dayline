<script setup lang="ts">
import { onLoad } from '@dcloudio/uni-app';
onLoad(() => uni.switchTab({ url: '/pages/me/index' }));
</script>
<template>
  <view class="page"><text class="text">正在进入“我的”…</text></view>
</template>
