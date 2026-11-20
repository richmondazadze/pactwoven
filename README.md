# Pactwoven

[![Code verification](https://github.com/richmondazadze/pactwoven/actions/workflows/ci.yml/badge.svg)](https://github.com/richmondazadze/pactwoven/actions/workflows/ci.yml)

Pactwoven is a web app for delegating operational tasks to a team of AI agents. Describe a job—such as comparing equipment options for an event—and agents research options, develop a plan, and return recommendations for review. You can follow their progress, update instructions, and approve paid actions from the same workspace.

## Features

- **Agent teams:** A coordinator delegates research and planning to specialists, with shared instructions, progress updates, and saved results.
- **Operational planning:** Keep each job’s site, deadlines, requirements, and acceptance criteria together.
- **Approvals and spending controls:** Define what agents may do, review versioned policies, and approve exact paid actions.
- **Traceable work:** Retain sources, memory, decisions, and receipts, with recovery for interrupted operations.

**Status:** In development. Full supplier coordination and financial execution are still being built. The current paid equipment demo uses Solana devnet and returns recommendations; it does not place equipment orders.

## Tech stack

TypeScript, Next.js, React, Hono, PostgreSQL/Drizzle, Clerk, and Azure OpenAI. The monorepo uses pnpm and Turborepo, with Cloudflare Workers and Vercel deployment configurations. A separate Rust/Anchor program handles custody initialization.

## Getting started

Requires **Node.js 24.22.1** and **pnpm 11.25.0**.

```bash
git clone https://github.com/richmondazadze/pactwoven.git
cd pactwoven
pnpm install --frozen-lockfile
pnpm dev
```

Open the app at **http://127.0.0.1:3001**. The API runs at **http://127.0.0.1:8787**, with a liveness endpoint at `/health`.

Without credentials, you can browse the marketing pages and setup screens. Authenticated features require a Clerk development application with organizations enabled and a PostgreSQL database named `pactwoven_dev`.

### Configuration

Create these local files with your development credentials:

| File | Variables |
| --- | --- |
| `apps/web/.env.local` | `NEXT_PUBLIC_API_BASE_URL`, `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY` |
| `services/api/.env.local` | `DATABASE_URL`, `PROVISIONER_DATABASE_URL`, `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_ISSUER` |

Set the web API URL to `http://127.0.0.1:8787`. Apply the [database migrations](packages/db/migrations) using the [migration runner](packages/db/src/migrate.ts), and use separate, non-owner database logins for runtime access and organization provisioning. Exact validation requirements are in [API configuration](services/api/src/config.ts). Environment files are ignored by Git.

Agent execution additionally requires Azure model deployments and dedicated worker credentials. After configuring [the coordinator](services/coordinator/src/config.ts), start it with:

```bash
pnpm --filter @pactwoven/coordinator dev
```

Hosted agent work, Google Calendar, and paid computation require their respective service bindings. See [native API configuration](services/native-api/src/config.ts) and [execution host configuration](services/native-host/src/config.ts).

## Project structure

| Directory | Purpose |
| --- | --- |
| `apps/web` | Marketing site and organization workspace |
| `services` | APIs, agent coordination, connectors, execution, and private signing |
| `packages` | Shared contracts, domain rules, database repositories, and utilities |
| `programs/pactwoven` | Solana custody initialization program and TypeScript client |
| `scripts` | Build helpers and verification checks |

## Development

```bash
pnpm test     # Run the default test suite
pnpm build    # Build the web app and service packages
```

[GitHub Actions](.github/workflows/ci.yml) defines the complete verification sequence, including type checks, import boundaries, publication checks, and isolated PostgreSQL tests. Database integration suites require explicit fixture configuration and may skip during the default test run.

The web app and native services include Vercel configurations; the workspace API also includes Cloudflare Worker configurations. Update provider resources, origins, and protected bindings for your deployment.

## License

No project-wide open-source license is currently included. Third-party licenses remain with their respective assets and dependencies.
