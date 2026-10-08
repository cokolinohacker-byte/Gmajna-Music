package com.gmajna.music

import android.annotation.SuppressLint
import android.Manifest
import android.app.AlertDialog
import android.content.BroadcastReceiver
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import io.socket.client.IO
import io.socket.client.Socket
import io.socket.emitter.Emitter
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayInputStream
import java.net.URI
import java.util.UUID

class MainActivity : android.app.Activity() {
    companion object {
        private const val SERVER = "https://gmajna-server.onrender.com"
        private const val GOLD = 0xFFF5A900.toInt()
        private const val RED = 0xFFFF1744.toInt()
        private const val BACKGROUND = 0xFF0D0D12.toInt()
        private const val PANEL = 0xFF191713.toInt()
    }

    private val handler = Handler(Looper.getMainLooper())
    private lateinit var webView: WebView
    private lateinit var songLine: TextView
    private lateinit var jamStateLine: TextView
    private lateinit var peerLine: TextView
    private lateinit var roomLine: TextView
    private lateinit var nowPlayingLine: TextView
    private lateinit var joinInput: EditText
    private var jamDialog: AlertDialog? = null
    private var socket: Socket? = null
    private var activeRoom = ""
    private var hostToken = ""
    private var peerId = ""
    private var hostId = ""
    private var isHost = false
    private var controlAllowed = false
    private var remoteUpdate = false
    private var inviteUrl = ""
    private var currentId = ""
    private var currentTitle = ""
    private var currentArtist = ""
    private var currentArt = ""
    private var lastPlaying: Boolean? = null
    private var lastPlaybackServiceState = ""
    private var pendingMediaAction = ""
    private var shouldPlay = false
    private val peers = linkedMapOf<String, String>()
    private val mediaControlReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            val action = intent.getStringExtra(PlaybackControlService.EXTRA_CONTROL).orEmpty()
            if (action.isNotBlank()) {
                getSharedPreferences("playback_widget", Context.MODE_PRIVATE).edit()
                    .remove("pendingControl")
                    .apply()
                pendingMediaAction = action
            }
        }
    }

    private val playerPoll = object : Runnable {
        override fun run() {
            readPlayerState()
            handler.postDelayed(this, 600)
        }
    }

    private val presencePoll = object : Runnable {
        override fun run() {
            emitPresence()
            handler.postDelayed(this, 1000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.statusBarColor = Color.rgb(9, 9, 9)
        window.navigationBarColor = Color.rgb(9, 9, 9)
        peerId = getPreferences(Context.MODE_PRIVATE).getString("peerId", null) ?: UUID.randomUUID().toString().also {
            getPreferences(Context.MODE_PRIVATE).edit().putString("peerId", it).apply()
        }
        val filter = IntentFilter(PlaybackControlService.ACTION_CONTROL)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(mediaControlReceiver, filter, Context.RECEIVER_NOT_EXPORTED)
        } else {
            @Suppress("DEPRECATION")
            registerReceiver(mediaControlReceiver, filter)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 1001)
        }
        buildScreen()
        openInvite(intent?.data)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildScreen() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(BACKGROUND)
            setOnApplyWindowInsetsListener { view, insets ->
                var top = 0
                var bottom = 0
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    val systemBars = insets.getInsets(android.view.WindowInsets.Type.systemBars())
                    top = systemBars.top
                    bottom = systemBars.bottom
                } else {
                    @Suppress("DEPRECATION")
                    val topInset = insets.systemWindowInsetTop
                    @Suppress("DEPRECATION")
                    val bottomInset = insets.systemWindowInsetBottom
                    top = topInset
                    bottom = bottomInset
                }
                view.setPadding(view.paddingLeft, top, view.paddingRight, bottom)
                insets
            }
        }

        val toolbar = LinearLayout(this).apply {
            gravity = Gravity.CENTER_VERTICAL
            orientation = LinearLayout.HORIZONTAL
            setPadding(dp(12), dp(6), dp(12), dp(6))
            background = GradientDrawable(
                GradientDrawable.Orientation.LEFT_RIGHT,
                intArrayOf(0xFF15120D.toInt(), 0xFF0B0B0B.toInt())
            )
        }
        val logo = ImageView(this).apply {
            setImageResource(R.drawable.gmajna_logo)
            scaleType = ImageView.ScaleType.CENTER_CROP
            background = rounded(GOLD, 18)
            clipToOutline = true
        }
        toolbar.addView(logo, LinearLayout.LayoutParams(dp(38), dp(38)))
        toolbar.addView(TextView(this).apply {
            text = "Gmajna Music"
            setTextColor(Color.WHITE)
            textSize = 16f
            setTypeface(typeface, Typeface.BOLD)
            setPadding(dp(10), 0, 0, 0)
        }, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        toolbar.addView(Button(this).apply {
            text = "JAM"
            setTextColor(Color.BLACK)
            textSize = 13f
            setTypeface(typeface, Typeface.BOLD)
            background = rounded(GOLD, 22)
            setOnClickListener { showJamDialog() }
        }, LinearLayout.LayoutParams(dp(76), dp(42)))
        root.addView(toolbar, LinearLayout.LayoutParams.MATCH_PARENT, dp(54))

        songLine = TextView(this).apply {
            text = "Odpiram YouTube Music …"
            setTextColor(0xFFD5C7A8.toInt())
            textSize = 12f
            maxLines = 1
            ellipsize = android.text.TextUtils.TruncateAt.END
            setPadding(dp(12), dp(5), dp(12), dp(5))
            setBackgroundColor(0xFF100F0D.toInt())
        }
        root.addView(songLine, LinearLayout.LayoutParams.MATCH_PARENT, dp(30))

        webView = WebView(this).apply {
            setBackgroundColor(BACKGROUND)
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.databaseEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
            settings.userAgentString = settings.userAgentString.replace("; wv", "")
            CookieManager.getInstance().setAcceptCookie(true)
            CookieManager.getInstance().setAcceptThirdPartyCookies(this, true)
            webChromeClient = WebChromeClient()
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                    val uri = request.url
                    if (uri.scheme == "gmajna" && uri.host == "join") {
                        openInvite(uri)
                        return true
                    }
                    return uri.scheme != "https" && uri.scheme != "http"
                }

                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    if (isKnownAdRequest(request.url)) {
                        return WebResourceResponse(
                            "text/plain",
                            "utf-8",
                            204,
                            "No Content",
                            emptyMap(),
                            ByteArrayInputStream(ByteArray(0))
                        )
                    }
                    return super.shouldInterceptRequest(view, request)
                }

                override fun onPageFinished(view: WebView, url: String) {
                    super.onPageFinished(view, url)
                    injectPlayerHelpers()
                }
            }
            loadUrl("https://music.youtube.com")
        }
        root.addView(webView, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            0,
            1f
        ))
        setContentView(root)
        root.requestApplyInsets()
        handler.post(playerPoll)
    }

    private fun isKnownAdRequest(uri: Uri): Boolean {
        val host = uri.host?.lowercase() ?: return false
        val adHosts = listOf(
            "doubleclick.net",
            "googlesyndication.com",
            "googleadservices.com",
            "adservice.google.com",
            "ads.youtube.com"
        )
        if (adHosts.any { host == it || host.endsWith(".$it") }) return true
        val path = uri.path.orEmpty().lowercase()
        return host == "music.youtube.com" && (
            path.startsWith("/pagead/") || path.startsWith("/api/stats/ads")
        )
    }

    private fun injectPlayerHelpers() {
        webView.evaluateJavascript(
            """
            (function(){
              function applyBrandingStyle(root){
                try{
                  if(!root||root.querySelector('#gmajna-android-branding'))return;
                  var style=document.createElement('style');
                  style.id='gmajna-android-branding';
                  style.textContent='ytmusic-logo,.ytmusic-logo,#logo.ytmusic-logo{display:none!important}';
                  root.appendChild(style);
                }catch(e){}
              }
              function scanShadowRoots(){
                try{
                  var roots=[document],seen=new Set();
                  while(roots.length){
                    var root=roots.pop();
                    if(!root||seen.has(root))continue;
                    seen.add(root);
                    applyBrandingStyle(root);
                    root.querySelectorAll('*').forEach(function(node){
                      if(node.shadowRoot)roots.push(node.shadowRoot);
                    });
                  }
                }catch(e){}
              }
              scanShadowRoots();
              if(!window.__gmajnaBrandingCheck)
                window.__gmajnaBrandingCheck=setInterval(scanShadowRoots,2000);
              if(!window.__gmajnaAdCheck)window.__gmajnaAdCheck=setInterval(function(){
                try{
                  var player=document.querySelector('#movie_player,.html5-video-player');
                  var video=document.querySelector('video');
                  var ad=!!document.querySelector('.ad-showing,.ad-interrupting')
                    ||!!(player&&player.classList.contains('ad-showing'));
                  if(!ad)return;
                  var skip=document.querySelector('.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern');
                  if(skip)skip.click();
                  if(video&&isFinite(video.duration)&&video.duration>0&&video.duration<180)
                    video.currentTime=video.duration;
                }catch(e){}
              },500);
            })();
            """.trimIndent(),
            null
        )
    }

    private fun showJamDialog() {
        if (jamDialog?.isShowing == true) return
        val content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(20), dp(18), dp(20), dp(12))
            setBackgroundColor(PANEL)
        }
        content.addView(TextView(this).apply {
            text = "Gmajna Jam"
            setTextColor(Color.WHITE)
            textSize = 21f
            setTypeface(typeface, Typeface.BOLD)
        })
        jamStateLine = dialogText("Ni povezano")
        roomLine = dialogText("Jam: ni povezan")
        peerLine = dialogText("Čakamo na poslušalce …")
        content.addView(jamStateLine)
        content.addView(roomLine)
        content.addView(peerLine)
        nowPlayingLine = dialogText("Zdaj se predvaja: ${currentTitle.ifBlank { "nič" }}")
        content.addView(nowPlayingLine)

        val createButton = actionButton("Ustvari Jam") { createJam() }
        val inviteButton = actionButton("Kopiraj povezavo") { copyInvite() }
        joinInput = EditText(this).apply {
            hint = "Prilepi povezavo ali kodo Jama"
            setHintTextColor(0xFFAAA391.toInt())
            setTextColor(Color.WHITE)
            textSize = 14f
            setSingleLine(true)
            setPadding(dp(12), 0, dp(12), 0)
            background = rounded(0xFF29251C.toInt(), 10)
        }
        content.addView(createButton)
        content.addView(inviteButton)
        content.addView(joinInput, LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(48)
        ))
        content.addView(actionButton("Pridruži se Jamu") { joinJam(joinInput.text.toString().trim()) })
        content.addView(actionButton("Dovoli / ustavi upravljanje gostom") { toggleGuestControl() })
        content.addView(actionButton("Zapusti / zapri Jam") { leaveJam(notifyHost = isHost) })

        val scroll = ScrollView(this).apply { addView(content) }
        jamDialog = AlertDialog.Builder(this)
            .setView(scroll)
            .setNegativeButton("Zapri", null)
            .create()
        jamDialog?.window?.setBackgroundDrawableResource(android.R.color.transparent)
        jamDialog?.show()
        jamDialog?.window?.setLayout((resources.displayMetrics.widthPixels * 0.92f).toInt(), -2)
        refreshJamUi()
    }

    private fun dialogText(value: String) = TextView(this).apply {
        text = value
        setTextColor(0xFFE3DCCB.toInt())
        textSize = 13f
        setPadding(0, dp(8), 0, dp(4))
    }

    private fun actionButton(label: String, action: () -> Unit) = Button(this).apply {
        text = label
        setTextColor(Color.WHITE)
        textSize = 13f
        isAllCaps = false
        background = rounded(0xFF302615.toInt(), 10, GOLD)
        setOnClickListener { action() }
        layoutParams = LinearLayout.LayoutParams(
            LinearLayout.LayoutParams.MATCH_PARENT,
            dp(48)
        )
        setPadding(dp(8), 0, dp(8), 0)
    }

    private fun createJam() {
        leaveJam(notifyHost = false)
        activeRoom = UUID.randomUUID().toString().replace("-", "").take(12)
        hostToken = UUID.randomUUID().toString()
        isHost = true
        controlAllowed = true
        inviteUrl = "$SERVER/j/$activeRoom"
        connectToJam()
    }

    private fun joinJam(raw: String) {
        if (raw.isBlank()) {
            toast("Vnesi kodo ali povabilno povezavo")
            return
        }
        val room = parseRoom(raw)
        if (room.isBlank()) {
            toast("Povezave ali kode Jama ni mogoče prebrati")
            return
        }
        leaveJam(notifyHost = false)
        activeRoom = room
        isHost = false
        controlAllowed = false
        hostToken = ""
        inviteUrl = ""
        connectToJam()
    }

    private fun parseRoom(value: String): String {
        val room = try {
            val uri = Uri.parse(value)
            when {
                uri.scheme == "gmajna" && uri.host == "join" -> uri.getQueryParameter("room").orEmpty()
                uri.scheme == "https" && uri.host == Uri.parse(SERVER).host && uri.pathSegments.firstOrNull() == "j" ->
                    uri.pathSegments.getOrNull(1).orEmpty()
                uri.scheme == "https" && uri.host == Uri.parse(SERVER).host ->
                    uri.getQueryParameter("room").orEmpty()
                else -> value
            }
        } catch (_: Exception) {
            value
        }
        return room.takeIf { it.matches(Regex("[\\w-]{1,100}")) }.orEmpty()
    }

    private fun connectToJam() {
        try {
            val options = IO.Options.builder()
                .setReconnection(true)
                .setReconnectionAttempts(Int.MAX_VALUE)
                .build()
            socket = IO.socket(URI.create(SERVER), options)
            socket?.on(Socket.EVENT_CONNECT, Emitter.Listener {
                val activeSocket = socket ?: return@Listener
                activeSocket.emit("join", activeRoom)
                val registration = JSONObject()
                    .put("peerId", peerId)
                    .put("name", if (isHost) "Gostitelj" else "Poslušalec")
                    .put("wantsHost", isHost)
                if (isHost) registration.put("hostToken", hostToken)
                activeSocket.emit("jam:register", registration)
                if (isHost) activeSocket.emit("jam:control", JSONObject().put("enabled", controlAllowed))
                runOnUiThread {
                    handler.removeCallbacks(presencePoll)
                    handler.post(presencePoll)
                    refreshJamUi()
                }
            })
            socket?.on("jam:state", onJamState)
            socket?.on("jam:error", onJamError)
            socket?.on("jam:ended", onJamEnded)
            socket?.on("sync", onSync)
            socket?.on(Socket.EVENT_DISCONNECT, Emitter.Listener {
                runOnUiThread {
                    jamStateLineOrToast("Povezava z Jamom je prekinjena")
                }
            })
            socket?.connect()
            refreshJamUi()
        } catch (error: Exception) {
            toast("Povezava z Jamom ni uspela: ${error.localizedMessage.orEmpty()}")
        }
    }

    private val onJamState = Emitter.Listener { args ->
        val state = args.firstOrNull() as? JSONObject ?: return@Listener
        runOnUiThread {
            hostId = state.optString("hostId")
            controlAllowed = state.optBoolean("controlAllowed")
            peers.clear()
            val members = state.optJSONArray("members")
            if (members != null) for (index in 0 until members.length()) {
                val member = members.optJSONObject(index) ?: continue
                val id = member.optString("peerId")
                if (id.isNotBlank()) peers[id] = member.optString("name", "Poslušalec")
            }
            refreshJamUi()
        }
    }

    private val onJamError = Emitter.Listener { args ->
        val message = args.firstOrNull()?.toString() ?: "V Jamu je prišlo do napake"
        runOnUiThread { toast(message) }
    }

    private val onJamEnded = Emitter.Listener {
        runOnUiThread {
            leaveJam(notifyHost = false)
            toast("Gostitelj je zaključil Jam")
        }
    }

    private val onSync = Emitter.Listener { args ->
        val packet = args.firstOrNull() as? JSONObject ?: return@Listener
        if (packet.optString("peerId") == peerId) return@Listener
        val action = packet.optString("a")
        if (action == "close" && (packet.optString("peerId") == hostId || packet.optBoolean("isHost"))) {
            runOnUiThread {
                leaveJam(notifyHost = false)
                toast("Gostitelj je zaključil Jam")
            }
            return@Listener
        }
        if (action == "presence") {
            val peer = packet.optString("peerId")
            if (packet.optBoolean("isHost") && peer.isNotBlank()) {
                if (hostId.isNotBlank() && hostId != peer) return@Listener
                hostId = peer
                controlAllowed = packet.optBoolean("controlAllowed")
                runOnUiThread { refreshJamUi() }
            }
            updatePeer(packet)
            if (packet.optString("peerId") == hostId && !isHost) applyRemote(packet)
            return@Listener
        }
        val sender = packet.optString("peerId")
        if (sender != hostId && !(controlAllowed && peers.containsKey(sender))) return@Listener
        applyRemote(packet)
    }

    private fun updatePeer(packet: JSONObject) {
        val id = packet.optString("peerId")
        if (id.isBlank()) return
        synchronized(peers) {
            peers[id] = packet.optString("name", "Poslušalec")
        }
        runOnUiThread { refreshJamUi() }
    }

    private fun applyRemote(packet: JSONObject) {
        val id = packet.optString("id")
        val action = packet.optString("a")
        val time = packet.optDouble("t", -1.0)
        val playing = packet.optBoolean("playing", action == "play")
        remoteUpdate = true
        shouldPlay = playing
        if (id.matches(Regex("[\\w-]{11}")) && id != currentId) {
            currentId = id
            val title = JSONObject.quote(packet.optString("title"))
            val artist = JSONObject.quote(packet.optString("artist"))
            webView.evaluateJavascript(
                """
                (function(){
                  var p=document.getElementById('movie_player');
                  if(p&&p.loadVideoById)p.loadVideoById('$id');
                  else location.href='https://music.youtube.com/watch?v=$id';
                  window.__gmajnaRemote={title:$title,artist:$artist,time:$time,playing:$playing};
                })()
                """.trimIndent(), null
            )
        } else {
            val safeTime = if (time >= 0) time else 0
            webView.evaluateJavascript(
                """
                (function(){
                  var v=document.querySelector('video');
                  if(!v)return;
                  var t=$safeTime;
                  if(isFinite(t)&&Math.abs(v.currentTime-t)>0.8)v.currentTime=t;
                  if($playing&&!v.paused)v.play().catch(function(){});
                  else if($playing&&v.paused)v.play().catch(function(){});
                  else if(!$playing&&!v.paused)v.pause();
                })()
                """.trimIndent(), null
            )
        }
        handler.postDelayed({ remoteUpdate = false }, 900)
    }

    private fun readPlayerState() {
        if (!::webView.isInitialized) return
        webView.evaluateJavascript(
            """
            (function(){
              var p=document.getElementById('movie_player');
              var v=document.querySelector('video');
              var d=p&&p.getVideoData?p.getVideoData():{};
              return JSON.stringify({
                id:(d&&d.video_id)||new URLSearchParams(location.search).get('v')||'',
                title:(d&&d.title)||'',
                artist:(d&&d.author)||'',
                art:(d&&d.thumbnail_url)||'',
                time:v?v.currentTime:0,
                playing:v?!v.paused:false
              });
            })()
            """.trimIndent()
        ) { result ->
            try {
                val jsonString = JSONTokener(result).nextValue().toString()
                val player = JSONObject(jsonString)
                val id = player.optString("id")
                if (id.matches(Regex("[\\w-]{11}"))) {
                    val changedTrack = currentId.isNotBlank() && currentId != id
                    currentId = id
                    currentTitle = player.optString("title")
                    currentArtist = player.optString("artist")
                    currentArt = player.optString("art")
                    songLine.text = listOf(currentTitle, currentArtist).filter { it.isNotBlank() }.joinToString(" · ")
                    if (pendingMediaAction.isNotBlank()) {
                        val action = pendingMediaAction
                        pendingMediaAction = ""
                        runMediaAction(action)
                    } else {
                        val savedAction = getSharedPreferences("playback_widget", Context.MODE_PRIVATE)
                            .getString("pendingControl", "")
                            .orEmpty()
                        if (savedAction.isNotBlank()) {
                            getSharedPreferences("playback_widget", Context.MODE_PRIVATE).edit()
                                .remove("pendingControl")
                                .apply()
                            runMediaAction(savedAction)
                        }
                    }
                    if (changedTrack && !remoteUpdate) {
                        emitSync(JSONObject()
                            .put("a", "track")
                            .put("id", id)
                            .put("title", currentTitle)
                            .put("artist", currentArtist)
                            .put("art", currentArt))
                    }
                }
                val playing = player.optBoolean("playing")
                syncPlaybackControls(playing)
                if (lastPlaying != null && lastPlaying != playing && !remoteUpdate) {
                    emitSync(JSONObject()
                        .put("a", if (playing) "play" else "pause")
                        .put("id", currentId)
                        .put("t", player.optDouble("time"))
                        .put("playing", playing)
                        .put("title", currentTitle)
                        .put("artist", currentArtist)
                        .put("art", currentArt))
                }
                lastPlaying = playing
            } catch (error: Exception) {
                android.util.Log.w("GmajnaMusic", "Player state read failed", error)
            }
        }
    }

    private fun syncPlaybackControls(playing: Boolean) {
        if (currentId.isBlank()) return
        val state = listOf(currentId, currentTitle, currentArtist, playing.toString()).joinToString("\u0000")
        if (state == lastPlaybackServiceState) return
        lastPlaybackServiceState = state
        val serviceIntent = Intent(this, PlaybackControlService::class.java)
            .setAction(PlaybackControlService.ACTION_UPDATE)
            .putExtra("videoId", currentId)
            .putExtra("title", currentTitle)
            .putExtra("artist", currentArtist)
            .putExtra("playing", playing)
        startForegroundService(serviceIntent)
    }

    private fun runMediaAction(action: String) {
        if (!::webView.isInitialized || webView.url.isNullOrBlank()) {
            pendingMediaAction = action
            return
        }
        val script = when (action) {
            PlaybackControlService.ACTION_PLAY -> """
                (function(){var v=document.querySelector('video');if(v&&v.paused)v.play().catch(function(){});})()
            """.trimIndent()
            PlaybackControlService.ACTION_PAUSE -> """
                (function(){var v=document.querySelector('video');if(v&&!v.paused)v.pause();})()
            """.trimIndent()
            PlaybackControlService.ACTION_NEXT -> """
                (function(){
                  var p=document.getElementById('movie_player');
                  if(p&&typeof p.nextVideo==='function'){p.nextVideo();return;}
                  var roots=[document],b=null;
                  while(roots.length&&!b){
                    var root=roots.pop();
                    b=root.querySelector('#next-button button,#next-button');
                    if(!b)root.querySelectorAll('*').forEach(function(n){if(n.shadowRoot)roots.push(n.shadowRoot);});
                  }
                  if(b)b.click();
                })()
            """.trimIndent()
            PlaybackControlService.ACTION_PREVIOUS -> """
                (function(){
                  var p=document.getElementById('movie_player');
                  if(p&&typeof p.previousVideo==='function'){p.previousVideo();return;}
                  var roots=[document],b=null;
                  while(roots.length&&!b){
                    var root=roots.pop();
                    b=root.querySelector('#previous-button button,#previous-button');
                    if(!b)root.querySelectorAll('*').forEach(function(n){if(n.shadowRoot)roots.push(n.shadowRoot);});
                  }
                  if(b)b.click();
                })()
            """.trimIndent()
            else -> return
        }
        webView.evaluateJavascript(script, null)
    }

    private fun emitPresence() {
        val activeSocket = socket ?: return
        if (!activeSocket.connected()) return
        val playing = lastPlaying == true
        val packet = JSONObject()
            .put("a", "presence")
            .put("peerId", peerId)
            .put("name", if (isHost) "Gostitelj" else "Poslušalec")
            .put("isHost", isHost)
            .put("hostId", hostId)
            .put("controlAllowed", controlAllowed)
            .put("playing", playing)
            .put("title", currentTitle)
            .put("artist", currentArtist)
            .put("art", currentArt)
        if (currentId.matches(Regex("[\\w-]{11}"))) packet.put("id", currentId)
        webView.evaluateJavascript(
            "(function(){var v=document.querySelector('video');return v?v.currentTime:0})()"
        ) { time ->
            packet.put("t", time.toDoubleOrNull() ?: 0.0)
            activeSocket.emit("sync", packet)
        }
    }

    private fun emitSync(packet: JSONObject) {
        val activeSocket = socket ?: return
        if (!activeSocket.connected() || remoteUpdate) return
        if (!isHost && !controlAllowed) return
        packet.put("peerId", peerId)
        packet.put("hostId", hostId)
        packet.put("isHost", isHost)
        activeSocket.emit("sync", packet)
    }

    private fun toggleGuestControl() {
        if (!isHost) {
            toast("To lahko spremeni samo gostitelj")
            return
        }
        controlAllowed = !controlAllowed
        socket?.emit("jam:control", JSONObject().put("enabled", controlAllowed))
        refreshJamUi()
    }

    private fun copyInvite() {
        if (inviteUrl.isBlank()) {
            toast("Povezavo lahko kopira samo gostitelj")
            return
        }
        val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        clipboard.setPrimaryClip(ClipData.newPlainText("Gmajna Jam", inviteUrl))
        toast("Povabilna povezava je kopirana")
    }

    private fun leaveJam(notifyHost: Boolean) {
        val activeSocket = socket
        if (notifyHost && isHost && activeSocket?.connected() == true) {
            activeSocket.emit("jam:close")
            activeSocket.emit("sync", JSONObject().put("a", "close").put("peerId", peerId).put("isHost", true))
        }
        handler.removeCallbacks(presencePoll)
        socket = null
        activeSocket?.disconnect()
        activeSocket?.close()
        activeRoom = ""
        hostToken = ""
        hostId = ""
        isHost = false
        controlAllowed = false
        inviteUrl = ""
        peers.clear()
        refreshJamUi()
    }

    private fun refreshJamUi() {
        if (!::jamStateLine.isInitialized || jamDialog?.isShowing != true) return
        jamStateLine.text = when {
            socket?.connected() == true -> if (isHost) "Povezano kot gostitelj" else "Povezano kot poslušalec"
            activeRoom.isNotBlank() -> "Povezovanje z Jamom …"
            else -> "Ni povezano"
        }
        roomLine.text = if (activeRoom.isBlank()) "Jam: ni povezan" else "Jam: $activeRoom"
        peerLine.text = if (peers.isEmpty()) "Čakamo na poslušalce …" else
            peers.entries.joinToString("  ·  ") { (id, name) -> if (id == hostId) "$name (host)" else name }
        if (::nowPlayingLine.isInitialized) {
            nowPlayingLine.text = "Zdaj se predvaja: ${currentTitle.ifBlank { "nič" }}"
        }
    }

    private fun jamStateLineOrToast(message: String) {
        if (::jamStateLine.isInitialized && jamDialog?.isShowing == true) jamStateLine.text = message
        else toast(message)
    }

    private fun openInvite(uri: Uri?) {
        if (uri == null || uri.scheme != "gmajna" || uri.host != "join") return
        val server = uri.getQueryParameter("server")
        if (server != null && server != SERVER) {
            toast("Povabilo uporablja neznan Jam strežnik")
            return
        }
        val room = uri.getQueryParameter("room").orEmpty()
        if (room.matches(Regex("[\\w-]{1,100}"))) {
            showJamDialog()
            joinInput.setText(room)
            joinJam(room)
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        openInvite(intent.data)
    }

    override fun onBackPressed() {
        if (::webView.isInitialized && webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    override fun onDestroy() {
        handler.removeCallbacks(playerPoll)
        handler.removeCallbacks(presencePoll)
        unregisterReceiver(mediaControlReceiver)
        if (isFinishing) stopService(Intent(this, PlaybackControlService::class.java))
        leaveJam(notifyHost = false)
        if (::webView.isInitialized) {
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    private fun toast(message: String) {
        Toast.makeText(this, message, Toast.LENGTH_SHORT).show()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()

    private fun rounded(color: Int, radius: Int, stroke: Int? = null) =
        GradientDrawable().apply {
            setColor(color)
            cornerRadius = dp(radius).toFloat()
            if (stroke != null) setStroke(dp(1), stroke)
        }
}
