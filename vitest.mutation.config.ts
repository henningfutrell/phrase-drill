import { configDefaults, defineConfig, mergeConfig } from 'vitest/config'
import baseConfig from './vite.config'

/**
 * The vitest config the mutation gate (T043) runs under: the root config with
 * exactly one test file removed, and nothing else changed.
 *
 * `pwa.build.test.ts` shells out to a real `npm run build`. Stryker re-runs
 * the covering tests once per mutant, and at seconds-per-build across
 * hundreds of mutants that is hours spent rebuilding a bundle no domain
 * mutant can affect.
 *
 * Everything else stays — including the adapter and screen tests, which cost
 * almost nothing here because `coverageAnalysis: "perTest"` runs only the
 * tests that actually touch each mutant. Narrowing this to the domain's own
 * test files would be faster and dishonest: a mutant in `ports.ts` that
 * `parseLibraryFile`'s adapter test kills would be reported as surviving,
 * and the gate would demand a duplicate domain test to satisfy an artefact
 * of its own configuration.
 */
export default mergeConfig(
  baseConfig,
  defineConfig({
    test: {
      // Spelled out rather than left to mergeConfig's array handling: if that
      // ever replaces instead of concatenating, an implicit version of this
      // list would silently lose `node_modules`.
      exclude: [
        ...configDefaults.exclude,
        '.stryker-tmp/**',
        'pwa.build.test.ts',
      ],
    },
  }),
)
