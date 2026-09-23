"""前后端契约回归测试 —— 图片上传链路（/api/analyze、/api/analyze/stream、/api/ocr）.

为什么需要这一层:
  图片上传链路经历过一次迁移（base64 JSON → multipart/form-data），迁移期一度出现
  过两端字段名对不上的契约漂移：前端发 `imageBase64` / `subjectId` / `ocrText`，
  后端却只认 `imageDataUrl` / `subject`，表现为 analyze 接口对前端 **必然 422**。
  这类问题的可怕之处在于两端各自单测都过、CI 全绿，只有真机联调才暴露。

  所以这里把"前端实际会发的载荷形状"逐条钉死，任何一侧改字段名都会立刻失败。

覆盖的载荷形状（全部是前端真实在用的）:
  1. multipart: file 字段 `image` + form 字段 `subjectId` / `ocrText` / `language`
     —— 当前 Web 前端 src/app/page.tsx、src/app/notebooks/[id]/add/page.tsx
  2. JSON: `imageBase64`（裸 base64）—— 迁移中的旧前端 / 移动端
  3. JSON: `imageBase64`（data URL）
  4. JSON: `imageDataUrl` —— 更早的字段名，仍需兼容
  OCR 端点同理覆盖 multipart 与 JSON 两种。

测试策略:
  走真实 ASGI 应用（app.main:app）+ 真实依赖链（X-Forwarded-User 身份桥接 +
  真实 SQLAlchemy session），只把"真正花钱的两处"换成桩：AI provider 与 OCR 引擎。
  这样 422/400 这类请求解析层的行为与线上完全一致。
"""

from __future__ import annotations

import base64
import json
import os
import sys
import tempfile
from pathlib import Path

# ---------------------------------------------------------------------------
# 环境准备：必须在 import app.* 之前完成
#   - app.database 在 import 时就按 DATABASE_URL 建 engine，且 get_settings 有 lru_cache
# ---------------------------------------------------------------------------
BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

_TMP_DIR = Path(tempfile.mkdtemp(prefix="wn-contract-"))
os.environ["DATABASE_URL"] = f"sqlite:///{(_TMP_DIR / 'contract.db').as_posix()}"
os.environ["DEBUG"] = "true"
# 身份桥接：模拟 Next.js catch-all 注入的 X-Forwarded-User
os.environ["TRUST_X_FORWARDED_USER"] = "true"
# 关缓存：每个用例都必须真的走到桩，否则后面的断言可能读到前面的缓存
os.environ["AI_CACHE_ENABLED"] = "false"
os.environ["AI_OCR_TEXT_MODE"] = "auto"
os.environ["AI_OCR_TEXT_MIN_CHARS"] = "80"
os.environ["GOOGLE_API_KEY"] = "contract-test-key"
os.environ["JWT_SECRET_KEY"] = "contract-test-jwt-secret"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app import database  # noqa: E402
from app.api.v1 import analyze as analyze_module  # noqa: E402
from app.api.v1 import ocr as ocr_module  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Subject, User  # noqa: E402
from app.schemas.ai import AnalyzedQuestion  # noqa: E402
from app.utils import rate_limiter  # noqa: E402
from app.utils.auth import hash_password  # noqa: E402

# ---------------------------------------------------------------------------
# 测试用图片：真实 1x1 PNG（magic bytes 必须过硬，否则 decode_validated_image 会拒）
# ---------------------------------------------------------------------------
PNG_1PX = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=="
)
PNG_B64 = base64.b64encode(PNG_1PX).decode()
PNG_DATA_URL = f"data:image/png;base64,{PNG_B64}"

TEST_EMAIL = "contract-test@example.com"
TEST_USER_ID = "contract-user"
TEST_SUBJECT_ID = "contract-subject-0001"
TEST_SUBJECT_NAME = "数学错题本"

# 短 OCR 文本（< 80 字）→ 仍走图片模式；长文本 → 走纯文本直通模式（省 token）
SHORT_OCR = "解方程 x+1=2"
LONG_OCR = "已知一元二次方程 x²-5x+6=0，求该方程的两个根，并说明根与系数的关系。" * 3


def _forwarded_user_header() -> dict[str, str]:
    """构造 Next.js catch-all 会注入的 X-Forwarded-User（base64 JSON）."""
    payload = {"id": TEST_USER_ID, "email": TEST_EMAIL, "role": "user"}
    return {"X-Forwarded-User": base64.b64encode(json.dumps(payload).encode()).decode()}


class StubAIService:
    """AI provider 桩 —— 记录收到的入参，返回固定结构."""

    name = "stub"

    def __init__(self) -> None:
        self.calls: list[dict] = []

    async def analyze_image(
        self,
        image_data_url=None,
        subject=None,
        grade_semester=None,
        custom_prompt=None,
        ocr_text=None,
    ):  # noqa: ANN001, ANN003
        self.calls.append(
            {
                "image_data_url": image_data_url,
                "subject": subject,
                "grade_semester": grade_semester,
                "custom_prompt": custom_prompt,
                "ocr_text": ocr_text,
            }
        )
        return AnalyzedQuestion(
            question_text="题目正文",
            answer_text="答案",
            analysis="解析",
            mistake_analysis="错因",
            mistake_status="unmastered",
            subject=subject,
            knowledge_tags=["一元二次方程", "AI 编造的不存在标签"],
        )


@pytest.fixture(scope="module")
def stub_ai() -> StubAIService:
    return StubAIService()


@pytest.fixture(scope="module")
def stub_ocr():
    """OCR 引擎桩 —— 真实解码校验仍会跑，只是不加载 onnxruntime."""
    calls: list[dict] = []

    def _fake_recognize(buf: bytes, user_id: str) -> ocr_module.OcrResponse:
        calls.append({"bytes": len(buf), "user_id": user_id})
        return ocr_module.OcrResponse(
            text="识别出来的题目文字", lines=[], line_count=0, request_id="contract"
        )

    return calls, _fake_recognize


@pytest.fixture(scope="module")
def client(stub_ai: StubAIService, stub_ocr):
    """真实 ASGI 应用 + 身份桥接；AI provider 与 OCR 引擎换成桩."""
    analyze_module.get_ai_service = lambda: stub_ai  # type: ignore[assignment]
    _ocr_calls, fake_recognize = stub_ocr
    ocr_module._recognize = fake_recognize  # type: ignore[assignment]

    with TestClient(app) as c:
        # 建库 + 造一个笔记本（Subject），用于验证 subjectId → 学科名 的桥接
        db = database.SessionLocal()
        try:
            if db.get(User, TEST_USER_ID) is None:
                db.add(
                    User(
                        id=TEST_USER_ID,
                        email=TEST_EMAIL,
                        password=hash_password("contract-test-pw"),
                        name="Contract Tester",
                        role="user",
                        is_active=True,
                        must_change_password=False,
                    )
                )
            if db.get(Subject, TEST_SUBJECT_ID) is None:
                db.add(
                    Subject(id=TEST_SUBJECT_ID, name=TEST_SUBJECT_NAME, user_id=TEST_USER_ID)
                )
            db.commit()
        finally:
            db.close()
        yield c


@pytest.fixture(autouse=True)
def _reset_stubs(stub_ai: StubAIService, stub_ocr):
    """每个用例都从干净状态开始.

    限流器必须重建：analyze 限 10 次/分钟，若不复位，用例数量一多
    后面几条就会被 429 挡住，看起来像功能坏了（实际上限流工作正常）。
    这里复位计数，而不是把限流关掉 —— 限流行为本身也要被测到。
    """
    stub_ai.calls.clear()
    stub_ocr[0].clear()
    rate_limiter.reload_rate_limiter()
    yield


# ===========================================================================
# /api/analyze —— 前端真实载荷形状必须全部被接受（绝不能 422）
# ===========================================================================

def test_analyze_multipart_current_frontend_payload(client, stub_ai):
    """形状 1：当前前端发的 multipart（file 字段 image + form 字段 subjectId/ocrText/language）."""
    resp = client.post(
        "/api/analyze",
        files={"image": ("image.jpg", PNG_1PX, "image/jpeg")},
        data={"language": "zh", "subjectId": TEST_SUBJECT_ID, "ocrText": SHORT_OCR},
        headers=_forwarded_user_header(),
    )

    assert resp.status_code != 422, f"前端 multipart 载荷被拒: {resp.text}"
    assert resp.status_code == 200, resp.text

    body = resp.json()
    # 响应必须是前端 types/api.ts 里 AnalyzeResponse 的 camelCase 形状
    assert body["question"]["questionText"] == "题目正文"
    assert body["question"]["knowledgeTags"] == ["一元二次方程", "AI 编造的不存在标签"]

    call = stub_ai.calls[-1]
    # 图片被归一化成 data URL（后端按这个前缀校验，裸 base64 会被判非法）
    assert call["image_data_url"].startswith("data:image/"), call["image_data_url"][:40]
    assert base64.b64decode(call["image_data_url"].split(",", 1)[1]) == PNG_1PX
    # subjectId 是笔记本 id —— 后端必须翻成学科名再交给 AI
    assert call["subject"] == TEST_SUBJECT_NAME
    # 短 OCR 文本不足以走纯文本模式 → 仍带图，且不把 ocr_text 塞给图片通路
    assert call["ocr_text"] is None


@pytest.mark.parametrize(
    "payload",
    [
        pytest.param({"imageBase64": PNG_B64}, id="json-imageBase64-bare"),
        pytest.param({"imageBase64": PNG_DATA_URL}, id="json-imageBase64-data-url"),
        pytest.param({"imageDataUrl": PNG_DATA_URL}, id="json-imageDataUrl"),
    ],
)
def test_analyze_json_payload_shapes(client, stub_ai, payload):
    """形状 2/3/4：JSON 通路的各种字段名与编码都要吃下来."""
    resp = client.post(
        "/api/analyze",
        json={**payload, "language": "zh", "subjectId": TEST_SUBJECT_ID, "ocrText": SHORT_OCR},
        headers=_forwarded_user_header(),
    )

    assert resp.status_code != 422, f"JSON 载荷 {sorted(payload)} 被拒: {resp.text}"
    assert resp.status_code == 200, resp.text
    assert base64.b64decode(stub_ai.calls[-1]["image_data_url"].split(",", 1)[1]) == PNG_1PX


def test_analyze_contract_never_returns_422_for_frontend_shapes(client):
    """契约总闸：前端会发的所有形状轮一遍，任何一个 422 都算契约漂移.

    单独写这一条是因为它是这个文件存在的理由 —— 一旦有人把请求体
    又改回"必须匹配某个 pydantic 模型"的写法，这里会立刻炸。
    """
    cases: list[tuple[str, dict]] = [
        (
            "multipart-image-subjectId-ocrText",
            {
                "files": {"image": ("i.jpg", PNG_1PX, "image/jpeg")},
                "data": {"subjectId": TEST_SUBJECT_ID, "ocrText": SHORT_OCR, "language": "zh"},
            },
        ),
        ("json-imageBase64-bare", {"json": {"imageBase64": PNG_B64}}),
        ("json-imageBase64-dataurl", {"json": {"imageBase64": PNG_DATA_URL}}),
        ("json-imageDataUrl", {"json": {"imageDataUrl": PNG_DATA_URL}}),
        (
            "json-full-frontend-body",
            {
                "json": {
                    "imageBase64": PNG_B64,
                    "subjectId": TEST_SUBJECT_ID,
                    "ocrText": SHORT_OCR,
                    "language": "zh",
                }
            },
        ),
    ]

    for name, kwargs in cases:
        resp = client.post("/api/analyze", headers=_forwarded_user_header(), **kwargs)
        assert resp.status_code != 422, f"{name} 触发 422（契约漂移）: {resp.text}"
        assert resp.status_code == 200, f"{name} 意外失败 {resp.status_code}: {resp.text}"


def test_analyze_missing_image_is_400_not_422(client):
    """确实没图时应当是明确的 400，而不是 pydantic 的 422 —— 报错语义也是契约的一部分."""
    resp = client.post(
        "/api/analyze",
        json={"language": "zh", "subjectId": TEST_SUBJECT_ID},
        headers=_forwarded_user_header(),
    )
    assert resp.status_code == 400, resp.text
    assert "image is required" in resp.json()["detail"]


def test_analyze_long_ocr_text_uses_text_passthrough(client, stub_ai):
    """长 OCR 文本 → 纯文本直通模式：把文字交给模型，不再烧图片 token."""
    resp = client.post(
        "/api/analyze",
        files={"image": ("image.jpg", PNG_1PX, "image/jpeg")},
        data={"subjectId": TEST_SUBJECT_ID, "ocrText": LONG_OCR},
        headers=_forwarded_user_header(),
    )

    assert resp.status_code == 200, resp.text
    call = stub_ai.calls[-1]
    assert call["ocr_text"] == LONG_OCR, "长 ocrText 应走纯文本直通"
    assert call["subject"] == TEST_SUBJECT_NAME


def test_analyze_stream_multipart(client):
    """SSE 版走同一套解析逻辑，multipart 载荷同样不能被 422 挡住."""
    resp = client.post(
        "/api/analyze/stream",
        files={"image": ("image.jpg", PNG_1PX, "image/jpeg")},
        data={"subjectId": TEST_SUBJECT_ID, "ocrText": SHORT_OCR},
        headers=_forwarded_user_header(),
    )

    assert resp.status_code != 422, f"stream 端点 multipart 载荷被拒: {resp.text}"
    assert resp.status_code == 200, resp.text
    assert "event: status" in resp.text
    assert "event: done" in resp.text


def test_analyze_requires_authentication(client):
    """没有身份头 → 401（而不是 422），确认错误分层没被请求体解析抢走."""
    resp = client.post(
        "/api/analyze",
        files={"image": ("image.jpg", PNG_1PX, "image/jpeg")},
        data={"subjectId": TEST_SUBJECT_ID},
    )
    assert resp.status_code == 401, resp.text


def test_analyze_rate_limit_still_enforced(client):
    """限流不能被测试夹具顺手关掉 —— 第 11 次/分钟必须 429."""
    payload = {"imageBase64": PNG_B64, "subjectId": TEST_SUBJECT_ID}
    statuses = []
    for _ in range(analyze_module.ANALYZE_RATE_LIMIT + 1):
        statuses.append(client.post("/api/analyze", json=payload, headers=_forwarded_user_header()).status_code)

    assert statuses[: analyze_module.ANALYZE_RATE_LIMIT] == [200] * analyze_module.ANALYZE_RATE_LIMIT
    assert statuses[-1] == 429, f"超出限额未被拒: {statuses}"


# ===========================================================================
# /api/ocr —— 同一套双格式解析
# ===========================================================================

def test_ocr_accepts_multipart_and_json(client, stub_ocr):
    """OCR 端点：multipart（当前前端）与 JSON（旧客户端）都必须可用."""
    _calls, _fn = stub_ocr

    resp_mp = client.post(
        "/api/ocr",
        files={"image": ("ocr.png", PNG_1PX, "image/png")},
        headers=_forwarded_user_header(),
    )
    assert resp_mp.status_code == 200, resp_mp.text
    assert resp_mp.json()["text"] == "识别出来的题目文字"
    # 响应字段必须是 camelCase（前端读 data.lineCount / data.requestId）
    assert "lineCount" in resp_mp.json()
    assert "requestId" in resp_mp.json()

    resp_json = client.post(
        "/api/ocr",
        json={"imageBase64": PNG_B64},
        headers=_forwarded_user_header(),
    )
    assert resp_json.status_code == 200, resp_json.text
    assert _calls[-1]["bytes"] == len(PNG_1PX), "解码后的字节数应与原图一致"


def test_ocr_rejects_non_image_body_with_400(client):
    """既没有 file 也没有 imageBase64 → 400，不是 422."""
    resp = client.post("/api/ocr", json={"hello": "world"}, headers=_forwarded_user_header())
    assert resp.status_code == 400, resp.text


# ===========================================================================
# 结构守卫 —— 防止有人把严格请求模型"改回来"
# ===========================================================================

def test_no_strict_request_model_regression():
    """守卫：analyze 的请求体必须由 request_parsing 承接，而不是某个 pydantic 模型.

    历史上正是 `AnalyzeRequest`（要求 image_data_url/subject 的 snake_case）
    把前端的 imageBase64/subjectId 挡在门外。这个用例确保它不会被重新引入。
    """
    from app import schemas

    assert not hasattr(schemas.ai, "AnalyzeRequest"), (
        "AnalyzeRequest 又被加回来了 —— 它会把 camelCase 前端载荷挡成 422。"
        "请求体解析请继续用 utils/request_parsing.py。"
    )

    from app.utils import request_parsing

    # 双格式解析器的字段名约定：这些名字就是前后端之间的契约面
    assert request_parsing._IMAGE_FILE_FIELDS == ("image", "file")
    assert set(request_parsing._IMAGE_JSON_FIELDS) >= {"imageBase64", "imageDataUrl", "image"}
