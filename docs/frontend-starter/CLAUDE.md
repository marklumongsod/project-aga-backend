# CLAUDE.md: Project AGA frontend

> Copy this file into the root of the **frontend** repo, together with `FRONTEND_REQUIREMENTS.md` and the `design-reference/` folder (put both under `docs/`).

Web app for TESDA's Project AGA (Assessment Center Gap Analysis):
- an office dashboard for **CO / RO / PO** (sign-in)
- a public **Assessment Center Finder** for learners (no sign-in)

**The spec is `docs/FRONTEND_REQUIREMENTS.md`. Read it before building any screen.** The approved designs are `docs/design-reference/*.html`; open them in a browser and match them.

## Stack

Vite + React 18 + TypeScript (strict) · React Router 6 · TanStack Query 5 · MapLibre GL JS · React Hook Form + Zod · Vitest + Testing Library · Playwright.

## Backend

- Lives in the separate `project-aga-backend` repo (NestJS). Run it first: `docker compose up -d db && npm run db:setup && npm run simulate && npm run start:dev`.
- Base URL comes from `VITE_API_URL` (default `http://localhost:3000/api/v1`). Swagger is at `http://localhost:3000/docs`.
- API types are generated, never hand-written: `npx openapi-typescript http://localhost:3000/docs-json -o src/api/schema.d.ts`. Regenerate after backend changes. A few endpoints have untyped responses in Swagger (`/dashboard/map`, `/dashboard/centers`, `/centers/*`, `/public/*`); type those from the samples in the spec, in `src/api/types.ts`.
- Demo logins: `co.planning@demo.aga.local`, `ro.region6@demo.aga.local`, `po.negrosoccidental@demo.aga.local`. The password is `SEED_DEMO_PASSWORD` from the backend `.env`.

## Commands

```bash
npm run dev          # http://localhost:5173 (the backend's CORS allows this origin)
npm run build
npm run typecheck    # tsc --noEmit
npm test             # vitest
npm run e2e          # playwright (backend must be running)
```

Run `npm run typecheck && npm test` before calling anything done.

## Rules

- **Only three office roles (CO, RO, PO) plus the public.** No registration or user management; accounts come from T2MIS.
- Hide what a role can't use; the backend still enforces scope (403). Never show figures outside the user's area.
- The **public Finder never shows** candidate counts, flagged counts or utilization.
- Rates from the API are **fractions** (`2.2` = 220%). `rate: null` = "No center".
- Map colors come from the API `legend` (band → color). Don't hard-code the utilization palette.
- Dates from the API are **epoch seconds**. Display them in Asia/Manila.
- All API calls go through `src/api/client.ts` (`apiFetch`): token header, global 401 → sign out, typed `ApiError`.
- Token: in memory + `sessionStorage`; never `localStorage`. Don't log it.
- Design tokens live in `src/styles/tokens.css` (values in spec §10). Fonts: Bricolage Grotesque, Figtree, JetBrains Mono.
- Features without a backend (SSO, save proposal, reports, per-qualification filters) get honest placeholders as listed in spec §13. Never fake data.
- Keep user-facing copy in `src/copy.ts`; English for now, Filipino later.
- Accessibility: WCAG 2.1 AA. Every chart and map has a table or text equivalent, and colors always come with numbers.
