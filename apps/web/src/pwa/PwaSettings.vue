<script setup lang="ts">
import { tr } from '../i18n';
import { pwa } from './client';
const { state } = pwa;
</script>
<template>
  <section class="account-settings pwa-settings">
    <div class="settings-row">
      <div>
        <h2>{{ tr('pwa.app') }}</h2>
        <p>{{ tr(state.installed ? 'pwa.installed' : 'pwa.installHint') }}</p>
      </div>
      <button
        v-if="!state.installed"
        class="settings-link"
        @click="pwa.install"
      >
        {{ tr('pwa.install') }}
      </button>
      <button
        v-if="state.updateAvailable"
        class="settings-link"
        :disabled="state.offline || state.updating"
        @click="pwa.showUpdateHelp(true)"
      >
        {{ tr('pwa.update') }}
      </button>
      <button
        v-else-if="state.installed"
        class="settings-link"
        :disabled="state.offline || state.checking"
        @click="pwa.checkUpdate(true)"
      >
        {{ tr('pwa.checkUpdate') }}
      </button>
    </div>
    <p class="muted">
      {{
        tr(
          state.failed
            ? 'pwa.cacheFailed'
            : state.offlineReady
              ? 'pwa.offlineReady'
              : 'pwa.cachePending',
        )
      }}
      {{ tr('pwa.offlineHint') }}
      <span v-if="state.checked && !state.updateAvailable" role="status">{{
        tr('pwa.upToDate')
      }}</span>
    </p>
  </section>
</template>
