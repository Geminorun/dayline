<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from 'vue';
import { api } from './api';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { localRepository } from './adapters/local-repository';
import { errorMessage } from './records/record-service';
const account = useAccount(),
  workspace = useWorkspace();
const busy = ref(false),
  error = ref(''),
  notice = ref(''),
  warning = ref(false),
  warningText = ref(''),
  selected = ref<'csv' | 'json'>('json');
let intent = 0;
onBeforeUnmount(() => {
  intent++;
});
watch(
  () => `${account.current.value?.id}:${workspace.mode.value}`,
  () => {
    intent++;
    busy.value = false;
    error.value = '';
    notice.value = '';
    warning.value = false;
    warningText.value = '';
  },
  { flush: 'sync' },
);
async function download(format: 'csv' | 'json', confirmed = false) {
  const id = account.current.value?.id,
    generation = api.getGeneration(),
    space = workspace.generation(),
    own = intent;
  if (!id || workspace.mode.value !== 'account' || busy.value) return;
  const current = () =>
    own === intent &&
    generation === api.getGeneration() &&
    space === workspace.generation() &&
    id === account.current.value?.id &&
    workspace.mode.value === 'account';
  busy.value = true;
  error.value = '';
  selected.value = format;
  try {
    if (!confirmed) {
      let drafts: Awaited<ReturnType<typeof localRepository.drafts>>;
      try {
        drafts = await localRepository.drafts(id);
      } catch {
        if (current()) {
          warningText.value =
            '本机草稿暂时无法读取，原始数据保留。可明确继续只导出云端记录，未提交输入不会混入备份。';
          warning.value = true;
        }
        return;
      }
      if (!current()) return;
      if (drafts.length) {
        warningText.value =
          '有未提交草稿。可先单独保留，或明确继续只导出云端记录。';
        warning.value = true;
        return;
      }
    }
    warning.value = false;
    const response = await api.request(`/api/v1/exports/${format}`, {
      native: true,
      account: true,
      decode: (v: unknown) => {
        if (typeof v !== 'string') throw new Error('文件未生成');
        return v;
      },
    });
    if (!current() || !response.data) return;
    const url = URL.createObjectURL(
      new Blob([response.data], {
        type:
          format === 'csv'
            ? 'text/csv;charset=utf-8'
            : 'application/json;charset=utf-8',
      }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download = `dayline-${new Date().toISOString().slice(0, 10)}.${format}`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    notice.value = '文件已生成，请妥善保管。仅含云端已保存记录。';
  } catch (e) {
    if (current()) error.value = errorMessage(e);
  } finally {
    if (current()) busy.value = false;
  }
}
</script>
<template>
  <section
    v-if="account.current.value && workspace.mode.value === 'account'"
    class="record-panel"
  >
    <h2>导出已保存记录</h2>
    <p>
      CSV 包含活动事项，完整 JSON
      包含分类、重点及仍保留的回收站。未提交草稿单独保留，不混入云端备份。导出直接读取服务器，不依赖本机完整缓存或普通快照。
    </p>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status" class="notice">{{ notice }}</p>
    <button :disabled="busy" @click="download('csv')">导出 CSV</button
    ><button :disabled="busy" @click="download('json')">导出完整 JSON</button>
    <div v-if="warning" role="status">
      <p>{{ warningText }}</p>
      <button :disabled="busy" @click="download(selected, true)">
        继续只导出云端记录</button
      ><RouterLink to="/drafts">复制或下载草稿</RouterLink>
    </div>
  </section>
</template>
