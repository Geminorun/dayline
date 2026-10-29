<script setup lang="ts">
import {
  computed,
  getCurrentInstance,
  nextTick,
  onMounted,
  onUpdated,
  ref,
} from 'vue';
import IconButton from './IconButton.vue';
defineProps<{ title: string }>();
defineEmits<{ close: [] }>();
const contentHeight = ref(280),
  screenHeight = ref(700),
  instance = getCurrentInstance();
const height = computed(() =>
  Math.max(80, Math.min(screenHeight.value * 0.64, contentHeight.value)),
);
function measure() {
  if (typeof uni === 'undefined') return;
  screenHeight.value = uni.getSystemInfoSync?.().windowHeight ?? 700;
  if (typeof uni.createSelectorQuery !== 'function') return;
  let query = uni.createSelectorQuery();
  if (instance?.proxy) query = query.in(instance.proxy);
  query
    .select('.sheet-inner')
    .boundingClientRect((rect) => {
      if (!Array.isArray(rect) && rect.height)
        contentHeight.value = Math.ceil(rect.height);
    })
    .exec();
}
onMounted(() => void nextTick(measure));
onUpdated(() => void nextTick(measure));
</script>
<template>
  <view class="sheet-mask" @click="$emit('close')" @touchmove.stop.prevent
    ><view class="sheet" @click.stop @touchmove.stop
      ><view class="sheet-header"
        ><text class="heading">{{ title }}</text
        ><IconButton icon="close" label="关闭" @click="$emit('close')" /></view
      ><scroll-view
        scroll-y
        class="sheet-content"
        :style="{ height: height + 'px' }"
        ><view class="sheet-inner"><slot /></view></scroll-view></view
  ></view>
</template>
