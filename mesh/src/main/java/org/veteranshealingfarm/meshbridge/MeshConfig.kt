package org.veteranshealingfarm.meshbridge

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import org.veteranshealingfarm.meshbridge.MeshConfigEdits.Edit
import org.veteranshealingfarm.meshbridge.MeshConfigEdits.KEY_ENABLED
import org.veteranshealingfarm.meshbridge.MeshConfigEdits.KEY_MATCH
import org.veteranshealingfarm.meshbridge.MeshConfigEdits.KEY_NODE
import org.veteranshealingfarm.meshbridge.MeshConfigEdits.KEY_PIN

/**
 * Settings for the optional mesh bridge (MeshBridgeService). Off unless switched on.
 *
 * There is no on-screen UI for this — the television has no keyboard, and this app has no
 * activity at all. It is set once over ADB (see docs/MESH_BRIDGE.md):
 *
 *   adb shell am broadcast --include-stopped-packages \
 *       -a org.veteranshealingfarm.meshbridge.MESH_CONFIG \
 *       -n org.veteranshealingfarm.meshbridge/.MeshConfigReceiver \
 *       --ez enabled true --es node AA:BB:CC:DD:EE:FF --es pin <pairing PIN>
 *
 * There is no default pairing PIN: until one is configured the bridge does not answer the
 * node's pairing prompt (it logs why), so no real PIN ever has to live in source control.
 *
 * Opened with MODE_MULTI_PROCESS (each read re-checks the file on disk), as when the bridge
 * lived inside the display APK (v1.2.x). This is a separate package, so its settings start
 * empty and must be entered once after it is installed.
 */
object MeshConfig {
    private const val TAG = "VhfMesh"
    private const val PREFS = "mesh_bridge"
    /** Auto-pick only takes a node whose BLE name contains this (the owner names in MESH_BRIDGE.md). */
    const val DEFAULT_MATCH = "VHF"

    @Suppress("DEPRECATION")
    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE or Context.MODE_MULTI_PROCESS)

    fun enabled(context: Context) = prefs(context).getBoolean(KEY_ENABLED, false)
    fun nodeAddress(context: Context): String? = prefs(context).getString(KEY_NODE, null)
    /** The node's BLE pairing PIN, or null until one is configured with `--es pin`. */
    fun pin(context: Context): String? = prefs(context).getString(KEY_PIN, null)?.takeIf { it.isNotBlank() }
    fun nodeMatch(context: Context) = prefs(context).getString(KEY_MATCH, DEFAULT_MATCH) ?: DEFAULT_MATCH

    fun setNode(context: Context, address: String) {
        prefs(context).edit().putString(KEY_NODE, address.uppercase()).commit()
    }

    /**
     * Starts the bridge if it is switched on; otherwise a no-op. Never throws: it is called
     * from the boot, upgrade and config receivers, which must not crash.
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
            Log.w(TAG, "could not start the mesh bridge", t)
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
        const val ACTION = "org.veteranshealingfarm.meshbridge.MESH_CONFIG"
        const val ACTION_SCAN = "org.veteranshealingfarm.meshbridge.MESH_SCAN"
        private const val SCAN_MS = 8_000L
    }
}

/**
 * After `adb install -r` the old process is gone, and nothing else would bring the bridge back
 * until the next boot. This restarts the bridge, a service; this app has no screen to show.
 * Runs in the ":mesh" process; not exported (the system still delivers it).
 */
class MeshUpgradeReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        MeshConfig.startIfEnabled(context)
    }
}

/**
 * Starts the bridge after the television boots, if it is switched on. Starts a service only,
 * never an activity, so it can never touch the screen. (Until display 1.3.0 the display app's
 * BootReceiver did this.) Not exported: BOOT_COMPLETED is a protected broadcast sent by the
 * system, which reaches non-exported receivers.
 */
class MeshBootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED) return
        MeshConfig.startIfEnabled(context)
    }
}
