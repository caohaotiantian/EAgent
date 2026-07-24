// Build-time stub for `react-devtools-core`. Ink statically imports this
// dev-only module to expose a React DevTools bridge; the production bundle never
// uses it. esbuild aliases the import to this empty module (`--alias`) so the
// bundle does not hoist `react-devtools-core` as an unresolved external ESM
// import (which would ERR_MODULE_NOT_FOUND at load). See the build:tui recipe.
export default {};
