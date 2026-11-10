// Retired historical pre-install snapshot checker. Its no-lockfile assumptions
// no longer describe this repository; use the pinned supported checks instead.
console.error('RETIRED: Run pnpm typecheck, pnpm test, pnpm test:race and pnpm build after pnpm install --frozen-lockfile.');
process.exitCode=2;
