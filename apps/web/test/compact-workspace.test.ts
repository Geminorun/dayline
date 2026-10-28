import { mount, flushPromises } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import { createGuestPackage } from '@dayline/contracts';
import CategoryTabs from '../src/components/CategoryTabs.vue';
import InlineSearch from '../src/components/InlineSearch.vue';
it('reorders categories by accessible keyboard control and rolls back failed saves', async () => {
  const categories = createGuestPackage(
    () => crypto.randomUUID(),
    new Date().toISOString(),
  ).categories;
  const reorder = vi.fn(async () => {});
  const w = mount(CategoryTabs, {
    props: { categories, selected: '', disabled: false, reorder },
    global: { stubs: { RouterLink: { template: '<a><slot/></a>' } } },
  });
  try {
    const first = w.get('.category-tab');
    await first.trigger('keydown', { key: 'ArrowRight', altKey: true });
    await flushPromises();
    expect(reorder).toHaveBeenCalledWith([
      categories[1]?.id,
      categories[0]?.id,
      ...categories.slice(2).map((c) => c.id),
    ]);
    reorder.mockRejectedValueOnce(new Error('network failure'));
    await w
      .get('.category-tab')
      .trigger('keydown', { key: 'ArrowRight', altKey: true });
    await flushPromises();
    expect(
      w.findAll('.category-tab').map((b) => b.attributes('data-id')),
    ).toEqual(categories.map((c) => c.id));
    expect(w.get('[role=alert]').text()).toContain('未保存');
  } finally {
    w.unmount();
  }
});
it('expands search inline, retains active queries on blur and clears with Escape', async () => {
  const w = mount(InlineSearch, {
    props: {
      modelValue: '',
      'onUpdate:modelValue': (v: string) => {
        void w.setProps({ modelValue: v });
      },
    },
    attachTo: document.body,
  });
  try {
    expect(w.find('input').exists()).toBe(false);
    await w.get('button').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(w.get('input').element);
    await w.get('input').setValue('读书');
    await w.get('input').trigger('blur');
    expect(w.find('input').exists()).toBe(true);
    await w.get('input').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(w.find('input').exists()).toBe(false);
    expect(document.activeElement).toBe(w.get('button').element);
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['']);
  } finally {
    w.unmount();
  }
});
