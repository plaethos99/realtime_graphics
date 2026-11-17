"""Recording sessions: cleaning the transcript and building the saved recording."""
import asyncio

from app.sessions import Line, Session, Sessions


def test_clean_lines_drop_repeats_and_microphone_echo():
    s = Session(id="x", mode="meeting")
    s.lines = [
        Line(0.0, "mic", "Hi everyone."),
        Line(5.0, "system", "Hi everyone, this is Priya. Let's review the launch plan."),
        Line(6.0, "mic", "this is Priya, let's review the launch plan"),  # the mic hearing the speakers
        Line(8.0, "mic", "I'm a friend."),
        Line(9.0, "mic", "I'm a friend."),
        Line(10.0, "mic", "I'm a friend."),
        Line(30.0, "mic", "Sounds good to me."),
    ]
    assert [(l.source, l.text) for l in s.clean_lines()] == [
        ("mic", "Hi everyone."),
        ("system", "Hi everyone, this is Priya. Let's review the launch plan."),
        ("mic", "I'm a friend."),
        ("mic", "Sounds good to me."),
    ]
    assert "[0:05] Others: Hi everyone, this is Priya." in s.transcript()
    assert "[0:30] You: Sounds good to me." in s.transcript()


class FakeSTT:
    def __init__(self):
        self.prompts = []

    async def transcribe_segments(self, data, filename, content_type, prompt=""):
        self.prompts.append(prompt)
        return [(0.5, "Thank you."), (2.0, "We ship on Friday.")]


class FakeLLM:
    async def complete(self, messages, max_tokens=None):
        return (
            '{"title": "Launch", "summary": "We agreed to ship.", "key_points": ["Ship Friday"], '
            '"decisions": ["Ship on Friday"], "actions": [{"who": "Marco", "what": "Fix the crash", "when": "Friday"}]}'
        )


def test_session_end_to_end(tmp_path):
    from app.books.library import Library

    stt, library = FakeSTT(), Library(tmp_path)
    sessions = Sessions(stt, FakeLLM(), library)
    session = sessions.create("meeting")

    async def run():
        await sessions.add_audio(session.id, b"wav", "system", 10.0)
        await sessions.add_audio(session.id, b"wav", "mic", 20.0)
        assert "We ship on Friday" in sessions.context(session.id)
        return await sessions.finish(session.id)

    result = asyncio.run(run())
    assert stt.prompts[1] == ""  # the mic's prompt doesn't include the computer's words
    assert [l.text for l in session.lines] == ["We ship on Friday.", "We ship on Friday."]  # "Thank you." dropped
    assert result["title"] == "Launch" and result["scene"]["panel"]["type"] == "steps"
    book = library.get(result["book"])
    assert book["genre"] == "meeting" and [p["title"] for p in book["parts"]][0] == "Summary"
    summary = library.part_text(book["id"], 0)
    assert "Marco: Fix the crash (by Friday)" in summary and "Ship on Friday" in summary
    assert session.id not in sessions.active


def test_garbled_echo_overlapping_in_time_is_dropped():
    s = Session(id="y", mode="meeting")
    s.lines = [
        Line(20.0, "system", "Then we move the launch from March 3rd to March 10th. Marco, can you fix the payment crash by Friday?"),
        Line(20.5, "mic", "Then he moved the launch on March 30, March 10"),
        Line(22.5, "mic", "the last time I'm on the pitco crash by Friday"),
        Line(23.0, "mic", "Friday works for me."),  # a real reply: only one shared word
    ]
    assert [l.text for l in s.clean_lines() if l.source == "mic"] == ["Friday works for me."]
