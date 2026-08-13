/**
 * Resolves a `--locale` code to the Faker locale chains the generator uses.
 *
 * Faker is locale-aware: point it at a `de`/`fr`/`ja` locale and names, emails,
 * companies, phone numbers, and address parts all come out in that locale
 * instead of US English. This module maps a locale code (e.g. `de`, `pt_BR`,
 * `en_GB`) onto the locale definition chains the two generator fakers are built
 * from, always appending `en` as a fallback so a locale that's missing a given
 * data category degrades to English rather than throwing.
 *
 * One thing stays US-only: the intra-row *address* coherence that makes a `zip`
 * fall inside its `state` and a `city` actually sit in it (see coherence.ts).
 * That relies on en_US's postcode-by-state and a curated city list; Faker
 * exposes no equivalent reverse mapping for other locales. So `usAddress` is
 * true only for the default (no `--locale`) and an explicit `en_US`; under any
 * other locale the address columns are still generated in-locale, just without
 * the cross-field guarantee.
 */

import { en, en_US, allLocales, type LocaleDefinition } from "@faker-js/faker";

export interface LocaleResolution {
  /** Locale chain for the main generator faker (the requested locale, then en). */
  main: LocaleDefinition[];
  /** Locale chain for the coherence faker (requested locale, then en_US, then en). */
  coherence: LocaleDefinition[];
  /** Whether US-specific address coherence (zip-in-state, curated cities,
   *  "United States") applies. True for the default and en_US only. */
  usAddress: boolean;
}

/** Faker keys `allLocales` with underscores (`en_US`, `pt_BR`); accept dashes too. */
const normalize = (code: string) => code.trim().replace(/-/g, "_");

/** Every usable locale code, sorted, for error messages (`base` is internal). */
export function availableLocales(): string[] {
  return Object.keys(allLocales)
    .filter((k) => k !== "base")
    .sort();
}

/**
 * Resolve a `--locale` code (or `undefined` for the default) into the faker
 * locale chains and the US-address flag. The default returns exactly the chains
 * the generator has always used, so an unqualified run's seeded output is
 * unchanged. An unknown code throws with the list of valid ones.
 */
export function resolveLocale(code?: string): LocaleResolution {
  if (code === undefined) {
    return { main: [en], coherence: [en_US, en], usAddress: true };
  }
  const key = normalize(code);
  const def = (allLocales as Record<string, LocaleDefinition | undefined>)[key];
  if (!def || key === "base") {
    throw new Error(
      `Unknown --locale '${code}'. Available: ${availableLocales().join(", ")}`,
    );
  }
  return {
    main: [def, en],
    coherence: [def, en_US, en],
    usAddress: key === "en_US",
  };
}
