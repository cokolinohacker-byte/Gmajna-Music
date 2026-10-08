# Gmajna Music for Android

This is a standalone Android project. It keeps YouTube Music in a WebView and
adds Gmajna branding and Jam room controls backed by the existing Socket.IO
server. Playback exposes Android media controls in the notification and
lock-screen; add the Gmajna Music widget to the home screen for play/pause and
track skipping without reopening the app. Background playback remains subject
to WebView, Android battery-management, and YouTube Music restrictions.

The ad filter blocks known third-party ad hosts and attempts to skip visible
player ads. YouTube may serve ad media from the same hosts as music, so this
best-effort filter cannot promise the same result on every device or prevent
every ad. It does not unlock Premium features or provide media downloads.

Google may restrict account sign-in inside embedded WebViews. If that happens,
the app can still show the music page, but playback may require the official
YouTube Music app or a supported browser.

## Build

Open this folder in Android Studio with JDK 17 and Android SDK 35 installed,
or run `gradle assembleDebug`. The APK is written to
`app/build/outputs/apk/debug/app-debug.apk`.

The GitHub Actions workflow in the desktop repository builds an APK artifact
when this Android project is updated.
