
## 템플릿: modern (레이아웃 지정 필수)

각 slide에 `"layout"` 필드를 넣어라. 슬라이드 내용에 맞는 레이아웃을 골라 다양하게 섞어라 (같은 body 레이아웃 연속 반복 금지).

| layout | 역할 | 필요한 필드 | 언제 쓰나 |
|---|---|---|---|
| `cover-hero.html` | cover | headline, sub, tags(배열 3-4개), image_prompt | 키워드 훅이 강한 커버. headline에서 `**..**` 줄은 파란 박스가 된다 |
| `cover-grad.html` | cover | headline, sub, number("01"), image_prompt | 사진/그래픽 위 큰 타이틀 |
| `cover-center.html` | cover | headline, sub, body(1줄), image_prompt | 분위기 사진 + 중앙 타이틀 |
| `body-photo-top.html` | body | headline, body, image_prompt | 사진이 주인공인 슬라이드 |
| `body-photo-card.html` | body | headline, body, image_prompt | 기본형: 제목 + 본문 + 사진 카드 |
| `body-list.html` | body | headline, items(3개: icon 이모지/title/desc), body(하단 배너 1줄) | 항목 나열 (3가지 포인트 등) |
| `body-photo-mid.html` | body | headline, body, image_prompt | 중앙 정렬 제목 + 큰 사진 |
| `body-text.html` | body | headline, sub(칩 라벨), body(길어도 됨) | 텍스트 위주 설명 |
| `body-qa.html` | body | q(질문), headline(답 요약), body(답 상세), tip | Q&A 형식 |
| `last-follow.html` | cta | headline, body, cta | 기본 팔로우 유도 |
| `last-profile.html` | cta | body | 프로필 카드 + Follow 버튼 |
| `last-blue.html` | cta | headline, sub, body | 파란 풀블리드 아웃트로 |

- `image_prompt`는 위 표에 있는 레이아웃에만 넣어라. 없는 레이아웃(body-list, body-text, body-qa, last-*)은 image_prompt를 아예 생략해라 (배경 생성 비용 절약).
- cover 1장 + body 3–5장 (레이아웃 다양하게) + cta 1장.
