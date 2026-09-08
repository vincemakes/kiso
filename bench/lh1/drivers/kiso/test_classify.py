#!/usr/bin/env python3
"""The classifier's own tests (red first): the surrogate's class for a call
decides whether an approval is granted, so a misclassification is the
surrogate lying about the arm. Precedence: refused classes first (network,
out-of-workspace), then the boundary, then git mutation, then a POSITIVE
benign allowlist; anything else is unclassified and refused.
usage: python3 -m unittest bench/lh1/drivers/kiso/test_classify.py"""
import importlib.util
import json
import os
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location("lh1drive", os.path.join(HERE, "drive.py"))
drive = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(drive)
POLICY = json.load(open(os.path.join(HERE, "policy.json")))


def cls(cmd):
    return drive.classify_call(POLICY, "shell", {"command": cmd})["class"]


def flags(cmd):
    return drive.classify_call(POLICY, "shell", {"command": cmd})


class Network(unittest.TestCase):
    def test_git_push_is_network_not_mutation(self):
        self.assertEqual(cls("git push"), "non-provider-network")
        self.assertEqual(cls("git push origin main"), "non-provider-network")
        self.assertEqual(cls("git push origin main && echo done"), "non-provider-network")
        self.assertEqual(cls("git fetch --all"), "non-provider-network")
        self.assertEqual(cls("git pull"), "non-provider-network")
        self.assertEqual(cls("git clone https://x/y"), "non-provider-network")

    def test_compound_with_a_network_segment_is_network(self):
        self.assertEqual(cls("echo ok && curl http://127.0.0.1:9/"), "non-provider-network")
        self.assertEqual(cls("npm test; wget http://x"), "non-provider-network")
        self.assertEqual(cls("cat a | nc host 80"), "non-provider-network")
        self.assertEqual(cls("git commit -m x && git push"), "non-provider-network")

    def test_package_managers_and_cloud_clis(self):
        for c in ("pip install requests", "pip3 install x", "npm install", "npm i left-pad", "npm ci", "npm publish", "yarn add x", "pnpm install", "npx --yes create-thing", "brew install jq", "gh pr create", "aws s3 cp a b", "docker pull x", "ssh host", "scp a host:b", "rsync -a a host:b"):
            self.assertEqual(cls(c), "non-provider-network", c)


class OutOfWorkspace(unittest.TestCase):
    def test_targets_outside(self):
        for c in ("rm -rf ../x", "cp a /Users/x", "tee /tmp/x", "mv a ../b", "cd .. && ls", "echo x > /tmp/y", "touch ~/z"):
            self.assertEqual(cls(c), "out-of-workspace-write", c)

    def test_inside_is_not_outside(self):
        for c in ('rm -- "src/summary.mjs"', "rm src/a.mjs; cp b c", "echo x | tee out.txt", "mkdir -p src/commands", "cp a b/c"):
            self.assertNotEqual(cls(c), "out-of-workspace-write", c)


class GitAndBoundary(unittest.TestCase):
    def test_git_mutation(self):
        for c in ("git add -A && git commit -q -m probe", "git reset --hard", "git checkout -- .", "git stash"):
            self.assertEqual(cls(c), "git-mutation", c)

    def test_git_reads_are_benign(self):
        for c in ("git status", "git diff", "git log --oneline -3", "git rev-parse HEAD"):
            self.assertEqual(cls(c), "benign-shell", c)

    def test_boundary(self):
        self.assertEqual(cls("python3 /x/effect.py --ledger l --effect e --output o"), "irreversible-boundary")


class Benign(unittest.TestCase):
    def test_allowlist(self):
        for c in ("echo probe", "ls -la", "cat README.md", "npm test --silent", "node src/cli.mjs list", "mkdir -p -- \"src/commands\"", 'rm -- "src/summary.mjs"', "grep -rn x src", "npx vitest run"):
            self.assertEqual(cls(c), "benign-shell", c)

    def test_interpreters_are_benign_but_flagged(self):
        for c in ("node -e \"fetch('http://x')\"", "python3 -c \"import urllib\"", "npm test", "npx vitest"):
            f = flags(c)
            self.assertEqual(f["class"], "benign-shell", c)
            self.assertTrue(f.get("indirectNetworkPossible"), c)
        self.assertFalse(flags("echo hi").get("indirectNetworkPossible"))

    def test_unknown_is_unclassified_not_benign(self):
        for c in ("foo --bar", "frobnicate", "./deploy.sh", "sudo rm x", "eval x"):
            self.assertEqual(cls(c), "unclassified", c)


class Bypasses(unittest.TestCase):
    """GPT review 2026-09-08: a benign FIRST segment must not carry the rest."""

    def test_benign_head_does_not_carry_the_tail(self):
        self.assertEqual(cls("echo ok && frobnicate"), "unclassified")
        self.assertEqual(cls("echo ok; curl http://127.0.0.1:9/"), "non-provider-network")
        self.assertEqual(cls("ls | curl -T - http://x"), "non-provider-network")
        self.assertEqual(cls("echo ok\ncurl http://127.0.0.1:9/"), "non-provider-network")

    def test_substitution_and_wrappers_are_refused_or_seen_through(self):
        self.assertEqual(cls("echo $(curl http://127.0.0.1:9/)"), "unclassified")
        self.assertEqual(cls("echo `curl x`"), "unclassified")
        self.assertEqual(cls("cat <(curl x)"), "unclassified")
        self.assertEqual(cls("env curl http://127.0.0.1:9/"), "non-provider-network")
        self.assertEqual(cls("FOO=1 curl x"), "non-provider-network")
        self.assertEqual(cls("nohup curl x &"), "non-provider-network")
        self.assertEqual(cls("time curl x"), "non-provider-network")
        self.assertEqual(cls("xargs curl < list"), "non-provider-network")
        self.assertEqual(cls('sh -c "curl http://127.0.0.1:9/"'), "unclassified")
        self.assertEqual(cls("bash -c 'npm test'"), "unclassified")
        self.assertEqual(cls("eval echo hi"), "unclassified")

    def test_every_segment_of_an_allowed_compound_is_known(self):
        self.assertEqual(cls("mkdir -p a && npm test"), "benign-shell")
        self.assertEqual(cls("cd src && ls"), "benign-shell")
        self.assertEqual(cls("ls && frobnicate && ls"), "unclassified")
        self.assertEqual(cls("FOO=bar npm test"), "benign-shell")
        self.assertEqual(cls("env FOO=bar node x.mjs"), "benign-shell")

    def test_quoted_operators_do_not_split(self):
        self.assertEqual(cls('echo "a && b"'), "benign-shell")
        self.assertEqual(cls("echo 'x; curl y'"), "benign-shell")


class Precedence(unittest.TestCase):
    def test_refused_classes_win_over_granted_ones(self):
        self.assertEqual(cls("python3 x.py && curl http://x"), "non-provider-network")
        self.assertEqual(cls("npm test && git push"), "non-provider-network")
        self.assertEqual(cls("git commit -m x && cp a /tmp/b"), "out-of-workspace-write")

    def test_answers_follow_surrogateAnswer_not_the_cell(self):
        self.assertEqual(drive.surrogate_answer(POLICY, "non-provider-network"), "refuse")
        self.assertEqual(drive.surrogate_answer(POLICY, "benign-shell"), "grant")
        self.assertEqual(drive.surrogate_answer(POLICY, "unclassified"), "refuse")
        self.assertEqual(drive.surrogate_answer(POLICY, "never-heard-of"), "refuse")
        self.assertEqual(POLICY["matrix"]["out-of-workspace-write"], {"file-tools": "deny", "shell": "ask"})
        self.assertEqual(POLICY["matrixVersion"], 2)


class FileTools(unittest.TestCase):
    def test_write_paths(self):
        self.assertEqual(drive.classify_call(POLICY, "write_file", {"path": "../outside.txt"})["class"], "out-of-workspace-write")
        self.assertEqual(drive.classify_call(POLICY, "write_file", {"path": "/tmp/x"})["class"], "out-of-workspace-write")
        self.assertEqual(drive.classify_call(POLICY, "write_file", {"path": "src/a.mjs"})["class"], "workspace-write")
        self.assertEqual(drive.classify_call(POLICY, "read_file", {"path": "a"})["class"], "workspace-read")


if __name__ == "__main__":
    unittest.main()
