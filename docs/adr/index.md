# Architecture Decision Records

Accepted ADRs are immutable: change a decision with a superseding ADR, never by editing an
accepted one. Propose a new ADR with `status: proposed` and stop for human acceptance.

| ID | Title | Status |
|---|---|---|
| [ADR-0001](0001-eval-first-vertical-slices.md) | Build by eval-first, testable vertical slices | accepted |
| [ADR-0002](0002-application-stack.md) | Application stack: AdonisJS v7 + Inertia/React on Postgres/pgvector | accepted |
| [ADR-0003](0003-authorization-and-identity.md) | Authorisation and identity: OIDC, ACLs, workspace RLS, turn-local handles | accepted |
| [ADR-0004](0004-azure-deployment-bicep.md) | Azure deployment as Bicep IaC | proposed |
| [ADR-0006](0006-automated-adversarial-discovery-lane.md) | Automated adversarial discovery lane (PyRIT) | accepted |
| [ADR-0007](0007-mask-external-urls.md) | Mask external URLs in answers | accepted |
| [ADR-0008](0008-moonshot-discovery-source.md) | Moonshot recipes as a discovery attack source | accepted |
| [ADR-0009](0009-discovery-url-finding-informational.md) | Discovery lane: a legitimate-repo-URL finding is informational, not a failure | accepted |
| [ADR-0010](0010-gateway-inbound-reject-is-a-block.md) | Discovery lane: a gateway inbound 403 is a block, not an error | accepted |
| [ADR-0012](0012-llm-gateway-boundary.md) | The model is reached only through a thin egress gateway that binds every call to a person | accepted |
| [ADR-0013](0013-evidence-gated-cited-answers.md) | An answer ships only the sentences the evidence supports; everything else is withheld with a reason | accepted |
| [ADR-0014](0014-no-model-in-a-critical-path.md) | No model output decides access, tenancy, or what the index returns | accepted |
| [ADR-0015](0015-no-persistent-model-memory.md) | The model keeps no memory between turns; the index is the only durable knowledge | accepted |
| [ADR-0016](0016-explicit-agent-loop.md) | The turn is an explicit, bounded tool loop, not an orchestration framework | accepted |
| [ADR-0017](0017-injection-detection-as-a-signal.md) | A pinned local classifier flags instruction-shaped text as a signal, never as a gate | accepted |
| [ADR-0018](0018-output-handling.md) | Output is rendered as data: one sanitiser, one stream encoder, and a link and command policy | accepted |
| [ADR-0019](0019-hybrid-retrieval-and-chunking.md) | Retrieval fuses vectors and BM25 over whole-declaration chunks, ranked on what the model is shown | accepted |
| [ADR-0020](0020-registration-reachability-preflight.md) | Registration confirms the remote is reachable before it stores a repository | accepted |
