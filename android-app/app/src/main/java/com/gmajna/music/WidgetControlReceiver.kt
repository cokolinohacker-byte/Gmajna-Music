package com.gmajna.music

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

class WidgetControlReceiver : BroadcastReceiver() {
    companion object {
        const val ACTION_PLAY_PAUSE = "com.gmajna.music.widget.PLAY_PAUSE"
        const val ACTION_PREVIOUS = "com.gmajna.music.widget.PREVIOUS"
        const val ACTION_NEXT = "com.gmajna.music.widget.NEXT"
        private const val PREFS = "playback_widget"
    }

    override fun onReceive(context: Context, intent: Intent) {
        val action = when (intent.action) {
            ACTION_PREVIOUS -> PlaybackControlService.ACTION_PREVIOUS
            ACTION_PLAY_PAUSE -> {
                val playing = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getBoolean("playing", false)
                if (playing) PlaybackControlService.ACTION_PAUSE else PlaybackControlService.ACTION_PLAY
            }
            ACTION_NEXT -> PlaybackControlService.ACTION_NEXT
            else -> return
        }
        context.startForegroundService(
            Intent(context, PlaybackControlService::class.java).setAction(action)
        )
    }
}
