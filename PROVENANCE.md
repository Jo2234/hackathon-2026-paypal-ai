# Derived release provenance

Curated snapshot of source commit 499031255dc74e5a86f59da0d95fd8a668664093. Public history is a fresh single commit,
squashed for secret hygiene; original development history is retained privately.
Original RP snapshot: 0175d2924b8b9ad5d19a652b8c7ebc9af8b23b1e; imported baseline: 4a75bb3.
This was a snapshot import, not complete original history. A fixture-based policy,
ledger and console prototype already existed. Earliest observed commit was October
19, 2026; this does not establish original creation or rule out pre-window code.
Observed November 9 submission-window updates added sandbox transport, merchant-bound
checkout, local inference, human-approval tooling and offline regression fixes.
AI assistance included Claude and OpenAI tools; retained private records preserve
authorship and failed/unrun checks. Copyright 2026 Johan Vaz; MIT (see LICENSE).
Current judge instructions and limits are in README.md and docs/VERIFICATION.md.
Historical inference claims refer to measured earlier commits, not this release.
Real PayPal sandbox and combined judge acceptance are not established by packaging.
Original process evidence and upstream documentation captures are omitted from this
derivative; original hashes and records are retained privately.

Offline Orders v2 fixture provenance: tests/fixtures/paypal/orders-examples.json
contains unmodified create 200, get 200 and capture 201 examples from the official
Orders v2 schema (https://developer.paypal.com/docs/api/orders/v2/). Captured schema
SHA256: 5bcb2242a4158a307dceff74f74352a078777f9afb9b0fb407ce10e392ee96b7.
These are documentation samples, not live responses; production does not load them.
