<script setup lang="ts">
import { ref } from 'vue';
import { tr } from '../i18n';
import PlannerDialog from '../components/PlannerDialog.vue';
import PlannerIcon from '../components/PlannerIcon.vue';
import { pwa } from './client';
import { canReload } from './reload-guards';
import { useWorkspace } from '../records/workspace';
const { state } = pwa;
const workspace = useWorkspace();
const dismissed = ref(false),
  checking = ref(false);
async function update() {
  if (checking.value || workspace.busy.value) return;
  checking.value = true;
  try {
    if (await canReload()) pwa.update();
  } finally {
    checking.value = false;
    pwa.showUpdateHelp(false);
  }
}
</script>
<template>
  <aside
    v-if="state.updateAvailable && !dismissed"
    class="pwa-update"
    role="status"
  >
    <PlannerIcon name="refresh" />
    <span>{{
      tr(state.failed ? 'pwa.updateFailed' : 'pwa.updateAvailable')
    }}</span>
    <button
      class="settings-link"
      :disabled="state.offline || state.updating"
      @click="pwa.showUpdateHelp(true)"
    >
      {{ tr('pwa.update') }}
    </button>
    <button
      class="icon-btn"
      :aria-label="tr('pwa.later')"
      :title="tr('pwa.later')"
      @click="dismissed = true"
    >
      <PlannerIcon name="close" />
    </button>
  </aside>
  <PlannerDialog
    v-if="state.updateHelp"
    :label="tr('pwa.update')"
    @close="pwa.showUpdateHelp(false)"
  >
    <section class="pwa-help">
      <h2>{{ tr('pwa.update') }}</h2>
      <p>{{ tr('pwa.updateHint') }}</p>
      <div class="pwa-actions">
        <button class="settings-link" @click="pwa.showUpdateHelp(false)">
          {{ tr('common.cancel') }}
        </button>
        <button
          class="settings-primary"
          :disabled="checking || workspace.busy.value || state.offline"
          @click="update"
        >
          {{ tr('pwa.reload') }}
        </button>
      </div>
    </section>
  </PlannerDialog>
  <PlannerDialog
    v-if="state.installHelp"
    :label="tr('pwa.install')"
    @close="pwa.showInstallHelp(false)"
  >
    <section class="pwa-help">
      <header>
        <h2>{{ tr('pwa.install') }}</h2>
        <button
          class="icon-btn"
          :aria-label="tr('common.closePrompt')"
          @click="pwa.showInstallHelp(false)"
        >
          <PlannerIcon name="close" />
        </button>
      </header>
      <p>{{ tr('pwa.installHint') }}</p>
      <ul>
        <li>{{ tr('pwa.appleHint') }}</li>
        <li>{{ tr('pwa.browserHint') }}</li>
      </ul>
      <p class="muted">{{ tr('pwa.offlineHint') }}</p>
    </section>
  </PlannerDialog>
</template>
