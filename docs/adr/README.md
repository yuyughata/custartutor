# Architecture decision records

| ADR                                                    | Decision                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------- |
| [0001](0001-monorepo-and-apps.md)                      | Monorepo with two Expo apps and shared packages                     |
| [0002](0002-guardian-session-and-grownup-elevation.md) | Guardian session, child mode and server-verified grown-up elevation |
| [0003](0003-sync-protocol.md)                          | Local-first sync: `sync_seq`, tombstones, append-only events        |
| [0004](0004-lesson-packs.md)                           | Immutable lesson packs, stable IDs, atomic swap                     |
| [0005](0005-ai-jobs-and-tutor-safety.md)               | `pgmq` job engine, tutor safety and safeguarding                    |
| [0006](0006-template-enrichment-count.md)              | The unit template wins: 2 to 5 enrichment sections, not 2 to 3      |

The overall build plan is in [../plan.md](../plan.md).
