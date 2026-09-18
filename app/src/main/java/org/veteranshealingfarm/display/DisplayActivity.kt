package org.veteranshealingfarm.display

import android.annotation.SuppressLint
import android.content.Context
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.appcompat.app.AppCompatActivity

/**
 * The appliance shell.
 *
 * One fullscreen WebView pointed at the published Netlify site. The page itself owns the
 * scene engine, caching (Service Worker) and content refresh — see docs/ARCHITECTURE.md.
 * This activity owns only the things a web page cannot do for itself:
 *
 *  - the screen never sleeps (FLAG_KEEP_SCREEN_ON, plus the TV's own sleep setting)
 *  - no system chrome, ever (immersive sticky, re-asserted on every focus change)
 *  - the page comes back after a network outage (retry with backoff, then offline card)
 *  - the page comes back after a renderer crash or a stall (watchdog + reload)
 *  - the remote cannot navigate away from the display
 */
class DisplayActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private val handler = Handler(Looper.getMainLooper())

    /** Wall-clock of the last successful page load; 0 until the first one lands. */
    private var lastGoodLoadAt = 0L

    /** Consecutive failed load attempts, used for the retry backoff. */
    private var failureStreak = 0

    /** True between a load starting and that same load either finishing or failing. */
    private var loadInFlight = false

    private val displayUrl: String by lazy { getString(R.string.display_url) }
    private val displayHost: String by lazy { Uri.parse(displayUrl).host.orEmpty() }

    private val retryLoad = Runnable { loadDisplay() }

    /**
     * Fires every WATCHDOG_INTERVAL_MS. Reloads if a load has been in flight too long
     * (a stalled request that never errors) or if nothing has loaded successfully at all.
     */
    private val watchdog = object : Runnable {
        override fun run() {
            val now = SystemClock.elapsedRealtime()
            val stalled = loadInFlight && now - loadStartedAt > LOAD_TIMEOUT_MS
            val neverLoaded = lastGoodLoadAt == 0L && !loadInFlight
            if (stalled || neverLoaded) {
                Log.w(TAG, "watchdog reload (stalled=$stalled neverLoaded=$neverLoaded)")
                loadDisplay()
            }
            handler.postDelayed(this, WATCHDOG_INTERVAL_MS)
        }
    }

    private var loadStartedAt = 0L

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.addFlags(WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        window.addFlags(WindowManager.LayoutParams.FLAG_DISMISS_KEYGUARD)
        hideSystemUi()

        webView = WebView(this)
        setContentView(webView)

        with(webView.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadWithOverviewMode = true
            useWideViewPort = true
            mediaPlaybackRequiresUserGesture = false
            cacheMode = WebSettings.LOAD_DEFAULT
        }

        // Nothing on this display is interactive; keep focus and the D-pad out of the page.
        webView.isFocusable = false
        webView.isFocusableInTouchMode = false
        webView.isHorizontalScrollBarEnabled = false
        webView.isVerticalScrollBarEnabled = false
        webView.setOnLongClickListener { true }

        webView.webViewClient = object : WebViewClient() {

            override fun onPageStarted(view: WebView?, url: String?, favicon: android.graphics.Bitmap?) {
                super.onPageStarted(view, url, favicon)
                loadInFlight = true
                loadStartedAt = SystemClock.elapsedRealtime()
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                loadInFlight = false
                if (url != null && !url.startsWith("data:")) {
                    lastGoodLoadAt = System.currentTimeMillis()
                    failureStreak = 0
                }
                hideSystemUi()
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                // Sub-resource failures are the page's problem, not ours.
                if (request?.isForMainFrame != true) return
                loadInFlight = false
                scheduleRetry()
            }

            @Suppress("DEPRECATION")
            override fun onReceivedError(
                view: WebView?,
                errorCode: Int,
                description: String?,
                failingUrl: String?
            ) {
                // Pre-API-23 path. Only the main frame reaches this callback.
                loadInFlight = false
                scheduleRetry()
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

        loadDisplay()
        handler.postDelayed(watchdog, WATCHDOG_INTERVAL_MS)
    }

    private fun loadDisplay() {
        handler.removeCallbacks(retryLoad)
        loadStartedAt = SystemClock.elapsedRealtime()
        loadInFlight = true
        webView.loadUrl(displayUrl)
    }

    /**
     * Back off after a failed load, but never give up: capped at RETRY_MAX_MS so a
     * television left running through an overnight outage is at most a minute behind
     * the network coming back. While waiting, show the offline card rather than
     * Chromium's "webpage not available" error page.
     */
    private fun scheduleRetry() {
        failureStreak++
        val delay = (RETRY_BASE_MS * (1 shl (failureStreak - 1).coerceAtMost(5)))
            .coerceAtMost(RETRY_MAX_MS)
        Log.w(TAG, "load failed (streak=$failureStreak), retrying in ${delay}ms")
        if (lastGoodLoadAt == 0L) showOfflineCard()
        handler.postDelayed(retryLoad, delay)
    }

    /** Shown only before the first successful load; after that the page's own cache covers us. */
    private fun showOfflineCard() {
        webView.loadUrl("file:///android_asset/offline.html")
    }

    override fun onResume() {
        super.onResume()
        webView.onResume()
        webView.resumeTimers()
        hideSystemUi()
    }

    override fun onPause() {
        super.onPause()
        // Deliberately NOT pausing timers: the display must keep animating if the system
        // briefly puts an overlay in front of it.
        webView.onPause()
    }

    override fun onDestroy() {
        handler.removeCallbacksAndMessages(null)
        webView.destroy()
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
            webView.evaluateJavascript(
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
        const val WATCHDOG_INTERVAL_MS = 60_000L
        const val LOAD_TIMEOUT_MS = 45_000L
        const val RETRY_BASE_MS = 5_000L
        const val RETRY_MAX_MS = 60_000L
    }
}
