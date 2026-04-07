import hashlib


def handler(ctx):
    session_id = ctx.get("sessionId", "session")
    turn_id = ctx.get("turnId", "turn")
    runtime_id = ctx.get("runtimeId", "runtime")
    tier = ctx.get("input", {}).get("tier", "none")
    event_id = ctx.get("input", {}).get("eventId", "none")

    raw = f"{session_id}:{turn_id}:{runtime_id}:{tier}:{event_id}"
    digest = hashlib.sha1(raw.encode("utf-8")).hexdigest()[:12]
    return {
        "tag": f"luck-{digest}"
    }
