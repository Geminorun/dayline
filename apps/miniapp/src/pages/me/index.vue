<script setup lang="ts">
import { ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { patchProfileSchema, userDtoSchema } from '@dayline/contracts';
import { useWorkspace, message } from '../../workspace';
import { api } from '../../api';
const {
  mode,
  current,
  snapshot,
  busy,
  loading,
  error,
  notice,
  ensure,
  switchMode,
  login,
  restoreSession,
  logout,
} = useWorkspace();
const name = ref(''),
  base = ref(0);
onShow(async () => {
  await ensure();
  name.value = current.value?.displayName ?? '';
  base.value = current.value?.profileVersion ?? 0;
});
watch(
  () => current.value?.id,
  () => {
    name.value = current.value?.displayName ?? '';
    base.value = current.value?.profileVersion ?? 0;
  },
);
async function save() {
  const input = patchProfileSchema.safeParse({
    displayName: name.value,
    expectedProfileVersion: base.value,
  });
  if (!input.success) {
    error.value = '显示名须为 1–40 字。';
    return;
  }
  busy.value = true;
  error.value = '';
  try {
    const response = await api.request('/api/v1/me', {
      method: 'PATCH',
      account: true,
      body: input.data,
      decode: userDtoSchema.parse,
    });
    if (response.data) {
      current.value = response.data;
      base.value = response.data.profileVersion;
      notice.value = '显示名已保存。';
    }
  } catch (cause) {
    error.value = message(cause);
  } finally {
    busy.value = false;
  }
}
function navigate(url: string) {
  uni.navigateTo({ url });
}
</script>
<template>
  <view class="page"
    ><text class="subtitle">DAYLINE</text><text class="title">我的日序</text
    ><text v-if="loading" class="text">正在读取…</text
    ><text v-if="error" class="text error">{{ error }}</text
    ><text v-if="notice" class="text notice">{{ notice }}</text
    ><view class="card"
      ><text class="heading">{{
        mode === 'guest' ? '游客 · 仅本机保存' : '已验证账号 · 云端记录'
      }}</text
      ><text class="text muted">{{
        mode === 'guest'
          ? '本机记录仅存在此设备；清除存储后无法找回。'
          : '在线保存，当前页面未保存的输入不会自动补传。'
      }}</text
      ><text v-if="snapshot" class="text"
        >{{ snapshot.entries.length }} 条活动事项 ·
        {{ snapshot.categories.length }} 个分类</text
      ><button class="secondary" :disabled="busy" @click="switchMode('guest')">
        继续使用游客本机记录</button
      ><button v-if="current" :disabled="busy" @click="switchMode('account')">
        进入已验证账号记录</button
      ><template v-else
        ><button :disabled="busy" @click="login">微信登录</button
        ><button class="secondary" :disabled="busy" @click="restoreSession">
          读取已有会话并进入账号
        </button></template
      ><text class="text muted"
        >游客与账号记录分别保留。游客登录接入将在下一阶段开放；当前不会自动导入或删除。</text
      ></view
    ><view v-if="current" class="card"
      ><text class="heading">账号资料</text
      ><text class="text">{{ current.displayName }}</text
      ><text class="text"
        >邮箱：{{ current.email ?? '尚未绑定真实邮箱' }} ·
        {{ current.emailVerified ? '已验证' : '未验证' }}</text
      ><text class="text"
        >微信：{{ current.wechatBound ? '已关联' : '尚未关联' }}</text
      ><text class="text"
        >密码：{{ current.passwordEnabled ? '已启用' : '未启用' }}</text
      ><text v-if="current.status !== 'active'" class="text notice"
        >账号受限 · 注销到期 {{ current.deletionDueAt }}</text
      ><text class="text">显示名</text
      ><input v-model="name" aria-label="显示名" /><button
        :disabled="busy || current.status !== 'active'"
        @click="save"
      >
        保存显示名</button
      ><button class="secondary" :disabled="busy" @click="logout">
        退出当前账号
      </button></view
    ><view class="card"
      ><button class="secondary" @click="navigate('/pages/categories/index')">
        分类管理</button
      ><button class="secondary" @click="navigate('/pages/trash/index')">
        回收站</button
      ><text class="text muted"
        >CSV / JSON 文件请在网页端操作（阶段 5
        开放）；绑定合并与自助注销将在后续阶段开放。</text
      ></view
    ></view
  >
</template>
