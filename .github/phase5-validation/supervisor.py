#!/usr/bin/env python3
"""Temporary, single-check supervisor. Compilation and test runs are GitHub-only."""
from pathlib import Path
from datetime import datetime, timezone
import hashlib
import json
import os
import pwd
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import time

GIB = 1024**3
CAP = 7 * GIB
RESERVE = 4 * GIB
CGROOT = Path("/sys/fs/cgroup")
CG_FIELDS = (
    "memory.current", "memory.peak", "memory.high", "memory.max",
    "memory.swap.current", "memory.swap.max", "memory.events",
    "memory.events.local", "memory.stat", "memory.pressure",
    "cpu.max", "cpu.stat", "pids.current", "pids.max",
)
SETTINGS = {
    "GOMEMLIMIT": "2GiB", "GOGC": "30", "GOMAXPROCS": "1",
    "NODE_OPTIONS": "--max-old-space-size=512",
    "OPENCLAW_LOCAL_CHECK": "1", "OPENCLAW_LOCAL_CHECK_MODE": "throttled",
    "OPENCLAW_TSGO_SPARSE_SKIP": "0",
}
ENV_KEYS = tuple(SETTINGS) + (
    "GODEBUG", "GOTRACEBACK", "OPENCLAW_TSGO_PPROF_DIR", "OPENCLAW_TSGO_HEAVY_CHECK_LOCK_HELD",
    "OPENCLAW_HEAVY_CHECK_LOCK_TIMEOUT_MS", "OPENCLAW_HEAVY_CHECK_LOCK_POLL_MS",
    "OPENCLAW_HEAVY_CHECK_LOCK_PROGRESS_MS", "OPENCLAW_HEAVY_CHECK_STALE_LOCK_MS",
    "OPENCLAW_HEAVY_CHECK_LOCK_SCOPE", "OPENCLAW_VITEST_MAX_WORKERS", "CI", "GITHUB_ACTIONS",
)


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def now():
    return datetime.now(timezone.utc).isoformat()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def save(out, name, data):
    # The supervisor fsyncs evidence before it asks systemd to kill the child.
    temporary = out / (name + ".tmp")
    with temporary.open("w") as stream:
        json.dump(data, stream)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, out / name)
    fd = os.open(out, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def read(path):
    try:
        return {"state": "recorded", "value": Path(path).read_text().strip()}
    except OSError as error:
        return {"state": "unavailable", "error": type(error).__name__}


def cgroup(pid):
    rows = Path(f"/proc/{pid}/cgroup").read_text().splitlines()
    unified = [row[3:] for row in rows if row.startswith("0::")]
    require(len(unified) == 1, "Unified cgroup v2 membership unavailable")
    return CGROOT / unified[0].lstrip("/")


def ancestors(path):
    result = []
    while path.is_relative_to(CGROOT):
        result.append({"path": str(path), "values": {k: read(path / k) for k in CG_FIELDS}})
        if path == CGROOT:
            break
        path = path.parent
    return result


def process(pid):
    result = {"pid": pid}
    try:
        result["cgroup"] = str(cgroup(pid))
        result["executable"] = os.readlink(f"/proc/{pid}/exe")
        result["arguments"] = Path(f"/proc/{pid}/cmdline").read_bytes().decode(errors="replace").rstrip("\0").split("\0")
        result["status"] = {
            k: v.strip()
            for line in Path(f"/proc/{pid}/status").read_text().splitlines()
            if ":" in line
            for k, v in [line.split(":", 1)]
            if k in ("Name", "State", "VmRSS", "VmHWM", "RssAnon", "Threads", "THP_enabled")
        }
    except OSError as error:
        result["unavailable"] = type(error).__name__
    return result


def host(out):
    memory = {
        row[0].rstrip(":"): int(row[1]) * 1024
        for line in Path("/proc/meminfo").read_text().splitlines()
        if (row := line.split())[0] in ("MemAvailable:", "MemTotal:", "SwapTotal:")
    }
    psi = {
        row[0]: dict(item.split("=") for item in row[1:])
        for line in Path("/proc/pressure/memory").read_text().splitlines()
        if (row := line.split())
    }
    return {
        "at": now(), "monotonic": time.monotonic(), **memory,
        "memoryFullTotalUs": int(psi["full"]["total"]), "hostMemoryPressure": psi,
        "tmpFree": shutil.disk_usage(out).free,
    }


def snapshot(out, child_cg=None):
    monitor = process(os.getpid())
    vm = dict(line.split() for line in Path("/proc/vmstat").read_text().splitlines())
    result = {
        **host(out), "monitor": monitor,
        "monitorAncestors": ancestors(Path(monitor["cgroup"])),
        "vmCounters": {
            k: int(v) for k, v in vm.items()
            if k.startswith(("compact_", "allocstall", "pgscan", "pgsteal", "pswp", "thp_"))
        },
        "globalThp": {k: read("/sys/kernel/mm/transparent_hugepage/" + k) for k in ("enabled", "defrag")},
        "goManagedMemory": {"state": "unknown", "reason": "No Go heap profiler enabled"},
    }
    if child_cg is not None:
        result["childAncestors"] = ancestors(child_cg)
        members = read(child_cg / "cgroup.procs")
        result["childMembership"] = members
        result["childProcesses"] = [
            process(int(pid)) for pid in members.get("value", "").split()
        ]
    return result


def guard(current, previous, streak, elapsed):
    interval = current["monotonic"] - previous["monotonic"]
    delta = current["memoryFullTotalUs"] - previous["memoryFullTotalUs"]
    require(interval > 0 and delta >= 0, "Invalid monotonic/PSI counter interval")
    percent = delta / (interval * 10000)
    streak = streak + 1 if percent > 1 else 0
    reason = None
    if current["MemAvailable"] < RESERVE:
        reason = "Host available memory fell below 4 GiB reserve"
    elif current["tmpFree"] < GIB:
        reason = "Temporary storage free space fell below 1 GiB"
    elif streak >= 5:
        reason = "New full-memory stalls exceeded 1% in five consecutive intervals"
    elif elapsed > 900:
        reason = "15-minute check deadline"
    return reason, streak, {"intervalSeconds": interval, "fullStallDeltaUs": delta, "fullStallPercent": percent}


def verify_separation(capture):
    child = capture["childAncestors"]
    monitor = capture["monitorAncestors"]
    require(not Path(monitor[0]["path"]).is_relative_to(Path(child[0]["path"])),
            "Supervisor is inside the child cgroup")
    for rows in (monitor, child[1:]):
        for row in rows:
            value = row["values"]["cpu.max"]
            if row["path"] == str(CGROOT) and value["state"] == "unavailable":
                continue  # cgroup-v2 root has no parent controller limit.
            require(value["state"] == "recorded" and value["value"].split()[0] == "max",
                    "A shared or tighter ancestor CPU quota exists")
    for key in ("memory.max", "memory.high"):
        finite = []
        for row in child:
            value = row["values"][key]
            if row["path"] == str(CGROOT) and value["state"] == "unavailable":
                continue
            require(value["state"] == "recorded", "Missing ancestor " + key)
            if value["value"] != "max":
                finite.append(int(value["value"]))
        require(finite and min(finite) == CAP, "Unexpected effective " + key)
    limits = child[0]["values"]
    require(limits["memory.swap.max"].get("value") == "0", "Child swap cap differs")
    require(limits["pids.max"].get("value") == "128", "Child task cap differs")
    quota, period = limits["cpu.max"].get("value", "").split()
    require(int(quota) == int(period), "Child CPU quota is not one CPU")
    for key in ("memory.current", "memory.peak", "memory.events", "memory.pressure", "cpu.stat"):
        require(limits[key]["state"] == "recorded", "Missing required measurement " + key)


def verify_candidate(manifest, full):
    for path, expected in manifest["files"].items():
        require(digest(path) == expected, "Candidate file changed: " + path)
    if full:
        require(subprocess.check_output(["git", "status", "--porcelain", "--untracked-files=no"], text=True) == "",
                "Tracked runner source changed during setup")
        # Publish a root snapshot, not the private local commit history.
        # Removing only the named automation must recover the exact source tree.
        with tempfile.TemporaryDirectory(prefix="phase5-identity-") as directory:
            env = os.environ.copy()
            env["GIT_INDEX_FILE"] = directory + "/index"
            subprocess.run(["git", "read-tree", "HEAD"], env=env, check=True)
            subprocess.run(["git", "update-index", "--force-remove", "--", *manifest["automation"]], env=env, check=True)
            tree = subprocess.check_output(["git", "write-tree"], env=env, text=True).strip()
        require(tree == manifest["sourceTree"], "Published source snapshot differs from the validated candidate")


def classify_compiler(code, log):
    result = {"wrapperExitCode": code}
    # Signals take precedence even when diagnostics were printed before death.
    # run-tsgo preserves native signals as 128 + signal instead of exit 1.
    if code < 0 or code >= 128:
        result.update(result="INTERRUPTED", reason="Wrapper or native compiler terminated abnormally")
    elif code == 0:
        result.update(result="PASS", reason="Compiler completed successfully")
    elif re.search(r"(?m)^[ \t]*(?:panic(?::| during panic)|fatal error:|runtime:|SIG[A-Z0-9]+:|stack trace unavailable)", log):
        # Go 1.26.3 panic/throw and tsgo skipped-output diagnostics both exit 2.
        # Runtime crash output must therefore outrank an earlier TS diagnostic.
        result.update(result="INTERRUPTED", reason="Native compiler panic or fatal runtime failure")
    elif code in (1, 2) and re.search(r"\berror TS\d+:", log):
        result.update(result="CODE_ERRORS", reason="Compiler completed with TypeScript diagnostics")
    else:
        result.update(result="INTERRUPTED", reason="Unexpected wrapper exit or missing TypeScript diagnostics")
    return result


def classify_tests(code):
    result = {"wrapperExitCode": code}
    if code < 0 or code >= 128:
        result.update(result="INTERRUPTED", reason="Test runner terminated abnormally")
    elif code == 0:
        result.update(result="PASS", reason="All selected tests completed successfully")
    else:
        result.update(result="TEST_FAILURE", reason="Test command failed; inspect test.log for the cause")
    return result


def child(out):
    contract = json.loads((out / "launch.json").read_text())
    prefix = "test" if contract["mode"] == "tests" else "compiler"
    os.environ.clear()
    os.environ.update(contract["environment"])
    signal.alarm(925 if contract["mode"] != "preflight" else 23)
    save(out, "child-ready.json", {
        "at": now(), "pid": os.getpid(), "cgroup": str(cgroup(os.getpid())),
        "environment": {k: {"state": "present" if k in os.environ else "absent", "value": os.environ.get(k)} for k in ENV_KEYS},
        "nice": os.getpriority(os.PRIO_PROCESS, 0),
    })
    while not (out / "release.json").exists():
        time.sleep(0.02)
    if contract["mode"] != "preflight":
        save(out, prefix + "-started.json", {"at": now(), "command": contract["command"]})
        with (out / (prefix + ".log")).open("w") as log:
            result = subprocess.run(contract["command"], stdout=log, stderr=subprocess.STDOUT)
        save(out, prefix + "-result.json", {"at": now(), "wrapperExitCode": result.returncode})
    # Keep the unit alive so the independent supervisor can capture terminal
    # memory/events before systemd removes the cgroup, even after normal exit.
    while True:
        time.sleep(0.1)


def run(mode, out):
    require(mode in ("preflight", "core", "core-test", "tests"), "Unsupported mode")
    full = mode != "preflight"
    prefix = "test" if mode == "tests" else "compiler"
    manifest = json.loads(Path(__file__).with_name("candidate.json").read_text())
    if full:
        require(os.environ.get("GITHUB_ACTIONS") == "true"
                and os.environ.get("GITHUB_REPOSITORY") == manifest["repository"],
                "Checks are restricted to the approved GitHub repository")
        require(os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "Automatic workflow reruns are disabled")
    out.mkdir(mode=0o700, parents=True)
    unit = "phase5-check-" + str(os.getpid())
    remote = os.environ.get("GITHUB_ACTIONS") == "true"
    ctl = ["sudo", "-n", "systemctl"] if remote else ["systemctl", "--user"]
    launch = ["sudo", "-n", "systemd-run"] if remote else ["systemd-run", "--user"]
    child_cg = None
    launcher = None
    result = {"result": "INTERRUPTED", "reason": "Readiness not completed", "compilerStarted": False}
    released = None

    def deadline(signum, frame):
        raise TimeoutError("Supervisor deadline or external termination")

    signal.signal(signal.SIGALRM, deadline)
    signal.signal(signal.SIGTERM, deadline)
    signal.alarm(920 if full else 20)
    try:
        verify_candidate(manifest, full)
        before = snapshot(out)
        save(out, "before-launch.json", before)
        require(before["MemAvailable"] >= CAP + RESERVE, "Insufficient available memory for cap plus reserve")
        require(before["tmpFree"] >= 2 * GIB, "Less than 2 GiB temporary free space")
        environment = {k: os.environ[k] for k in ("PATH", "HOME", "LANG", "TMPDIR") if k in os.environ}
        environment.update(SETTINGS)
        environment.update({"CI": "true" if remote else "false", "GITHUB_ACTIONS": "true" if remote else "false"})
        node = shutil.which("node")
        require(node is not None, "Node executable missing")
        project = "tsconfig.core.json" if mode == "core" else "test/tsconfig/tsconfig.core.test.json"
        args = ["-p", project, "--incremental", "--tsBuildInfoFile", str(out / (mode + ".tsbuildinfo"))]
        # The inspected helper only defines functions at import. Never import
        # run-tsgo.mjs here: it launches compilation at module top level.
        policy = """
import {applyLocalTsgoPolicy, resolveLocalHeavyCheckEnv} from './scripts/lib/local-heavy-check-runtime.mjs';
process.stdout.write(JSON.stringify(applyLocalTsgoPolicy(JSON.parse(process.argv[1]), resolveLocalHeavyCheckEnv(process.env))));
"""
        prepared = json.loads(subprocess.check_output([node, "--input-type=module", "-e", policy, json.dumps(args)], env=environment, text=True, timeout=5))
        require(prepared["env"] == environment and "--singleThreaded" in prepared["args"], "Unexpected wrapper policy")
        require(prepared["args"][prepared["args"].index("--checkers") + 1] == "1", "Unexpected checker count")
        require(prepared["args"][prepared["args"].index("--declaration") + 1] == "false", "Unexpected declaration policy")
        native = Path("node_modules/@typescript/native-preview-linux-x64/lib/tsgo").resolve()
        identity = {"nativeExecutable": str(native), "preparedNativeArgs": prepared["args"], "actualNativeLaunch": "pending"}
        if full:
            package = json.loads(Path("node_modules/@typescript/native-preview/package.json").read_text())
            require(package["version"] == manifest["compilerVersion"], "Compiler package version changed")
            require(digest(native) == manifest["compilerSha256"], "Native compiler binary changed")
            require(subprocess.check_output([node, "--version"], text=True).strip() == "v" + manifest["nodeVersion"], "Node version changed")
            identity.update({"packageVersion": package["version"], "nativeSha256": digest(native)})
            if shutil.which("go"):
                identity["goBuildMetadata"] = subprocess.check_output(["go", "version", "-m", str(native)], text=True, timeout=5)
        contract = {
            "mode": mode, "environment": environment, "command": [node, "scripts/run-tsgo.mjs", *args],
            "identity": identity, "compilerDeadlineSeconds": 900, "systemdDeadlineSeconds": 930,
            "lockDefaults": {"waitMs": 600000, "pollMs": 500, "progressMs": 15000, "staleMs": 30000},
            "gatewayHealth": "not applicable to isolated compiler; no production Gateway contacted",
        }
        if mode == "tests":
            files = manifest["testFiles"]
            require(files and all(p in manifest["files"] and p.endswith(".test.ts") for p in files),
                    "Tests must be explicit candidate test files")
            environment.update({"NODE_OPTIONS": "--max-old-space-size=4096", "OPENCLAW_VITEST_MAX_WORKERS": "1"})
            contract["command"] = [node, "scripts/run-vitest.mjs", "run", *files, "--maxWorkers=1"]
            contract["identity"]["actualNativeLaunch"] = "not applicable: test runner only"
        save(out, "launch.json", contract)
        properties = [
            "WorkingDirectory=" + str(Path.cwd()), "MemoryMax=7G", "MemoryHigh=7G",
            "MemorySwapMax=0", "CPUQuota=100%", "Nice=10", "TasksMax=128",
            "RuntimeMaxSec=930", "TimeoutStopSec=5", "KillMode=control-group", "OOMPolicy=kill",
        ]
        if remote:
            properties.append("User=" + pwd.getpwuid(os.getuid()).pw_name)
        command = launch + ["--wait", "--pipe", "--unit=" + unit] + ["--property=" + p for p in properties] + [
            sys.executable, "-I", "-B", str(Path(__file__).resolve()), "child", str(out),
        ]
        save(out, "systemd-command.json", command)
        with (out / "systemd.log").open("w") as log:
            launcher = subprocess.Popen(command, stdout=log, stderr=subprocess.STDOUT)
        start = time.monotonic()
        while not (out / "child-ready.json").exists():
            require(launcher.poll() is None, "Child launcher exited before readiness")
            require(time.monotonic() - start < 10, "Child readiness deadline")
            time.sleep(0.02)
        ready = json.loads((out / "child-ready.json").read_text())
        child_cg = cgroup(ready["pid"])
        baseline = snapshot(out, child_cg)
        save(out, "baseline.json", baseline)
        verify_separation(baseline)
        require(ready["nice"] >= 10, "Child priority cap differs")
        require(baseline["MemAvailable"] >= CAP + RESERVE, "Capacity changed before release")
        require(not (out / (prefix + "-started.json")).exists(), "Check started before readiness proof")
        save(out, "separation.json", {"verified": True, "monitorCgroup": str(cgroup(os.getpid())), "childCgroup": str(child_cg)})
        save(out, "release.json", {"at": now(), "separationVerified": True})
        released = time.monotonic()
        previous, streak = host(out), 0
        with (out / "samples.jsonl").open("w") as samples:
            while True:
                time.sleep(1)
                current = snapshot(out, child_cg)
                reason, streak, calculation = guard(current, previous, streak, time.monotonic() - released)
                previous = current
                samples.write(json.dumps({**current, "calculation": calculation, "pressureStreak": streak}) + "\n")
                samples.flush()
                os.fsync(samples.fileno())
                if reason:
                    result = {"result": "INTERRUPTED", "reason": reason}
                    break
                if not full:
                    result = {"result": "PREFLIGHT_PASS", "reason": "Independent monitoring and gated harmless child verified"}
                    break
                if (out / (prefix + "-result.json")).exists():
                    code = json.loads((out / (prefix + "-result.json")).read_text())["wrapperExitCode"]
                    result = classify_tests(code) if mode == "tests" else classify_compiler(code, (out / "compiler.log").read_text(errors="replace"))
                    verify_candidate(manifest, True)
                    break
                if launcher.poll() is not None:
                    result = {"result": "INTERRUPTED", "reason": "Restricted unit exited before check verdict", "launcherExitCode": launcher.returncode}
                    break
    except Exception as error:
        result = {"result": "INTERRUPTED", "reason": str(error), "errorType": type(error).__name__}
    finally:
        signal.alarm(0)
        receipt = None
        try:
            save(out, "pre-stop.json", snapshot(out, child_cg))
            receipt = digest(out / "pre-stop.json")
            save(out, "stop-request.json", {"at": now(), "reason": result, "actorPid": os.getpid(), "preStopSha256": receipt})
        except Exception as error:
            result = {"result": "INTERRUPTED", "reason": "Pre-stop capture failed: " + str(error), "priorResult": result}
        # A capture failure must not prevent cleanup of our owned unit.
        try:
            if launcher is not None:
                try:
                    state = subprocess.run(ctl + ["show", unit, "--property=ActiveState,SubState,Result,ExecMainCode,ExecMainStatus,MemoryPeak,CPUUsageNSec"], text=True, capture_output=True, timeout=5)
                    save(out, "unit-before-stop.json", {"exitCode": state.returncode, "stdout": state.stdout, "stderr": state.stderr})
                    if "Result=oom-kill" in state.stdout:
                        result = {"result": "INTERRUPTED", "reason": "Kernel OOM killed the restricted unit", "priorResult": result}
                except Exception as error:
                    result = {"result": "INTERRUPTED", "reason": "Unit-state capture failed: " + str(error), "priorResult": result}
                stopped = subprocess.run(ctl + ["stop", unit], text=True, capture_output=True, timeout=10)
                save(out, "stop-result.json", {"exitCode": stopped.returncode, "stdout": stopped.stdout, "stderr": stopped.stderr})
                require(stopped.returncode == 0, "Owned unit cleanup failed")
                launcher.wait(timeout=5)
                require(not child_cg or not child_cg.exists() or not (child_cg / "cgroup.procs").read_text().strip(), "Owned child still active")
            require(receipt is not None, "No pre-stop receipt survived")
            require(digest(out / "pre-stop.json") == receipt, "Evidence changed after termination")
            result["preStopEvidenceSurvived"] = True
        except Exception as error:
            result = {"result": "INTERRUPTED", "reason": "Cleanup/evidence failure: " + str(error), "priorResult": result}
        result.update({"at": now(), "compilerStarted": (out / "compiler-started.json").exists(),
                       "testsStarted": (out / "test-started.json").exists(),
                       "releasedAtMonotonic": released, "candidateDiffSha256": manifest["diffSha256"]})
        save(out, "result.json", result)
        print(json.dumps(result), flush=True)
    return 0 if result["result"] in ("PASS", "PREFLIGHT_PASS") else 1


if __name__ == "__main__":
    require(len(sys.argv) == 3, "Usage: supervisor.py preflight|core|core-test|tests|child OUTPUT")
    output = Path(sys.argv[2]).resolve()
    if sys.argv[1] == "child":
        child(output)
    else:
        sys.exit(run(sys.argv[1], output))
