@echo off
chcp 65001 >nul
setlocal EnableExtensions
cd /d "%~dp0"
title 키워드 검색량 APK 만들기

echo ==========================================================
echo   키워드 검색량 - 안드로이드 APK 만들기 (내 PC 빌드)
echo ==========================================================
echo.

where node >nul 2>&1
if errorlevel 1 goto nonode

if not defined JAVA_HOME if exist "C:\Program Files\Android\Android Studio\jbr\bin\java.exe" set "JAVA_HOME=C:\Program Files\Android\Android Studio\jbr"
if not defined JAVA_HOME goto nojava

if not defined ANDROID_HOME if exist "%LOCALAPPDATA%\Android\Sdk" set "ANDROID_HOME=%LOCALAPPDATA%\Android\Sdk"
if not defined ANDROID_HOME goto nosdk
set "SDKDIR=%ANDROID_HOME:\=/%"
> android\local.properties echo sdk.dir=%SDKDIR%

if not exist "signing\keystore.properties" goto nokey

set "VN="
set /p "VN=버전을 입력하세요 (예: 1.0.0, 그냥 Enter = 1.0.0): "
if "%VN%"=="" set "VN=1.0.0"
set "MA=" & set "MI=" & set "PA="
for /f "tokens=1-3 delims=." %%a in ("%VN%") do (
  set "MA=%%a"
  set "MI=%%b"
  set "PA=%%c"
)
if "%PA%"=="" goto badver
set /a VC=MA*10000+MI*100+PA
if %VC% LEQ 0 goto badver

set "UPDATE_URL="
if exist "update_url.txt" set /p UPDATE_URL=<update_url.txt
> www\js\build-info.js echo export const BUILD = { versionName: "%VN%", versionCode: %VC%, updateUrl: "%UPDATE_URL%" };

echo.
echo [1/3] 패키지 설치 중...
call npm install --no-audit --no-fund
if errorlevel 1 goto fail

echo [2/3] 안드로이드 프로젝트 동기화 중...
call npx cap sync android
if errorlevel 1 goto fail

echo [3/3] APK 빌드 중... 처음에는 필요한 파일을 내려받느라 5~10분 걸립니다.
pushd android
call gradlew.bat assembleRelease -PappVersionCode=%VC% -PappVersionName=%VN%
set "ERR=%errorlevel%"
popd
if not "%ERR%"=="0" goto fail

if not exist "결과물" mkdir "결과물"
copy /y "android\app\build\outputs\apk\release\app-release.apk" "결과물\keyword-volume.apk" >nul
copy /y "android\app\build\outputs\apk\release\app-release.apk" "결과물\keyword-volume-%VN%.apk" >nul
> "결과물\version.json" echo {"versionName": "%VN%", "versionCode": %VC%, "url": ""}

echo.
echo 완료: 결과물\keyword-volume.apk  (버전 %VN%, 코드 %VC%)
echo 이 파일을 다운로드 링크로 올리고, tools\QR_만들기.html 로 QR코드를 만드세요.
explorer "결과물"
pause
exit /b 0

:nonode
echo Node.js 가 없습니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
start "" https://nodejs.org/ko
pause
exit /b 1

:nojava
echo Java를 찾지 못했습니다. Android Studio 를 설치하면 함께 들어옵니다.
echo https://developer.android.com/studio 에서 설치 후, 한 번 실행해 기본 설정을 끝내고 다시 실행하세요.
start "" https://developer.android.com/studio
pause
exit /b 1

:nosdk
echo Android SDK 를 찾지 못했습니다. Android Studio 를 한 번 실행해 기본 설치(Standard)를 끝낸 뒤 다시 실행하세요.
pause
exit /b 1

:nokey
echo 서명 키가 없습니다.
echo 함께 받은 "서명키_보관용" 폴더의 keyword-release.jks 와 keystore.properties 를
echo 이 폴더 안의 signing 폴더에 복사한 뒤 다시 실행하세요.
echo 업데이트 버전을 기존 앱 위에 설치하려면 항상 같은 서명 키로 빌드해야 합니다.
pause
exit /b 1

:badver
echo 버전은 1.0.0 처럼 숫자.숫자.숫자 형식으로 넣어주세요.
pause
exit /b 1

:fail
echo.
echo 빌드에 실패했습니다. 위쪽의 오류 메시지를 확인하세요.
pause
exit /b 1
