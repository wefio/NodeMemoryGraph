# E. Optional HA/MGR integration

[中文](optional-ha-mgr-integration.zh-CN.md) · [Terms used](optional-ha-mgr-integration.terms.yaml)

**Authority:** [Parent scope](../task-unit-semantics-obligations.md).

## E. Optional HA/MGR integration

The [task-adviser design](../task-unit-semantics/autodiff-ha-mgr-integration.md) owns the reuse direction and wiring order. This ledger proves only the offline seam: `src/integration/task-advisers.ts` gives an optional source a bounded `AdviceProjection` and the shared legal set from `selectableTasks`; it may rank within that set but cannot change legality. `BoardAdmission` has optional `advisers`, with none as the default. No HA or MGR implementation is wired, no gate changed and no switch was added.

| Node | Obligation | State | Evidence |
| --- | --- | --- | --- |
| E1 | Refuse an out-of-set action even if it scores highest | Proven | `tests/integration/ooo-advisers.test.ts`: `a suggestion outside the legal set is refused, however high it scores`; a `1e9` score changes order only inside the set. Mutant `a-suggestion-outside-the-legal-set-is-scored`; retired tooth `the-ordering-adds-a-task-to-the-set` is covered by the case's refusal and set-equality assertions. |
| E2 | A soft premise or `requires`-style gate cannot unlock a real dependency | Proven | The same suite: task A depends on B; a high-scoring suggestion for A carries `assumptions: ["requires: B", "hypothesis: B is satisfied"]` but is refused while `selectableTasks` returns `["B"]`. The control is adopted only after B's artifact is accepted. `assumptions` is provenance, not a legality input. |
| E3 | A disabled or failing source falls back to rule policy and names why | Proven | The named case keeps rule order for `enabled: false` and a throwing source, with fallbacks `disabled` and `failed: no trained state is available`. Mutant `a-disabled-source-is-asked-anyway`; retired tooth `a-failing-source-takes-the-decision-with-it` is covered by the case's enumerated fallback reasons. |
| E4 | A score does not cross a session or branch | Proven | A suggestion whose provenance names another session or branch is refused by name; the projection carries both identities and the module stores no prior-session score. Mutant `a-score-from-another-scope-is-reused`. |
| E5 | A changed parameter or projection version cannot reuse an old suggestion | Proven | Both mismatches are reported as re-scored with the differing input named; neither old score orders the set. Mutant `a-version-mismatch-still-counts-as-the-same-reading`. |
| E6 | Missing score history is never reported as reproduction | Proven | A provenance without `observationOrder`/`initialState`, or with a different observation order, is re-scored and names the missing inputs. Mutant `a-score-with-no-recorded-history-counts-as-a-reproduction`. |
| E7 | A suggestion cannot start an unmodelled action | Proven | `fuse` and `prepare` are refused on the `action` field; speculative execution and combining units into one acceptance are not rankings. Mutant `an-unmodelled-action-is-scored`. |
| E8 | Re-check an adopted ranking at claim time | Proven | `BoardAdmission.refuseStaleRanking` refuses the adopted task when it is no longer in the legal set. Mutant `a-ranking-survives-into-the-claim`. |
| E9 | Rule policy returns the head of the legal set, and a blocked head is not skipped | Proven | The case asserts `nextTask(dispatch) === selectableTasks(dispatch)[0] === admission.next()`; a head blocked by stale input yields no candidate. Mutants `a-head-blocked-by-a-stale-input-is-skipped` and `next-task-is-not-the-head-of-the-legal-set`. |

These nine proofs establish the seam's limits, not a live HA/MGR integration or a product caller. The design page owns the candidate, ranking, claim and commit contract.
