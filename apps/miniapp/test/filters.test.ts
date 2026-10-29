import { mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import { emptyFilter } from '@dayline/core';
import Filters from '../src/components/Filters.vue';
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it('does not search pinyin during composition, then commits Chinese and cancels delayed searches on clearing', async () => {
  vi.useFakeTimers();
  const w = mount(Filters, {
    props: { modelValue: emptyFilter(), categories: [] },
  });
  try {
    const input = w.get('input');
    await input.trigger('compositionstart');
    await input.setValue('zhong');
    await vi.advanceTimersByTimeAsync(500);
    expect(w.emitted('update:modelValue')).toBeUndefined();
    await input.setValue('中文');
    await input.trigger('compositionend');
    expect(w.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      search: '中文',
    });
    await input.setValue('later');
    await w.setProps({ modelValue: { ...emptyFilter(), search: '中文' } });
    await w.get('[aria-label="清除筛选"]').trigger('click');
    await vi.advanceTimersByTimeAsync(500);
    expect(w.emitted('update:modelValue')?.at(-1)?.[0]).toMatchObject({
      search: '',
    });
  } finally {
    w.unmount();
  }
});
