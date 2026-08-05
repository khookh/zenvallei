# Contributing

## Setup

```powershell
pnpm install --frozen-lockfile
pnpm verify:quick
```

Use Node.js 24 LTS and the pnpm version declared in `package.json`.

## Code style

- Prefer small named functions and plain objects.
- Keep runtime UI code under `src` and preparation code under `scripts`.
- Put dataset meaning and palette logic in its layer module.
- Do not add layer-specific branches to the shared MapLibre controller.
- Use JSDoc for shared contracts and non-obvious structures.
- Comment why a constraint exists, especially source authority, geometry transformations and security boundaries.
- Do not comment statements that are already clear from their names.
- Add matching Dutch and English translation keys; tests require catalogue parity.
- Escape source-provided text and pass external URLs through `safeExternalUrl`.

## Testing

Use `pnpm test:watch` while changing pure logic. Before each reviewable commit, run:

```powershell
pnpm verify:quick
```

Before release or handover, run:

```powershell
pnpm verify
pnpm test:e2e:cross-browser
```

Preparation commands are not part of the normal static build because they require large official inputs or short-lived credentials. Their reusable logic must have fixtures under `tests`.

## Generated data

Commit browser-ready outputs and their provenance only after `pnpm data:validate` passes. Never commit raw source archives, credentials, `.env` files or personal local paths.

Keep data and structural refactors in separate commits so numerical changes remain reviewable.
