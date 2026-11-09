# speed-measure-vite-plugin

## 3.0.0

### Major Changes

- Modernize for Vite 3-7 and Vite 6+ Environment API:
  - Add standard plugin usage support: `plugins: [vue(), smvp()]`
  - Maintain 100% backwards compatibility with wrapper syntax: `plugins: smvp([plugins], options)`
  - Remove `decorate-vite-plugin` dependency for zero runtime dependencies
  - Support both function hooks and object hooks (`{ order, handler }`)
  - Support Vite 6/7 Environment API (`config.environments`)
  - Support wall-clock parallel execution duration and speedup ratio metrics
  - Debounced dev mode with clean timer disposal and server restart handling
  - Full TDD test coverage and bilingual documentation
