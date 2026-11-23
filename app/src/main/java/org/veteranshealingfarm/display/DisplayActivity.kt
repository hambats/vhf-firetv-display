package org.veteranshealingfarm.display

import android.annotation.SuppressLint
import android.annotation.TargetApi
import android.content.Context
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.appcompat.app.AppCompatActivity

/**
 * The appliance shell.
 *
 * One fullscreen WebView pointed at the published site. The page itself owns the
 * scene engine, caching (Service Worker) and content refresh — see docs/ARCHITECTURE.md.
 * This activity owns only the things a web page cannot do for itself:
 *
 *  - the screen never sleeps (FLAG_KEEP_SCREEN_ON, plus the TV's own sleep setting)
 *  - no system chrome, ever (immersive sticky, re-asserted on every focus change)
 *  - the page comes back after a network outage or an HTTP error (retry with backoff,
 *    offline card in between)
 *  - the page comes back after a stall (watchdog + reload)
 *  - a renderer crash or OOM kill does not take the app down: the dead WebView is replaced
 *    in place, inside this activity — immediately if it is in front, otherwise the next time
 *    it is resumed. Nothing here ever brings the activity forward.
 *  - the remote cannot navigate away from the display
 */
class DisplayActivity : AppCompatActivity() {

    private lateinit var container: FrameLayout

    /** Null only between a renderer death and the rebuild that replaces it. */
    private var webView: WebView? = null
    private val handler = Handler(Looper.getMainLooper())

    /** Wall-clock of the last real load of the published site; 0 until the first one lands. */
    private var lastGoodLoadAt = 0L

    /** Consecutive failed load attempts, used for the retry backoff. */
    private var failureStreak = 0

    /** True between a load starting and that same load either finishing or failing. */
    private var loadInFlight = false

    private var loadStartedAt = 0L

    /**
     * Set by a main-frame failure (network error or HTTP status >= 400) and consumed by the
     * next onPageFinished for the published site, so an error page never counts as a good
     * load. WebView can report the error before onPageStarted, so onPageStarted cannot clear it.
     */
    private var mainFrameFailed = false

    private var resumed = false

    /** elapsedRealtime of each renderer rebuild within the last REBUILD_WINDOW_MS. */
    private val rendererRebuilds = ArrayDeque<Long>()

    private val displayUrl: String by lazy { getString(R.string.display_url) }
    private val displayHost: String by lazy { Uri.parse(displayUrl).host.orEmpty() }

    private val retryLoad = Runnable { loadDisplay() }
    private val rebuildWebView = Runnable { rebuildWebViewIfAllowed() }

    /**
     * Fires every WATCHDOG_INTERVAL_MS. Reloads if a load has been in flight too long
     * (a stalled request that never errors) or if nothing has loaded successfully at all.
     */
    private val watchdog = object : Runnable {
        override fun run() {
            val now = SystemClock.elapsedRealtime()
            val stalled = loadInFlight && now - loadStartedAt > LOAD_TIMEOUT_MS
            val neverLoaded = lastGoodLoadAt == 0L && !loadInFlight
            if (webView != null && (stalled || neverLoaded)) {
                Log.w(TAG, "watchdog reload (stalled=$stalled neverLoaded=$neverLoaded)")
                loadDisplay()
            }
            handler.postDelayed(this, WATCHDOG_INTERVAL_MS)
        }
    }

    private val client = object : WebViewClient() {

        override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
            super.onPageStarted(view, url, favicon)
            if (view !== webView) return
            loadInFlight = true
            loadStartedAt = SystemClock.elapsedRealtime()
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            super.onPageFinished(view, url)
            if (view !== webView) return
            loadInFlight = false
            // Only the published site counts: not the offline card (file:), not data: URLs,
            // not an error page standing in for the site.
            if (isPublishedSite(url)) {
                if (mainFrameFailed) {
                    Log.w(TAG, "load of the site ended on an error page; not counting it")
                } else {
                    lastGoodLoadAt = System.currentTimeMillis()
                    failureStreak = 0
                }
                mainFrameFailed = false
            }
            hideSystemUi()
        }

        override fun onReceivedError(
            view: WebView?,
            request: WebResourceRequest?,
            error: WebResourceError?
        ) {
            // No super: on API 23+ it forwards main-frame errors to the deprecated overload
            // below, which would count every failure twice.
            // Sub-resource failures are the page's problem, not ours.
            if (request?.isForMainFrame != true) return
            // A navigation we cancelled ourselves (offline card <-> retry) is not a failure.
            if (error?.description?.contains("ERR_ABORTED") == true) return
            onMainFrameFailed(view, request.url?.toString(), "error ${error?.errorCode} ${error?.description}")
        }

        @Suppress("DEPRECATION")
        override fun onReceivedError(
            view: WebView?,
            errorCode: Int,
            description: String?,
            failingUrl: String?
        ) {
            // Pre-API-23 path only; newer releases report through the overload above.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) return
            onMainFrameFailed(view, failingUrl, "error $errorCode $description")
        }

        override fun onReceivedHttpError(
            view: WebView?,
            request: WebResourceRequest?,
            errorResponse: WebResourceResponse?
        ) {
            super.onReceivedHttpError(view, request, errorResponse)
            // e.g. GitHub Pages answering 404/5xx: the page (and its own watchdog) never runs.
            if (request?.isForMainFrame != true) return
            onMainFrameFailed(view, request.url?.toString(), "HTTP ${errorResponse?.statusCode}")
        }

        @TargetApi(Build.VERSION_CODES.O)
        override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
            // Returning true is what keeps the process alive; the default (false) kills the app.
            onRendererGone(view, detail?.didCrash() == true)
            return true
        }

        override fun shouldOverrideUrlLoading(
            view: WebView?,
            request: WebResourceRequest?
        ): Boolean {
            val host = request?.url?.host.orEmpty()
            return host != displayHost
        }

        @Suppress("DEPRECATION")
        override fun shouldOverrideUrlLoading(view: WebView?, url: String?): Boolean {
            return Uri.parse(url ?: "").host.orEmpty() != displayHost
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        window.addFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
        hideSystemUi()

        container = FrameLayout(this)
        setContentView(container)
        webView = buildWebView()

        loadDisplay()
        handler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS)

        // Optional and off by default; see MeshBridgeService and docs/MESH_BRIDGE.md.
        // Never throws, and the bridge runs in its own process.
        MeshConfig.startIfEnabled(this)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val view = WebView(this)
        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        // Nothing on this display is interactive; keep focus and the D-pad out of the page.
        view.isFocusable = false
        view.isFocusableInTouchMode = false
        view.isHorizontalScrollBarEnabled = false
        view.isVerticalScrollBarEnabled = false
        view.setOnLongClickListener { true }
        view.webViewClient = client

        container.addView(
            view,
            FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
        )
        return view
    }

    private fun isPublishedSite(url: String?): Boolean {
        if (url == null) return false
        val uri = Uri.parse(url)
        return (uri.scheme == "https" || uri.scheme == "http") && uri.host == displayHost
    }

    private fun loadDisplay() {
        handler.removeCallbacks(retryLoad)
        val view = webView ?: return
        mainFrameFailed = false
        loadStartedAt = SystemClock.elapsedRealtime()
        loadInFlight = true
        view.loadUrl(displayUrl)
    }

    /** Only failures of the published site count; never the offline card's own file: load. */
    private fun onMainFrameFailed(view: WebView?, url: String?, what: String) {
        if (view !== webView || !isPublishedSite(url)) return
        mainFrameFailed = true
        loadInFlight = false
        Log.w(TAG, "main frame failed: $what")
        scheduleRetry()
    }

    /**
     * Back off after a failed load, but never give up: capped at RETRY_MAX_MS so a
     * television left running through an overnight outage is at most a minute behind
     * the network coming back. While waiting, show the offline card rather than
     * Chromium's "webpage not available" page or the host's error page. (A failure only
     * reaches here when the page's own cache could not cover it.)
     */
    private fun scheduleRetry() {
        failureStreak++
        val delay = (RETRY_BASE_MS * (1 shl (failureStreak - 1).coerceAtMost(5)))
            .coerceAtMost(RETRY_MAX_MS)
        Log.w(TAG, "load failed (streak=$failureStreak), retrying in ${delay}ms")
        showOfflineCard()
        handler.removeCallbacks(retryLoad)
        handler.postDelayed(retryLoad, delay)
    }

    private fun showOfflineCard() {
        webView?.loadUrl("file:///android_asset/offline.html")
    }

    /**
     * The renderer died (crash, or killed by the system for memory). The dead WebView cannot be
     * reused: remove and destroy it, then build a fresh one in this same activity.
     */
    private fun onRendererGone(view: WebView?, crashed: Boolean) {
        Log.w(
            RENDERER_TAG,
            "renderer ${if (crashed) "crashed" else "was killed by the system (likely memory)"}"
        )
        if (view != null) {
            container.removeView(view)
            view.destroy()
        }
        if (webView != null && view !== webView) return // a stale view; the current one is fine
        webView = null
        loadInFlight = false
        handler.removeCallbacks(retryLoad)
        rebuildWebViewIfAllowed()
    }

    /**
     * Rebuilds only while the activity is resumed: in the background (residents watching
     * something else) a new renderer would just compete for memory, so it waits for onResume.
     * At most MAX_REBUILDS per REBUILD_WINDOW_MS; past that it waits for the window to clear.
     */
    private fun rebuildWebViewIfAllowed() {
        handler.removeCallbacks(rebuildWebView)
        if (webView != null || isFinishing || isDestroyed) return
        if (!resumed) {
            Log.i(RENDERER_TAG, "display not in front; rebuilding the WebView when it is next resumed")
            return
        }
        val now = SystemClock.elapsedRealtime()
        while (rendererRebuilds.isNotEmpty() && now - rendererRebuilds.first() >= REBUILD_WINDOW_MS) {
            rendererRebuilds.removeFirst()
        }
        if (rendererRebuilds.size >= MAX_REBUILDS) {
            val wait = rendererRebuilds.first() + REBUILD_WINDOW_MS - now
            Log.w(RENDERER_TAG, "renderer lost $MAX_REBUILDS times in 10 min; next rebuild in ${wait / 1000}s")
            handler.postDelayed(rebuildWebView, wait)
            return
        }
        rendererRebuilds.addLast(now)
        Log.i(RENDERER_TAG, "rebuilding the WebView (${rendererRebuilds.size} in the last 10 min)")
        webView = buildWebView()
        loadDisplay()
    }

    override fun onResume() {
        super.onResume()
        resumed = true
        webView?.let {
            it.onResume()
            it.resumeTimers()
        }
        hideSystemUi()
        if (webView == null) rebuildWebViewIfAllowed()
    }

    override fun onPause() {
        super.onPause()
        resumed = false
        // Deliberately NOT pausing timers: the display must keep animating if the system
        // briefly puts an overlay in front of it.
        webView?.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        webView?.destroy()
        webView = null
        super.onDestroy()
    }

    /**
     * Swallow every remote key except a long-press BACK, which is the deliberate way out.
     * A short BACK press instead wakes the page from quiet hours (web/js/engine.js,
     * VhfQuietHours.wake) so staff can confirm the display is alive on a closed day
     * without waiting for content to come back on its own.
     */
    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && event != null && event.isLongPress) {
            return super.onKeyDown(keyCode, event)
        }
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            event?.startTracking()
            return true
        }
        return true
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent?): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            webView?.evaluateJavascript(
                "window.VhfQuietHours && window.VhfQuietHours.wake();",
                null
            )
            return true
        }
        return true
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    private fun hideSystemUi() {
        @Suppress("DEPRECATION")
        window.decorView.systemUiVisibility = (
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
            )
    }

    @Suppress("unused")
    private fun isOnline(): Boolean {
        val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        @Suppress("DEPRECATION")
        return cm.activeNetworkInfo?.isConnected == true
    }

    private companion object {
        const val TAG = "VhfDisplay"
        const val RENDERER_TAG = "VhfRenderer"
        const val WATCHDOG_INTERVAL_MS = 60_000L
        const val LOAD_TIMEOUT_MS = 45_000L
        const val RETRY_BASE_MS = 5_000L
        const val RETRY_MAX_MS = 60_000L
        const val MAX_REBUILDS = 3
        const val REBUILD_WINDOW_MS = 10 * 60_000L
    }
}
