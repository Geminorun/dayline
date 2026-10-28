<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { patchProfileSchema, userDtoSchema } from '@dayline/contracts';
import { api } from './api';
import { useAccount } from './account';
import { useWorkspace } from './records/workspace';
import { errorMessage } from './records/record-service';
import AppearanceSettings from './appearance/AppearanceSettings.vue';
const account = useAccount(),
  workspace = useWorkspace();
const { current } = account;
const tab = ref<'appearance' | 'account'>('appearance');
const name = ref(''),
  base = ref(0),
  editingName = ref(false),
  busy = ref(false),
  error = ref(''),
  notice = ref('');
function useCurrentProfile() {
  name.value = current.value?.displayName ?? '';
  base.value = current.value?.profileVersion ?? 0;
  editingName.value = false;
}
watch(
  () => current.value?.id,
  () => {
    useCurrentProfile();
    error.value = '';
    notice.value = '';
  },
);
onMounted(async () => {
  await workspace.ensure();
  if (!editingName.value) useCurrentProfile();
});
function selectTab(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  tab.value = tab.value === 'appearance' ? 'account' : 'appearance';
  document.getElementById(`settings-tab-${tab.value}`)?.focus();
}
async function save() {
  if (busy.value) return;
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
  notice.value = '';
  try {
    const generation = api.getGeneration();
    await api.request('/api/v1/me', {
      method: 'PATCH',
      account: true,
      body: input.data,
      decode: userDtoSchema.parse,
    });
    if (generation !== api.getGeneration()) return;
    await account.refresh();
    if (generation !== api.getGeneration()) return;
    useCurrentProfile();
    notice.value = '显示名已保存。';
  } catch (cause) {
    error.value = errorMessage(cause);
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="settings-page">
    <header class="settings-heading">
      <h1>设置</h1>
      <p>调整外观，管理你的账号。</p>
    </header>
    <nav
      class="settings-tabs"
      role="tablist"
      aria-label="设置分类"
      @keydown="selectTab"
    >
      <button
        id="settings-tab-appearance"
        role="tab"
        :aria-selected="tab === 'appearance'"
        :tabindex="tab === 'appearance' ? 0 : -1"
        aria-controls="settings-appearance"
        @click="tab = 'appearance'"
      >
        外观
      </button>
      <button
        id="settings-tab-account"
        role="tab"
        :aria-selected="tab === 'account'"
        :tabindex="tab === 'account' ? 0 : -1"
        aria-controls="settings-account"
        @click="tab = 'account'"
      >
        账号与安全
      </button>
    </nav>
    <div
      v-if="tab === 'appearance'"
      id="settings-appearance"
      role="tabpanel"
      aria-labelledby="settings-tab-appearance"
    >
      <AppearanceSettings />
    </div>
    <section
      v-else
      id="settings-account"
      role="tabpanel"
      aria-labelledby="settings-tab-account"
      class="account-settings"
    >
      <template v-if="current">
        <p v-if="error" role="alert" class="settings-error">{{ error }}</p>
        <p v-if="notice" role="status" class="settings-success">{{ notice }}</p>
        <div class="settings-row">
          <div>
            <h2>显示名</h2>
            <p>{{ current.displayName }}</p>
          </div>
          <button
            v-if="!editingName"
            class="settings-link"
            :disabled="current.status !== 'active'"
            @click="
              useCurrentProfile();
              editingName = true;
            "
          >
            编辑
          </button>
          <form v-else class="profile-edit" @submit.prevent="save">
            <label class="sr-only" for="profile-name">显示名</label
            ><input
              id="profile-name"
              v-model="name"
              required
              maxlength="40"
              :disabled="busy"
            />
            <button class="settings-primary" :disabled="busy">保存</button
            ><button
              type="button"
              class="settings-link"
              :disabled="busy"
              @click="useCurrentProfile"
            >
              取消
            </button>
          </form>
        </div>
        <div class="settings-row">
          <div>
            <h2>邮箱</h2>
            <p>
              {{ current.email ?? '尚未绑定邮箱'
              }}<span v-if="current.email" class="settings-badge">{{
                current.emailVerified ? '已验证' : '待验证'
              }}</span>
            </p>
          </div>
          <RouterLink
            v-if="current.status === 'active'"
            class="settings-link"
            to="/identity"
            >管理</RouterLink
          >
        </div>
        <div class="settings-row">
          <div>
            <h2>微信</h2>
            <p>
              {{ current.wechatBound ? '已关联微信账号' : '尚未关联微信账号' }}
            </p>
          </div>
          <RouterLink
            v-if="current.status === 'active'"
            class="settings-link"
            to="/identity"
            >{{ current.wechatBound ? '管理' : '关联' }}</RouterLink
          >
        </div>
        <div class="settings-row">
          <div>
            <h2>登录密码</h2>
            <p>
              {{
                current.passwordEnabled
                  ? '使用邮箱和密码登录。'
                  : '绑定邮箱后，可设置登录密码。'
              }}
            </p>
          </div>
          <RouterLink
            v-if="current.passwordEnabled && current.status === 'active'"
            class="settings-link"
            to="/change-password"
            >修改密码</RouterLink
          >
        </div>
        <details class="settings-advanced">
          <summary>更多账号操作</summary>
          <RouterLink class="settings-detail-link" to="/identity"
            ><span
              >关联或合并账号<small
                >确认邮箱或微信身份后，管理两个账号的记录。</small
              ></span
            ><span aria-hidden="true">›</span></RouterLink
          >
          <RouterLink
            class="settings-detail-link settings-danger"
            to="/account-deletion"
            ><span
              >{{
                current.status === 'pending_deletion'
                  ? '查看或撤销账号注销'
                  : '注销账号'
              }}<small>查看注销规则与恢复期限。</small></span
            ><span aria-hidden="true">›</span></RouterLink
          >
        </details>
      </template>
      <div v-else class="settings-empty">
        <h2>登录后管理账号</h2>
        <p>登录后可以修改资料、关联微信和管理密码。外观设置随时可用。</p>
        <RouterLink class="settings-primary" to="/login">登录·注册</RouterLink>
      </div>
    </section>
  </section>
</template>
