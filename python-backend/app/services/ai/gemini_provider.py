"""Google Gemini Provider (google-genai SDK)."""

from __future__ import annotations

from typing import Any

from ...config import get_settings
from ...schemas.ai import AnalyzedQuestion, PracticeQuestion
from .base import AIService
from .openai_provider import _parse_analyze, _parse_practice
from .prompts import (
    ANALYZE_SYSTEM_PROMPT,
    PRACTICE_SYSTEM_PROMPT,
    build_analyze_user_prompt,
    build_practice_user_prompt,
)


class GeminiService(AIService):
    """Google Gemini Provider.

    使用官方 google-genai SDK (google.genai.Client). 若运行时不可用则降级到 HTTP 直连.
    """

    def __init__(self, api_key: str, model: str) -> None:
        self._api_key = api_key
        self._model = model
        self._client: Any = None
        try:
            from google.genai import Client as _GenAIClient  # type: ignore

            self._client = _GenAIClient(api_key=api_key)
        except Exception:  # pragma: no cover - 未装 SDK
            self._client = None

    @property
    def name(self) -> str:
        return "gemini"

    # ------------------ analyze_image ------------------
    async def analyze_image(
        self,
        image_data_url: str,
        subject: str | None = None,
        grade_semester: str | None = None,
        custom_prompt: str | None = None,
    ) -> AnalyzedQuestion:
        user_prompt = build_analyze_user_prompt(subject, grade_semester, None, custom_prompt)
        raw = await self._call(
            system=ANALYZE_SYSTEM_PROMPT,
            user_text=user_prompt,
            image_data_url=image_data_url,
            max_tokens=2048,
            temperature=0.2,
        )
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
        raw = await self._call(
            system=PRACTICE_SYSTEM_PROMPT,
            user_text=user_prompt,
            max_tokens=1024,
            temperature=0.7,
        )
        return _parse_practice(raw)

    # ------------------ reanswer ------------------
    async def reanswer(self, question: str, subject: str | None = None) -> str:
        subject_hint = f"（科目：{subject}）" if subject else ""
        return (
            await self._call(
                system="你是一名耐心的解题老师，请逐步推理并给出最终答案。",
                user_text=f"请解答以下题目{subject_hint}：\n{question}",
                max_tokens=1024,
                temperature=0.3,
            )
        ).strip()

    # ------------------ ping ------------------
    async def ping(self) -> str:
        # 发一次极小的生成请求验证 key 有效
        result = await self._call(
            system="", user_text="ping", max_tokens=1, temperature=0.0
        )
        return f"gemini ({self._model})"

    # ------------------ 调用实现 ------------------
    async def _call(
        self,
        system: str,
        user_text: str,
        image_data_url: str | None = None,
        max_tokens: int = 1024,
        temperature: float = 0.2,
    ) -> str:
        if self._client is not None:
            return await self._call_sdk(system, user_text, image_data_url, max_tokens, temperature)
        return await self._call_http(system, user_text, image_data_url, max_tokens, temperature)

    async def _call_sdk(
        self,
        system: str,
        user_text: str,
        image_data_url: str | None,
        max_tokens: int,
        temperature: float,
    ) -> str:
        from google.genai import types  # type: ignore

        contents: list[Any] = []
        if image_data_url:
            # 拆分 data URL: data:image/png;base64,xxxx
            meta, _, b64 = image_data_url.partition(",")
            mime = meta.removeprefix("data:").removesuffix(";base64")
            contents.append(
                types.Content(
                    role="user",
                    parts=[
                        types.Part(text=user_text),
                        types.Part(inline_data=types.Blob(mime_type=mime, data=_b64_bytes(b64))),
                    ],
                )
            )
        else:
            contents.append(types.Content(role="user", parts=[types.Part(text=user_text)]))

        result = await self._client.aio.models.generate_content(
            model=self._model,
            contents=contents,
            config=types.GenerateContentConfig(
                system_instruction=system,
                temperature=temperature,
                max_output_tokens=max_tokens,
            ),
        )
        return (result.text or "").strip()

    async def _call_http(
        self,
        system: str,
        user_text: str,
        image_data_url: str | None,
        max_tokens: int,
        temperature: float,
    ) -> str:
        """无 SDK 时用 HTTP 直连 (v1beta generateContent)."""
        import httpx

        url = (
            "https://generativelanguage.googleapis.com/v1beta/models/"
            f"{self._model}:generateContent?key={self._api_key}"
        )
        parts: list[dict[str, Any]] = [{"text": user_text}]
        if image_data_url:
            meta, _, b64 = image_data_url.partition(",")
            mime = meta.removeprefix("data:").removesuffix(";base64")
            parts.append({"inline_data": {"mime_type": mime, "data": b64}})

        payload = {
            "system_instruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": parts}],
            "generationConfig": {
                "temperature": temperature,
                "maxOutputTokens": max_tokens,
            },
        }
        async with httpx.AsyncClient(timeout=120) as client:
            r = await client.post(url, json=payload)
            r.raise_for_status()
            data = r.json()
            return data["candidates"][0]["content"]["parts"][0].get("text", "")


def _b64_bytes(b64: str) -> bytes:
    import base64

    return base64.b64decode(b64)


def make_gemini_service() -> GeminiService:
    settings = get_settings()
    if not settings.google_api_key:
        raise RuntimeError("GOOGLE_API_KEY is not configured")
    return GeminiService(api_key=settings.google_api_key, model=settings.google_model)
