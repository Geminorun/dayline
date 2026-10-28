import { randomUUID } from 'node:crypto';
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createGuestPackage, type GuestMutation } from '@dayline/contracts';
import { nextCategoryColor } from '@dayline/core';
import CategoryManager from '../src/records/CategoryManager.vue';
import PasswordInput from '../src/components/PasswordInput.vue';
import ColorPicker from '../src/components/ColorPicker.vue';

describe('category tools and themed controls', () => {
  it('keeps names inline, uses versioned palette updates and retains explicit trash confirmation for deletion', async () => {
    const data = createGuestPackage(randomUUID, new Date().toISOString());
    const category = data.categories[0],
      target = data.categories[1];
    if (!category || !target) throw new Error('categories');
    const mutate = vi.fn<
      (mutation: GuestMutation, cloud: () => Promise<unknown>) => Promise<void>
    >(async () => {});
    const w = mount(CategoryManager, {
      props: {
        categories: data.categories,
        dataVersion: '1',
        entries: [],
        busy: false,
        mutate,
      },
    });
    try {
      const rename = w.get(`button[aria-label="重命名${category.name}"]`);
      expect(rename.attributes('title')).toBe(`重命名${category.name}`);
      expect(rename.text()).toBe('');
      await rename.trigger('click');
      await w.get('form input').setValue('新名称');
      await w.get('form').trigger('submit');
      await flushPromises();
      expect(mutate).toHaveBeenLastCalledWith(
        {
          kind: 'updateCategory',
          id: category.id,
          input: {
            expectedVersion: category.version,
            name: '新名称',
            color: category.color,
          },
        },
        expect.any(Function),
      );
      await w
        .get(`button[aria-label="更改${category.name}颜色"]`)
        .trigger('click');
      await w
        .findAll('.color-palette')[0]
        ?.findAll('.color-swatch')[0]
        ?.trigger('click');
      await flushPromises();
      expect(mutate).toHaveBeenLastCalledWith(
        {
          kind: 'updateCategory',
          id: category.id,
          input: {
            expectedVersion: category.version,
            name: category.name,
            color: '#6CA58A',
          },
        },
        expect.any(Function),
      );
      await w
        .get(`button[aria-label="删除${category.name}分类"]`)
        .trigger('click');
      expect(mutate).toHaveBeenCalledTimes(2);
      await w.get('.category-delete-confirm .danger').trigger('click');
      expect(mutate).toHaveBeenLastCalledWith(
        {
          kind: 'deleteCategory',
          id: category.id,
          input: {
            expectedVersion: category.version,
            mode: 'trash',
            expectedDataVersion: '1',
            fallbackCategoryId: expect.any(String),
          },
        },
        expect.any(Function),
      );
      await flushPromises();
      await w.get('.category-add').trigger('click');
      await w.get('form input').setValue('新分类');
      await w.get('form').trigger('submit');
      expect(mutate.mock.calls.at(-1)?.[0]).toMatchObject({
        kind: 'createCategory',
        input: {
          name: '新分类',
          color: nextCategoryColor(data.categories.map((c) => c.color)),
        },
      });
    } finally {
      w.unmount();
    }
  });
  it('keeps native password semantics and toggles visibility without submitting', async () => {
    const w = mount(PasswordInput, {
      props: { modelValue: 'secret-value' },
      attrs: { autocomplete: 'current-password', disabled: false },
    });
    try {
      expect(w.get('input').attributes('autocomplete')).toBe(
        'current-password',
      );
      await w.get('button[aria-label="显示密码"]').trigger('click');
      expect(w.get('input').attributes('type')).toBe('text');
      expect(w.get('button').attributes('type')).toBe('button');
      await w.setProps({ modelValue: '' });
      expect(w.get('input').attributes('type')).toBe('password');
    } finally {
      w.unmount();
    }
  });
});

it('waits for native custom-color confirmation before emitting a save, rather than persisting every preview movement', async () => {
  const w = mount(ColorPicker, { props: { modelValue: '#123456' } });
  try {
    const picker = w.get<HTMLInputElement>('input[type=color]');
    picker.element.value = '#abcdef';
    await picker.trigger('input');
    expect(w.emitted('update:modelValue')).toBeUndefined();
    await picker.trigger('change');
    expect(w.emitted('update:modelValue')).toEqual([['#ABCDEF']]);
  } finally {
    w.unmount();
  }
});
