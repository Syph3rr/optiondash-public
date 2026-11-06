"""Errors shared by the router and the stdio layer; no heavy imports."""


class NotFound(Exception):
    """Neither source knows the symbol."""


class CodedError(ValueError):
    """An expected failure the gateway maps by `code` (e.g. "not_connected", "timeout",
    "busy"). It is a ValueError, so the stdio layer answers it without logging a crash."""

    def __init__(self, message: str, code: str):
        super().__init__(message)
        self.code = code
