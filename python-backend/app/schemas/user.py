"""认证相关 schemas."""

from __future__ import annotations

from pydantic import BaseModel, ConfigDict, EmailStr, Field
from pydantic.alias_generators import to_camel


class UserRegister(BaseModel):
    email: EmailStr
    password: str = Field(min_length=6, max_length=128)
    name: str | None = Field(default=None, max_length=128)

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class UserLogin(BaseModel):
    email: EmailStr
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    user: "UserOut | None" = None

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


class UserOut(BaseModel):
    id: str
    email: str
    name: str | None
    role: str
    is_active: bool
    must_change_password: bool = False
    education_stage: str | None = None
    enrollment_year: int | None = None

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, from_attributes=True)


class UserUpdate(BaseModel):
    name: str | None = None
    education_stage: str | None = None
    enrollment_year: int | None = None


class ChangePassword(BaseModel):
    old_password: str
    new_password: str = Field(min_length=6, max_length=128)


# Forward ref for TokenResponse.user
TokenResponse.model_rebuild()
