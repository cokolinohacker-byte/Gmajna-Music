package com.gmajna.music

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaMetadata
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.util.Log
import java.net.URL
import java.util.concurrent.Executors

class PlaybackControlService : Service() {
    companion object {
        const val ACTION_UPDATE = "com.gmajna.music.action.UPDATE"
        const val ACTION_PLAY = "com.gmajna.music.action.PLAY"
        const val ACTION_PAUSE = "com.gmajna.music.action.PAUSE"
        const val ACTION_NEXT = "com.gmajna.music.action.NEXT"
        const val ACTION_PREVIOUS = "com.gmajna.music.action.PREVIOUS"
        const val ACTION_CONTROL = "com.gmajna.music.action.CONTROL"
        const val EXTRA_CONTROL = "control"

        private const val CHANNEL_ID = "gmajna_playback"
        private const val NOTIFICATION_ID = 42
        private const val PREFS = "playback_widget"
    }

    private lateinit var mediaSession: MediaSession
    private var title = ""
    private var artist = ""
    private var videoId = ""
    private var playing = false
    private var positionMs = 0L
    private var durationMs = 0L
    private var artUrl = ""
    private var artwork: Bitmap? = null
    private var lastWidgetState = ""
    private val artworkExecutor = Executors.newSingleThreadExecutor()
    private val mainHandler = Handler(Looper.getMainLooper())

    override fun onCreate() {
        super.onCreate()
        createNotificationChannel()
        readSavedState()
        mediaSession = MediaSession(this, "GmajnaMusic").apply {
            setCallback(object : MediaSession.Callback() {
                override fun onPlay() = sendControl(ACTION_PLAY)
                override fun onPause() = sendControl(ACTION_PAUSE)
                override fun onSkipToNext() = sendControl(ACTION_NEXT)
                override fun onSkipToPrevious() = sendControl(ACTION_PREVIOUS)
                override fun onStop() = sendControl(ACTION_PAUSE)
            })
            isActive = true
        }
        updateSession()
        if (artUrl.isNotBlank()) loadArtwork(artUrl)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_UPDATE -> {
                title = intent.getStringExtra("title").orEmpty()
                artist = intent.getStringExtra("artist").orEmpty()
                videoId = intent.getStringExtra("videoId").orEmpty()
                positionMs = intent.getLongExtra("positionMs", 0L).coerceAtLeast(0L)
                durationMs = intent.getLongExtra("durationMs", 0L).coerceAtLeast(0L)
                playing = intent.getBooleanExtra("playing", false)
                val nextArtUrl = intent.getStringExtra("artUrl").orEmpty()
                if (nextArtUrl != artUrl) loadArtwork(nextArtUrl)
                saveState()
                updateSession()
            }
            ACTION_PLAY, ACTION_PAUSE, ACTION_NEXT, ACTION_PREVIOUS ->
                sendControl(intent.action!!)
        }
        startForeground(NOTIFICATION_ID, buildNotification())
        return START_NOT_STICKY
    }

    private fun sendControl(action: String) {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString("pendingControl", action)
            .apply()
        val intent = Intent(ACTION_CONTROL)
            .setPackage(packageName)
            .putExtra(EXTRA_CONTROL, action)
        sendBroadcast(intent)
    }

    private fun updateSession() {
        mediaSession.setMetadata(
            MediaMetadata.Builder()
                .putString(MediaMetadata.METADATA_KEY_TITLE, title.ifBlank { "Gmajna Music" })
                .putString(MediaMetadata.METADATA_KEY_ARTIST, artist)
                .putString(MediaMetadata.METADATA_KEY_MEDIA_ID, videoId)
                .putLong(MediaMetadata.METADATA_KEY_DURATION, durationMs)
                .apply {
                    artwork?.let {
                        putBitmap(MediaMetadata.METADATA_KEY_ART, it)
                        putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, it)
                        putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON, it)
                    }
                }
                .build()
        )
        val actions = PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE or
            PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_SKIP_TO_NEXT or
            PlaybackState.ACTION_SKIP_TO_PREVIOUS or PlaybackState.ACTION_STOP
        mediaSession.setPlaybackState(
            PlaybackState.Builder()
                .setActions(actions)
                .setState(
                    if (playing) PlaybackState.STATE_PLAYING else PlaybackState.STATE_PAUSED,
                    positionMs,
                    if (playing) 1f else 0f
                )
                .build()
        )
        val widgetState = listOf(title, artist, playing.toString(), artUrl, (artwork != null).toString())
            .joinToString("\u0000")
        if (widgetState != lastWidgetState) {
            lastWidgetState = widgetState
            GmajnaWidgetProvider.updateAll(this, title, artist, playing, artwork)
        }
    }

    private fun buildNotification(): Notification {
        val previous = servicePendingIntent(ACTION_PREVIOUS, 0)
        val playPause = servicePendingIntent(if (playing) ACTION_PAUSE else ACTION_PLAY, 1)
        val next = servicePendingIntent(ACTION_NEXT, 2)
        val launchApp = PendingIntent.getActivity(
            this,
            3,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return Notification.Builder(this, CHANNEL_ID)
            .setSmallIcon(R.drawable.gmajna_logo)
            .setContentTitle(title.ifBlank { "Gmajna Music" })
            .setContentText(artist.ifBlank { "YouTube Music" })
            .setLargeIcon(artwork)
            .setContentIntent(launchApp)
            .setVisibility(Notification.VISIBILITY_PUBLIC)
            .setOnlyAlertOnce(true)
            .setOngoing(playing)
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_previous, "Prejšnja", previous).build())
            .addAction(
                Notification.Action.Builder(
                    if (playing) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play,
                    if (playing) "Premor" else "Predvajaj",
                    playPause
                ).build()
            )
            .addAction(Notification.Action.Builder(android.R.drawable.ic_media_next, "Naslednja", next).build())
            .setStyle(
                Notification.MediaStyle()
                    .setMediaSession(mediaSession.sessionToken)
                    .setShowActionsInCompactView(0, 1, 2)
            )
            .build()
    }

    private fun servicePendingIntent(action: String, requestCode: Int) =
        PendingIntent.getService(
            this,
            requestCode,
            Intent(this, PlaybackControlService::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

    private fun createNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val channel = NotificationChannel(
            CHANNEL_ID,
            "Predvajanje glasbe",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Kontrole predvajanja Gmajna Music"
            setShowBadge(false)
        }
        getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
    }

    private fun readSavedState() {
        val prefs = getSharedPreferences(PREFS, MODE_PRIVATE)
        title = prefs.getString("title", "").orEmpty()
        artist = prefs.getString("artist", "").orEmpty()
        videoId = prefs.getString("videoId", "").orEmpty()
        playing = prefs.getBoolean("playing", false)
        artUrl = prefs.getString("artUrl", "").orEmpty()
    }

    private fun saveState() {
        getSharedPreferences(PREFS, MODE_PRIVATE).edit()
            .putString("title", title)
            .putString("artist", artist)
            .putString("videoId", videoId)
            .putString("artUrl", artUrl)
            .putBoolean("playing", playing)
            .apply()
    }

    private fun loadArtwork(url: String) {
        artUrl = url
        artwork = null
        if (url.isBlank()) {
            updateSession()
            return
        }
        if (!url.startsWith("https://")) {
            Log.w("GmajnaMusic", "Ignoring non-HTTPS playback artwork URL: $url")
            updateSession()
            return
        }
        artworkExecutor.execute {
            try {
                val connection = URL(url).openConnection().apply {
                    connectTimeout = 5000
                    readTimeout = 5000
                }
                val bitmap = connection.getInputStream().use(BitmapFactory::decodeStream)
                    ?: throw IllegalStateException("Artwork image could not be decoded")
                mainHandler.post {
                    if (artUrl != url) return@post
                    artwork = bitmap
                    updateSession()
                    getSystemService(NotificationManager::class.java)
                        .notify(NOTIFICATION_ID, buildNotification())
                }
            } catch (error: Exception) {
                Log.w("GmajnaMusic", "Could not load playback artwork: $url", error)
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        playing = false
        saveState()
        GmajnaWidgetProvider.updateAll(this, title, artist, playing, artwork)
        mediaSession.isActive = false
        mediaSession.release()
        stopForeground(STOP_FOREGROUND_REMOVE)
        artworkExecutor.shutdownNow()
        super.onDestroy()
    }
}
