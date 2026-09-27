"""Tests for the Jev runner: the real jev-ultrafast policy code, a fake TypeSafe
and a fake browser.

    JEV_ULTRAFAST_DIR=<a jev-ultrafast checkout> python3 apps/jev-runner/runner_test.py

Needs httpx (jev_ultrafast.model imports it); no network, no key.
"""

import json
import os
import sys
import unittest

os.environ.setdefault("TYPESAFE_API_KEY", "test-key")
sys.path.insert(0, os.path.dirname(__file__))
import runner  # noqa: E402


def answer(choice, ids):
    ids = list(ids)
    probs = {i: (0.9 if i == choice else 0.1 / max(1, len(ids) - 1)) for i in ids}
    if len(ids) == 1:
        probs = {choice: 1.0}
    return {"choice": choice, "probabilities": probs, "confidence": 0.9}


class FakeTypeSafe:
    """Answers in order from a script of (OPERATION, target label) — or, for a
    value question, the value's name."""

    def __init__(self, script, broken=False):
        self.script, self.broken, self.bodies = list(script), broken, []

    def __call__(self, url, key, body):
        self.bodies.append(body)
        if self.broken:
            return {"answers": {"operation": {"choice": "NOPE"}}, "model": "fake"}
        questions = body["questions"]
        if "value" in questions:
            name = self.script.pop(0)
            criteria = questions["value"]["criteria"]
            pick = next((k for k, c in criteria.items() if k != "NONE" and c["name"] == name), "NONE")
            return {"answers": {"value": answer(pick, criteria)}, "model": "fake"}
        op, label = self.script.pop(0)
        answers = {"operation": answer(op, questions["operation"]["criteria"])}
        for qname, q in questions.items():
            if qname == "operation":
                continue
            ids = list(q["criteria"])
            hit = next((i for i, c in q["criteria"].items() if label and label in c["element"]), ids[0])
            answers[qname] = answer(hit, ids)
        return {"answers": answers, "model": "fake", "usage": {}}


def page(title, actions, text="Flights"):
    return {"url": f"https://example.com/{title}", "title": title, "text": text, "scroll": 0,
            "actions": actions}


SEARCH = page("search", [
    {"id": "e1", "node": 1, "kind": "fill", "label": "From", "role": "combobox", "value": ""},
    {"id": "e2", "node": 2, "kind": "click", "label": "Search", "role": "button"},
])
RESULTS = page("results", [{"id": "e3", "node": 3, "kind": "click", "label": "First flight", "role": "link"}], "3 flights")


class FakeBrowser:
    """Serves observations and records actions; `acts` maps id → what happens."""

    def __init__(self, first, acts):
        self.state, self.acts, self.log, self.sent = first, acts, [], []

    def install(self):
        pending = []

        def send(message):
            self.sent.append(message)
            if "op" in message:
                pending.append(message)

        def receive():
            msg = pending.pop(0)
            if msg["op"] == "observe":
                return {"ok": True, "state": self.state}
            self.log.append((msg["id"], msg.get("text")))
            outcome = self.acts.get(msg["id"])
            if isinstance(outcome, list):
                outcome = outcome.pop(0) if outcome else self.state
            if isinstance(outcome, str):
                return {"ok": False, "error": outcome}
            if outcome is not None:
                self.state = outcome
            return {"ok": True, "state": self.state}

        runner.send, runner.receive = send, receive


class RunnerTest(unittest.TestCase):
    def go(self, browser, ts, goal="Find flights from Zurich", values=None, max_actions=10):
        browser.install()
        runner.model.post_json = ts
        return runner.run(goal, values or {}, max_actions)

    def test_types_a_given_value_clicks_and_finishes(self):
        b = FakeBrowser(SEARCH, {"e1": None, "e2": RESULTS})
        ts = FakeTypeSafe([("TYPE_TEXT", "From"), "from", ("CLICK", "Search"), ("DONE", None)])
        result = self.go(b, ts, values={"from": "Zurich"})
        self.assertEqual(result["status"], "done")
        self.assertEqual(b.log, [("e1", "Zurich"), ("e2", None)])
        steps = [m for m in b.sent if m.get("event") == "step"]
        self.assertEqual([s["label"] for s in steps], ["From", "Search"])

    def test_no_fitting_value_hands_the_field_back(self):
        b = FakeBrowser(SEARCH, {})
        ts = FakeTypeSafe([("TYPE_TEXT", "From"), "nothing-fits"])
        result = self.go(b, ts, values={"date": "20 September"})
        self.assertEqual(result["status"], "needs_value")
        self.assertIn("From", result["detail"])
        self.assertEqual(b.log, [])

    def test_no_values_at_all_hands_the_field_back_without_asking(self):
        b = FakeBrowser(SEARCH, {})
        ts = FakeTypeSafe([("TYPE_TEXT", "From")])
        result = self.go(b, ts)
        self.assertEqual(result["status"], "needs_value")
        self.assertEqual(len(ts.bodies), 1)

    def test_a_stale_refusal_is_observed_again_not_failed(self):
        b = FakeBrowser(SEARCH, {"e2": ["That control changed or is covered. Take a new snapshot.", RESULTS]})
        ts = FakeTypeSafe([("CLICK", "Search"), ("CLICK", "Search"), ("DONE", None)])
        result = self.go(b, ts)
        self.assertEqual(result["status"], "done")
        self.assertEqual(b.log, [("e2", None), ("e2", None)])

    def test_three_actions_that_change_nothing_stop_the_run(self):
        b = FakeBrowser(SEARCH, {"e2": None})
        ts = FakeTypeSafe([("CLICK", "Search")] * 5)
        result = self.go(b, ts)
        self.assertEqual(result["status"], "blocked")
        self.assertEqual(len(b.log), 3)

    def test_a_hard_refusal_ends_the_run_with_its_reason(self):
        b = FakeBrowser(SEARCH, {"e2": "That leads away from this site, which is not allowed."})
        ts = FakeTypeSafe([("CLICK", "Search")])
        with self.assertRaises(RuntimeError) as ctx:
            self.go(b, ts)
        self.assertIn("away from this site", str(ctx.exception))

    def test_an_invalid_typesafe_answer_is_never_executed(self):
        b = FakeBrowser(SEARCH, {})
        with self.assertRaises(ValueError):
            self.go(b, FakeTypeSafe([], broken=True))
        self.assertEqual(b.log, [])

    def test_the_action_budget_holds(self):
        loop = page("loop", [{"id": "e9", "node": 9, "kind": "click", "label": "Next", "role": "button"}])
        pages = [page(f"p{i}", loop["actions"], f"page {i}") for i in range(10)]
        b = FakeBrowser(loop, {"e9": pages})
        ts = FakeTypeSafe([("CLICK", "Next")] * 10)
        result = self.go(b, ts, max_actions=4)
        self.assertEqual(result["status"], "budget")
        self.assertEqual(len(b.log), 4)


if __name__ == "__main__":
    unittest.main(verbosity=2)
