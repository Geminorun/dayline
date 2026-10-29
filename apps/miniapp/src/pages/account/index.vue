<script setup lang="ts">
import { tr } from '../../i18n/index';
import { onLoad } from '@dcloudio/uni-app';
onLoad(() => uni.switchTab({ url: '/pages/me/index' }));
</script>
<template>
  <view class="page"
    ><text class="text">{{ tr('mini.enteringMy') }}</text></view
  >
</template>
