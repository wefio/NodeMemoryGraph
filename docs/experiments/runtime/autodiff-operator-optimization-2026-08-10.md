# Autodiff Operator Optimization: Historical Design and Measurements (2026-08-10)

[English](autodiff-operator-optimization-2026-08-10.md) | [简体中文](autodiff-operator-optimization-2026-08-10.zh-CN.md) · [Terms](autodiff-operator-optimization-2026-08-10.terms.yaml)

**Status:** Historical optimization record, later extended with measurements through 2026-08-28. The reported timings and test counts were not reproduced in this documentation pass. The note concerns the experimental autodiff engine and optional GPU work; it is not a general claim about NMG Core performance or a current GPU backend.

## Main findings recorded

- **Algebraic simplification and activity analysis:** the 2026-08-10 report recorded `l2_normalize_backward_128` improving from about 14.8 µs to about 8 µs/step (1.8×). `controller_train_f32_b32` and `matmul_forward` were approximately neutral.
- **Generic elementwise closure fusion:** the attempted controller path regressed to about 105–113 µs and was reverted. Profiling attributed 38.8% to closure reads; for the small arrays in that workload, closure-call overhead outweighed avoided allocations.
- **Opt-in compiled tape:** a later implementation recorded `controller_train_f32_b32` improving from about 90–105 µs to 44–46 µs (about 2.2×) with `NMG_AUTODIFF_COMPILE=1`. `matmul_forward` was neutral; `l2_normalize_backward` fell back to the interpreter and was approximately neutral. The report recorded 665/665 tests passing with compile mode globally enabled and a parameter-identity guard against cross-model gradient-cache reuse.
- **CSE/hash-consing:** deferred pending a workload large enough to justify interning overhead.
- **GPU:** remained a separate optional experiment. The report noted that small online CPU workloads would not amortize launch and transfer cost; a GPU threshold was not adopted as a selectable tier.
- **SIMD candidate (2026-08-28):** a four-column loop-unroll experiment measured 84.88 versus 84.65 µs/op, about 0.3%, within run-to-run variation; it was not retained. The report proposed restarting only with a profile-confirmed arithmetic bottleneck and stable end-to-end gains across relevant matrix sizes.

## Design lessons from the report

The note emphasized profiling before choosing an optimization: optimize the measured bottleneck, not the most attractive technique. Its measured controller workload was small and interpreter/scheduling dominated, so generic fusion and local arithmetic tuning did not automatically help. Reusing a stable graph through a compiled tape was a better match to the observed repeated-training shape than rebuilding and interpreting the graph every step.

The reported compiled mode used a forward/backward tape, data rebinding, and a structural guard with fallback. The note also recorded two failed approaches: recomputing string structure signatures on every step, and allowing a data getter to replace the backward-owned session. These are historical implementation lessons, not a complete current code specification.

## Evidence boundary and current owners

The dated measurements are local microbenchmarks tied to their graph shapes, environment, and opt-in mode. They do not establish performance for other workloads, a default-enabled mode, or a GPU crossover. The original literature survey and detailed proposed APIs are omitted from this compact record and were not independently revalidated.

- Autodiff engine: [`src/lab/autodiff.ts`](../../../src/lab/autodiff.ts)
- Backend selection exploration: [Batch backend cost model](backend-selection-cost-model-2026-08-10.md)
- Current behavior and tests: inspect the present `src/lab/` owners and targeted tests before relying on a historical claim.