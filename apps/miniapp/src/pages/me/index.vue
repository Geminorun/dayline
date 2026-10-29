<script setup lang="ts">
import PageShell from '../../components/PageShell.vue';

import { msg } from '@dayline/locales';

import GuestAdmission from '../../components/GuestAdmission.vue';
import { computed, ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';
import { patchProfileSchema, userDtoSchema } from '@dayline/contracts';
import { useWorkspace, message } from '../../workspace';
import { api } from '../../api';
import AppearanceSettings from '../../appearance/AppearanceSettings.vue';
import SyncStatus from '../../components/SyncStatus.vue';
import MiniIcon from '../../components/MiniIcon.vue';
const {
  mode,
  credentialWarning,
  identityState,
  current,
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
const accountOptions = ref(false),
  editing = ref(false);
const avatar = computed(
  () => [...(current.value?.displayName ?? '日')][0] ?? '日',
);
const name = ref(''),
  base = ref(0);
onShow(async () => {
  await ensure();
  if (!editing.value) {
    name.value = current.value?.displayName ?? '';
    base.value = current.value?.profileVersion ?? 0;
  }
});
watch(
  () => current.value?.id,
  () => {
    editing.value = false;
    accountOptions.value = false;
    name.value = current.value?.displayName ?? '';
    base.value = current.value?.profileVersion ?? 0;
  },
);
watch(current, (next, previous) => {
  if (
    next &&
    previous &&
    next.id === previous.id &&
    next.displayName === previous.displayName
  )
    base.value = next.profileVersion;
});
async function save() {
  const input = patchProfileSchema.safeParse({
    displayName: name.value,
    expectedProfileVersion: base.value,
  });
  if (!input.success) {
    error.value = msg('account.displayNameMustBe140Characters');
    return;
  }
  busy.value = true;
  error.value = '';
  const generation = api.getGeneration();
  try {
    const response = await api.request('/api/v1/me', {
      method: 'PATCH',
      account: true,
      body: input.data,
      decode: userDtoSchema.parse,
    });
    if (response.data && generation === api.getGeneration()) {
      current.value = response.data;
      base.value = response.data.profileVersion;
      notice.value = msg('common.displayNameSaved');
      editing.value = false;
    }
  } catch (cause) {
    if (generation === api.getGeneration()) error.value = message(cause);
  } finally {
    if (generation === api.getGeneration()) busy.value = false;
  }
}
function navigate(url: string) {
  uni.navigateTo({ url });
}
</script>
<template>
  <PageShell>
    <view class="screen-heading"
      ><view
        ><text class="eyebrow">DAYLINE</text
        ><text class="title">我的</text></view
      ><SyncStatus
    /></view>
    <view v-if="identityState === 'unknown'" class="card"
      ><text class="text">暂时无法确认登录状态，本机记录仍保留。</text
      ><button :disabled="busy" @click="restoreSession">重试连接</button></view
    >
    <view class="card profile-card">
      <view class="avatar">{{ avatar }}</view>
      <view class="profile-main"
        ><text class="heading">{{
          current?.displayName || '记录生活，从这里开始'
        }}</text
        ><text class="muted">{{
          mode === 'account' ? '微信账号 · 云端保存' : '游客 · 仅保存在本机'
        }}</text></view
      >
      <button v-if="!current" :disabled="busy || loading" @click="login">
        微信登录
      </button>
      <button
        v-else-if="mode !== 'account'"
        :disabled="busy"
        @click="switchMode('account')"
      >
        进入云端记录
      </button>
    </view>
    <text v-if="!current" class="text muted"
      >无需登录也能记录。微信登录后，可将本机记录同步到账号，换手机后继续回看。</text
    >
    <GuestAdmission v-if="mode === 'account' && current?.status === 'active'" />
    <view class="card"><AppearanceSettings /></view>
    <view class="card menu-list">
      <button class="menu-row" @click="navigate('/pages/categories/index')">
        <MiniIcon name="folder" /><text>分类管理</text
        ><MiniIcon name="chevron-right" />
      </button>
      <button class="menu-row" @click="navigate('/pages/trash/index')">
        <MiniIcon name="trash" /><text>回收站</text
        ><MiniIcon name="chevron-right" />
      </button>
      <button
        v-if="current"
        class="menu-row danger-ink"
        :disabled="busy"
        @click="logout"
      >
        <MiniIcon name="logout" /><text>退出登录</text>
      </button>
    </view>
    <view v-if="current" class="card"
      ><button class="menu-row" @click="accountOptions = !accountOptions">
        <text>账号管理</text><MiniIcon name="chevron-right" /></button
      ><template v-if="accountOptions">
        <view class="settings-row"
          ><text>显示名</text
          ><button class="text-button" @click="editing = !editing">
            {{ editing ? '取消' : '修改' }}
          </button></view
        >
        <view v-if="editing"
          ><input v-model="name" :maxlength="80" aria-label="显示名" /><button
            :disabled="busy || current.status !== 'active'"
            @click="save"
          >
            保存
          </button></view
        >
        <button
          class="menu-row danger-ink"
          @click="navigate('/pages/account/deletion')"
        >
          <text>{{
            current.status === 'pending_deletion'
              ? '注销进度与撤销'
              : '注销账号'
          }}</text
          ><MiniIcon name="chevron-right" />
        </button> </template
    ></view>
    <text v-if="credentialWarning" class="text error">{{
      credentialWarning
    }}</text>
  </PageShell>
</template>
