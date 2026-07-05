"""App settings: LLM API key (keychain) + persisted preferences (SQLite).

Non-secret preferences live in the ``settings`` table as string values, read
back through the typed helpers below (each falls back to the ``config`` default
when unset/invalid). Secrets (the API key) stay in the keychain.
"""

from __future__ import annotations

import keyring
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlmodel import Session

from backend.agent.prompts import FIXED_SYSTEM_PROMPT
from backend.agent.provider import MODELS, PROVIDERS, all_models, provider_for_model
from backend.config import (
    DEFAULT_AGENT_MAX_STEPS,
    DEFAULT_AGENT_MAX_TOKENS,
    DEFAULT_AGENT_TIMEOUT_SEC,
    DEFAULT_LLM_MODEL,
    DEFAULT_PREVIEW_ROW_LIMIT,
    DEFAULT_STATEMENT_TIMEOUT_MS,
    KEYRING_SERVICE,
    llm_key_username,
)
from backend.store.db import get_session
from backend.store.models import Setting

router = APIRouter(prefix="/settings", tags=["settings"])

# Setting-table keys.
CUSTOM_INSTRUCTIONS_KEY = "agent_custom_instructions"
AGENT_TIMEOUT_KEY = "agent_timeout_sec"
AGENT_MAX_STEPS_KEY = "agent_max_steps"
AGENT_MAX_TOKENS_KEY = "agent_max_tokens"
DEFAULT_MODEL_KEY = "default_model"
QUERY_TIMEOUT_KEY = "query_timeout_sec"
PREVIEW_ROW_LIMIT_KEY = "preview_row_limit"

# Bounds (values are clamped on write).
MAX_CUSTOM_INSTRUCTIONS = 8_000
MIN_AGENT_TIMEOUT_SEC, MAX_AGENT_TIMEOUT_SEC = 5, 600
MIN_AGENT_MAX_STEPS, MAX_AGENT_MAX_STEPS = 2, 50
MIN_AGENT_MAX_TOKENS, MAX_AGENT_MAX_TOKENS = 1_000, 64_000
MIN_QUERY_TIMEOUT_SEC, MAX_QUERY_TIMEOUT_SEC = 1, 3_600
MIN_PREVIEW_ROW_LIMIT, MAX_PREVIEW_ROW_LIMIT = 1, 100_000


def _get_int(s: Session, key: str, default: int) -> int:
    row = s.get(Setting, key)
    try:
        return int(row.value) if row and row.value else default
    except ValueError:
        return default


def get_custom_instructions(s: Session) -> str:
    """Read the saved custom instructions (empty string if unset)."""
    row = s.get(Setting, CUSTOM_INSTRUCTIONS_KEY)
    return row.value if row else ""


def get_agent_timeout_sec(s: Session) -> int:
    return _get_int(s, AGENT_TIMEOUT_KEY, DEFAULT_AGENT_TIMEOUT_SEC)


def get_agent_max_steps(s: Session) -> int:
    return _get_int(s, AGENT_MAX_STEPS_KEY, DEFAULT_AGENT_MAX_STEPS)


def get_agent_max_tokens(s: Session) -> int:
    return _get_int(s, AGENT_MAX_TOKENS_KEY, DEFAULT_AGENT_MAX_TOKENS)


def get_query_timeout_sec(s: Session) -> int:
    return _get_int(s, QUERY_TIMEOUT_KEY, DEFAULT_STATEMENT_TIMEOUT_MS // 1000)


def get_preview_row_limit(s: Session) -> int:
    return _get_int(s, PREVIEW_ROW_LIMIT_KEY, DEFAULT_PREVIEW_ROW_LIMIT)


def get_default_model(s: Session) -> str:
    row = s.get(Setting, DEFAULT_MODEL_KEY)
    model = row.value if row and row.value else DEFAULT_LLM_MODEL
    # Guard against a saved model that's no longer offered by any provider.
    return model if model in all_models() else DEFAULT_LLM_MODEL


def _provider_key_status() -> list[dict]:
    """Per-provider metadata + whether an API key is stored for each."""
    return [
        {
            "id": pid,
            "label": meta["label"],
            "keyPlaceholder": meta["keyPlaceholder"],
            "hasKey": bool(keyring.get_password(KEYRING_SERVICE, llm_key_username(pid))),
        }
        for pid, meta in PROVIDERS.items()
    ]


def _set(s: Session, key: str, value: str) -> None:
    row = s.get(Setting, key) or Setting(key=key)
    row.value = value
    s.add(row)
    s.commit()


class LlmKeyIn(BaseModel):
    key: str
    provider: str = "anthropic"


class CustomInstructionsIn(BaseModel):
    customInstructions: str


class AgentTimeoutIn(BaseModel):
    agentTimeoutSec: int


class AgentMaxStepsIn(BaseModel):
    agentMaxSteps: int


class AgentMaxTokensIn(BaseModel):
    agentMaxTokens: int


class DefaultModelIn(BaseModel):
    defaultModel: str


class QueryTimeoutIn(BaseModel):
    queryTimeoutSec: int


class PreviewRowLimitIn(BaseModel):
    previewRowLimit: int


@router.get("")
def get_settings(s: Session = Depends(get_session)) -> dict:
    providers = _provider_key_status()
    return {
        "providers": providers,
        # True if *any* provider has a key — used for coarse UI gating.
        "hasLlmKey": any(p["hasKey"] for p in providers),
        "models": all_models(),
        # model id -> provider, so the UI can tell which key a chosen model needs.
        "modelProviders": {m: prov for prov, ms in MODELS.items() for m in ms},
        "defaultModel": get_default_model(s),
        # The fixed base prompt (read-only in the UI) + the editable block.
        "systemPrompt": FIXED_SYSTEM_PROMPT,
        "customInstructions": get_custom_instructions(s),
        "agentTimeoutSec": get_agent_timeout_sec(s),
        "agentMaxSteps": get_agent_max_steps(s),
        "agentMaxTokens": get_agent_max_tokens(s),
        "queryTimeoutSec": get_query_timeout_sec(s),
        "previewRowLimit": get_preview_row_limit(s),
    }


@router.put("/llm-key")
def set_llm_key(body: LlmKeyIn) -> dict:
    provider = body.provider if body.provider in PROVIDERS else "anthropic"
    keyring.set_password(KEYRING_SERVICE, llm_key_username(provider), body.key.strip())
    return {"provider": provider, "hasKey": True}


@router.put("/custom-instructions")
def set_custom_instructions(
    body: CustomInstructionsIn, s: Session = Depends(get_session)
) -> dict:
    value = body.customInstructions.strip()[:MAX_CUSTOM_INSTRUCTIONS]
    _set(s, CUSTOM_INSTRUCTIONS_KEY, value)
    return {"customInstructions": value}


@router.put("/agent-timeout")
def set_agent_timeout(body: AgentTimeoutIn, s: Session = Depends(get_session)) -> dict:
    sec = max(MIN_AGENT_TIMEOUT_SEC, min(body.agentTimeoutSec, MAX_AGENT_TIMEOUT_SEC))
    _set(s, AGENT_TIMEOUT_KEY, str(sec))
    return {"agentTimeoutSec": sec}


@router.put("/agent-max-steps")
def set_agent_max_steps(body: AgentMaxStepsIn, s: Session = Depends(get_session)) -> dict:
    steps = max(MIN_AGENT_MAX_STEPS, min(body.agentMaxSteps, MAX_AGENT_MAX_STEPS))
    _set(s, AGENT_MAX_STEPS_KEY, str(steps))
    return {"agentMaxSteps": steps}


@router.put("/agent-max-tokens")
def set_agent_max_tokens(body: AgentMaxTokensIn, s: Session = Depends(get_session)) -> dict:
    tokens = max(MIN_AGENT_MAX_TOKENS, min(body.agentMaxTokens, MAX_AGENT_MAX_TOKENS))
    _set(s, AGENT_MAX_TOKENS_KEY, str(tokens))
    return {"agentMaxTokens": tokens}


@router.put("/default-model")
def set_default_model(body: DefaultModelIn, s: Session = Depends(get_session)) -> dict:
    if body.defaultModel not in all_models():
        # Ignore unknown models rather than persisting a value we can't honor.
        return {"defaultModel": get_default_model(s)}
    _set(s, DEFAULT_MODEL_KEY, body.defaultModel)
    return {"defaultModel": body.defaultModel}


@router.put("/query-timeout")
def set_query_timeout(body: QueryTimeoutIn, s: Session = Depends(get_session)) -> dict:
    sec = max(MIN_QUERY_TIMEOUT_SEC, min(body.queryTimeoutSec, MAX_QUERY_TIMEOUT_SEC))
    _set(s, QUERY_TIMEOUT_KEY, str(sec))
    return {"queryTimeoutSec": sec}


@router.put("/preview-row-limit")
def set_preview_row_limit(
    body: PreviewRowLimitIn, s: Session = Depends(get_session)
) -> dict:
    limit = max(MIN_PREVIEW_ROW_LIMIT, min(body.previewRowLimit, MAX_PREVIEW_ROW_LIMIT))
    _set(s, PREVIEW_ROW_LIMIT_KEY, str(limit))
    return {"previewRowLimit": limit}
