package com.gmajna.music

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.widget.RemoteViews

class GmajnaWidgetProvider : AppWidgetProvider() {
    companion object {
        private const val PREFS = "playback_widget"

        fun updateAll(
            context: Context,
            title: String,
            artist: String,
            playing: Boolean,
            artwork: Bitmap?
        ) {
            val manager = AppWidgetManager.getInstance(context)
            val component = ComponentName(context, GmajnaWidgetProvider::class.java)
            val ids = manager.getAppWidgetIds(component)
            if (ids.isNotEmpty()) onUpdateWidgets(context, manager, ids, title, artist, playing, artwork)
        }

        private fun onUpdateWidgets(
            context: Context,
            manager: AppWidgetManager,
            ids: IntArray,
            title: String,
            artist: String,
            playing: Boolean,
            artwork: Bitmap?
        ) {
            ids.forEach { id ->
                val views = RemoteViews(context.packageName, R.layout.gmajna_music_widget).apply {
                    setTextViewText(R.id.widget_title, title.ifBlank { "Gmajna Music" })
                    setTextViewText(R.id.widget_artist, artist.ifBlank { "Predvajanje ni na voljo" })
                    setTextViewText(R.id.widget_play_pause, if (playing) "Ⅱ" else "▶")
                    if (artwork == null) setImageViewResource(R.id.widget_open, R.drawable.gmajna_logo)
                    else setImageViewBitmap(R.id.widget_open, artwork)
                    setOnClickPendingIntent(
                        R.id.widget_previous,
                        widgetAction(context, WidgetControlReceiver.ACTION_PREVIOUS, 0)
                    )
                    setOnClickPendingIntent(
                        R.id.widget_play_pause,
                        widgetAction(context, WidgetControlReceiver.ACTION_PLAY_PAUSE, 1)
                    )
                    setOnClickPendingIntent(
                        R.id.widget_next,
                        widgetAction(context, WidgetControlReceiver.ACTION_NEXT, 2)
                    )
                    setOnClickPendingIntent(
                        R.id.widget_open,
                        PendingIntent.getActivity(
                            context,
                            3,
                            Intent(context, MainActivity::class.java)
                                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                        )
                    )
                }
                manager.updateAppWidget(id, views)
            }
        }

        private fun widgetAction(context: Context, action: String, requestCode: Int): PendingIntent {
            val intent = Intent(context, WidgetControlReceiver::class.java).setAction(action)
            return PendingIntent.getBroadcast(
                context,
                requestCode,
                intent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
            )
        }
    }

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val title = prefs.getString("title", "").orEmpty()
        val artist = prefs.getString("artist", "").orEmpty()
        val playing = prefs.getBoolean("playing", false)
        ids.forEach { id ->
            val views = RemoteViews(context.packageName, R.layout.gmajna_music_widget).apply {
                setTextViewText(R.id.widget_title, title.ifBlank { "Gmajna Music" })
                setTextViewText(R.id.widget_artist, artist.ifBlank { "Odpri aplikacijo za predvajanje" })
                setTextViewText(R.id.widget_play_pause, if (playing) "Ⅱ" else "▶")
                setImageViewResource(R.id.widget_open, R.drawable.gmajna_logo)
                setOnClickPendingIntent(R.id.widget_previous, widgetAction(context, WidgetControlReceiver.ACTION_PREVIOUS, 0))
                setOnClickPendingIntent(R.id.widget_play_pause, widgetAction(context, WidgetControlReceiver.ACTION_PLAY_PAUSE, 1))
                setOnClickPendingIntent(R.id.widget_next, widgetAction(context, WidgetControlReceiver.ACTION_NEXT, 2))
                setOnClickPendingIntent(
                    R.id.widget_open,
                    PendingIntent.getActivity(
                        context,
                        3,
                        Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
                        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                    )
                )
            }
            manager.updateAppWidget(id, views)
        }
    }

}
