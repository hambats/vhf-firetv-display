package org.veteranshealingfarm.display

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.SharedPreferences
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

/**
 * Settings for the optional mesh bridge (MeshBridgeService). Off unless switched on.
 *
 * There is no on-screen UI for this — the television has no keyboard and nothing on the
 * display is interactive. It is set once over ADB (see docs/MESH_BRIDGE.md):
 *
 *   adb shell am broadcast -a org.veteranshealingfarm.display.MESH_CONFIG \
 *       -n org.veteranshealingfarm.display/.MeshConfigReceiver \
 *       --ez enabled true --es node AA:BB:CC:DD:EE:FF --es pin 123456
 */
object MeshConfig {
    private const val PREFS = "mesh_bridge"

    private fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun enabled(context: Context) = prefs(context).getBoolean("enabled", false)
    fun nodeAddress(context: Context) = prefs(context).getString("node", null)
    fun pin(context: Context) = prefs(context).getString("pin", "123456") ?: "123456"

    fun setNode(context: Context, address: String) =
        prefs(context).edit().putString("node", address.uppercase()).apply()

    /**
     * Starts the bridge if it is switched on; otherwise a no-op. With no node address set,
     * the bridge picks the strongest Meshtastic node it hears and remembers it.
     */
    fun startIfEnabled(context: Context) {
        if (!enabled(context)) return
        val intent = Intent(context, MeshBridgeService::class.java)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            context.startForegroundService(intent)
        } else {
            context.startService(intent)
        }
    }

    internal fun apply(context: Context, intent: Intent) {
        prefs(context).edit().apply {
            if (intent.hasExtra("enabled")) putBoolean("enabled", intent.getBooleanExtra("enabled", false))
            // An empty node ("--es node ''") clears it, so the bridge auto-picks again.
            intent.getStringExtra("node")?.let { node ->
                if (node.isBlank()) remove("node") else putString("node", node.trim().uppercase())
            }
            intent.getStringExtra("pin")?.let { putString("pin", it.trim()) }
        }.apply()
    }
}

/**
 * Receives MESH_CONFIG from `adb shell am broadcast`. Guarded by the DUMP permission, which
 * the ADB shell holds and no installable app can, so only someone at ADB can change it.
 */
class MeshConfigReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == ACTION_SCAN) {
            // Results go to `adb logcat -s VhfMesh`; kept under the background-broadcast limit.
            val pending = goAsync()
            MeshScanner.scan(context, SCAN_MS, Handler(Looper.getMainLooper())) { pending.finish() }
            return
        }
        if (intent.action != ACTION) return
        MeshConfig.apply(context, intent)
        Log.i(
            "VhfMesh",
            "config: enabled=${MeshConfig.enabled(context)} node=${MeshConfig.nodeAddress(context)}"
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
