const guards = new Set<() => Promise<boolean>>();
export function registerReloadGuard(guard: () => Promise<boolean>) {
  guards.add(guard);
  return () => {
    guards.delete(guard);
  };
}
export async function canReload() {
  for (const guard of guards) if (!(await guard())) return false;
  return true;
}
