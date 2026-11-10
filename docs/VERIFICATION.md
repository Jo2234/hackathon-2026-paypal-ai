# README verification and offline scope — 2026-11-09

This replaces earlier stale source assumptions using base 4a43309a294454316095df723b3ff18340d377e2 plus the release-docs commits. Exact final SHA and verifier evidence live in the external release-docs report; the verifier receives the full immutable commit ID, avoiding a self-referential documentation hash. All runtime evidence below is offline fixtures or owned loopback stubs. No real PayPal or model calls, credentials, shared restarts, publication or history rewriting.

Environment: Darwin arm64, Node 24.22.0, pnpm 12.14.0, activated via the supplied project toolchain. A cache-only `pnpm install --offline --frozen-lockfile` failed for a missing tinyglobby store snapshot. `pnpm install --frozen-lockfile` passed with registry downloads. This was not a clean judge OS installation.

Dated offline result summary: `typecheck`, `test`, `test:race`, `build` passed before the added review fixes. Final checks are rerun by the exact-SHA verifier after all commits. Typecheck is OVERLAY_ASSISTED_MODIFIED_DECLARATIONS; unmodified upstream declaration strictcheck remains known failing. No test is deleted or weakened.

## All 18 verification items

| Item | Disposition | Evidence and remaining boundary |
| --- | --- | --- |
| V01 | Resolved | Re-read final scripts, main/env/config, adapter, catalogue, UI, labels, e2e and supplied reports; README now describes the built judge start and implemented local adapter. |
| V02 | Partial; comment retained | Pinned versions and frozen install passed on this Darwin arm64 host. Clean judge machine, other OS/prerequisites unverified. |
| V03 | Unverified; retained | No account onboarding, dashboard, funding, region or buyer/seller checks. Guidance is attributed, not observed. |
| V04 | Unverified; retained | No Ollama installation/runtime release validated or process managed. |
| V05 | Unverified; retained | No model pull/show, digest/weights/template, RAM, latency or inference validation. qwen3:4b is a candidate only. |
| V06 | Partial; retained | Source confirms external-file loading, server-side OAuth and merchant binding; non-secret fixture file mode 0600 checked. Real seller binding and end-to-end credential non-disclosure unverified. .env.example omits required local-model fields; README states them explicitly. |
| V07 | Partial; retained | Resolved external path with fixture-only settings loaded by actual `pnpm start`; session reports fixture modes. No private sandbox configuration used. |
| V08 | Partial; retained | Adapter exists, strict loopback/model settings documented, offline route/lease/failure/proxy regressions pass. Real model semantic/provenance and outage acceptance unverified. |
| V09 | Resolved offline | Frozen install and required checks; exact final commit rechecked by verifier. Overlay limitation preserved. |
| V10 | Unverified sandbox; retained | Actual built fixture entry point checked, but no sandbox startup/recovery/provider reads. |
| V11 | Partial; retained | Actual built HTTP root and same-origin session bootstrap pass; fixture desktop/phone journeys pass. Sandbox popup/return/cancel and developer Vite proxy are unverified. |
| V12 | Unverified; retained | No timed combined live-AI/sandbox walkthrough. Five-minute times are targets only. |
| V13 | Partial; retained | Source price 1250 + shipping 500 = 1750; no-other-activity allowance 8000 - 1750 = 6250. Fixture browser proves allowed agent cart, exact step-up and over-limit refusal before mutation; unit policy tests cover denials. Exact manual COF-001 plus gift-card judge sequence remains unrun. |
| V14 | Resolved source/fixture scope | Sandbox labels read from paymentLabels; fixture banner, handwritten model, simulation approval and dispatch labels exercised by e2e. Real provider/model labels are source-confirmed only, not live execution. |
| V15 | Unverified sandbox; retained | Offline capture/full-refund/browser and local HTTP reconciliation regressions pass, including unknown accounting tests; actual sandbox refund/pending/never_restore path remains unrun. |
| V16 | Unverified; retained | `test:sandbox` not run: it requires explicit configuration and creates transactions. Source confirms direct transport scope and evidence/sandbox destination. |
| V17 | Resolved fixture scope | Built `pnpm start`, external non-secret file, HTTP root/session, disposable APP_DB_PATH, mode isolation and listener stop checked. E2e explicitly uses fixture modes and disposable DB. Default DB resolved from main to data/{fixture,sandbox}.sqlite (repository root); no existing state erased. |
| V18 | Partial; retained | Error/source/storage/limits checked; unsupported PORT reproduced then corrected. Local stub tests cover outages/unknowns; actual model outage, bad real sandbox settings and buyer cancellation remain unverified. |

Resolved: V01, V09, V14, V17 (scopes above). Remaining comments: V02–V08, V10–V13, V15–V16, V18. Partial is not acceptance.

## Added review fixes and proof

1. Mixed normal-success/hostile-HTTP500 runner regression: before fix, six valid normal calls plus 135 hostile HTTP500 calls produced exit 0; the assertion failed. After fix, both runner tests pass: mixed case is FAIL with 135 transportErrors/inferenceFailures and six evaluated inferences, all 141 cases retained. Only validated tool calls or explicit model refusals count as evaluated inference; invalid output, timeout, missing result and transport error cannot pass. Per-case and total counts are retained. Source exports still fail HEAD_UNAVAILABLE honestly.
2. Bodyless statuses 204/205/304: before, each child terminated with uncaught Response constructor TypeError; after, every child exits 0 returning a typed transport_error with one attempt. Conversion callbacks catch/reject synchronous exceptions and dispose of streams. Proxy isolation regression remains intact.
3. PORT=5199 now fails before listening with a hint naming supported ports 5173/8787. Host/Origin equality is unchanged. Judge smoke uses free 5173 and a disposable ledger. The pnpm wrapper is terminated by SIGTERM (-15); listener closure is verified. An initial arbitrary-port smoke attempt exposed the mismatch and was corrected, not counted as a pass.
4. Refund badge is derived from completedApplied COMPLETED refund facts for the selected reservation equalling positive gross capture, with no unknown operation or anomaly; gross captured remains displayed. Ledger state is unchanged. Desktop sidebar stretches with the document; phone retains its top navigation. E2e adds badge and full-height assertions without removing any existing assertion; the height comparison rounds a fractional CSS pixel to the document's integer scrollHeight. Initial geometry assertion exposed that rounding mismatch. Final fixture screenshots/traces were visually inspected at desktop and phone widths; raw records are retained privately.

## Curation and remaining publication work

Historical source captures, original manifests and design/review records are retained privately outside the standalone package. The prior claim that three pinned receipts are an export dependency is superseded: typecheck passed after their exclusion. No verification gate was removed. LICENSE is unchanged.

Existing history still contains the original token-shaped sample and stale README blobs. Historical privacy and third-party snapshot rights review remain owner work before any export/publication. Scanner matches are classified in the final external report; no scanner is disabled or changed. Passing offline execution is not live acceptance or permission to publish.
