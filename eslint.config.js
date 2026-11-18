import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';
export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', '.tools/**', '.model-audit/**', '.cache/**',
    'test-results/**', 'playwright-report/**', 'coverage/**', 'apps/web/public/runtime/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { languageOptions: { globals: { ...globals.browser, ...globals.node, ...globals.worker, chrome: 'readonly' } }, rules: { '@typescript-eslint/no-explicit-any': 'off' } },
);
