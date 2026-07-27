"""Fake `copperhead serve` child for client.py tests: speaks just enough
NDJSON to exercise every ServeClient behavior, with failure modes selected
via COPPERHEAD_FAKE_MODE (normal | garbage | die | stderr)."""

import json
import os
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    mode = os.environ.get("COPPERHEAD_FAKE_MODE", "normal")
    if mode == "die":
        sys.exit(7)
    if mode == "stderr":
        for i in range(8):
            sys.stderr.write("stderr line %d\n" % i)
        sys.stderr.flush()
        sys.exit(3)
    emit(
        {
            "event": "hello",
            "data": {
                "protocol": 1,
                "model": "fake",
                "repoRoot": os.getcwd(),
                # Lets tests prove the client forwards its environment.
                "marker": os.environ.get("COPPERHEAD_TEST_MARKER", ""),
            },
        }
    )
    if mode == "garbage":
        sys.stdout.write("this line is not json at all\n")
        sys.stdout.flush()
    for line in sys.stdin:
        try:
            req = json.loads(line)
        except ValueError:
            continue
        rid = req.get("id")
        if req.get("method") == "run":
            emit({"id": rid, "event": "log", "data": {"line": "working"}})
            emit({"id": rid, "result": {"outcome": "success", "summary": req["params"]["request"]}})
        elif req.get("method") == "check":
            emit({"id": rid, "result": {"ok": True}})
        else:
            emit({"id": rid, "error": {"code": "unknown-method", "message": "?"}})


if __name__ == "__main__":
    main()
