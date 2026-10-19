# Fixed trusted baseline verification

[中文](trusted-baseline-verification.zh-CN.md) · [Terms used](trusted-baseline-verification.terms.yaml)

**Authority:** [Repository Control Plane](../repository-control-plane.md).

## Fixed trusted baseline verification

Use these explicit local commands to verify a candidate commit under fixed,
reviewed rules. Ordinary `reconcile` / `agent:verify` does not automatically gain
this baseline isolation. This procedure and the
[RCP decision](../../../decisions/implemented/2026-08-29-repository-control-plane.md)
own the choice; ordinary check selection belongs to the
[gate reference](lightweight-verification.md) and its
[decision](../../../decisions/implemented/2026-09-07-rcp-lightweight-verification-default.md).

### Confirm the reviewed input and external directory

First explicitly review a commit containing this feature and its acceptance
policy. Installation neither commits the worktree nor automatically trusts the
candidate.

Replace the placeholders: `<repository>` supplies the reviewed baseline;
`<reviewed-commit>` is that fixed revision; `<new-external-directory>` is a new
installation outside the candidate repository. Its parent must exist and the
target itself must not exist.

Installation accepts regular files only, rejects symlinks and submodules, and
caps Git output at 256 MiB. An unavailable installation environment is not a pass.

### Install or upgrade the baseline

```text
npm run rcp -- trust-install <repository> <reviewed-commit> <new-external-directory>
```

Installation reads the fixed Git commit. With a lockfile, it automatically runs
`npm ci --ignore-scripts --no-audit --no-fund`, without installation lifecycle
scripts. Dependency installation fails closed, without fallback. If acceptance
needs native scripts or generated artifacts that cannot run, that obligation
fails; missing environment is not an exemption.

For an upgrade, install into another new external directory and explicitly choose
its entry point. Do not overwrite the old installation.

### Check whether policy admits the change

The reviewed baseline supplies `.rcp/trusted-policy.json`:

- `candidateRoots` declares mutable product directories.
- `obligations` is nonempty; each has a unique ID, named claim, explicit
  `tests/*.test.ts` paths and a timeout.

The current policy allows product changes under `src` only. Other changes,
including tests, helpers, tools, policy, root package/lock/config and docs, return
`blocked` and require independent approval. Package/lock/tsconfig files are not
ordinary product changes even under an allowed directory.

For new obligations or changes to tests/dependencies, first review the rule change
independently and install a new baseline. Do not admit it with an ordinary product
change or broaden candidate authority to let the candidate certify itself.

### Verify the fixed candidate snapshot externally

Replace `<candidate-repository>` and `<candidate-commit>` with the repository and
revision to verify. Launch the source from the external installation, not the
candidate's verifier:

```text
node --experimental-strip-types <new-external-directory>/src/rcp/trusted.ts verify <candidate-repository> <candidate-commit>
```

Verification resolves the candidate commit once and binds commit plus Git content
digest. It neither reads dirty/untracked content nor commits automatically, then
materializes the snapshot in a temporary directory.

Tests and helpers match the baseline byte for byte. Their relative imports target
the temporary candidate product, not the old installed product. Candidate
`src/rcp` changes can be tested but cannot replace the external adjudicator.
Dependencies come from the installation; candidate dependency declarations may
not change.

Verification checks the full installed-source digest before and after execution.
Changes to pre-existing snapshot files fail the run. Adversarial forgery of output
or the test environment is outside this local trust boundary.

### Interpret success and failure

Every obligation executes; historical results are not reused. Each obligation
requires a zero Node test-runner exit, nonzero completed TAP test count, every
test passed and zero fail, cancelled, skipped and todo counts. Missing tests,
missing completion reports, errors, timeout or any failed obligation cannot pass.

| Exit | Meaning |
| --- | --- |
| 0 | passed |
| 1 | failed or invalid input |
| 2 | policy blocked; use the independent approval or baseline-update path above |

JSON binds invocation, candidate commit/content, baseline commit/content, policy
digest, verifier digest and Node version, with the actual named claims and results.
Downstream claims can cite those obligations, not conclude every design is
implemented.

The output is not a third-party signed proof. It neither writes an RCP receipt nor
advances `implemented` or merge state automatically. JSON self-consistency cannot
authenticate historical execution.

### Keep the trust and proof limits

This procedure reruns tests under fixed rules; it is not a cryptographic succinct
argument or formal verification. It targets ordinary Agent mistakes,
self-reported completion and weakened checks—not same-permission malicious
processes, administrators, compromised Node/Git/npm or dependencies, or an
incomplete test specification.

Test and product code execute in one process. Without permission isolation this
cannot claim resistance to malicious code. `tests/rcp/trusted.test.ts` owns the
adversarial regressions. An ordinary full-gate pass does not prove this design or
the verifier correct either.
