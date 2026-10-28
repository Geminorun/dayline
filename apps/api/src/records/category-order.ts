import type { Prisma } from '../generated/prisma/client.js';
/** Every category creator appends under its already-held user lock. */
export async function nextCategoryPosition(
  tx: Prisma.TransactionClient,
  userId: string,
) {
  const value = await tx.category.aggregate({
    where: { userId },
    _max: { sortOrder: true },
  });
  return (value._max.sortOrder ?? -1) + 1;
}
export const categoryOrder = [
  { sortOrder: 'asc' },
  { createdAt: 'asc' },
  { id: 'asc' },
] satisfies Prisma.CategoryOrderByWithRelationInput[];
