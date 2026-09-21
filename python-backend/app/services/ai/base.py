"""AI 服务接口定义."""

from __future__ import annotations

from abc import ABC, abstractmethod

from ...schemas.ai import AnalyzedQuestion, PracticeQuestion


class AIService(ABC):
    """所有 AI Provider 的抽象基类."""

    @property
    @abstractmethod
    def name(self) -> str:
        """Provider 名称."""

    @abstractmethod
    async def analyze_image(
        self,
        image_data_url: str,
        subject: str | None = None,
        grade_semester: str | None = None,
        custom_prompt: str | None = None,
    ) -> AnalyzedQuestion:
        """分析一张题目图片, 返回结构化结果."""

    @abstractmethod
    async def generate_practice(
        self,
        question_text: str,
        answer_text: str | None,
        analysis: str | None,
        subject: str | None,
        option_count: int = 4,
    ) -> PracticeQuestion:
        """基于错题生成干扰项 / 练习小题."""
