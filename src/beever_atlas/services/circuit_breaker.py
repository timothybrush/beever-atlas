"""Injectable LLM circuit breaker (PR-C).

Replaces the module-level globals that previously lived at
``services/batch_processor.py:53-54`` (``_consecutive_503_count`` /
``_consecutive_503_lock``). Module-level asyncio primitives are not
test-injectable and bind to whichever event loop first imports the
module — pytest tearing down a TestClient loop and starting a new one
left dangling locks pointing at a closed loop, which manifested as
``Event loop is closed`` failures across the sync_runner test file.

This class is the structural fix: callers receive a ``CircuitBreaker``
through their constructor (default singleton via
:func:`get_circuit_breaker`), so per-test instantiation is trivial
and there are no module-globals to reset.

States: ``closed`` (allow all) → ``open`` (fail fast) → ``half_open``
(probe with one call) → back to ``closed`` (probe success) or
``open`` (probe failure).

Spec: ``openspec/changes/oss-pipeline-and-wiki-redesign/specs/llm-circuit-breaker/``
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass, field
from typing import Literal

logger = logging.getLogger(__name__)


BreakerState = Literal["closed", "open", "half_open"]


@dataclass
class CircuitBreakerSnapshot:
    """Read-only snapshot of breaker state for observability endpoints."""

    state: BreakerState
    consecutive_failures: int
    threshold: int
    cooldown_seconds: int
    opened_at: float | None
    last_transition: str | None


class CircuitBreaker:
    """LLM circuit breaker with three-state machine.

    Concurrency: an internal ``asyncio.Lock`` guards state transitions
    so two tasks racing through ``allow()`` cannot both enter
    ``half_open`` and burn two probes against an upstream that's still
    unhealthy. The lock is created lazily on first ``allow()``/
    ``record_*`` call so the constructor is event-loop-free (callable
    from sync test fixtures).

    Usage::

        breaker = CircuitBreaker(threshold=5, cooldown_seconds=60)
        if not await breaker.allow():
            raise ProviderOutageError("breaker open")
        try:
            result = await call_llm()
        except SomeError:
            await breaker.record_failure()
            raise
        else:
            await breaker.record_success()
    """

    def __init__(
        self,
        threshold: int = 5,
        cooldown_seconds: int = 60,
        provider_label: str = "gemini",
    ) -> None:
        self._threshold = threshold
        self._cooldown_seconds = cooldown_seconds
        self._provider_label = provider_label
        self._state: BreakerState = "closed"
        self._consecutive_failures: int = 0
        self._opened_at: float | None = None
        self._last_transition: str | None = None
        self._lock: asyncio.Lock | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def allow(self) -> bool:
        """Return True if a call should proceed.

        Transitions ``open → half_open`` automatically when the cooldown
        has elapsed. The half-open call IS the probe — only one call
        gets through; ``record_success``/``record_failure`` then settles
        the state.
        """
        async with self._get_lock():
            if self._state == "closed":
                return True
            if self._state == "open":
                if self._opened_at is None:
                    return False
                if time.monotonic() - self._opened_at >= self._cooldown_seconds:
                    self._transition("open", "half_open")
                    return True
                return False
            # half_open: only one probe at a time. If two callers race,
            # the first holds the lock and gets through; the second sees
            # state==half_open but cannot also probe, so we deny here
            # and the first probe's outcome will move the state next.
            return False

    async def record_success(self) -> None:
        """Reset the failure counter; close the breaker if it was probing."""
        async with self._get_lock():
            previous_state = self._state
            self._consecutive_failures = 0
            if self._state in ("open", "half_open"):
                self._transition(previous_state, "closed")
                self._opened_at = None

    async def record_failure(self, exc: BaseException | None = None) -> None:
        """Increment failure count; trip / re-trip the breaker as needed."""
        async with self._get_lock():
            self._consecutive_failures += 1
            if self._state == "half_open":
                # Probe failed — back to open with a fresh cooldown.
                self._transition("half_open", "open")
                self._opened_at = time.monotonic()
                return
            if self._state == "closed" and self._consecutive_failures >= self._threshold:
                self._transition("closed", "open")
                self._opened_at = time.monotonic()

    def is_open(self) -> bool:
        """Cheap synchronous accessor — does NOT advance state.

        Used by the LLMProvider failover seam: when this returns True
        AND ``LLM_FAILOVER_ENABLED`` is on, ``resolve_model`` returns
        the fallback model rather than the primary. Read-only; will not
        transition the breaker out of open even if the cooldown has
        elapsed (only ``allow()`` can do that).
        """
        return self._state == "open"

    def state(self) -> BreakerState:
        """Current state without lock acquisition."""
        return self._state

    def snapshot(self) -> CircuitBreakerSnapshot:
        """Atomic-enough snapshot for /metrics and structured logs."""
        return CircuitBreakerSnapshot(
            state=self._state,
            consecutive_failures=self._consecutive_failures,
            threshold=self._threshold,
            cooldown_seconds=self._cooldown_seconds,
            opened_at=self._opened_at,
            last_transition=self._last_transition,
        )

    def reset(self) -> None:
        """Force the breaker back to ``closed`` (test-only escape hatch).

        Production callers should NOT use this — let the breaker recover
        through its half-open probe like the design intended. Tests use
        this to isolate per-test state without restarting the process.
        """
        self._state = "closed"
        self._consecutive_failures = 0
        self._opened_at = None
        self._last_transition = None

    # ------------------------------------------------------------------
    # Internal
    # ------------------------------------------------------------------

    def _get_lock(self) -> asyncio.Lock:
        if self._lock is None:
            self._lock = asyncio.Lock()
        return self._lock

    def _transition(self, from_state: BreakerState, to_state: BreakerState) -> None:
        self._state = to_state
        self._last_transition = f"{from_state}->{to_state}"
        # Structured log per spec: ``circuit_breaker_state_change``.
        logger.info(
            "circuit_breaker_state_change",
            extra={
                "event": "circuit_breaker_state_change",
                "from_state": from_state,
                "to_state": to_state,
                "provider": self._provider_label,
                "consecutive_failures": self._consecutive_failures,
            },
        )


# ----------------------------------------------------------------------
# Singleton wiring (registered by the FastAPI lifespan at startup)
# ----------------------------------------------------------------------

_breaker_instance: CircuitBreaker | None = None


def init_circuit_breaker(breaker: CircuitBreaker) -> None:
    """Register the process-wide CircuitBreaker.

    Called from the FastAPI lifespan so :class:`BatchProcessor`,
    :class:`ExtractionWorker`, and :class:`LLMProvider` all share state.
    Sharing matters: the inline-extraction path during dual-read window
    must see the same breaker as the worker path so a 503 storm doesn't
    blow through twice.
    """
    global _breaker_instance
    _breaker_instance = breaker


def get_circuit_breaker() -> CircuitBreaker:
    """Return the singleton, lazy-creating it from settings if needed.

    Lazy creation makes tests work without explicit init: the first
    ``get_circuit_breaker()`` call from a test reads the (mocked or
    real) settings and returns a fresh breaker. Production startup
    overrides via ``init_circuit_breaker`` so the lifespan-managed
    instance carries the correct provider label.
    """
    global _breaker_instance
    if _breaker_instance is None:
        from beever_atlas.infra.config import get_settings

        settings = get_settings()
        _breaker_instance = CircuitBreaker(
            threshold=settings.llm_outage_breaker_threshold,
            cooldown_seconds=getattr(settings, "llm_outage_breaker_cooldown_seconds", 60),
        )
    return _breaker_instance


def reset_circuit_breaker_for_tests() -> None:
    """Test helper: drop the singleton so the next ``get_*`` rebuilds it.

    Replaces the autouse fixture's ad-hoc reset of ``_consecutive_503_*``
    module-globals in ``tests/test_sync_runner.py``. With this in place,
    PR-A.6.1's test-pollution workaround is no longer needed because
    the new flow has no module-globals to bleed across tests.
    """
    global _breaker_instance
    _breaker_instance = None
