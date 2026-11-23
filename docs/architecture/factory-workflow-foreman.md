# Scoped workflow foreman

A route node can pin a foreman profile in `routePolicy.nodes[routeId].foremanProfile`. Wallie runs inference once for that exact occurrence, then uses the graph's typed commands to validate and apply the recorded plan.

## Configuration

- Set `definitionRevisionId` and `definitionDigest` to a previously activated foreman definition in the same factory. Its named route prompt and approved scope must match the route.
- Declare the route's destinations, confidence threshold, and fallback. Configure a bounded `delegationPolicy` with a separate profile for each eligible child target.
- Bind the foreman to a workspace-scoped Codex API key and a supported OpenAI model. Wallie resolves GPT‑5.4 mini and GPT‑5.5 to fixed snapshots with standard text rates. The credential stays out of the model messages. [GPT-5.4 mini rates](https://developers.openai.com/api/docs/models/gpt-5.4-mini), [GPT-5.5 rates](https://developers.openai.com/api/docs/models/gpt-5.5)
- Size inference and child capacity within the shared root budget. Wallie counts the exact input before issuing one tool-free Responses request and caps output against the remaining tokens and dollars. It meters observed token usage at the uncached standard rate for the pinned snapshot. [Responses token counting](https://developers.openai.com/api/docs/guides/token-counting)

## Commands

| Command      | Required scope                                                                      | Durable result                                                                        |
| ------------ | ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `route`      | Current route occurrence and declared destinations                                  | The existing selected, fallback, or clarification decision                            |
| `delegate`   | The preceding recorded route decision and its selected declared child target        | Child session, job, run, and source checkpoint pinned by the normal admission command |
| `read_child` | The preceding route receipt and a child reference offered by this inference attempt | Child phase and exact occurrence identity                                             |

Every plan starts with a route decision. It may also delegate work to the selected destination or inspect one offered child. Fresh commands recheck ownership, lineage, grants, budget, and exact inputs. Foreman runs and command receipts retain the plan, decisions, measured usage, and child provenance. A duplicate request reuses its receipt. Once inference is issued, recovery waits for exact settlement or expiry so it cannot silently issue another provider request.

If settlement is unavailable, Wallie attempts to save measured usage and the original issue's accounting capability in an encrypted private journal. A successful write lets replay settle accounting against that issue. If both settlement and journal storage fail, the issue's original token and spend reserves continue to count against the root budget.

The foreman has no checkout or publisher authority. Child jobs use the ordinary pipeline and review path, and the parent source remains bound to human-approved checkpoints.
