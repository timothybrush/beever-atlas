"""Tests for the LLMProvider failover seam (PR-C, post env-var cleanup).

After the env-var consolidation, failover is gated by TWO module-level
constants in ``beever_atlas.llm.provider``:
  * ``_FAILOVER_ENABLED`` (bool, default False) — out of OSS scope
  * ``_FALLBACK_MAP`` (dict, default empty)

Multi-provider failover requires a second-provider key (Claude / OpenAI)
that OSS doesn't ship. Enterprise tier flips the constants in code; OSS
operators don't get a runtime knob for a feature they can't actually use.

Tests verify the seam still works when the constants are explicitly
patched on (i.e., the enterprise enablement path).

Spec: ``openspec/changes/oss-pipeline-and-wiki-redesign/specs/llm-circuit-breaker/``
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import patch

import pytest

from beever_atlas.llm.provider import LLMProvider
from beever_atlas.services.circuit_breaker import (
    CircuitBreaker,
    init_circuit_breaker,
    reset_circuit_breaker_for_tests,
)


def _make_settings():
    """Construct a minimal settings stub for LLMProvider — env vars
    no longer carry failover config; only the basic model fields remain."""
    return SimpleNamespace(
        llm_fast_model="gemini-2.5-flash",
        llm_quality_model="gemini-2.5-pro",
    )


@pytest.fixture(autouse=True)
def _reset_breaker_singleton():
    reset_circuit_breaker_for_tests()
    yield
    reset_circuit_breaker_for_tests()


@pytest.mark.asyncio
async def test_failover_disabled_by_default_returns_primary_when_breaker_open() -> None:
    """OSS default: ``_FAILOVER_ENABLED=False``, breaker open → primary returned.

    The failover code path is preserved as a code seam for the enterprise
    tier, but in OSS it never fires regardless of breaker state.
    """
    settings = _make_settings()
    breaker = CircuitBreaker(threshold=1, cooldown_seconds=60)
    init_circuit_breaker(breaker)
    await breaker.record_failure()
    assert breaker.is_open()

    provider = LLMProvider(settings)
    with patch("beever_atlas.llm.provider.resolve_model_object", side_effect=lambda s: s):
        result = provider.resolve_model("fact_extractor")

    assert "flash-lite" not in str(result), (
        "OSS default has _FAILOVER_ENABLED=False — primary model must NOT be re-mapped"
    )


@pytest.mark.asyncio
async def test_enterprise_failover_enabled_returns_fallback_when_breaker_open() -> None:
    """Enterprise enablement path: when both constants are flipped, the
    breaker-open state re-maps to the fallback model. Locks in that the
    seam still works for whoever ships the multi-provider tier."""
    settings = _make_settings()
    breaker = CircuitBreaker(threshold=1, cooldown_seconds=60)
    init_circuit_breaker(breaker)
    await breaker.record_failure()

    provider = LLMProvider(settings)
    with (
        patch("beever_atlas.llm.provider._FAILOVER_ENABLED", True),
        patch(
            "beever_atlas.llm.provider._FALLBACK_MAP",
            {"gemini-2.5-flash": "gemini-2.5-flash-lite"},
        ),
        patch("beever_atlas.llm.provider.resolve_model_object", side_effect=lambda s: s),
    ):
        result = provider.resolve_model("fact_extractor")
    assert "flash-lite" in str(result)


@pytest.mark.asyncio
async def test_enterprise_failover_breaker_closed_returns_primary() -> None:
    """Failover only fires when the breaker is actually open. A healthy
    upstream keeps using the primary even with the constants on."""
    settings = _make_settings()
    breaker = CircuitBreaker(threshold=5, cooldown_seconds=60)
    init_circuit_breaker(breaker)
    assert not breaker.is_open()

    provider = LLMProvider(settings)
    with (
        patch("beever_atlas.llm.provider._FAILOVER_ENABLED", True),
        patch(
            "beever_atlas.llm.provider._FALLBACK_MAP",
            {"gemini-2.5-flash": "gemini-2.5-flash-lite"},
        ),
        patch("beever_atlas.llm.provider.resolve_model_object", side_effect=lambda s: s),
    ):
        result = provider.resolve_model("fact_extractor")
    assert "flash-lite" not in str(result)


@pytest.mark.asyncio
async def test_failover_swallows_breaker_errors_and_uses_primary() -> None:
    """If the breaker module raises during the seam check, failover must
    not crash resolution — the primary model is returned and a warning logged."""
    settings = _make_settings()
    provider = LLMProvider(settings)

    with (
        patch("beever_atlas.llm.provider._FAILOVER_ENABLED", True),
        patch(
            "beever_atlas.llm.provider._FALLBACK_MAP",
            {"gemini-2.5-flash": "gemini-2.5-flash-lite"},
        ),
        patch(
            "beever_atlas.services.circuit_breaker.get_circuit_breaker",
            side_effect=RuntimeError("breaker module exploded"),
        ),
        patch("beever_atlas.llm.provider.resolve_model_object", side_effect=lambda s: s),
    ):
        result = provider.resolve_model("fact_extractor")
        assert result is not None


@pytest.mark.asyncio
async def test_enterprise_failover_uses_primary_when_no_fallback_configured() -> None:
    """Even with `_FAILOVER_ENABLED=True`, a model not in the fallback map
    is left alone. We never invent fallbacks; missing entries are a
    deliberate no-op."""
    settings = _make_settings()
    breaker = CircuitBreaker(threshold=1, cooldown_seconds=60)
    init_circuit_breaker(breaker)
    await breaker.record_failure()

    provider = LLMProvider(settings)
    provider._agent_overrides["fact_extractor"] = "gemini-2.5-pro"
    with (
        patch("beever_atlas.llm.provider._FAILOVER_ENABLED", True),
        patch(
            "beever_atlas.llm.provider._FALLBACK_MAP",
            {"some-other-model": "some-fallback"},
        ),
        patch("beever_atlas.llm.provider.resolve_model_object", side_effect=lambda s: s),
    ):
        result = provider.resolve_model("fact_extractor")
    assert str(result) == "gemini-2.5-pro"


@pytest.mark.asyncio
async def test_oss_default_with_empty_map_does_not_attempt_breaker_lookup() -> None:
    """When ``_FALLBACK_MAP`` is empty (OSS default), the seam short-circuits
    BEFORE consulting the breaker. Verifies we don't pay any breaker
    lookup cost in the steady-state OSS path."""
    settings = _make_settings()
    provider = LLMProvider(settings)

    with (
        patch("beever_atlas.llm.provider._FAILOVER_ENABLED", False),
        patch("beever_atlas.llm.provider._FALLBACK_MAP", {}),
        patch(
            "beever_atlas.services.circuit_breaker.get_circuit_breaker",
        ) as breaker_lookup,
        patch("beever_atlas.llm.provider.resolve_model_object", side_effect=lambda s: s),
    ):
        provider.resolve_model("fact_extractor")
        breaker_lookup.assert_not_called()
