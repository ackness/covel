import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "scripts"))

from generate_luck_tag import handler


def test_generate_luck_tag():
    result = handler(
        {
            "sessionId": "session-1",
            "turnId": "turn-2",
            "runtimeId": "luck-roller",
            "input": {
                "tier": "rare",
                "eventId": "hidden-passage",
            },
        }
    )

    assert result["tag"].startswith("luck-")
    assert len(result["tag"]) > 10


if __name__ == "__main__":
    test_generate_luck_tag()
    print("All tests passed!")
