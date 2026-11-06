/**
 * Sorting Player - Google Drive Pure Frontend WebApp
 * Google Identity Services(GIS) + Google Drive API v3
 */

// --- 1. 상태 및 전역 변수 ---
const STATE = {
    accessToken: null,
    tokenExpiresAt: 0,
    tokenClient: null,
    userEmail: null,

    // 네비게이션
    currentFolderId: null,
    currentFolderName: '루트',
    parentFolderId: null,
    folderStack: [], // 히스토리 스택 [{ id, name }]

    // 목록 데이터
    subFolders: [],
    songs: [],
    lyricsMap: new Map(), // filename_without_ext -> { id, name }
    relatedFilesMap: new Map(), // filename_without_ext (소문자) -> Array<{ id, name, ext }> (wav, mp3, txt, json)

    // 재생 상태
    currentIndex: -1,
    isPlaying: false,
    isShuffle: false,
    shuffleIndices: [],
    shufflePointer: 0,
    repeatMode: 0, // 0: 반복 안함, 1: 전체 반복, 2: 1곡 반복
    sortAsc: true,

    // 배속 매핑
    speedSteps: [-3, -2, -1, 0, 1, 2, 3],
    speedValues: [0.75, 0.85, 0.9, 1.0, 1.1, 1.25, 1.5],
    currentSpeedIndex: 3, // 1.0x 기본값

    // 음량 상태
    volume: 1.0,
    isMuted: false,
    lastVolume: 1.0,

    // 현재 재생 중인 Blob URL (메모리 해제 관리)
    currentBlobUrl: null
};

// 지원 오디오 확장자
const AUDIO_EXTS = ['.mp3', '.wav', '.flac', '.ogg', '.m4a', '.aac', '.wma'];
// 연계 처리 지원 대상 4종 확장자 (음원, 가사, 메타데이터 JSON 등)
const TARGET_ASSOCIATED_EXTS = ['.wav', '.mp3', '.txt', '.json'];

// 파일명에서 확장자를 제외한 베이스 이름(stem)과 확장자(ext) 분리
function getFileStemAndExt(filename) {
    if (!filename) return { stem: '', ext: '' };
    const lastDot = filename.lastIndexOf('.');
    if (lastDot <= 0) return { stem: filename, ext: '' };
    return {
        stem: filename.substring(0, lastDot),
        ext: filename.substring(lastDot).toLowerCase()
    };
}

// --- 2. 설정 관리 (LocalStorage) ---
const CONFIG_KEY = 'gdrive_player_config_v1';

function getDefaultConfig() {
    return {
        clientId: '',
        rootFolder: '',
        t1: '',
        t2: '',
        t3: '',
        p1: '',
        p2: '',
        p3: '',
        volume: 1.0,
        speedIndex: 3,
        repeatMode: 0,
        isShuffle: false,
        keepScreenAwake: true
    };
}

function loadConfig() {
    try {
        const raw = localStorage.getItem(CONFIG_KEY);
        if (raw) {
            return { ...getDefaultConfig(), ...JSON.parse(raw) };
        }
    } catch (e) {
        console.error('설정 로드 실패:', e);
    }
    return getDefaultConfig();
}

function saveConfigToStorage(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
}

// 구글 드라이브 URL 또는 일반 텍스트에서 폴더 ID만 정규식으로 안전하게 추출
function extractFolderId(input) {
    if (!input) return '';
    input = input.trim();
    // https://drive.google.com/drive/folders/1ABC... 형태
    const folderMatch = input.match(/folders\/([a-zA-Z0-9_-]+)/);
    if (folderMatch) return folderMatch[1];
    
    // https://drive.google.com/open?id=1ABC... 형태
    const idMatch = input.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (idMatch) return idMatch[1];

    // 공백 및 따옴표 제거된 원본 문자열 반환
    return input.replace(/['"]/g, '');
}

// --- 3. Google Identity Services (GIS) 인증 모듈 ---
function initGisAuth() {
    const cfg = loadConfig();
    if (!cfg.clientId) {
        console.warn('Google Client ID가 설정되지 않았습니다.');
        return false;
    }

    if (typeof google === 'undefined' || !google.accounts || !google.accounts.oauth2) {
        console.warn('Google Identity Services SDK 로드 대기 중...');
        setTimeout(initGisAuth, 500);
        return false;
    }

    STATE.tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cfg.clientId.trim(),
        scope: 'https://www.googleapis.com/auth/drive',
        callback: handleTokenResponse
    });

    // 브라우저 로컬 저장소에 유효한 토큰이 남아있는지 확인 (브라우저를 닫아도 유지)
    const savedToken = localStorage.getItem('gdrive_token');
    const savedExpires = localStorage.getItem('gdrive_token_expires');
    if (savedToken && savedExpires && Date.now() < parseInt(savedExpires, 10)) {
        STATE.accessToken = savedToken;
        STATE.tokenExpiresAt = parseInt(savedExpires, 10);
        updateAuthUI(true);
        onAuthenticated();
    }
    return true;
}

function handleAuthClick() {
    if (STATE.accessToken) {
        // 로그아웃 처리
        if (confirm('구글 계정 로그아웃 하시겠습니까?')) {
            logout();
        }
    } else {
        // 로그인 진행
        const cfg = loadConfig();
        if (!cfg.clientId) {
            showToast('환경 설정에서 Google Client ID를 먼저 입력해주세요.', 'error');
            openConfigModal();
            return;
        }
        if (!STATE.tokenClient) {
            initGisAuth();
        }
        if (STATE.tokenClient) {
            // 이전에 로그인한 적이 있으면 prompt를 비워 번거로운 동의 절차 없이 가볍게 갱신
            const hasLoggedInBefore = localStorage.getItem('gdrive_has_logged_in') === 'true';
            STATE.tokenClient.requestAccessToken({ prompt: hasLoggedInBefore ? '' : 'consent' });
        } else {
            showToast('Google 인증 라이브러리를 초기화하는 중입니다. 잠시 후 다시 시도해주세요.', 'error');
        }
    }
}

function handleTokenResponse(resp) {
    if (resp.error) {
        console.error('Google Auth Error:', resp);
        // 만약 prompt: '' 로 자동 갱신 실패 시 consent로 재시도
        if (resp.error === 'interaction_required' && STATE.tokenClient) {
            STATE.tokenClient.requestAccessToken({ prompt: 'consent' });
            return;
        }
        showToast('구글 로그인에 실패했습니다: ' + resp.error, 'error');
        return;
    }
    STATE.accessToken = resp.access_token;
    // 만료 시간 기록 (유효시간 expiresIn초, 보통 3600초)
    const expiresIn = (resp.expires_in || 3500) * 1000;
    STATE.tokenExpiresAt = Date.now() + expiresIn;
    localStorage.setItem('gdrive_token', STATE.accessToken);
    localStorage.setItem('gdrive_token_expires', STATE.tokenExpiresAt.toString());
    localStorage.setItem('gdrive_has_logged_in', 'true');

    updateAuthUI(true);
    showToast('구글 계정 인증이 완료되었습니다.', 'success');
    onAuthenticated();
}

function logout() {
    if (STATE.accessToken && typeof google !== 'undefined' && google.accounts && google.accounts.oauth2) {
        google.accounts.oauth2.revoke(STATE.accessToken, () => {});
    }
    STATE.accessToken = null;
    STATE.tokenExpiresAt = 0;
    localStorage.removeItem('gdrive_token');
    localStorage.removeItem('gdrive_token_expires');
    localStorage.removeItem('gdrive_has_logged_in');
    updateAuthUI(false);
    showToast('로그아웃되었습니다.', 'success');
    
    // UI 초기화
    document.getElementById('folder-list').innerHTML = '<div style="color:var(--text-secondary);padding:0.5rem;">로그인 후 사용 가능합니다.</div>';
    document.getElementById('file-list').innerHTML = '<div style="color:var(--text-secondary);padding:0.5rem;">로그인 후 사용 가능합니다.</div>';
    document.getElementById('path-display').textContent = '로그인이 필요합니다';
    document.getElementById('folder-count').textContent = '0개';
    document.getElementById('song-count').textContent = '0곡';
}

function updateAuthUI(isLoggedIn) {
    const btn = document.getElementById('btn-auth');
    const txt = document.getElementById('auth-btn-text');
    if (isLoggedIn) {
        btn.className = 'btn-icon btn-auth-logout';
        txt.textContent = '로그아웃';
        btn.querySelector('i').className = 'fas fa-sign-out-alt';
    } else {
        btn.className = 'btn-icon btn-auth-login';
        txt.textContent = '로그인';
        btn.querySelector('i').className = 'fab fa-google';
    }
}

async function ensureValidToken() {
    if (!STATE.accessToken || Date.now() >= STATE.tokenExpiresAt - 60000) {
        // 토큰 만료 또는 없음 -> 백그라운드 갱신 요청 시도
        return new Promise((resolve, reject) => {
            if (!STATE.tokenClient) {
                reject(new Error('Auth client not initialized'));
                return;
            }
            STATE.tokenClient.callback = (resp) => {
                if (resp.error) {
                    reject(resp.error);
                } else {
                    handleTokenResponse(resp);
                    resolve(resp.access_token);
                }
            };
            STATE.tokenClient.requestAccessToken({ prompt: '' });
        });
    }
    return STATE.accessToken;
}

// --- 4. Google Drive API v3 통신 모듈 ---
async function driveFetch(url, options = {}, retries = 2) {
    try {
        const token = await ensureValidToken();
        const headers = {
            ...(options.headers || {}),
            Authorization: `Bearer ${token}`
        };

        const response = await fetch(url, { ...options, headers });

        if (response.status === 401 && retries > 0) {
            // 토큰 만료 재시도
            STATE.accessToken = null;
            return driveFetch(url, options, retries - 1);
        }

        if ((response.status === 429 || response.status === 403) && retries > 0) {
            // Rate Limit 지수 백오프
            await new Promise(r => setTimeout(r, 1000 * (3 - retries)));
            return driveFetch(url, options, retries - 1);
        }

        if (!response.ok) {
            const errBody = await response.text();
            throw new Error(`API 오류 (${response.status}): ${errBody}`);
        }

        return response;
    } catch (e) {
        console.error('driveFetch 실패:', e);
        throw e;
    }
}

// 폴더 정보(이름, 부모 ID) 조회
async function fetchFolderInfo(folderId) {
    if (!folderId || folderId === 'root') {
        return { id: 'root', name: '내 드라이브', parentId: null };
    }
    const url = `https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,name,parents&supportsAllDrives=true`;
    const res = await driveFetch(url);
    const data = await res.json();
    return {
        id: data.id,
        name: data.name,
        parentId: data.parents && data.parents.length > 0 ? data.parents[0] : null
    };
}

// 지정된 폴더의 하위 폴더 및 파일 전체 조회 (Pagination 지원)
async function fetchFolderContents(folderId) {
    const subFolders = [];
    const audioFiles = [];
    const lyricsMap = new Map();
    const relatedFilesMap = new Map(); // stem.toLowerCase() -> Array<{ id, name, ext, mimeType, size }>

    let pageToken = null;
    do {
        let q = `'${folderId}' in parents and trashed = false`;
        let url = `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=nextPageToken,files(id,name,mimeType,size,modifiedTime)&pageSize=1000&supportsAllDrives=true&includeItemsFromAllDrives=true`;
        if (pageToken) {
            url += `&pageToken=${encodeURIComponent(pageToken)}`;
        }

        const res = await driveFetch(url);
        const data = await res.json();

        if (data.files) {
            for (const file of data.files) {
                if (file.mimeType === 'application/vnd.google-apps.folder') {
                    subFolders.push(file);
                } else {
                    const { stem, ext } = getFileStemAndExt(file.name);
                    const lowerStem = stem.toLowerCase();

                    // 4종 연계 파일(.wav, .mp3, .txt, .json) 수집
                    if (TARGET_ASSOCIATED_EXTS.includes(ext)) {
                        if (!relatedFilesMap.has(lowerStem)) {
                            relatedFilesMap.set(lowerStem, []);
                        }
                        relatedFilesMap.get(lowerStem).push({
                            id: file.id,
                            name: file.name,
                            ext: ext,
                            mimeType: file.mimeType,
                            size: file.size
                        });
                    }

                    // 음원 재생 목록 대상
                    const isAudio = AUDIO_EXTS.includes(ext);
                    if (isAudio) {
                        audioFiles.push(file);
                    }

                    // 가사 파일 대상
                    if (ext === '.txt') {
                        lyricsMap.set(lowerStem, file);
                    }
                }
            }
        }
        pageToken = data.nextPageToken;
    } while (pageToken);

    return { subFolders, audioFiles, lyricsMap, relatedFilesMap };
}

// 음원 바이너리 Blob 다운로드
async function downloadAudioBlob(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
    const res = await driveFetch(url);
    return await res.blob();
}

// 텍스트 파일(가사) 다운로드
async function downloadLyricsText(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;
    const res = await driveFetch(url);
    return await res.text();
}

// 파일 이동 (부모 변경)
async function moveDriveFile(fileId, currentParentId, targetFolderId) {
    let url = `https://www.googleapis.com/drive/v3/files/${fileId}?addParents=${encodeURIComponent(targetFolderId)}&supportsAllDrives=true`;
    if (currentParentId) {
        url += `&removeParents=${encodeURIComponent(currentParentId)}`;
    }
    const res = await driveFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' }
    });
    return await res.json();
}

// 파일 휴지통 이동 (삭제)
async function trashDriveFile(fileId) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`;
    const res = await driveFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trashed: true })
    });
    return await res.json();
}

// 파일 이름 변경 (Prefix 적용 등)
async function renameDriveFile(fileId, newName) {
    const url = `https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`;
    const res = await driveFetch(url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newName })
    });
    return await res.json();
}

// --- 5. 플레이어 엔진 및 UI 로직 ---
const audio = document.getElementById('audio-player');

async function onAuthenticated() {
    const cfg = loadConfig();
    const startFolder = extractFolderId(cfg.rootFolder) || 'root';
    await loadFolder(startFolder);
}

// 특정 폴더 로드
async function loadFolder(folderId) {
    showLoading('폴더 목록을 불러오는 중입니다...');
    try {
        const folderInfo = await fetchFolderInfo(folderId);
        STATE.currentFolderId = folderInfo.id;
        STATE.currentFolderName = folderInfo.name;
        STATE.parentFolderId = folderInfo.parentId;

        document.getElementById('path-display').textContent = folderInfo.name;
        document.getElementById('path-display').title = `ID: ${folderInfo.id}`;

        const contents = await fetchFolderContents(folderId);
        STATE.subFolders = contents.subFolders;
        STATE.songs = contents.audioFiles;
        STATE.lyricsMap = contents.lyricsMap;
        STATE.relatedFilesMap = contents.relatedFilesMap;

        // 이름순 정렬
        sortSongs();

        // UI 렌더링
        renderFolderList();
        renderSongList();

        // 셔플 인덱스 생성
        if (STATE.isShuffle) {
            generateShuffleIndices();
        }

    } catch (e) {
        console.error('폴더 로드 실패:', e);
        showToast('폴더를 불러올 수 없습니다: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

// 하위 폴더 렌더링
function renderFolderList() {
    const listEl = document.getElementById('folder-list');
    document.getElementById('folder-count').textContent = `${STATE.subFolders.length}개`;
    listEl.innerHTML = '';

    // 상위 폴더 이동 버튼 (루트가 아닐 때)
    if (STATE.parentFolderId) {
        const upDiv = document.createElement('div');
        upDiv.className = 'item';
        upDiv.innerHTML = `
            <div class="item-icon"><i class="fas fa-level-up-alt"></i></div>
            <div class="item-info">
                <div class="item-name">.. (상위 폴더로 이동)</div>
            </div>
        `;
        upDiv.onclick = () => loadFolder(STATE.parentFolderId);
        listEl.appendChild(upDiv);
    }

    if (STATE.subFolders.length === 0 && !STATE.parentFolderId) {
        listEl.innerHTML = '<div style="color:var(--text-secondary);font-size:0.8rem;padding:0.5rem;">하위 폴더가 없습니다.</div>';
        return;
    }

    // 이름순 정렬
    STATE.subFolders.sort((a, b) => a.name.localeCompare(b.name, 'ko'));

    STATE.subFolders.forEach(folder => {
        const div = document.createElement('div');
        div.className = 'item';
        div.innerHTML = `
            <div class="item-icon"><i class="fas fa-folder"></i></div>
            <div class="item-info">
                <div class="item-name">${escapeHtml(folder.name)}</div>
            </div>
        `;
        div.onclick = () => loadFolder(folder.id);
        listEl.appendChild(div);
    });
}

// 음원 목록 렌더링
function renderSongList() {
    const listEl = document.getElementById('file-list');
    document.getElementById('song-count').textContent = `${STATE.songs.length}곡`;
    listEl.innerHTML = '';

    if (STATE.songs.length === 0) {
        listEl.innerHTML = '<div style="color:var(--text-secondary);font-size:0.8rem;padding:0.5rem;">이 폴더에 오디오 파일이 없습니다.</div>';
        return;
    }

    STATE.songs.forEach((song, idx) => {
        const div = document.createElement('div');
        div.className = `item ${idx === STATE.currentIndex ? 'active' : ''}`;
        div.id = `song-item-${idx}`;

        const baseName = song.name.substring(0, song.name.lastIndexOf('.'));
        const hasLyrics = STATE.lyricsMap.has(baseName.toLowerCase());
        const sizeMb = (song.size / (1024 * 1024)).toFixed(1);

        div.innerHTML = `
            <div class="item-icon"><i class="fas ${idx === STATE.currentIndex && STATE.isPlaying ? 'fa-volume-up' : 'fa-music'}"></i></div>
            <div class="item-info">
                <div class="item-name">${escapeHtml(song.name)}</div>
                <div class="item-meta">
                    <span>${sizeMb} MB</span>
                    ${hasLyrics ? '<span class="item-has-lyrics"><i class="fas fa-file-alt"></i> 가사</span>' : ''}
                </div>
            </div>
        `;
        div.onclick = () => playSongAtIndex(idx);
        listEl.appendChild(div);
    });
}

// 곡 정렬
function sortSongs() {
    STATE.songs.sort((a, b) => {
        const cmp = a.name.localeCompare(b.name, 'ko', { numeric: true });
        return STATE.sortAsc ? cmp : -cmp;
    });
}

function toggleSort() {
    STATE.sortAsc = !STATE.sortAsc;
    const icon = document.getElementById('sort-icon');
    icon.className = STATE.sortAsc ? 'fas fa-sort-alpha-down' : 'fas fa-sort-alpha-up';
    
    // 현재 재생 중인 곡의 ID 보존
    const currentSongId = STATE.currentIndex >= 0 && STATE.currentIndex < STATE.songs.length ? STATE.songs[STATE.currentIndex].id : null;

    sortSongs();

    if (currentSongId) {
        STATE.currentIndex = STATE.songs.findIndex(s => s.id === currentSongId);
    }
    renderSongList();
    showToast(STATE.sortAsc ? '이름 오름차순 정렬' : '이름 내림차순 정렬');
}

// 곡 재생
async function playSongAtIndex(index) {
    if (index < 0 || index >= STATE.songs.length) return;
    STATE.currentIndex = index;
    const song = STATE.songs[index];

    // UI 갱신
    document.querySelectorAll('.song-panel .item').forEach((el, i) => {
        el.classList.toggle('active', i === index);
        const icon = el.querySelector('.item-icon i');
        if (icon) icon.className = (i === index) ? 'fas fa-spinner fa-spin' : 'fas fa-music';
    });

    document.getElementById('np-title').textContent = song.name;
    document.getElementById('np-status').textContent = '클라우드에서 스트리밍 로딩 중...';

    // 가사 로딩
    loadLyricsForSong(song);

    try {
        // 기존 메모리 Blob URL 해제
        if (STATE.currentBlobUrl) {
            URL.revokeObjectURL(STATE.currentBlobUrl);
            STATE.currentBlobUrl = null;
        }

        // 음원 바이너리 가져오기
        const blob = await downloadAudioBlob(song.id);
        STATE.currentBlobUrl = URL.createObjectURL(blob);
        audio.src = STATE.currentBlobUrl;

        // 배속 적용
        applySpeed();

        await audio.play();
        STATE.isPlaying = true;
        updatePlayBtnUI();
        document.getElementById('np-status').textContent = '재생 중';

        // 목록 아이콘 갱신
        const currentItem = document.getElementById(`song-item-${index}`);
        if (currentItem) {
            const icon = currentItem.querySelector('.item-icon i');
            if (icon) icon.className = 'fas fa-volume-up';
            currentItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }

        // MediaSession 등록 (모바일 잠금화면)
        setupMediaSession(song.name);

    } catch (e) {
        console.error('재생 실패:', e);
        showToast('음원을 재생할 수 없습니다: ' + e.message, 'error');
        document.getElementById('np-status').textContent = '재생 오류';
    }
}

// 가사 로딩
async function loadLyricsForSong(song) {
    const lyricsEl = document.getElementById('lyrics-content');
    lyricsEl.textContent = '가사를 확인하는 중...';

    const baseName = song.name.substring(0, song.name.lastIndexOf('.'));
    const txtFile = STATE.lyricsMap.get(baseName.toLowerCase());

    if (!txtFile) {
        lyricsEl.textContent = '동일한 이름의 가사 파일(.txt)이 없습니다.';
        return;
    }

    try {
        const text = await downloadLyricsText(txtFile.id);
        lyricsEl.textContent = text || '(가사 파일 내용이 비어 있습니다)';
    } catch (e) {
        console.error('가사 로드 실패:', e);
        lyricsEl.textContent = '가사를 불러오는 중 오류가 발생했습니다.';
    }
}

// 재생 / 일시정지 토글
function togglePlay() {
    if (!audio.src || STATE.currentIndex === -1) {
        if (STATE.songs.length > 0) {
            playSongAtIndex(0);
        }
        return;
    }

    if (audio.paused) {
        audio.play();
        STATE.isPlaying = true;
    } else {
        audio.pause();
        STATE.isPlaying = false;
    }
    updatePlayBtnUI();
}

function updatePlayBtnUI() {
    const playIcon = document.getElementById('play-icon');
    playIcon.className = STATE.isPlaying ? 'fas fa-pause-circle' : 'fas fa-play-circle';
}

// 다음 곡 / 이전 곡
function playNext() {
    if (STATE.songs.length === 0) return;

    if (STATE.isShuffle) {
        STATE.shufflePointer = (STATE.shufflePointer + 1) % STATE.shuffleIndices.length;
        playSongAtIndex(STATE.shuffleIndices[STATE.shufflePointer]);
    } else {
        let nextIdx = STATE.currentIndex + 1;
        if (nextIdx >= STATE.songs.length) {
            if (STATE.repeatMode === 1) { // 전체 반복
                nextIdx = 0;
            } else {
                showToast('재생 목록의 끝입니다.');
                return;
            }
        }
        playSongAtIndex(nextIdx);
    }
}

function playPrev() {
    if (STATE.songs.length === 0) return;

    // 현재 곡 재생이 3초 이상 지났으면 곡의 처음으로
    if (audio.currentTime > 3) {
        audio.currentTime = 0;
        return;
    }

    if (STATE.isShuffle) {
        STATE.shufflePointer = (STATE.shufflePointer - 1 + STATE.shuffleIndices.length) % STATE.shuffleIndices.length;
        playSongAtIndex(STATE.shuffleIndices[STATE.shufflePointer]);
    } else {
        let prevIdx = STATE.currentIndex - 1;
        if (prevIdx < 0) {
            prevIdx = STATE.songs.length - 1;
        }
        playSongAtIndex(prevIdx);
    }
}

// 셔플 모드 토글
function toggleShuffle() {
    STATE.isShuffle = !STATE.isShuffle;
    const btn = document.getElementById('btn-shuffle');
    btn.classList.toggle('active', STATE.isShuffle);

    if (STATE.isShuffle) {
        generateShuffleIndices();
        showToast('랜덤 재생 켜짐', 'success');
    } else {
        showToast('순차 재생 모드');
    }
}

function generateShuffleIndices() {
    STATE.shuffleIndices = STATE.songs.map((_, i) => i);
    // Fisher-Yates 알고리즘
    for (let i = STATE.shuffleIndices.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [STATE.shuffleIndices[i], STATE.shuffleIndices[j]] = [STATE.shuffleIndices[j], STATE.shuffleIndices[i]];
    }
    STATE.shufflePointer = 0;
    if (STATE.currentIndex !== -1) {
        const p = STATE.shuffleIndices.indexOf(STATE.currentIndex);
        if (p !== -1) STATE.shufflePointer = p;
    }
}

// 반복 모드 토글 (0: 끔 -> 1: 전체 -> 2: 1곡)
function toggleRepeat() {
    STATE.repeatMode = (STATE.repeatMode + 1) % 3;
    const icon = document.getElementById('repeat-icon');
    const btn = document.getElementById('btn-repeat');

    if (STATE.repeatMode === 0) {
        btn.classList.remove('active');
        icon.className = 'fas fa-redo';
        showToast('반복 안함');
    } else if (STATE.repeatMode === 1) {
        btn.classList.add('active');
        icon.className = 'fas fa-redo';
        showToast('전체 반복 재생', 'success');
    } else if (STATE.repeatMode === 2) {
        btn.classList.add('active');
        icon.className = 'fas fa-redo-alt'; // 1곡 반복 아이콘 대용
        showToast('한 곡 반복 재생', 'success');
    }
}

// --- Screen Wake Lock API (재생 중 스마트폰 화면 꺼짐 방지) ---
let wakeLockSentinel = null;

async function requestWakeLock() {
    const cfg = loadConfig();
    if (cfg.keepScreenAwake === false) return;

    if ('wakeLock' in navigator) {
        try {
            if (wakeLockSentinel !== null && !wakeLockSentinel.released) {
                return;
            }
            wakeLockSentinel = await navigator.wakeLock.request('screen');
            wakeLockSentinel.addEventListener('release', () => {
                wakeLockSentinel = null;
            });
            console.log('[WakeLock] 화면 꺼짐 방지 활성화');
        } catch (err) {
            console.warn('[WakeLock] 화면 꺼짐 방지 요청 실패:', err);
        }
    }
}

function releaseWakeLock() {
    if (wakeLockSentinel !== null) {
        wakeLockSentinel.release()
            .then(() => { wakeLockSentinel = null; })
            .catch(() => { wakeLockSentinel = null; });
    }
}

// 오디오 재생 / 일시정지 이벤트와 연동
audio.addEventListener('play', () => {
    STATE.isPlaying = true;
    updatePlayBtnUI();
    requestWakeLock();
});

audio.addEventListener('pause', () => {
    STATE.isPlaying = false;
    updatePlayBtnUI();
    releaseWakeLock();
});

// 브라우저 탭 복귀 시 음악 재생 중이면 Wake Lock 재요청
document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && STATE.isPlaying && !audio.paused) {
        await requestWakeLock();
    }
});

// 오디오 재생 완료 시
audio.addEventListener('ended', () => {
    releaseWakeLock();
    if (STATE.repeatMode === 2) {
        // 한 곡 반복
        audio.currentTime = 0;
        audio.play();
    } else {
        playNext();
    }
});

// 프로그레스 바 업데이트
audio.addEventListener('timeupdate', () => {
    if (!audio.duration) return;
    const cur = audio.currentTime;
    const dur = audio.duration;
    const pct = (cur / dur) * 100;
    document.getElementById('progress-fill').style.width = `${pct}%`;
    document.getElementById('time-current').textContent = formatTime(cur);
    document.getElementById('time-total').textContent = formatTime(dur);
});

function seek(e) {
    if (!audio.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pos = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pos * audio.duration;
}

function formatTime(sec) {
    if (isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// 배속 조절
function onSpeedSliderChange(stepVal) {
    const idx = parseInt(stepVal, 10) + 3;
    setSpeedStep(idx);
}

function stepSpeed(delta) {
    const newIdx = Math.max(0, Math.min(STATE.speedSteps.length - 1, STATE.currentSpeedIndex + delta));
    setSpeedStep(newIdx);
}

function setSpeedStep(idx) {
    STATE.currentSpeedIndex = idx;
    const slider = document.getElementById('speed-slider');
    if (slider) slider.value = idx - 3;
    const speedVal = STATE.speedValues[idx];
    const display = document.getElementById('speed-display');
    if (display) display.textContent = `${speedVal.toFixed(2).replace(/\.?0+$/, '')}x`;
    applySpeed();
}

function applySpeed() {
    const speedVal = STATE.speedValues[STATE.currentSpeedIndex];
    audio.playbackRate = speedVal;
}

// 음량(볼륨) 조절
function onVolumeChange(val) {
    const v = parseFloat(val);
    audio.volume = v;
    STATE.volume = v;
    STATE.isMuted = (v === 0);
    if (v > 0) {
        STATE.lastVolume = v;
    }
    updateVolumeUI();
    saveVolumeSetting(v);
}

function toggleMute() {
    if (STATE.isMuted || audio.volume === 0) {
        // 음소거 해제 -> 이전 볼륨 복원
        const restoreVol = STATE.lastVolume > 0 ? STATE.lastVolume : 1.0;
        audio.volume = restoreVol;
        STATE.volume = restoreVol;
        STATE.isMuted = false;
    } else {
        // 음소거 실행
        STATE.lastVolume = audio.volume > 0 ? audio.volume : 1.0;
        audio.volume = 0;
        STATE.volume = 0;
        STATE.isMuted = true;
    }
    updateVolumeUI();
    saveVolumeSetting(audio.volume);
}

function updateVolumeUI() {
    const slider = document.getElementById('vol-slider');
    const display = document.getElementById('vol-display');
    const icon = document.getElementById('vol-icon');

    if (slider) slider.value = audio.volume;
    if (display) display.textContent = `${Math.round(audio.volume * 100)}%`;

    if (icon) {
        if (audio.volume === 0 || STATE.isMuted) {
            icon.className = 'fas fa-volume-mute';
        } else if (audio.volume < 0.5) {
            icon.className = 'fas fa-volume-down';
        } else {
            icon.className = 'fas fa-volume-up';
        }
    }
}

function saveVolumeSetting(vol) {
    const cfg = loadConfig();
    cfg.volume = vol;
    saveConfigToStorage(cfg);
}

function initVolumeFromConfig() {
    const cfg = loadConfig();
    const savedVol = typeof cfg.volume === 'number' ? cfg.volume : 1.0;
    audio.volume = savedVol;
    STATE.volume = savedVol;
    STATE.lastVolume = savedVol > 0 ? savedVol : 1.0;
    STATE.isMuted = (savedVol === 0);
    updateVolumeUI();
}

// MediaSession 모바일 잠금화면 연동
function setupMediaSession(title) {
    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: title,
            artist: 'Sorting Player',
            album: STATE.currentFolderName
        });

        navigator.mediaSession.setActionHandler('play', () => { audio.play(); STATE.isPlaying = true; updatePlayBtnUI(); });
        navigator.mediaSession.setActionHandler('pause', () => { audio.pause(); STATE.isPlaying = false; updatePlayBtnUI(); });
        navigator.mediaSession.setActionHandler('previoustrack', playPrev);
        navigator.mediaSession.setActionHandler('nexttrack', playNext);
    }
}

// --- 6. 파일 액션 (T1, T2, T&D, P1, P2, P&D, Del, Prefix) ---

// 현재 곡의 베이스 파일명과 연계된 모든 파일(wav, mp3, txt, json) 목록 반환
function getAssociatedFiles(song) {
    if (!song) return [];
    const { stem } = getFileStemAndExt(song.name);
    const key = stem.toLowerCase();
    const list = STATE.relatedFilesMap.get(key) || [];

    // 만약 relatedFilesMap에 현재 곡 자체가 없는 경우 대비
    const hasCurrent = list.some(f => f.id === song.id);
    if (!hasCurrent) {
        return [{ id: song.id, name: song.name, ext: getFileStemAndExt(song.name).ext }, ...list];
    }
    return list;
}

// 작업 후 연계된 모든 곡(동일 stem을 가진 wav, mp3)을 STATE.songs에서 제거하고 다음 곡 재생
function removeAssociatedSongsFromListAndAdvance(baseStem) {
    const lowerStem = baseStem.toLowerCase();

    // 현재 선택된 곡의 stem과 동일한 곡들을 모두 필터링하여 제거
    STATE.songs = STATE.songs.filter(song => {
        const { stem } = getFileStemAndExt(song.name);
        return stem.toLowerCase() !== lowerStem;
    });

    // 맵에서도 정리
    STATE.relatedFilesMap.delete(lowerStem);
    STATE.lyricsMap.delete(lowerStem);

    renderSongList();

    if (STATE.songs.length === 0) {
        audio.pause();
        audio.src = '';
        STATE.isPlaying = false;
        STATE.currentIndex = -1;
        document.getElementById('np-title').textContent = '재생 중이 아님';
        document.getElementById('np-status').textContent = '대기 중';
        updatePlayBtnUI();
        return;
    }

    // 다음 곡 인덱스 유지
    const nextIdx = STATE.currentIndex < STATE.songs.length ? STATE.currentIndex : 0;
    playSongAtIndex(nextIdx);
}

async function performAction(actionType) {
    if (STATE.currentIndex === -1 || STATE.currentIndex >= STATE.songs.length) {
        showToast('선택된 곡이 없습니다.', 'error');
        return;
    }

    const currentSong = STATE.songs[STATE.currentIndex];
    const { stem: baseStem } = getFileStemAndExt(currentSong.name);
    const associatedFiles = getAssociatedFiles(currentSong);

    const cfg = loadConfig();

    if (actionType === 'del') {
        const fileNames = associatedFiles.map(f => f.name).join('\n - ');
        if (!confirm(`다음 관련 파일(최대 4종: wav, mp3, txt, json)을 모두 구글 드라이브 휴지통으로 이동하시겠습니까?\n\n - ${fileNames}`)) {
            return;
        }
        showLoading(`관련 파일(총 ${associatedFiles.length}개)을 삭제(휴지통 이동) 중입니다...`);
        try {
            await Promise.allSettled(associatedFiles.map(f => trashDriveFile(f.id)));
            showToast(`삭제 완료: 총 ${associatedFiles.length}개 관련 파일(wav/mp3/txt/json)이 휴지통으로 이동되었습니다.`, 'success');
            removeAssociatedSongsFromListAndAdvance(baseStem);
        } catch (e) {
            console.error('삭제 실패:', e);
            showToast('삭제 실패: ' + e.message, 'error');
        } finally {
            hideLoading();
        }
        return;
    }

    // 대상 폴더 ID 매핑
    let targetFolderId = '';
    let isTxtOnly = false; // T&D (T3), P&D (P3) 여부

    switch (actionType) {
        case 't1': targetFolderId = extractFolderId(cfg.t1); break;
        case 't2': targetFolderId = extractFolderId(cfg.t2); break;
        case 't3': 
            targetFolderId = extractFolderId(cfg.t3); 
            isTxtOnly = true; 
            break;
        case 'p1': targetFolderId = extractFolderId(cfg.p1); break;
        case 'p2': targetFolderId = extractFolderId(cfg.p2); break;
        case 'p3': 
            targetFolderId = extractFolderId(cfg.p3); 
            isTxtOnly = true; 
            break;
    }

    if (!targetFolderId) {
        showToast(`설정에서 ${actionType.toUpperCase()} 대상 폴더를 먼저 지정해주세요.`, 'error');
        openConfigModal();
        return;
    }

    showLoading(`${actionType.toUpperCase()} 작업을 처리 중입니다... (관련 파일 ${associatedFiles.length}개)`);
    try {
        if (isTxtOnly) {
            // T&D (T3) / P&D (P3): txt 파일만 대상 폴더로 이동, 음원(wav, mp3) 및 json 파일은 휴지통으로 이동
            const txtFiles = associatedFiles.filter(f => f.ext === '.txt');
            const otherFiles = associatedFiles.filter(f => f.ext !== '.txt');

            for (const tf of txtFiles) {
                await moveDriveFile(tf.id, STATE.currentFolderId, targetFolderId);
            }
            for (const ofile of otherFiles) {
                await trashDriveFile(ofile.id);
            }

            showToast(`${actionType.toUpperCase()}: txt 파일은 이동하고, 음원(wav/mp3) 및 json 파일은 삭제되었습니다.`, 'success');
        } else {
            // 일반 이동 (T1, T2, P1, P2): 모든 연계 파일(wav, mp3, txt, json)을 대상 폴더로 이동
            for (const f of associatedFiles) {
                await moveDriveFile(f.id, STATE.currentFolderId, targetFolderId);
            }
            showToast(`${actionType.toUpperCase()} 이동 완료: 총 ${associatedFiles.length}개 관련 파일 이동`, 'success');
        }

        removeAssociatedSongsFromListAndAdvance(baseStem);

    } catch (e) {
        console.error('파일 이동 실패:', e);
        showToast('작업 실패: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

// Prefix 모달 열기
function openPrefixModal() {
    if (STATE.currentIndex === -1 || STATE.currentIndex >= STATE.songs.length) {
        showToast('곡을 먼저 선택해주세요.', 'error');
        return;
    }
    const song = STATE.songs[STATE.currentIndex];
    document.getElementById('prefix-target-title').textContent = song.name;
    document.getElementById('prefix-custom-input').value = '';
    document.getElementById('prefix-modal').classList.add('active');
}

function closePrefixModal() {
    document.getElementById('prefix-modal').classList.remove('active');
}

function applyPrefixQuick(val) {
    applyPrefix(`${val}_`);
}

function applyPrefixCustom() {
    const val = document.getElementById('prefix-custom-input').value.trim();
    if (!val) {
        showToast('접두사를 입력해주세요.', 'error');
        return;
    }
    applyPrefix(val.endsWith('_') ? val : `${val}_`);
}

async function applyPrefix(prefix) {
    closePrefixModal();
    if (STATE.currentIndex === -1 || STATE.currentIndex >= STATE.songs.length) {
        showToast('선택된 곡이 없습니다.', 'error');
        return;
    }

    const currentSong = STATE.songs[STATE.currentIndex];
    const { stem: baseStem } = getFileStemAndExt(currentSong.name);
    const associatedFiles = getAssociatedFiles(currentSong);

    showLoading(`Prefix 적용 중: ${prefix}... (총 ${associatedFiles.length}개 파일)`);
    try {
        for (const file of associatedFiles) {
            const newName = `${prefix}${file.name}`;
            await renameDriveFile(file.id, newName);
            file.name = newName;
        }

        // STATE.songs 내 이름도 갱신
        for (const s of STATE.songs) {
            const match = associatedFiles.find(af => af.id === s.id);
            if (match) {
                s.name = match.name;
            }
        }

        // relatedFilesMap 키 갱신
        STATE.relatedFilesMap.delete(baseStem.toLowerCase());
        const newStem = `${prefix}${baseStem}`;
        STATE.relatedFilesMap.set(newStem.toLowerCase(), associatedFiles);

        renderSongList();
        showToast(`이름 변경 완료: ${prefix} 적용 (총 ${associatedFiles.length}개 파일)`, 'success');

        // 기존 데스크톱/웹 플레이어 규칙: Prefix 적용 후 현재 곡 정지 및 다음 곡 자동 재생
        audio.pause();
        playNext();

    } catch (e) {
        console.error('Prefix 적용 실패:', e);
        showToast('이름 변경 실패: ' + e.message, 'error');
    } finally {
        hideLoading();
    }
}

// --- 7. 뷰 전환 및 모달 관리 ---
function switchView(view) {
    const isPlayer = view === 'player';
    document.getElementById('tab-player').classList.toggle('active', isPlayer);
    document.getElementById('tab-lyrics').classList.toggle('active', !isPlayer);

    document.getElementById('folder-panel').style.display = isPlayer ? 'flex' : 'none';
    document.getElementById('song-panel').style.display = isPlayer ? 'flex' : 'none';
    document.getElementById('lyrics-panel').style.display = isPlayer ? 'none' : 'block';
}

function openConfigModal() {
    const cfg = loadConfig();
    document.getElementById('cfg-client-id').value = cfg.clientId || '';
    document.getElementById('cfg-root-folder').value = cfg.rootFolder || '';
    document.getElementById('cfg-t1').value = cfg.t1 || '';
    document.getElementById('cfg-t2').value = cfg.t2 || '';
    document.getElementById('cfg-t3').value = cfg.t3 || '';
    document.getElementById('cfg-p1').value = cfg.p1 || '';
    document.getElementById('cfg-p2').value = cfg.p2 || '';
    document.getElementById('cfg-p3').value = cfg.p3 || '';
    document.getElementById('cfg-keep-screen').checked = cfg.keepScreenAwake !== false;
    document.getElementById('config-modal').classList.add('active');
}

function closeConfigModal() {
    document.getElementById('config-modal').classList.remove('active');
}

function saveConfig() {
    const cfg = loadConfig();
    cfg.clientId = document.getElementById('cfg-client-id').value.trim();
    cfg.rootFolder = document.getElementById('cfg-root-folder').value.trim();
    cfg.t1 = document.getElementById('cfg-t1').value.trim();
    cfg.t2 = document.getElementById('cfg-t2').value.trim();
    cfg.t3 = document.getElementById('cfg-t3').value.trim();
    cfg.p1 = document.getElementById('cfg-p1').value.trim();
    cfg.p2 = document.getElementById('cfg-p2').value.trim();
    cfg.p3 = document.getElementById('cfg-p3').value.trim();
    cfg.keepScreenAwake = document.getElementById('cfg-keep-screen').checked;

    saveConfigToStorage(cfg);
    closeConfigModal();
    showToast('설정이 저장되었습니다. 페이지를 새로고침합니다.', 'success');
    setTimeout(() => location.reload(), 800);
}

// 유틸리티
function showLoading(msg) {
    document.getElementById('loading-text').textContent = msg || '처리 중...';
    document.getElementById('loading-overlay').classList.add('active');
}

function hideLoading() {
    document.getElementById('loading-overlay').classList.remove('active');
}

function showToast(msg, type = 'normal') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = `toast show ${type}`;
    clearTimeout(t._timer);
    t._timer = setTimeout(() => {
        t.className = 'toast';
    }, 2800);
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/[&<>"']/g, m => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[m]);
}

// 키보드 단축키
window.addEventListener('keydown', (e) => {
    // 인풋 포커스 상태에서는 단축키 제외
    if (['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
    } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        playNext();
    } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        playPrev();
    } else if (e.code === 'ArrowUp') {
        e.preventDefault();
        onVolumeChange(Math.min(1.0, audio.volume + 0.05));
    } else if (e.code === 'ArrowDown') {
        e.preventDefault();
        onVolumeChange(Math.max(0.0, audio.volume - 0.05));
    } else if (e.code === 'KeyM') {
        e.preventDefault();
        toggleMute();
    } else if (e.code === 'Delete') {
        e.preventDefault();
        performAction('del');
    }
});

// 초기화 시작
window.addEventListener('DOMContentLoaded', () => {
    initVolumeFromConfig();
    initGisAuth();
});

