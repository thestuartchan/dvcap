# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## Data integrity — standing rules

These are enforced at build time by `scripts/*` in the `prebuild` step; they are not suggestions.

1. **An LLM call is never a data source for a numeric market value.** Prices, spreads, yields,
   ratios and volumes come from a real feed through the Vercel serverless proxy (`api/*`) with the
   provider key server-side, or they are hardcoded with a visible as-of date. Asking a model to
   "return today's price" with no market-data tool wired in returns a training-data guess rendered
   as a live quote — fabricated data. Enforced by `scripts/check-no-llm-feeds.mjs` (any `fetch()` to
   an LLM host from `src`/`api`/`lib` fails the build).
2. **Nothing renders a number without a source and a timestamp.** Every figure shows where it came
   from and how current it is (e.g. the recession table's per-row source tag + as-of, the 13F
   matrix's positions-as-of/filed dates, the 📡 live / ✍️ manual provenance badges).
3. **Status colours come only from `lib/status.js`** — enforced by `scripts/check-status-tokens.mjs`.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
