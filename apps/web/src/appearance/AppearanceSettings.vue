<script setup lang="ts">
import { tr } from '../i18n/index';
import { ref, watch } from 'vue';
import { themePresets } from './presets';
import { useAppearance } from './theme';
const appearance = useAppearance();
const { preferences, resolvedMode, accent, storageError } = appearance;
const modes = [
  {
    value: 'system',
    get label() {
      return tr('common.followTheSystem');
    },
  },
  {
    value: 'light',
    get label() {
      return tr('common.lightColor');
    },
  },
  {
    value: 'dark',
    get label() {
      return tr('common.darkColor');
    },
  },
] as const;
const hex = ref(accent.value),
  invalid = ref(false);
watch(accent, (value) => {
  hex.value = value;
  invalid.value = false;
});
function setColor(event: Event) {
  if (!(event.target instanceof HTMLInputElement)) return;
  invalid.value = !appearance.setAccent(event.target.value);
}
function applyHex() {
  invalid.value = !appearance.setAccent(hex.value);
}
</script>
<template>
  <section
    class="appearance-settings"
    :aria-label="tr('common.appearanceSettings')"
  >
    <div class="settings-row">
      <div>
        <h2>{{ tr('common.colorMode') }}</h2>
        <p>{{ tr('appearance.chooseBetweenLightAndDarkOrSwitch') }}</p>
      </div>
      <div
        class="mode-options"
        role="group"
        :aria-label="tr('common.colorMode')"
      >
        <label
          v-for="mode in modes"
          :key="mode.value"
          :class="{ selected: preferences.mode === mode.value }"
        >
          <input
            type="radio"
            name="color-mode"
            :value="mode.value"
            :checked="preferences.mode === mode.value"
            @change="appearance.setMode(mode.value)"
          />{{ mode.label }}
        </label>
      </div>
    </div>
    <div class="theme-heading">
      <h2>{{ tr('common.themeStyle') }}</h2>
      <p>{{ tr('appearance.keepFamiliarColorsAndFindARecording') }}</p>
    </div>
    <div class="theme-grid" role="group" :aria-label="tr('common.themeStyle')">
      <label
        v-for="theme in themePresets"
        :key="theme.id"
        class="theme-option"
        :class="{ selected: preferences.theme === theme.id }"
      >
        <input
          type="radio"
          name="theme-style"
          :value="theme.id"
          :checked="preferences.theme === theme.id"
          @change="appearance.setTheme(theme.id)"
        />
        <span
          class="theme-preview"
          aria-hidden="true"
          :style="{
            '--preview-bg': theme[resolvedMode].canvas,
            '--preview-surface': theme[resolvedMode].surface,
            '--preview-ink': theme[resolvedMode].ink,
            '--preview-line': theme[resolvedMode].line,
            '--preview-accent':
              preferences.theme === theme.id
                ? accent
                : theme[resolvedMode].accent,
          }"
        >
          <span class="preview-sidebar"><i></i><i></i><i></i></span
          ><span class="preview-content"><b></b><i></i><i></i><i></i></span>
        </span>
        <span class="theme-option-name"
          >{{ theme.name
          }}<span v-if="preferences.theme === theme.id" aria-hidden="true"
            >✓</span
          ></span
        >
        <span class="theme-option-description">{{ theme.description }}</span>
      </label>
    </div>
    <div class="settings-row accent-setting">
      <div>
        <h2>{{ tr('common.themeColor') }}</h2>
        <p>{{ tr('appearance.usedForButtonsSelectedStatesAndFocus') }}</p>
      </div>
      <div class="accent-controls">
        <input
          type="color"
          :value="accent"
          :aria-label="tr('common.selectThemeColor')"
          @input="setColor"
        />
        <input
          v-model="hex"
          class="hex-input"
          :aria-label="tr('common.themeColorHex')"
          :aria-invalid="invalid"
          maxlength="7"
          spellcheck="false"
          @change="applyHex"
          @keydown.enter.prevent="applyHex"
        />
        <button
          v-if="preferences.accent"
          class="settings-link"
          type="button"
          @click="appearance.resetAccent"
        >
          {{ tr('common.useDefaultColor') }}
        </button>
      </div>
    </div>
    <p v-if="invalid" role="alert" class="settings-error">
      {{ tr('appearance.pleaseEnterAValidColorValueSuch') }}
    </p>
    <p v-if="storageError" role="status" class="settings-error">
      {{ storageError }}
    </p>
    <footer class="settings-footer">
      <p>{{ tr('appearance.appearancesAreOnlySavedOnThisDevice') }}</p>
      <button class="settings-link" type="button" @click="appearance.reset">
        {{ tr('common.restoreDefaultAppearance') }}
      </button>
    </footer>
  </section>
</template>
