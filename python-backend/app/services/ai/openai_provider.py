"""OpenAI / OpenAI-compatible Provider — 覆盖 OpenAI & Azure OpenAI."""

from __future__ import annotations

from typing import Any

import httpx
from openai import AsyncOpenAI

from ...config import get_settings
from ...schemas.ai import AnalyzedQuestion, PracticeQuestion
from .base import AIService
from .parser import (
    extract_xml_tags,
    parse_bool,
    parse_int,
    parse_list,
    split_csv,
)
from .prompts import (
    ANALYZE_SYSTEM_PROMPT,
    PRACTICE_SYSTEM_PROMPT,
    build_analyze_user_prompt,
    build_practice_user_prompt,
)


class OpenAICompatibleService(AIService):
    """OpenAI 系列 (OpenAI 官方、Azure OpenAI、任何兼容端点)."""

    def __init__(self, client: AsyncOpenAI, model: str, name_hint: str = "openai") -> None:
        self._client = client
        self._model = model
        self._name = name_hint

    @property
    def name(self) -> str:
        return self._name

    # ------------------ analyze_image ------------------
    async def analyze_image(
        self,
        image_data_url: str,
        subject: str | None = None,
        grade_semester: str | None = None,
        custom_prompt: str | None = None,
    ) -> AnalyzedQuestion:
        user_prompt = build_analyze_user_prompt(subject, grade_semester, None, custom_prompt)

        messages: list[dict[str, Any]] = [
            {"role": "system", "content": ANALYZE_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url}},
                ],
            },
        ]

        resp = await self._client.chat.completions.create(
            model=self._model,
            messages=messages,
            temperature=0.2,
            max_tokens=2048,
        )
        raw = resp.choices[0].message.content or ""
        return AnalyzedQuestion(**_parse_analyze(raw))

    # ------------------ generate_practice ------------------
    async def generate_practice(
        self,
        question_text: str,
        answer_text: str | None,
        analysis: str | None,
        subject: str | None,
        option_count: int = 4,
    ) -> PracticeQuestion:
        user_prompt = build_practice_user_prompt(
            question_text, answer_text, analysis, subject, option_count
        )

        resp = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {"role": "system", "content": PRACTICE_SYSTEM_PROMPT},
                {"role": "user", "content": user_prompt},
            ],
            temperature=0.7,
            max_tokens=1024,
        )
        raw = resp.choices[0].message.content or ""
        return _parse_practice(raw)

    # ------------------ reanswer ------------------
    async def reanswer(self, question: str, subject: str | None = None) -> str:
        subject_hint = f"（科目：{subject}）" if subject else ""
        resp = await self._client.chat.completions.create(
            model=self._model,
            messages=[
                {
                    "role": "system",
                    "content": "你是一名耐心的解题老师，请逐步推理并给出最终答案。",
                },
                {"role": "user", "content": f"请解答以下题目{subject_hint}：\n{question}"},
            ],
            temperature=0.3,
            max_tokens=1024,
        )
        return (resp.choices[0].message.content or "").strip()

    # ------------------ ping ------------------
    async def ping(self) -> str:
        # 实际列一次模型即可验证 key / endpoint 是否有效, 不消耗太多额度
        await self._client.models.list()
        return f"openai-compatible ({self._model})"


def _parse_analyze(raw: str) -> dict[str, Any]:
    tags = extract_xml_tags(raw)
    return {
        "question_text": tags.get("question_text", ""),
        "answer_text": tags.get("answer_text") or None,
        "analysis": tags.get("analysis") or None,
        "wrong_answer_text": tags.get("wrong_answer_text") or None,
        "mistake_analysis": tags.get("mistake_analysis") or None,
        "mistake_status": tags.get("mistake_status") or None,
        "subject": tags.get("subject") or None,
        "knowledge_tags": split_csv(tags.get("knowledge_tags")),
        "geogebra_commands": parse_list(tags.get("geogebra_commands")),
        "geogebra_suitable": parse_bool(tags.get("geogebra_suitable"), False),
    }


def _parse_practice(raw: str) -> PracticeQuestion:
    tags = extract_xml_tags(raw)
    options: list[str] = []
    explanations: list[str] = []
    for i in range(1, 7):
        opt = tags.get(f"option_{i}")
        if opt:
            options.append(opt)
            explanations.append(tags.get(f"option_{i}_explain", ""))
    correct = parse_int(tags.get("correct_index"), 1) or 1
    return PracticeQuestion(
        question="请选择正确答案",
        options=options,
        correct_index=correct - 1,  # 转为 0-based
        explanations=explanations,
    )


# ---------- 构造 ----------
def make_openai_service() -> OpenAICompatibleService:
    settings = get_settings()
    if not settings.openai_api_key:
        raise RuntimeError("OPENAI_API_KEY is not configured")

    client_kwargs: dict[str, Any] = {
        "api_key": settings.openai_api_key,
        "http_client": httpx.AsyncClient(timeout=120),
    }
    if settings.openai_base_url:
        client_kwargs["base_url"] = settings.openai_base_url

    return OpenAICompatibleService(
        client=AsyncOpenAI(**client_kwargs),
        model=settings.openai_model,
        name_hint="openai",
    )


def make_azure_service() -> OpenAICompatibleService:
    settings = get_settings()
    if not settings.azure_openai_api_key or not settings.azure_openai_endpoint:
        raise RuntimeError("AZURE_OPENAI_API_KEY / ENDPOINT is not configured")

    client = AsyncOpenAI(
        api_key=settings.azure_openai_api_key,
        api_version="2024-06-01",
        base_url=f"{settings.azure_openai_endpoint.rstrip('/')}/openai/deployments",
        http_client=httpx.AsyncClient(timeout=120),
    )
    return OpenAICompatibleService(
        client=client,
        model=settings.azure_openai_deployment,
        name_hint="azure",
    )
