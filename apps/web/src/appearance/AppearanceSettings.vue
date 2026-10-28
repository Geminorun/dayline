<script setup lang="ts">
import { ref, watch } from 'vue';
import { themePresets } from './presets';
import { useAppearance } from './theme';
const appearance = useAppearance();
const { preferences, resolvedMode, accent, storageError } = appearance;
const modes = [
  { value: 'system', label: '跟随系统' },
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
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
  <section class="appearance-settings" aria-label="外观设置">
    <div class="settings-row">
      <div>
        <h2>颜色模式</h2>
        <p>选择明暗，或随设备设置切换。</p>
      </div>
      <div class="mode-options" role="group" aria-label="颜色模式">
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
      <h2>主题风格</h2>
      <p>保留熟悉的配色，找到适合自己的记录空间。</p>
    </div>
    <div class="theme-grid" role="group" aria-label="主题风格">
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
        <h2>主题色</h2>
        <p>用于按钮、选中状态和焦点，分类颜色保持独立。</p>
      </div>
      <div class="accent-controls">
        <input
          type="color"
          :value="accent"
          aria-label="选择主题色"
          @input="setColor"
        />
        <input
          v-model="hex"
          class="hex-input"
          aria-label="主题色 HEX"
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
          使用预设色
        </button>
      </div>
    </div>
    <p v-if="invalid" role="alert" class="settings-error">
      请输入有效色值，例如 #315C4D。
    </p>
    <p v-if="storageError" role="status" class="settings-error">
      {{ storageError }}
    </p>
    <footer class="settings-footer">
      <p>外观仅保存在此设备，游客也可以使用。</p>
      <button class="settings-link" type="button" @click="appearance.reset">
        恢复默认外观
      </button>
    </footer>
  </section>
</template>
