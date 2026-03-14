[Root](../../CLAUDE.md) > [apps](..) > **site**

# Docs Site Module

## Module Role

Public-facing documentation and marketing website for CodePilot. Built with Next.js 15 + Fumadocs, supports bilingual content (English/Chinese), includes a marketing landing page with feature showcase, and a full documentation section covering installation, features, and IM bridge setup.

## Entry and Startup

- **Dev server**: `npm run dev` (port 3001)
- **Entry layout**: `src/app/[lang]/layout.tsx` -- language-aware root layout
- **Marketing page**: `src/app/[lang]/(marketing)/page.tsx`
- **Docs pages**: `src/app/[lang]/docs/[[...slug]]/page.tsx` -- catch-all for MDX docs
- **Content source config**: `source.config.ts` -- Fumadocs MDX source configuration

## External Interfaces

- **Search API**: `src/app/api/search/route.ts` -- Fumadocs search endpoint
- **Sitemap**: `src/app/sitemap.ts`
- **Robots**: `src/app/robots.ts`

## Content Structure

```
content/
  docs/
    en/       -- English docs (13 MDX files)
      bridge/ -- Bridge setup guides (Telegram, Feishu, Discord, QQ)
    zh/       -- Chinese docs (13 MDX files, mirrored structure)
      bridge/
  marketing/
    en.ts     -- English marketing copy
    zh.ts     -- Chinese marketing copy
    index.ts  -- Barrel export
```

## Key Dependencies and Configuration

- `next`: 15.3.6 (separate from root's Next.js 16)
- `fumadocs-core` + `fumadocs-mdx` + `fumadocs-ui`: v15
- `framer-motion`: animations
- `shadcn`: UI components
- Config: `next.config.mjs`, `postcss.config.mjs`, `source.config.ts`

## Components

- `src/components/marketing/` -- Landing page sections (Hero, Features, Audience, FAQ, etc.)
- `src/components/docs/` -- Docs navigation (TopNav, LanguageSwitcher, NavTitle, DownloadButton)
- `src/components/ui/` -- Base UI components (button, input, select, tooltip, etc.)

## Data Model

No database. Content is static MDX files processed by Fumadocs at build time.

## Tests and Quality

- Typecheck: `npm run typecheck` (uses `tsconfig.check.json`)
- Lint: `npm run lint`
- No dedicated test suite

## Related Files

- `apps/site/package.json` -- Package config
- `apps/site/source.config.ts` -- Fumadocs source config
- `apps/site/next.config.mjs` -- Next.js config
- `apps/site/src/lib/i18n.ts` -- i18n configuration
- `apps/site/src/lib/site.config.ts` -- Site metadata config

## Changelog

| Date | Action |
|------|--------|
| 2026-03-14 | Initial documentation from architecture scan |
