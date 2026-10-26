export interface Actor {
  userId: string;
  sessionId: string;
  authEpoch: number;
  transport: 'cookie' | 'bearer';
}

declare module 'express-serve-static-core' {
  interface Request {
    requestId: string;
    actor?: Actor;
  }
}
