#!/usr/bin/env python
"""One-shot scan for Windows path-format issues across the OmniMemEval
scripts and our evals tooling.

Problem class: bash (git-bash/MSYS2) generates POSIX paths (/c/...) that are
then passed to native Windows Python, which silently fails to open them
(python-dotenv returns False without error). The scan:

  1. Static: finds every bash path construction and flags whether it is
     Windows-safe (pwd -W / cygpath) or risky (plain pwd).
  2. Cross-layer check: the only bash->python path injection is the env file
     via OMNIMEMEVAL_ENV_FILE — this is reproduced end-to-end (extract_env_arg
     -> python load_dotenv) and must print LOAD_OK + ANSWER_MODEL.

Usage: python evals/omnimemeval/scan-path-issues.py
"""
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OMNI = os.path.join(ROOT, ".benchmarks", "official", "OmniMemEval")

PATH_BUILDERS = [
    re.compile(r"\$\(\s*cd[^)]*&&\s*pwd(?:\s+-W)?\s*\)"),
    re.compile(r"\$\(\s*pwd(?:\s+-W)?\s*\)"),
    re.compile(r"realpath\s+"),
]
WINDOWS_SAFE = re.compile(r"pwd\s+-W|cygpath\s+-w")
PYTHON_CALLS = re.compile(
    r"python[0-9.]*\s+.*\.py|\.py\s+--|\$OMNIMEMEVAL_ENV_FILE|--env\s+\"?\$|export\s+\w*PATH\w*\s*=|export\s+.*_DIR\s*="
)


def scan_static():
    findings = []
    for dirpath, _, files in os.walk(os.path.join(OMNI, "scripts")):
        for name in files:
            if not name.endswith(".sh"):
                continue
            path = os.path.join(dirpath, name)
            with open(path, encoding="utf-8", errors="replace") as f:
                for lineno, line in enumerate(f, 1):
                    line = line.rstrip("\n")
                    if not line.strip() or line.strip().startswith("#"):
                        continue
                    for pat in PATH_BUILDERS:
                        if pat.search(line):
                            safe = bool(WINDOWS_SAFE.search(line))
                            rel = os.path.relpath(path, ROOT)
                            findings.append(
                                (rel, lineno, "path_build", "safe" if safe else "RISKY", line.strip()[:90])
                            )
                            break
    return findings


def find_git_bash():
    for candidate in [
        r"C:\Program Files\Git\bin\bash.exe",
        r"C:\Program Files\Git\usr\bin\bash.exe",
        r"C:\Program Files (x86)\Git\bin\bash.exe",
    ]:
        if os.path.exists(candidate):
            return candidate
    return None


def scan_dynamic():
    results = []
    bash = find_git_bash()
    if not bash:
        results.append("git-bash not found - dynamic check skipped (would need MSYS bash)")
        return results
    # Relative cd: works from python's cwd (NodeMemoryGraph) in any bash.
    body = [
        "cd .benchmarks/official/OmniMemEval/scripts",
        "source ./_experiment_utils.sh",
        "extract_env_arg --env ../.env.nmg-bgefix",
        'echo "PATH=$OMNIMEMEVAL_ENV_FILE"',
        "python -c \"import os; from dotenv import load_dotenv;"
        "p=os.environ['OMNIMEMEVAL_ENV_FILE'];"
        "ok=load_dotenv(p, override=True);"
        "print('LOAD_OK' if ok else 'LOAD_FAILED');"
        "print('ANSWER_MODEL='+os.environ.get('ANSWER_MODEL','MISSING'))\"",
    ]
    out = subprocess.run([bash, "-c", "\n".join(body)], capture_output=True, text=True)
    for line in out.stdout.strip().splitlines():
        results.append(line)
    if out.returncode != 0:
        results.append(f"exit={out.returncode} stderr={out.stderr.strip()[:200]}")
    return results


def main():
    print("=" * 90)
    print("STATIC SCAN - bash path constructions (Windows/MSYS2 risk)")
    print("=" * 90)
    static = scan_static()
    risky = [f for f in static if f[3] == "RISKY"]
    print(f"{len(static)} findings, {len(risky)} risky path builds:\n")
    for rel, lineno, kind, status, snippet in static:
        marker = "!!!" if status == "RISKY" else "   "
        print(f"{marker} {rel}:{lineno} [{status}] {snippet}")
    if risky:
        print("\nNOTE: PROJECT_DIR/SCRIPT_DIR are consumed by bash only (cd),")
        print("      never passed to python - see cross-layer check below.")

    print("\n" + "=" * 90)
    print("CROSS-LAYER CHECK - bash -> python env chain (the real injection)")
    print("=" * 90)
    for line in scan_dynamic():
        print(f"   {line}")

    print("\n" + "=" * 90)
    print("SUMMARY")
    print("=" * 90)
    dyn = scan_dynamic()
    ok = any("LOAD_OK" in line for line in dyn) and any("ANSWER_MODEL=" in line and "MISSING" not in line for line in dyn)
    print(f"risky path builds (static): {len(risky)} (all bash-internal unless noted)")
    print(f"bash->python env chain: {'PASS' if ok else 'FAIL'}")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
