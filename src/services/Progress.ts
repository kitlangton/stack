import * as Console from "effect/Console";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Terminal from "../terminal.ts";

export type ProgressEvent =
  | { readonly _tag: "Step"; readonly message: string }
  | { readonly _tag: "Wait"; readonly message: string };

export interface Interface {
  readonly emit: (event: ProgressEvent) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()("@stack/Progress") {}

export const render = (event: ProgressEvent, options: Terminal.StyleOptions = {}) => {
  switch (event._tag) {
    case "Step":
      return `${Terminal.paint(options, Terminal.color.green, "→")} ${event.message}`;
    case "Wait":
      return `${Terminal.paint(options, Terminal.color.yellow, "…")} ${event.message}`;
  }
};

export const noop = Layer.succeed(Service, Service.of({ emit: () => Effect.void }));

export const live = Layer.succeed(
  Service,
  Service.of({ emit: (event) => Console.log(render(event, { pretty: true })) }),
);

export const memory = (events: Array<ProgressEvent>) =>
  Layer.succeed(
    Service,
    Service.of({
      emit: (event) => Effect.sync(() => events.push(event)),
    }),
  );
