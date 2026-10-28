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
it('retains committed results during Chinese composition and applies the chosen characters only', async () => {
  vi.useFakeTimers();
  const w = mount(InlineSearch, { props: { modelValue: '原来的搜索' } });
  try {
    const input = w.get('input');
    await input.trigger('compositionstart');
    await input.setValue('yue');
    await vi.advanceTimersByTimeAsync(500);
    expect(w.emitted('update:modelValue')).toBeUndefined();
    await input.trigger('keydown', { key: 'Escape', isComposing: true });
    expect(w.find('input').exists()).toBe(true);
    await input.setValue('阅读');
    await input.trigger('compositionend');
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['阅读']);
    await input.setValue('阅读书籍');
    await vi.advanceTimersByTimeAsync(150);
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['阅读书籍']);
  } finally {
    w.unmount();
    vi.useRealTimers();
  }
});
it('zooms around the pointer and allows an item click immediately after panning', async () => {
  const { default: TimelineView } =
    await import('../src/records/TimelineView.vue');
  const { timelineCanvasWindow } = await import('@dayline/core');
  const today = '2026-10-28',
    now = `${today}T00:00:00.000Z`;
  const entry = {
    id: crypto.randomUUID(),
    categoryId: crypto.randomUUID(),
    title: '缩放与查看',
    startDate: '2026-10-26',
    endDate: null,
    version: 1,
    focusVersion: 1,
    deletedAt: null,
    purgeAfter: null,
    createdAt: now,
    updatedAt: now,
  };
  const w = mount(TimelineView, {
    props: {
      entries: [entry],
      focusDays: [],
      today,
      scale: 'month',
      anchor: today,
    },
  });
  try {
    const viewport = w.get<HTMLElement>('.timeline-viewport');
    viewport.element.setPointerCapture = vi.fn();
    viewport.element.hasPointerCapture = vi.fn(() => true);
    viewport.element.releasePointerCapture = vi.fn();
    const before = timelineCanvasWindow([entry], today, 'month', undefined, 80);
    viewport.element.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        clientX: 40,
        bubbles: true,
        cancelable: true,
      }),
    );
    const camera =
      w.emitted<{ day: number; days: number }[]>('camera')?.[0]?.[0];
    expect(camera).toBeDefined();
    if (!camera) throw new Error('Missing zoom camera');
    const after = timelineCanvasWindow(
      [entry],
      today,
      'quarter',
      camera.day,
      80,
      camera.days,
    );
    expect(before.start + 0.5 * 31).toBeCloseTo(
      after.start + 0.5 * camera.days,
      6,
    );
    viewport.element.dispatchEvent(
      new WheelEvent('wheel', {
        deltaY: 100,
        clientX: 40,
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    );
    expect(w.emitted('camera')).toHaveLength(1);
    function pointer(target: Element, type: string, x: number, id = 1) {
      const event = new MouseEvent(type, {
        button: 0,
        clientX: x,
        bubbles: true,
      });
      Object.defineProperty(event, 'pointerId', { value: id });
      target.dispatchEvent(event);
    }
    pointer(w.get('.timeline-track').element, 'pointerdown', 40);
    pointer(viewport.element, 'pointermove', 60);
    expect(w.emitted('camera')).toHaveLength(2);
    pointer(viewport.element, 'pointerup', 60);
    const item = w.get('.gantt-row-title button');
    pointer(item.element, 'pointerdown', 60, 2);
    await item.trigger('click');
    expect(w.emitted('view')?.[0]?.[0]).toEqual(entry);
  } finally {
    w.unmount();
  }
});
