<script setup lang="ts">
import { tr } from '../i18n';
</script>
<template>
  <div class="file-tool-loading" role="status" aria-live="polite">
    <span class="file-loading-ring"></span
    ><span>{{ tr('fileToolLoading.preparingFileTool') }}</span>
  </div>
</template>
