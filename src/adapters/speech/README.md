# adapters/speech

Wraps the Web Speech API (`fr-FR` synthesis) for the domain.

Boundary: the only place `SpeechSynthesis`/`speechSynthesis` is touched. Exposes a
small port the domain can call; never leaks browser speech types outward.
