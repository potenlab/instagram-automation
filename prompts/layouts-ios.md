
## 템플릿: ios (스마트폰/OS 팝업 스타일 — 레이아웃 지정 필수)

각 slide에 `"layout"` 필드를 넣어라. iOS 알림/채팅/메모 UI를 흉내내는 스타일이다. 카피는 알림·메시지처럼 짧고 대화체로 써라.

| layout | 역할 | 필요한 필드 | 언제 쓰나 |
|---|---|---|---|
| `cover-notif.html` | cover | headline, notifs(1개: icon 이모지/title/desc), image_prompt | 알림 + 사진 위젯 커버 |
| `cover-stack.html` | cover | headline, notifs(2개) | 알림 2개 스택 + 앱 아이콘 커버 (사진 불필요) |
| `cover-phone.html` | cover | headline, sub, notifs(1개) | 아이폰 목업 커버 (사진 불필요) |
| `body-dm.html` | body | chat(4개: [내 질문 짧게, 내 질문 보충, 상대 답 1, 상대 답 2]) | DM 대화 형식 |
| `body-chat-photo.html` | body | chat(4개), emoji(이모지 1개), image_prompt | 사진 위 채팅 버블 |
| `body-notes.html` | body | headline, body(중요 부분 `**..**` 하이라이트), note_hand(손글씨 한 줄, 영어), image_prompt | 사진 위 메모앱 카드 |
| `body-toggle.html` | body | headline, items(3개: icon 이모지/title/desc) | 설정 토글 리스트 (항목 나열) |
| `last-popup.html` | cta | headline, body | 팔로우 팝업 카드 |
| `last-dialog.html` | cta | headline, body | iOS 다이얼로그 (좋아요/구독 버튼) |

- `image_prompt`는 위 표에 있는 레이아웃에만 넣어라. 없는 레이아웃은 image_prompt를 아예 생략해라.
- cover 1장 + body 3–5장 (레이아웃 다양하게, 같은 것 연속 금지) + cta 1장.
