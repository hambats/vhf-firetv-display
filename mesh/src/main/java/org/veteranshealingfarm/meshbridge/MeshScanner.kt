package org.veteranshealingfarm.meshbridge

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.ParcelUuid
import android.util.Log
import java.util.UUID

/**
 * Short BLE scan for Meshtastic nodes, filtered on the Meshtastic service UUID so nothing
 * else nearby (remotes, soundbars) shows up. Used by MESH_SCAN and by the bridge's auto-pick.
 *
 * Android 9 returns no scan results without location permission, and does so silently —
 * hence the explicit check and the hint in the log.
 */
@SuppressLint("MissingPermission")
object MeshScanner {
    private const val TAG = "VhfMesh"

    val SERVICE_UUID: UUID = UUID.fromString("6ba1b218-15a8-461f-9fa8-5dcae273eafd")

    /** A running scan. stop() ends it early without calling `done`. */
    interface Handle {
        fun stop()
    }

    /**
     * Scans for [durationMs] and calls [done] on [handler] with every node heard, strongest
     * first; names containing [match] are flagged in the log. Never throws. Returns null when
     * no scan started — `done` has then already been posted with an empty list.
     */
    fun scan(
        context: Context,
        durationMs: Long,
        handler: Handler,
        match: String?,
        done: (List<MeshNode>) -> Unit
    ): Handle? {
        if (context.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(
                TAG, "scan needs location permission: adb shell pm grant " +
                    "${context.packageName} android.permission.ACCESS_COARSE_LOCATION"
            )
            handler.post { done(emptyList()) }
            return null
        }

        val found = LinkedHashMap<String, MeshNode>()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val name = result.scanRecord?.deviceName ?: result.device.name
                synchronized(found) { found[result.device.address] = MeshNode(result.device.address, name, result.rssi) }
            }

            override fun onScanFailed(errorCode: Int) {
                Log.w(TAG, "scan failed ($errorCode)")
            }
        }

        // Bluetooth can switch off between any check and startScan, which then throws.
        val scanner: BluetoothLeScanner
        try {
            val s = BluetoothAdapter.getDefaultAdapter()?.takeIf { it.isEnabled }?.bluetoothLeScanner
            if (s == null) {
                Log.w(TAG, "scan: bluetooth unavailable")
                handler.post { done(emptyList()) }
                return null
            }
            s.startScan(
                listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()),
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
                callback
            )
            scanner = s
        } catch (e: Exception) {
            Log.w(TAG, "scan could not start", e)
            handler.post { done(emptyList()) }
            return null
        }

        fun stopQuietly() {
            try { scanner.stopScan(callback) } catch (_: Exception) {}
        }

        val finish = Runnable {
            stopQuietly()
            val results = synchronized(found) { found.values.sortedByDescending { it.rssi } }
            if (results.isEmpty()) {
                Log.i(TAG, "scan: no Meshtastic nodes heard (if one is powered nearby, Fire OS location may be off)")
            }
            results.forEach {
                val flag = if (match != null && NodePicker.matches(it.name, match)) "  [matches '$match']" else ""
                Log.i(TAG, "scan: ${it.name ?: "(no name)"}  ${it.address}  rssi=${it.rssi}$flag")
            }
            done(results)
        }
        handler.postDelayed(finish, durationMs)
        return object : Handle {
            override fun stop() {
                handler.removeCallbacks(finish)
                stopQuietly()
            }
        }
    }
}
