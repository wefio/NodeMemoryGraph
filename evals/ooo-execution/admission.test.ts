import assert from "node:assert/strict";
import test from "node:test";
import { createAdmissionGate, type Task } from "./admission.ts";

function tasks(): Task[] {
  return [
    {
      id: "A",
      revision: "v1",
      input: "2",
      dependencies: [],
      verify: (output, input) => output === String(Number(input) * 2),
    },
    {
      id: "B",
      revision: "v1",
      input: "3",
      dependencies: [],
      verify: (output, input) => output === String(Number(input) * 2),
    },
    {
      id: "C",
      revision: "v1",
      input: "sum",
      dependencies: ["A", "B"],
      verify: (output, _input, dependencies) =>
        output === String(Number(dependencies.A) + Number(dependencies.B)),
    },
  ];
}

test("A waits while B completes; only verified A releases C, duplicate delivery is inert", async () => {
  const gate = createAdmissionGate(tasks());
  const a = gate.issue("A");
  let deliver!: (artifact: string) => void;
  const pending = new Promise<string>((resolve) => {
    deliver = resolve;
  });
  assert.deepEqual(gate.ready(), ["B"]);
  assert.throws(() => gate.issue("C"), /dependencies/);
  const b = gate.issue("B");
  assert.equal(gate.submit({ ticket: b, artifact: "6" }), "accepted");
  assert.deepEqual(gate.ready(), []);
  // A self-reported pass does not replace the coordinator-owned check.
  assert.equal(gate.submit({ ticket: a, artifact: "wrong", passed: true }), "rejected");
  deliver("4");
  const artifact = await pending;
  assert.equal(gate.submit({ ticket: a, artifact }), "accepted");
  assert.deepEqual(gate.ready(), ["C"]);
  assert.equal(gate.submit({ ticket: a, artifact }), "duplicate");
  assert.equal(gate.submit({ ticket: a, artifact: "changed" }), "rejected");
  const c = gate.issue("C");
  assert.equal(gate.submit({ ticket: c, artifact: "10" }), "accepted");
  assert.deepEqual(gate.ready(), []);
});

test("reissue fences old execution; version, input and gate binding cannot be substituted", () => {
  const gate = createAdmissionGate(tasks());
  const old = gate.issue("A");
  const current = gate.issue("A");
  assert.equal(gate.submit({ ticket: old, artifact: "4" }), "stale");
  for (const ticket of [
    { ...current, revision: "v2" },
    { ...current, inputDigest: "forged" },
    createAdmissionGate(tasks()).issue("A"),
  ])
    assert.equal(gate.submit({ ticket, artifact: "4" }), "stale");
  assert.equal(gate.submit({ ticket: current, artifact: "4" }), "accepted");
  assert.equal(gate.submit({ ticket: old, artifact: "4" }), "stale");
  assert.throws(() => gate.issue("A"), /completed/);
});

test("plan is copied; caller mutation cannot replace a registered verifier or input", () => {
  const plan = tasks();
  const gate = createAdmissionGate(plan);
  plan[0]!.verify = () => true;
  plan[0]!.input = "999";
  plan[2]!.dependencies.length = 0;
  const ticket = gate.issue("A");
  assert.equal(gate.submit({ ticket, artifact: "wrong" }), "rejected");
  assert.equal(gate.submit({ ticket, artifact: "4" }), "accepted");
  assert.throws(() => gate.issue("C"), /dependencies/);
});

test("invalid DAGs and malformed worker submissions fail closed", () => {
  assert.throws(() => createAdmissionGate([]), /empty/);
  const a = tasks()[0]!;
  for (const plan of [
    [a, a],
    [{ ...a, dependencies: ["missing"] }],
    [{ ...a, dependencies: ["A"] }],
    [
      { ...a, dependencies: ["B"] },
      { ...tasks()[1]!, dependencies: ["A"] },
    ],
  ])
    assert.throws(() => createAdmissionGate(plan));
  const gate = createAdmissionGate(tasks());
  for (const value of [null, {}, { passed: true }, { ticket: {}, artifact: 4 }]) {
    assert.equal(gate.submit(value), "rejected");
  }
  assert.throws(() => gate.issue("missing"), /unknown/);
});

test("verifier exceptions cannot complete a task", () => {
  const gate = createAdmissionGate([
    {
      ...tasks()[0]!,
      verify: () => {
        throw new Error("check failed");
      },
    },
  ]);
  const ticket = gate.issue("A");
  assert.equal(gate.submit({ ticket, artifact: "4" }), "rejected");
});

test("attempt is rechecked after verification, including reentrant coordinator changes", () => {
  let reissue = () => {};
  const gate = createAdmissionGate([
    {
      ...tasks()[0]!,
      verify: () => {
        reissue();
        return true;
      },
    },
  ]);
  const ticket = gate.issue("A");
  reissue = () => {
    gate.issue("A");
  };
  assert.equal(gate.submit({ ticket, artifact: "4" }), "stale");
});
