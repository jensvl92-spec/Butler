@echo off
echo ==========================================
echo      SMART BUTLER - ANDROID BUILDER
echo ==========================================
echo.
echo 1. Building Web Assets...
call npm run build
if %errorlevel% neq 0 pause && exit /b %errorlevel%

echo.
echo 2. Syncing to Android...
call npx cap sync android
if %errorlevel% neq 0 pause && exit /b %errorlevel%

echo.
echo 3. Killing Zombies and Compiling APK...
taskkill /F /IM java.exe
if exist "C:\Users\jensv\.gradle\caches\jars-9\jars-9.lock" del /f /q "C:\Users\jensv\.gradle\caches\jars-9\jars-9.lock"

cd android
call gradlew.bat --no-daemon clean
call gradlew.bat --no-daemon assembleDebug
if %errorlevel% neq 0 echo "Gradle Build Failed!" && pause && exit /b %errorlevel%

echo.
echo 4. Moving APK to Project Root...
cd ..
copy android\app\build\outputs\apk\debug\app-debug.apk butler-debug.apk

echo.
echo ==========================================
echo SUCCESS! 
echo Your app is ready: 'butler-debug.apk'
echo Transfer this file to your phone and install.
echo ==========================================
pause
