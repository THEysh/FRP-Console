'use strict';
/* 最小化 ESLint 配置：只为了让「引用了不存在的函数/变量」这类错误在 CI 里被抓住。
 *
 * 起因：1.2.183 里 syncCertToServerNginx 调用了不存在的 activeConnection()，
 * `node --check` 只查语法、抓不到，直接发到线上，真机点「部署到 nginx」才炸。
 * 之前试过用正则自建符号表（tools/check-undefined.cjs），被仓库里大量正则字面量
 * 与模板字符串搞得满屏假阳性，已删；改用真正的解析器。
 *
 * 规则只开「确定是 bug」的那几条，风格类一律不开，避免历史代码大面积报错。 */

const NODE_GLOBALS = {
  require: 'readonly', module: 'writable', exports: 'writable', process: 'readonly', console: 'readonly',
  Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly', global: 'readonly', globalThis: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  setImmediate: 'readonly', clearImmediate: 'readonly', queueMicrotask: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextEncoder: 'readonly', TextDecoder: 'readonly',
  AbortController: 'readonly', AbortSignal: 'readonly', fetch: 'readonly', structuredClone: 'readonly',
  performance: 'readonly', crypto: 'readonly', atob: 'readonly', btoa: 'readonly',
  WebSocket: 'readonly', EventSource: 'readonly',
};

const BROWSER_GLOBALS = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  localStorage: 'readonly', sessionStorage: 'readonly', history: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', getComputedStyle: 'readonly',
  HTMLElement: 'readonly', Element: 'readonly', Node: 'readonly', NodeList: 'readonly', Event: 'readonly',
  CustomEvent: 'readonly', KeyboardEvent: 'readonly', MouseEvent: 'readonly', ResizeObserver: 'readonly',
  MutationObserver: 'readonly', Blob: 'readonly', File: 'readonly', FileReader: 'readonly', FormData: 'readonly',
  Image: 'readonly', Audio: 'readonly', CSS: 'readonly', DOMParser: 'readonly', XMLHttpRequest: 'readonly',
  alert: 'readonly', confirm: 'readonly', prompt: 'readonly', matchMedia: 'readonly', scrollTo: 'readonly',
  PointerEvent: 'readonly', DragEvent: 'readonly', WheelEvent: 'readonly', FocusEvent: 'readonly',
  ClipboardEvent: 'readonly', InputEvent: 'readonly', KeyboardEvent: 'readonly' === 'x' ? 'readonly' : 'readonly',
  HTMLElement: 'readonly', HTMLSpanElement: 'readonly', HTMLTextAreaElement: 'readonly', HTMLInputElement: 'readonly',
  HTMLButtonElement: 'readonly', HTMLDivElement: 'readonly', HTMLSelectElement: 'readonly', HTMLOptionElement: 'readonly',
  HTMLAnchorElement: 'readonly', HTMLImageElement: 'readonly', HTMLLabelElement: 'readonly', HTMLFormElement: 'readonly',
  HTMLCanvasElement: 'readonly', SVGElement: 'readonly', Range: 'readonly', Selection: 'readonly',
  IntersectionObserver: 'readonly', getSelection: 'readonly',
  ...NODE_GLOBALS,
};

const RULES = {
  'no-undef': 'error',
  'no-dupe-keys': 'error',
  'no-dupe-args': 'error',
  'no-dupe-class-members': 'error',
  'no-const-assign': 'error',
  'no-func-assign': 'error',
  'no-obj-calls': 'error',
  'no-unexpected-multiline': 'error',
  'no-unsafe-negation': 'error',
  'no-self-assign': 'error',
  'no-self-compare': 'error',
  'use-isnan': 'error',
  'valid-typeof': 'error',
  'no-cond-assign': 'error',
};

module.exports = [
  {
    ignores: ['node_modules/**', 'dist/**', '.e2e/**', '.e2e-tmp/**', 'vendor/**', 'resources/**',
    /* 前端第三方打包产物（xterm 及其 addon），压缩成一行，不适合做 lint */
    'src/renderer/vendor/**'],
  },
  {
    files: ['src/main/**/*.js', 'tools/**/*.js', 'tools/**/*.cjs', 'tests/**/*.js', 'tests/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
      globals: NODE_GLOBALS,
    },
    rules: RULES,
  },
  {
    files: ['src/renderer/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'script',
      globals: BROWSER_GLOBALS,
    },
    rules: RULES,
  },
];
