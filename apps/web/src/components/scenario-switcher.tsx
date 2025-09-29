"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { type ChangeEvent, useMemo, useTransition } from "react";

import { BASELINE_SCENARIO_ID } from "@/lib/scenario-constants";
import type { ScenarioOption } from "@/types/scenario";

type Props = {
  scenarios: ScenarioOption[];
  activeScenarioId: string;
};

export function ScenarioSwitcher({ scenarios, activeScenarioId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const options = useMemo(() => {
    return scenarios.map((scenario) => ({
      id: scenario.id,
      label: scenario.label,
    }));
  }, [scenarios]);

  const handleChange = (event: ChangeEvent<HTMLSelectElement>) => {
    const nextValue = event.target.value;
    startTransition(() => {
      const params = new URLSearchParams(searchParams?.toString() ?? "");
      if (!nextValue || nextValue === BASELINE_SCENARIO_ID) {
        params.delete("scenario");
      } else {
        params.set("scenario", nextValue);
      }
      const queryString = params.toString();
      router.push(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false });
    });
  };

  return (
    <label className="scenario-switcher">
      <span className="scenario-switcher__label">Scenario</span>
      <select
        className="scenario-switcher__select"
        value={activeScenarioId}
        onChange={handleChange}
        disabled={isPending}
      >
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
      </select>
      {isPending ? <span className="scenario-switcher__spinner" aria-hidden>…</span> : null}
    </label>
  );
}
