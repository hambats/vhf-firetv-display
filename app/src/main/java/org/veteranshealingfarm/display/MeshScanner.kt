package org.veteranshealingfarm.display

import android.Manifest
import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Handler
import android.os.ParcelUuid
import android.util.Log
import androidx.core.content.ContextCompat
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

    data class Found(val address: String, val name: String?, val rssi: Int)

    /** Scans for [durationMs] and calls [done] on [handler] with results, strongest first. */
    fun scan(context: Context, durationMs: Long, handler: Handler, done: (List<Found>) -> Unit) {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.ACCESS_COARSE_LOCATION) !=
            PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(
                TAG, "scan needs location permission: adb shell pm grant " +
                    "${context.packageName} android.permission.ACCESS_COARSE_LOCATION"
            )
            handler.post { done(emptyList()) }
            return
        }
        val scanner = BluetoothAdapter.getDefaultAdapter()?.takeIf { it.isEnabled }?.bluetoothLeScanner
        if (scanner == null) {
            Log.w(TAG, "scan: bluetooth unavailable")
            handler.post { done(emptyList()) }
            return
        }

        val found = LinkedHashMap<String, Found>()
        val callback = object : ScanCallback() {
            override fun onScanResult(callbackType: Int, result: ScanResult) {
                val name = result.scanRecord?.deviceName ?: result.device.name
                synchronized(found) { found[result.device.address] = Found(result.device.address, name, result.rssi) }
            }

            override fun onScanFailed(errorCode: Int) {
                Log.w(TAG, "scan failed ($errorCode)")
            }
        }

        scanner.startScan(
            listOf(ScanFilter.Builder().setServiceUuid(ParcelUuid(SERVICE_UUID)).build()),
            ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build(),
            callback
        )
        handler.postDelayed({
            try { scanner.stopScan(callback) } catch (_: Exception) {}
            val results = synchronized(found) { found.values.sortedByDescending { it.rssi } }
            if (results.isEmpty()) {
                Log.i(TAG, "scan: no Meshtastic nodes heard (if one is powered nearby, Fire OS location may be off)")
            }
            results.forEach { Log.i(TAG, "scan: ${it.name ?: "(no name)"}  ${it.address}  rssi=${it.rssi}") }
            done(results)
        }, durationMs)
    }
}
