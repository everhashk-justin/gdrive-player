# Sorting Player (Google Drive Pure Frontend WebApp)

본 애플리케이션은 **PC에 백엔드 서버를 켜둘 필요 없이**, 모바일 스마트폰이나 태블릿, PC 브라우저에서 **구글 드라이브(Google Drive)에 직접 접속하여 음원 감상 및 분류 작업을 수행할 수 있는 순수 정적 프론트엔드 웹앱**입니다.

---

## 🌟 주요 특징 및 장점

1. **PC 전원 불필요**: PC를 완전히 끄고 외출해도 스마트폰 브라우저에서 단독으로 동작합니다.
2. **무료 영구 배포**: GitHub Pages, Cloudflare Pages, Vercel 등에 정적 파일로 업로드하여 언제 어디서나 접속할 수 있습니다.
3. **PWA(홈 화면 추가) 지원**: 스마트폰 브라우저에서 '홈 화면에 추가'를 누르면 전용 앱 아이콘으로 실행됩니다.
4. **오디오 플레이어 완벽 기능**:
   - 재생/일시정지, 슬라이더 탐색, 셔플(랜덤), 한 곡/전체 반복 재생
   - 배속 조절 (0.75x ~ 1.5x)
   - 동일 폴더 내 같은 이름의 `.txt` 가사 자동 로드 및 가사 뷰 지원
   - 모바일 잠금화면 컨트롤 지원 (`navigator.mediaSession`)
5. **원터치 분류 및 정렬 액션**:
   - **T1, T2, P1, P2**: 구글 드라이브 내 지정 폴더로 즉시 파일 이동
   - **T&D, P&D**: `.txt` 가사 파일만 대상 폴더로 이동하고 음원 파일은 휴지통으로 이동
   - **Prefix**: `1_`, `2_` 또는 사용자 지정 접두사를 파일명 앞에 추가 후 다음 곡 자동 재생
   - **Del**: 구글 드라이브 휴지통으로 안전하게 이동

---

## 🚀 사전 준비 (최초 1회: Google OAuth Client ID 발급)

구글 드라이브 API를 사용하려면 Google Cloud Console에서 본인 전용 **OAuth 2.0 웹 클라이언트 ID**가 필요합니다 (완전 무료).

1. [Google Cloud Console](https://console.cloud.google.com/) 접속 및 로그인
2. 상단 프로젝트 선택창에서 **[새 프로젝트]** 생성 (예: `MyAudioPlayer`)
3. 좌측 메뉴 **[API 및 서비스]** → **[라이브러리]** 이동
   - `Google Drive API` 검색 후 **[사용]** 버튼 클릭
4. **[API 및 서비스]** → **[OAuth 동의 화면]** 구성:
   - 사용자 유형: **외부(External)** 선택 후 만들기
   - 앱 이름(예: `GDrive Player`), 사용자 지원 이메일 입력 후 저장
   - 범위(Scope): `.../auth/drive` (또는 `.../auth/drive.file`) 추가
   - 테스트 사용자: **본인의 구글 계정 이메일** 추가 (필수)
5. **[API 및 서비스]** → **[사용자 인증 정보]** → **[+ 사용자 인증 정보 만들기]** → **[OAuth 클라이언트 ID]**:
   - 애플리케이션 유형: **웹 애플리케이션(Web application)**
   - 이름: `GDrive Player Client`
   - **승인된 자바스크립트 원본**:
     - 로컬 테스트 시: `http://localhost:8080`, `http://127.0.0.1:8080`
     - GitHub Pages 배포 시: `https://<내아이디>.github.io`
   - 만들기 클릭 후 발급된 **클라이언트 ID**(`xxxx.apps.googleusercontent.com`)를 복사합니다.

---

## 💻 로컬에서 실행 및 테스트하기

브라우저 보안 규정상 Google Identity Services는 `file://` 직접 열기가 아닌 로컬 웹 서버 환경에서 열어야 합니다.

`gdrive_web_player` 폴더에서 아래 명령어로 로컬 서버를 실행합니다:

```powershell
# gdrive_web_player 폴더로 이동 후 파이썬 내장 웹서버 실행
cd d:\00_antigravity\01_audio_player\gdrive_web_player
python -m http.server 8080
```

* 브라우저에서 `http://localhost:8080` 접속
* 우측 상단 **[설정(톱니바퀴)]** 클릭
* 복사해 둔 **Google OAuth Client ID** 및 **시작 폴더 ID**를 입력하고 [저장]
* 우측 상단 **[구글 로그인]** 클릭하여 본인 계정 승인 후 사용!

> **팁**: 폴더 ID는 구글 드라이브 웹 주소창의 전체 URL(예: `https://drive.google.com/drive/folders/1ABCxyz...`)을 그대로 복사해서 붙여넣어도 자동으로 폴더 ID만 추출됩니다.

---

## 📱 스마트폰에서 영구적으로 무료 사용하는 방법 (GitHub Pages 배포)

1. GitHub에 새 저장소(Public 또는 Private) 생성
2. `gdrive_web_player` 폴더 내의 파일들(`index.html`, `style.css`, `app.js`)을 업로드
3. GitHub 저장소의 **[Settings]** → **[Pages]** 메뉴에서 `Branch: main`, `Folder: /(root)` 설정 후 Save
4. 생성된 웹사이트 주소(예: `https://<아이디>.github.io/<저장소명>/`)를 Google Cloud Console의 **'승인된 자바스크립트 원본'**에 추가 등록
5. 스마트폰 브라우저로 해당 주소에 접속한 뒤 브라우저 메뉴의 **[홈 화면에 추가]**를 누르면 끝!

