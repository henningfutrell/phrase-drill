import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  // `.stryker-tmp` holds Stryker's sandbox — a full copy of the repo with the
  // source deliberately broken (T043). Linting it reports hundreds of errors
  // about code nobody wrote, and a failed or interrupted mutation run leaves
  // the directory behind, so this cannot rely on the run cleaning up.
  { ignores: ['dist', '.stryker-tmp', 'reports'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      ecmaVersion: 2023,
      globals: globals.browser,
    },
    plugins: {
      'react-hooks': reactHooks,
      'react-refresh': reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': [
        'warn',
        { allowConstantExport: true },
      ],
      // `lib` is ES2023 (tsconfig.app.json) and this is ES2024, so `tsc -b`
      // refuses it (TS2550). Raise `lib` only once the phone's Safari is known
      // to be 17.4 or later; until then the executor form is the rule here.
      'no-restricted-properties': [
        'error',
        {
          object: 'Promise',
          property: 'withResolvers',
          message:
            'ES2024, and lib is ES2023 (tsconfig.app.json): write new Promise((resolve, reject) => …) instead.',
        },
      ],
    },
  },
)
