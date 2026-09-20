#!/usr/bin/env python3
"""
A persistent Laya evaluator.

Laya ships as a Python library with no server mode, and its CLI loads the model
on every invocation — which is exactly what must not happen here: the model load
dominates, and routing calls it many times per session. So this is the smallest
thing that keeps a loaded model alive: newline-delimited JSON on stdin and
stdout, one model load at startup, one forward pass per request.

Deliberately not a web service. No port, no framework, no dependency beyond the
Laya runtime itself; the parent process owns its lifetime, and when the session
ends the process ends with it.

Protocol (one JSON object per line):
  in   {"id": "...", "op": "evaluate", "state": {...}, "questions": {...}}
       {"id": "...", "op": "ping"}
  out  {"id": "...", "ok": true, "answers": {...}, "latencyMs": 12, ...}
       {"id": "...", "ok": false, "error": "..."}

Startup writes one {"ready": true, ...} line carrying the model load time and
resident memory, so the caller can record what the load cost.
"""
import json
import os
import sys
import time


def _rss_mib():
    """Resident memory, if the platform makes it cheap to ask. No monitoring subsystem."""
    try:
        import resource
        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        # Linux reports kilobytes, macOS bytes.
        return round(peak / (1024 * 1024), 1) if sys.platform == "darwin" else round(peak / 1024, 1)
    except Exception:
        return None


def _emit(payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def _load(model, runtime, dtype):
    """
    Load a Laya model. `laya_mlx` is the Apple silicon runtime and `laya` the
    portable one; they expose the same load/predict surface, so the choice is
    which module to import rather than which code path to take.
    """
    if runtime == "mlx":
        import laya_mlx as backend
    elif runtime == "auto":
        try:
            import laya_mlx as backend
        except ImportError:
            import laya as backend
    else:
        import laya as backend

    try:
        return backend.load(model, dtype=dtype), backend
    except TypeError:
        # The portable runtime does not take a dtype.
        return backend.load(model), backend


def main():
    model = os.environ.get("LAYA_MODEL", "aac6fef/laya-mlx")
    runtime = os.environ.get("LAYA_RUNTIME", "auto")
    dtype = os.environ.get("LAYA_DTYPE", "float16")

    started = time.perf_counter()
    try:
        agent, backend = _load(model, runtime, dtype)
    except Exception as error:  # noqa: BLE001 - the caller needs the reason, whatever it is
        _emit({"ready": False, "error": f"{type(error).__name__}: {error}"})
        return 1
    load_ms = round((time.perf_counter() - started) * 1000)

    _emit({
        "ready": True,
        "model": model,
        "runtime": getattr(backend, "__name__", runtime),
        "dtype": dtype,
        "modelLoadMs": load_ms,
        "rssMiB": _rss_mib(),
        "pid": os.getpid(),
    })

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError:
            continue  # a malformed frame has no id to answer

        request_id = request.get("id")
        op = request.get("op", "evaluate")

        if op == "ping":
            _emit({"id": request_id, "ok": True, "modelLoadMs": load_ms, "rssMiB": _rss_mib()})
            continue
        if op == "shutdown":
            _emit({"id": request_id, "ok": True})
            return 0

        try:
            questions = request["questions"]
            began = time.perf_counter()
            # One call for every predicate: Laya batches internally, and asking
            # per predicate would forfeit the property this design depends on.
            result = agent.predict(request.get("state"), questions)
            latency_ms = round((time.perf_counter() - began) * 1000, 2)
            _emit({
                "id": request_id,
                "ok": True,
                "answers": result.get("answers", {}),
                "latencyMs": latency_ms,
                "questionCount": len(questions),
                "usage": {
                    key: result[key] for key in ("input_tokens", "output_tokens") if key in result
                } or None,
                "rssMiB": _rss_mib(),
            })
        except Exception as error:  # noqa: BLE001 - one bad request must not end the process
            _emit({"id": request_id, "ok": False, "error": f"{type(error).__name__}: {error}"})

    return 0


if __name__ == "__main__":
    sys.exit(main())
