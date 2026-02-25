import { useContext, useLayoutEffect, type ReactNode } from "react";
import { render } from "@testing-library/react";
import { RegistryContext, RegistryProvider } from "@effect-rx/rx-react";

export type RegistryLike = {
  set: (atom: unknown, value: unknown) => void;
  get: (atom: unknown) => unknown;
  update: (atom: unknown, fn: (current: unknown) => unknown) => void;
};

export function renderWithRegistry(
  ui: ReactNode,
  seed?: (registry: RegistryLike) => void,
) {
  function Seed() {
    const registry = useContext(RegistryContext) as RegistryLike;

    useLayoutEffect(() => {
      seed?.(registry);
    }, [registry]);

    return null;
  }

  return render(
    <RegistryProvider>
      <Seed />
      {ui}
    </RegistryProvider>,
  );
}
