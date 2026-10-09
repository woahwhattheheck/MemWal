"""Focused regression for Python SDK HTTP-date Retry-After handling.

Run from packages/python-sdk-memwal:
    pytest -q tests/test_retry_after_http_date.py
"""

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime
from types import SimpleNamespace

from memwal.client import (
    _clamped_retry_after_ms,
    _now_ms,
    _positive_retry_ms,
    _retry_after_ms,
)


def _error(retry_after: str, body: str = "") -> SimpleNamespace:
    return SimpleNamespace(retry_after=retry_after, body=body)


def test_retry_after_http_date_uses_provider_cooldown_instead_of_rapid_polling():
    date = format_datetime(datetime.now(timezone.utc) + timedelta(seconds=45), usegmt=True)
    err = _error(date, '{"retry_after_seconds": 1}')
    delay_ms = _retry_after_ms(err)
    # Email HTTP-date formatting rounds to seconds; the JSON fallback MUST
    # NOT override a longer, valid Retry-After header.
    assert 43_000 <= delay_ms <= 45_000
    assert 0 < _clamped_retry_after_ms(err, _now_ms() + 5_000) <= 5_000


def test_past_or_invalid_http_date_falls_back_to_body():
    past = format_datetime(datetime.now(timezone.utc) - timedelta(minutes=1), usegmt=True)
    assert _retry_after_ms(_error(past, '{"retry_after_seconds": 2}')) == 2_000
    assert _retry_after_ms(_error("not an HTTP date", '{"retry_after_seconds": 3}')) == 3_000


def test_seconds_and_overflowing_seconds_remain_safe():
    assert _retry_after_ms(_error("2.5", '{"retry_after_seconds": 10}')) == 2_500
    assert _positive_retry_ms("1e308") is None
    assert _retry_after_ms(_error("1e308", '{"retry_after_seconds": 4}')) == 4_000
