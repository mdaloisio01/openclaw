"""Small guard/evidence tests; never starts the compiler or a cgroup."""
from pathlib import Path
import importlib.util
import json
import os
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("supervisor", Path(__file__).with_name("supervisor.py"))
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


class GuardTests(unittest.TestCase):
    def sample(self, second, total, available=12 * supervisor.GIB):
        return {"monotonic": second, "memoryFullTotalUs": total,
                "MemAvailable": available, "tmpFree": 3 * supervisor.GIB}

    def test_lifetime_counter_is_not_pressure(self):
        before = self.sample(20, 900000000)
        current = self.sample(21, 900000001)
        reason, streak, calculation = supervisor.guard(current, before, 0, 1)
        self.assertIsNone(reason)
        self.assertEqual(streak, 0)
        self.assertEqual(calculation["fullStallDeltaUs"], 1)

    def test_five_measured_intervals_and_reset(self):
        streak, before = 0, self.sample(0, 0)
        for second in range(1, 6):
            current = self.sample(second, second * 20000)
            reason, streak, _ = supervisor.guard(current, before, streak, second)
            self.assertEqual(reason is not None, second == 5)
            before = current
        current = self.sample(6, 100000)
        reason, streak, _ = supervisor.guard(current, before, streak, 6)
        self.assertIsNone(reason)
        self.assertEqual(streak, 0)

    def test_elapsed_time_and_capacity_precedence(self):
        before, current = self.sample(0, 0), self.sample(2, 30000)
        _, _, calculation = supervisor.guard(current, before, 0, 2)
        self.assertEqual(calculation["fullStallPercent"], 1.5)
        current["MemAvailable"] = supervisor.RESERVE - 1
        reason, _, _ = supervisor.guard(current, before, 4, 901)
        self.assertIn("4 GiB", reason)

    def test_bad_measurements_cannot_pass(self):
        for current in [self.sample(0, 1), self.sample(1, -1)]:
            with self.assertRaises(RuntimeError):
                supervisor.guard(current, self.sample(0, 0), 0, 1)

    def test_receipt_survives_writer_scope(self):
        with tempfile.TemporaryDirectory() as directory:
            out = Path(directory)
            supervisor.save(out, "receipt.json", {"beforeTermination": True})
            expected = supervisor.digest(out / "receipt.json")
            self.assertEqual(json.loads((out / "receipt.json").read_text()), {"beforeTermination": True})
            self.assertEqual(supervisor.digest(out / "receipt.json"), expected)
            self.assertFalse((out / "receipt.json.tmp").exists())

    def test_diagnostics_do_not_hide_interruption(self):
        for code in (-15, 137, 143):
            self.assertEqual(supervisor.classify_compiler(code, "error TS2322: example")["result"], "INTERRUPTED")
        self.assertEqual(supervisor.classify_compiler(1, "error TS2322: example")["result"], "CODE_ERRORS")
        self.assertEqual(supervisor.classify_compiler(2, "error TS2322: example")["result"], "CODE_ERRORS")
        for crash in ("panic: example", "fatal error: out of memory", "runtime: cannot allocate memory", "panic during panic", "stack trace unavailable"):
            self.assertEqual(supervisor.classify_compiler(2, "error TS2322: example\n" + crash)["result"], "INTERRUPTED")
        self.assertEqual(supervisor.classify_compiler(0, "")["result"], "PASS")

    def test_wrapper_preserves_harmless_child_outcome(self):
        wrapper = Path(__file__).resolve().parents[2] / "scripts/run-tsgo.mjs"
        # Temporary fake executable: neither the installed compiler nor a project
        # is reachable. --version also keeps the heavy-check lock out of this test.
        with tempfile.TemporaryDirectory() as directory:
            fake = Path(directory) / "node_modules/.bin/tsgo"
            fake.parent.mkdir(parents=True)
            cases = (
                ("exit 0", 0, "PASS"),
                ("exit 1", 1, "CODE_ERRORS"),
                ("exit 2", 2, "CODE_ERRORS"),
                ("printf 'panic: harmless fixture\\n'\nexit 2", 2, "INTERRUPTED"),
                ("printf 'fatal error: harmless fixture\\n'\nexit 2", 2, "INTERRUPTED"),
                ("kill -TERM $$", 143, "INTERRUPTED"),
            )
            for ending, expected, verdict in cases:
                fake.write_text("#!/bin/sh\nprintf 'error TS2322: harmless fixture\\n'\n" + ending + "\n")
                fake.chmod(0o700)
                env = {k: os.environ[k] for k in ("PATH", "HOME", "LANG") if k in os.environ}
                run = subprocess.run([shutil.which("node"), str(wrapper), "--version"], cwd=directory,
                                     env=env, text=True, capture_output=True, timeout=5)
                self.assertEqual(run.returncode, expected, run.stderr)
                self.assertEqual(supervisor.classify_compiler(run.returncode, run.stdout + run.stderr)["result"], verdict)
                if expected == 143:
                    self.assertIn("native process terminated by SIGTERM", run.stderr)


if __name__ == "__main__":
    unittest.main()
