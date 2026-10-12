import babelParser from '@babel/eslint-parser';

const correctness = {
  'constructor-super': 'error', 'for-direction': 'error', 'getter-return': 'error',
  'no-async-promise-executor': 'error', 'no-compare-neg-zero': 'error',
  'no-cond-assign': ['error', 'always'], 'no-constant-binary-expression': 'error',
  'no-debugger': 'error', 'no-dupe-args': 'error', 'no-dupe-class-members': 'error',
  'no-dupe-else-if': 'error', 'no-dupe-keys': 'error', 'no-duplicate-case': 'error',
  'no-empty-character-class': 'error', 'no-ex-assign': 'error', 'no-fallthrough': 'error',
  'no-import-assign': 'error', 'no-loss-of-precision': 'error', 'no-new-native-nonconstructor': 'error',
  'no-prototype-builtins': 'error',
  'no-self-assign': 'error', 'no-setter-return': 'error', 'no-unexpected-multiline': 'error',
  'no-unreachable': 'error', 'no-unsafe-finally': 'error', 'no-unsafe-negation': 'error',
  'no-unsafe-optional-chaining': 'error', 'use-isnan': 'error', 'valid-typeof': 'error',
};

export default [
  { ignores: ['node_modules/**', 'src/generated/**', 'dist/**', '.artifacts/**', '.local/**', '.tmp/**'] },
  { files: ['src/**/*.ts', 'prisma.config.ts'], languageOptions: {
    parser: babelParser, parserOptions: { requireConfigFile: false, babelOptions: {
      plugins: ['@babel/plugin-syntax-typescript', ['@babel/plugin-syntax-decorators', { version: '2023-11' }]],
    } },
  }, rules: correctness },
  { files: ['scripts/**/*.mjs', 'test/**/*.mjs', 'eslint.config.mjs'], rules: correctness },
];
