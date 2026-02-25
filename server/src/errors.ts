import { Data } from "effect";

export class ConfigError extends Data.TaggedError("ConfigError")<{
  readonly message: string;
}> {}

export class PolymarketError extends Data.TaggedError("PolymarketError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class OrderError extends Data.TaggedError("OrderError")<{
  readonly message: string;
  readonly orderId?: string;
}> {}

export class FeedError extends Data.TaggedError("FeedError")<{
  readonly source: string;
  readonly message: string;
}> {}

export class PersistenceError extends Data.TaggedError("PersistenceError")<{
  readonly path: string;
  readonly message: string;
}> {}

export class RiskRejection extends Data.TaggedError("RiskRejection")<{
  readonly reason: string;
}> {}

export class AuthError extends Data.TaggedError("AuthError")<{
  readonly message: string;
}> {}
