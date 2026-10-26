import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = Symbol('IS_PUBLIC');
export const ALLOW_PENDING_DELETION = Symbol('ALLOW_PENDING_DELETION');
export const Public = () => SetMetadata(IS_PUBLIC, true);
export const AllowPendingDeletion = () =>
  SetMetadata(ALLOW_PENDING_DELETION, true);
