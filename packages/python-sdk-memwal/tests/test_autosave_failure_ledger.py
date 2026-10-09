"""Focused regressions for persistence failures after background saves settle."""

import asyncio
import threading

import pytest

from memwal.middleware import _PendingSaves


def test_completed_async_failure_survives_task_eviction() -> None:
    async def main() -> None:
        pending = _PendingSaves()

        async def failed_save() -> None:
            raise RuntimeError("PRIVATE_FACT_MUST_NOT_LEAK")

        pending.track_task(asyncio.create_task(failed_save()))
        await asyncio.sleep(0)
        await asyncio.sleep(0)  # Allow the done callback to untrack the task.

        with pytest.raises(RuntimeError, match="1 background auto-save") as exc:
            await pending.flush()
        assert "PRIVATE_FACT_MUST_NOT_LEAK" not in str(exc.value)

        # A failure is acknowledged once, not silently erased before flushing.
        await pending.flush()

    asyncio.run(main())


def test_cancelled_autosave_is_reported() -> None:
    async def main() -> None:
        pending = _PendingSaves()
        task = asyncio.create_task(asyncio.sleep(30))
        pending.track_task(task)
        task.cancel()

        with pytest.raises(RuntimeError, match="1 background auto-save"):
            await pending.flush()
        await pending.flush()

    asyncio.run(main())


def test_completed_thread_failure_survives_untracking() -> None:
    pending = _PendingSaves()
    completed = threading.Event()

    def failed_save() -> None:
        completed.set()
        raise ValueError("PRIVATE_SYNC_RESULT")

    pending.spawn_thread(failed_save)
    assert completed.wait(timeout=2)

    with pytest.raises(RuntimeError, match="1 background auto-save") as exc:
        pending.flush_sync()
    assert "PRIVATE_SYNC_RESULT" not in str(exc.value)
    pending.flush_sync()


def test_successful_saves_flush_without_error() -> None:
    pending = _PendingSaves()
    pending.spawn_thread(lambda: None)
    pending.flush_sync()
