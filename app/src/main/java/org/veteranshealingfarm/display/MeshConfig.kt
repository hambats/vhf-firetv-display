package org.veteranshealingfarm.display

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.veteranshealingfarm.display.MeshConfigEdits.Edit
import org.veteranshealingfarm.display.MeshConfigEdits.KEY_ENABLED
import org.veteranshealingfarm.display.MeshConfigEdits.KEY_MATCH
import org.veteranshealingfarm.display.MeshConfigEdits.KEY_NODE
import org.veteranshealingfarm.display.MeshConfigEdits.KEY_PIN

/**
 * Settings for the optional mesh bridge (MeshBridgeService). Off unless switched on.
 *
 * There is no on-screen UI for this — the television has no keyboard and nothing on the
 * display is interactive. It is set once over ADB (see docs/MESH_BRIDGE.md):
 *
 *   adb shell am broadcast -a org.veteranshealingfarm.display.MESH_CONFIG \
 *       -n org.veteranshealingfarm.display/.MeshConfigReceiver \
 *       --ez enabled true --es node AA:BB:CC:DD:EE:FF --es pin 123456
 *
 * The file is written by the ":mesh" process (MeshConfigReceiver, auto-pick) and read by both
 * processes, so it is opened with MODE_MULTI_PROCESS: each read re-checks the file on disk
 * instead of trusting this process's cached copy. Same file name and keys as v1.2.0, so an
 * upgrade keeps the existing settings.
 */
object MeshConfig {
    private const val TAG = "VhfMesh"
    private const val PREFS = "mesh_bridge"
    private const val DEFAULT_PIN = "123456"
    /** Auto-pick only takes a node whose BLE name contains this (the owner names in MESH_BRIDGE.md). */
    const val DEFAULT_MATCH = "VHF"

    @Suppress("DEPRECATION")
    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE or Context.MODE_MULTI_PROCESS)

    fun enabled(context: Context) = prefs(context).getBoolean(KEY_ENABLED, false)
    fun nodeAddress(context: Context): String? = prefs(context).getString(KEY_NODE, null)
    fun pin(context: Context) = prefs(context).getString(KEY_PIN, DEFAULT_PIN) ?: DEFAULT_PIN
    fun nodeMatch(context: Context) = prefs(context).getString(KEY_MATCH, DEFAULT_MATCH) ?: DEFAULT_MATCH

    fun setNode(context: Context, address: String) {
        prefs(context).edit().putString(KEY_NODE, address.uppercase()).commit()
    }

    /**
     * Starts the bridge if it is switched on; otherwise a no-op. Never throws: it is called on
     * the display's own startup path (DisplayActivity.onCreate, BootReceiver), and a bridge
     * that cannot start must not take the display with it.
     */
    fun startIfEnabled(context: Context) {
        try {
            if (!enabled(context)) return
            val intent = Intent(context, MeshBridgeService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "could not start the mesh bridge; the display carries on without it", t)
        }
    }

    internal fun apply(context: Context, intent: Intent) {
        val edits = MeshConfigEdits.from(
            enabled = if (intent.hasExtra(KEY_ENABLED)) intent.getBooleanExtra(KEY_ENABLED, false) else null,
            node = intent.getStringExtra(KEY_NODE),
            forget = intent.getBooleanExtra(EXTRA_FORGET, false),
            pin = intent.getStringExtra(KEY_PIN),
            match = intent.getStringExtra(KEY_MATCH),
        )
        val editor = prefs(context).edit()
        edits.forEach {
            when (it) {
                is Edit.PutBoolean -> editor.putBoolean(it.key, it.value)
                is Edit.PutString -> editor.putString(it.key, it.value)
                is Edit.Remove -> editor.remove(it.key)
            }
        }
        // commit, not apply: the other process reads the file, and the service restarts next.
        editor.commit()
    }

    /** `--ez forget true`: forget the node so the bridge auto-picks again. */
    const val EXTRA_FORGET = "forget"
}

/**
 * Receives MESH_CONFIG and MESH_SCAN from `adb shell am broadcast`. Guarded by the DUMP
 * permission, which the ADB shell holds and no installable app can, so only someone at ADB
 * can change it. Runs in the ":mesh" process with the bridge.
 */
class MeshConfigReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_SCAN) {
            // Results go to `adb logcat -s VhfMesh`; kept under the background-broadcast limit.
            val pending = goAsync()
            val handle = MeshScanner.scan(
                context, SCAN_MS, Handler(Looper.getMainLooper()), MeshConfig.nodeMatch(context)
            ) { pending.finish() }
            if (handle == null) Log.w("VhfMesh", "scan did not start")
            return
        }
        if (intent.action != ACTION) return
        MeshConfig.apply(context, intent)
        Log.i(
            "VhfMesh",
            "config: enabled=${MeshConfig.enabled(context)} node=${MeshConfig.nodeAddress(context)} " +
                "match=${MeshConfig.nodeMatch(context)}"
        )
        // Restart so a new node address or PIN takes effect; stopping is enough when disabled.
        context.stopService(Intent(context, MeshBridgeService::class.java))
        MeshConfig.startIfEnabled(context)
    }

    companion object {
        const val ACTION = "org.veteranshealingfarm.display.MESH_CONFIG"
        const val ACTION_SCAN = "org.veteranshealingfarm.display.MESH_SCAN"
        private const val SCAN_MS = 8_000L
    }
}

/**
 * After `adb install -r` the old process is gone, and nothing else would bring the bridge back
 * until the next boot or the next time someone opens the display. This restarts the bridge
 * only — never the activity: starting DisplayActivity here would turn the screen on in a
 * resident's room. Runs in the ":mesh" process; not exported (the system still delivers it).
 */
class MeshUpgradeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        MeshConfig.startIfEnabled(context)
    }
}
