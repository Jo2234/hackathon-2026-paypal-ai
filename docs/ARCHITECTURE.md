# Architecture and security scope

Derived from the 2026-10-19 engineering design and the implementation at 4a43309; original design/review records are retained privately outside the standalone repository. AI-assisted documentation is a summary, not runtime acceptance.

The built React console and AG Grid Community ledger share one loopback Hono server. Owner session and CSRF controls protect mutation routes. SQLite transactions bind signed policy identity, budget reservations, idempotency and payment claims; inference runs outside transactions with bounded leases and stale-finish exclusion.

Trusted catalogue prices and categories, integer minor-unit arithmetic, owner review and an exact-cart confirmation boundary constrain model proposals. Merchant descriptions are untrusted. Neither a model response nor a browser redirect confirms payment. The sandbox adapter reads provider orders/captures/refunds to reconcile outcomes; unknown outcomes retain holds. Refund completion and allowance restoration are separate facts governed by policy. Vault and inbound PayPal webhook verification are unavailable; this local path uses bounded GET reconciliation.

Fixture providers simulate approval and money movement. Local inference requires a configured literal-loopback endpoint and explicit model; schema/tool validation does not establish semantic quality. Production deployment, multi-user authentication, live-model quality and real sandbox acceptance remain outside verified scope. No production PayPal base is supported.
