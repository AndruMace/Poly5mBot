import { Effect, PubSub, Queue } from "effect";
import type { EngineEvent } from "../types.js";

export class EventBus extends Effect.Service<EventBus>()("EventBus", {
  effect: Effect.gen(function* () {
    const pubsub = yield* PubSub.unbounded<EngineEvent>();

    const publish = (event: EngineEvent) => PubSub.publish(pubsub, event);

    const subscribe = Effect.gen(function* () {
      const queue = yield* PubSub.subscribe(pubsub);
      return queue;
    });

    return { publish, subscribe, pubsub } as const;
  }),
}) {}
