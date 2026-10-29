<script setup lang="ts">
import PageShell from '../../components/PageShell.vue';
import { tr } from '../../i18n/index';
import { onLoad } from '@dcloudio/uni-app';
onLoad(() => uni.switchTab({ url: '/pages/me/index' }));
</script>
<template>
  <PageShell
    ><text class="text">{{ tr('mini.enteringMy') }}</text></PageShell
  >
</template>
