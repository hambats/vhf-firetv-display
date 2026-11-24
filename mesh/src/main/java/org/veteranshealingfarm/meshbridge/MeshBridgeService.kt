package org.veteranshealingfarm.meshbridge

import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothProfile
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import java.io.Closeable
import java.io.IOException
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

/**
 * Optional mesh bridge: makes the television look like a Wi-Fi Meshtastic node.
 *
 * A Meshtastic radio sits near the TV (powered from its USB port) and is reached over BLE.
 * This service exposes that radio on TCP 4403 — the Meshtastic network API, same port and
 * framing as a Wi-Fi node — bound only to the Tailscale tun address and loopback. Anything on
 * the tailnet can then use `meshtastic --host <tv>` or `TCPInterface("<tv>")` as if the radio
 * were plugged in locally. The API has no authentication (see docs/MESH_BRIDGE.md).
 *
 * It is a byte pipe and deliberately knows nothing about protobufs:
 *   TCP frame [0x94 0xC3 lenHi lenLo payload]  →  payload written to the ToRadio characteristic
 *   FromRadio characteristic read (non-empty)  →  framed and sent to the TCP client
 *
 * Session rules, matching a Wi-Fi node:
 *   - a TCP client is accepted only while the radio link is ready, and is closed whenever that
 *     link drops, so it reconnects and re-sends want_config to the node's fresh BLE session;
 *   - FromRadio is read only for an attached client that has sent something; with nobody
 *     attached, packets stay queued on the node for the next client.
 *
 * Kept apart from the display on purpose: since display 1.3.0 it is its own APK, and it still
 * runs in a ":mesh" process (AndroidManifest.xml). Inside that
 * process every bridge thread reports uncaught exceptions to [onBridgeCrashed], which tears
 * the bridge down and starts a fresh one after a growing delay. Logs under the tag VhfMesh
 * (`adb logcat -s VhfMesh`).
 */
@SuppressLint("MissingPermission")
class MeshBridgeService : Service() {

    private val main = Handler(Looper.getMainLooper())
    private var bridge: Bridge? = null
    private val crashTimes = ArrayDeque<Long>()
    private var destroyed = false

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())
        registerReceiver(pairingReceiver, IntentFilter(BluetoothDevice.ACTION_PAIRING_REQUEST).apply {
            priority = IntentFilter.SYSTEM_HIGH_PRIORITY - 1
        })
        startBridge()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_STICKY

    override fun onDestroy() {
        destroyed = true
        main.removeCallbacksAndMessages(null)
        try {
            unregisterReceiver(pairingReceiver)
        } catch (_: IllegalArgumentException) {
        }
        bridge?.shutdown()
        bridge = null
        super.onDestroy()
    }

    private fun startBridge() {
        if (destroyed) return
        bridge = Bridge().also { it.start() }
    }

    /** Main thread. Only the current bridge's crash counts; a late report from an old one is ignored. */
    private fun onBridgeCrashed(crashed: Bridge) {
        if (destroyed || bridge !== crashed) return
        bridge = null
        crashed.shutdown()
        val now = SystemClock.elapsedRealtime()
        while (crashTimes.isNotEmpty() && now - crashTimes.first() > CRASH_WINDOW_MS) crashTimes.removeFirst()
        crashTimes.addLast(now)
        val delay = (CRASH_RESTART_BASE_MS shl (crashTimes.size - 1).coerceAtMost(6)).coerceAtMost(CRASH_RESTART_MAX_MS)
        Log.w(TAG, "bridge restarting in ${delay / 1000}s (${crashTimes.size} crash(es) in the last hour)")
        main.postDelayed({ startBridge() }, delay)
    }

    /** Answers the node's pairing prompt with the configured PIN so nobody needs the remote. */
    private val pairingReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            try {
                @Suppress("DEPRECATION")
                val device = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE) ?: return
                if (!device.address.equals(MeshConfig.nodeAddress(context), ignoreCase = true)) return
                val pin = MeshConfig.pin(context)
                if (pin == null) {
                    Log.w(TAG, "pairing requested but no PIN is configured (--es pin); pair once by hand")
                    return
                }
                if (device.setPin(pin.toByteArray())) {
                    Log.i(TAG, "answered pairing request with configured PIN")
                    abortBroadcast()
                }
            } catch (e: Exception) {
                Log.w(TAG, "could not set PIN automatically; pair once by hand", e)
            }
        }
    }

    // ================================================================ one bridge run

    /**
     * Everything one run of the bridge owns. A crash anywhere in it ends the whole run
     * (shutdown) and a fresh instance replaces it; nothing is carried over but the settings.
     */
    private inner class Bridge {
        private val ctx: Context get() = this@MeshBridgeService

        private val crashHandler = Thread.UncaughtExceptionHandler { t, e ->
            Log.e(TAG, "bridge thread ${t.name} crashed", e)
            main.post { onBridgeCrashed(this@Bridge) }
        }

        private val thread = HandlerThread("vhf-mesh").also { it.uncaughtExceptionHandler = crashHandler }
        private lateinit var handler: Handler
        private val tcpOut = Executors.newSingleThreadExecutor { r ->
            Thread(r, "vhf-mesh-tcp-out").also { it.uncaughtExceptionHandler = crashHandler }
        }
        @Volatile private var stopped = false

        // --- BLE state; touched only on `handler` ---
        private var gatt: BluetoothGatt? = null
        private var toRadio: BluetoothGattCharacteristic? = null
        private var fromRadio: BluetoothGattCharacteristic? = null
        private val ops = ArrayDeque<() -> Boolean>()
        private var opBusy = false
        private var readQueued = false
        private var ready = false
        private var bleFailures = 0
        private var emptyScans = 0
        private var scan: MeshScanner.Handle? = null

        // --- TCP state; touched only on `handler` (accept and reader threads post to it) ---
        private val servers = mutableListOf<ServerSocket>()
        private val bound = mutableListOf<InetAddress>()
        private var client: Socket? = null
        private var clientSpoke = false

        fun start() {
            thread.start()
            handler = Handler(thread.looper)
            post { connectBle() }
            post { rebindTcp.run() }
        }

        /**
         * Main thread. Stops the looper first and waits briefly for it, so the teardown below
         * does not race the handler thread (and still works if that thread is the one that died).
         */
        fun shutdown() {
            stopped = true
            if (::handler.isInitialized) handler.removeCallbacksAndMessages(null)
            thread.quit()
            try {
                thread.join(JOIN_MS)
            } catch (_: InterruptedException) {
            }
            scan?.stop()
            scan = null
            gatt?.let {
                try {
                    it.disconnect()
                    it.close()
                } catch (e: Exception) {
                    Log.w(TAG, "closing GATT failed", e)
                }
            }
            gatt = null
            closeServers()
            closeClient("bridge stopping")
            tcpOut.shutdownNow()
        }

        private fun post(block: () -> Unit): Boolean = !stopped && handler.post(block)

        // ------------------------------------------------------------ BLE

        private fun connectBle() {
            if (stopped) return
            val address = MeshConfig.nodeAddress(ctx)
            if (address.isNullOrBlank()) {
                autoPickNode()
                return
            }
            val adapter = BluetoothAdapter.getDefaultAdapter()
            if (adapter == null || !adapter.isEnabled || !BluetoothAdapter.checkBluetoothAddress(address)) {
                Log.w(TAG, "bluetooth unavailable or bad node address '$address'")
                scheduleReconnect()
                return
            }
            val device = adapter.getRemoteDevice(address)
            Log.i(TAG, "connecting to $address (bond=${device.bondState})")
            val g = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                device.connectGatt(ctx, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
            } else {
                device.connectGatt(ctx, false, gattCallback)
            }
            if (g == null) {
                Log.w(TAG, "connectGatt refused (bluetooth switching off?)")
                scheduleReconnect()
                return
            }
            gatt = g
            handler.postDelayed(readyTimeout, READY_TIMEOUT_MS)
        }

        /** Catches a link that connects but never finishes setting up (no callback, stuck op). */
        private val readyTimeout = Runnable {
            if (!ready && gatt != null) dropLink("not ready after ${READY_TIMEOUT_MS / 1000}s")
        }

        /**
         * No node configured: take the strongest node whose name contains the match string
         * (default "VHF") and remember it. Nothing matching: back off, and after
         * SLOW_SCAN_AFTER empty scans only look every SLOW_SCAN_MS.
         */
        private fun autoPickNode() {
            val match = MeshConfig.nodeMatch(ctx)
            Log.i(TAG, "no node set; scanning for one whose name contains '$match'")
            scan = MeshScanner.scan(ctx, AUTO_SCAN_MS, handler, match) { found ->
                scan = null
                if (stopped) return@scan
                val best = NodePicker.pick(found, match)
                if (best == null) {
                    emptyScans++
                    Log.i(TAG, "no node named like '$match' heard ($emptyScans empty scan(s))")
                    scheduleReconnect(if (emptyScans >= SLOW_SCAN_AFTER) SLOW_SCAN_MS else 0L)
                    return@scan
                }
                emptyScans = 0
                Log.i(TAG, "auto-picked ${best.name} ${best.address} (rssi=${best.rssi})")
                MeshConfig.setNode(ctx, best.address)
                connectBle()
            }
        }

        private fun scheduleReconnect(minDelayMs: Long = 0L) {
            if (stopped) return
            bleFailures++
            val backoff = (RETRY_BASE_MS * (1 shl (bleFailures - 1).coerceAtMost(4))).coerceAtMost(RETRY_MAX_MS)
            val delay = maxOf(backoff, minDelayMs)
            Log.i(TAG, "next attempt in ${delay / 1000}s")
            handler.postDelayed({ connectBle() }, delay)
        }

        /**
         * Every BLE failure ends here: close the link, drop any TCP client so it re-syncs with
         * the node's next session, and back off. bleFailures is only reset once a link is ready.
         */
        private fun dropLink(reason: String) {
            val g = gatt ?: return
            Log.w(TAG, "dropping BLE link: $reason")
            handler.removeCallbacks(readyTimeout)
            try {
                g.disconnect()
                g.close()
            } catch (e: Exception) {
                Log.w(TAG, "closing GATT failed", e)
            }
            gatt = null
            toRadio = null
            fromRadio = null
            ops.clear()
            opBusy = false
            readQueued = false
            ready = false
            closeClient("radio link lost")
            scheduleReconnect()
        }

        /** Android allows one GATT operation in flight; everything goes through this queue. */
        private fun enqueue(op: () -> Boolean) {
            ops.addLast(op)
            pump()
        }

        private fun pump() {
            while (!opBusy && ops.isNotEmpty()) {
                opBusy = ops.removeFirst().invoke()
            }
        }

        private fun opDone() {
            opBusy = false
            pump()
        }

        /** Read FromRadio until empty, but only for an attached client that has spoken. */
        private fun queueDrain() {
            if (readQueued || !ready || client == null || !clientSpoke) return
            readQueued = true
            enqueue {
                readQueued = false
                val ch = fromRadio
                val g = gatt
                if (ch == null || g == null || client == null) return@enqueue false
                val started = g.readCharacteristic(ch)
                if (!started) dropLink("FromRadio read would not start")
                started
            }
        }

        private fun writeToRadio(payload: ByteArray) {
            enqueue {
                val ch = toRadio
                val g = gatt
                if (ch == null || g == null) return@enqueue false
                ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION")
                ch.value = payload
                @Suppress("DEPRECATION")
                val started = g.writeCharacteristic(ch)
                if (!started) dropLink("ToRadio write would not start")
                started
            }
        }

        private val gattCallback = object : BluetoothGattCallback() {
            override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
                post {
                    if (g != gatt) return@post
                    if (newState == BluetoothProfile.STATE_CONNECTED && status == BluetoothGatt.GATT_SUCCESS) {
                        Log.i(TAG, "BLE connected")
                        if (!g.requestMtu(MTU) && !g.discoverServices()) dropLink("service discovery would not start")
                    } else {
                        dropLink("disconnected (status=$status, state=$newState)")
                    }
                }
            }

            override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
                post {
                    if (g == gatt && !g.discoverServices()) dropLink("service discovery would not start")
                }
            }

            override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
                post {
                    if (g != gatt) return@post
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        dropLink("service discovery failed (status=$status)")
                        return@post
                    }
                    val service = g.getService(SERVICE_UUID)
                    val to = service?.getCharacteristic(TO_RADIO_UUID)
                    val from = service?.getCharacteristic(FROM_RADIO_UUID)
                    val fromNum = service?.getCharacteristic(FROM_NUM_UUID)
                    val cccd = fromNum?.getDescriptor(CCCD_UUID)
                    if (to == null || from == null || fromNum == null || cccd == null) {
                        Log.e(TAG, "not a Meshtastic node (service missing)")
                        dropLink("Meshtastic service missing")
                        return@post
                    }
                    toRadio = to
                    fromRadio = from
                    g.setCharacteristicNotification(fromNum, true)
                    enqueue {
                        @Suppress("DEPRECATION")
                        cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                        @Suppress("DEPRECATION")
                        val started = g.writeDescriptor(cccd)
                        if (!started) dropLink("FromNum subscription would not start")
                        started
                    }
                }
            }

            override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
                post {
                    if (g != gatt) return@post
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        // Typically 5/15 (insufficient authentication/encryption): wrong PIN, or a
                        // stale bond left over from before the node was reflashed.
                        dropLink("FromNum subscription failed (status=$status); wrong PIN or stale bond?")
                        return@post
                    }
                    ready = true
                    bleFailures = 0
                    handler.removeCallbacks(readyTimeout)
                    Log.i(TAG, "Meshtastic service ready")
                    opDone()
                }
            }

            @Deprecated("Deprecated in API 33; this app targets 28")
            override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
                @Suppress("DEPRECATION")
                val value = ch.value?.copyOf()
                post {
                    if (g != gatt) return@post
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        dropLink("FromRadio read failed (status=$status)")
                        return@post
                    }
                    if (value != null && value.isNotEmpty()) {
                        sendToClient(value)
                        queueDrain() // keep reading until the node returns empty
                    }
                    opDone()
                }
            }

            override fun onCharacteristicWrite(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
                post {
                    if (g != gatt) return@post
                    if (status != BluetoothGatt.GATT_SUCCESS) {
                        dropLink("ToRadio write failed (status=$status)")
                        return@post
                    }
                    queueDrain()
                    opDone()
                }
            }

            @Deprecated("Deprecated in API 33; this app targets 28")
            override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
                // FromNum ticked: the node has something. Read it only if a client is there for it.
                post { if (g == gatt) queueDrain() }
            }
        }

        // ------------------------------------------------------------ TCP

        /** Re-checked every TAILSCALE_CHECK_MS so the server follows Tailscale coming up late. */
        private val rebindTcp: Runnable = object : Runnable {
            override fun run() {
                if (stopped) return
                try {
                    val ts = TailscaleAddress.pick(interfaces())
                    // Loopback too, so `adb forward tcp:4403 tcp:4403` works for bench testing.
                    val wanted = listOfNotNull(LOOPBACK, ts)
                    if (wanted != bound) { // also retries a listener that failed to bind last time
                        closeServers()
                        wanted.forEach { listen(it) }
                        if (ts == null) Log.w(TAG, "no Tailscale address yet; loopback only")
                    }
                } catch (e: Exception) {
                    // Interface enumeration throws if one vanishes mid-walk (Tailscale restarting).
                    Log.w(TAG, "network check failed; keeping the current listeners", e)
                }
                handler.postDelayed(this, TAILSCALE_CHECK_MS)
            }
        }

        private fun interfaces(): List<TailscaleAddress.Iface> =
            NetworkInterface.getNetworkInterfaces()?.toList().orEmpty().map { ni ->
                val up = try {
                    ni.isUp
                } catch (_: SocketException) {
                    false
                }
                TailscaleAddress.Iface(ni.name.orEmpty(), up, ni.inetAddresses.toList())
            }

        private fun listen(address: InetAddress) {
            val server = try {
                ServerSocket(TCP_PORT, 2, address)
            } catch (e: IOException) {
                Log.w(TAG, "cannot listen on ${address.hostAddress}:$TCP_PORT", e)
                return
            }
            servers += server
            bound += address
            Log.i(TAG, "listening on ${address.hostAddress}:$TCP_PORT")
            Thread({
                while (!server.isClosed) {
                    val socket = try {
                        server.accept()
                    } catch (e: IOException) {
                        break
                    }
                    if (!post { attachClient(socket) }) closeQuietly(socket)
                }
            }, "vhf-mesh-accept").also { it.uncaughtExceptionHandler = crashHandler }.start()
        }

        /**
         * One client at a time; a newcomer replaces whoever was there. Refused while the radio
         * link is not ready: a client would otherwise send want_config into nothing and wait
         * forever. A refused client sees the connection close at once.
         */
        private fun attachClient(socket: Socket) {
            val from = socket.inetAddress?.hostAddress
            if (!ready) {
                Log.w(TAG, "refusing client from $from: radio link not ready")
                closeQuietly(socket)
                return
            }
            closeClient("replaced by $from")
            try {
                socket.tcpNoDelay = true
            } catch (_: SocketException) {
            }
            client = socket
            clientSpoke = false
            Log.i(TAG, "client connected from $from")
            Thread({
                try {
                    MeshFraming.readFrames(socket.getInputStream()) { payload ->
                        post {
                            if (client === socket) {
                                clientSpoke = true
                                writeToRadio(payload)
                            }
                        }
                    }
                } catch (_: IOException) {
                }
                post { if (client === socket) closeClient("client $from gone") }
            }, "vhf-mesh-client").also { it.uncaughtExceptionHandler = crashHandler }.start()
        }

        private fun sendToClient(payload: ByteArray) {
            val socket = client ?: return
            val frame = MeshFraming.frame(payload)
            try {
                tcpOut.execute {
                    try {
                        socket.getOutputStream().apply {
                            write(frame)
                            flush()
                        }
                    } catch (_: IOException) {
                        post { if (client === socket) closeClient("write to client failed") }
                    }
                }
            } catch (_: RejectedExecutionException) {
                // Bridge is shutting down.
            }
        }

        private fun closeClient(reason: String) {
            val c = client ?: return
            client = null
            clientSpoke = false
            Log.i(TAG, "closing TCP client: $reason")
            closeQuietly(c)
        }

        private fun closeServers() {
            servers.forEach { closeQuietly(it) }
            servers.clear()
            bound.clear()
        }
    }

    // ================================================================ notification

    private fun buildNotification(): Notification {
        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(NotificationManager::class.java)
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Mesh bridge", NotificationManager.IMPORTANCE_MIN)
            )
            Notification.Builder(this, CHANNEL_ID)
        } else {
            @Suppress("DEPRECATION")
            Notification.Builder(this)
        }
        return builder
            .setSmallIcon(android.R.drawable.stat_sys_data_bluetooth)
            .setContentTitle("VHF mesh bridge")
            .setOngoing(true)
            .build()
    }

    private companion object {
        const val TAG = "VhfMesh"
        const val CHANNEL_ID = "mesh_bridge"
        const val NOTIFICATION_ID = 4403
        const val TCP_PORT = 4403
        const val MTU = 512
        const val RETRY_BASE_MS = 5_000L
        const val RETRY_MAX_MS = 60_000L
        const val READY_TIMEOUT_MS = 60_000L
        const val TAILSCALE_CHECK_MS = 30_000L
        const val AUTO_SCAN_MS = 10_000L
        const val SLOW_SCAN_AFTER = 10
        const val SLOW_SCAN_MS = 30 * 60_000L
        const val CRASH_RESTART_BASE_MS = 10_000L
        const val CRASH_RESTART_MAX_MS = 10 * 60_000L
        const val CRASH_WINDOW_MS = 60 * 60_000L
        const val JOIN_MS = 500L

        val LOOPBACK: InetAddress = InetAddress.getByAddress(byteArrayOf(127, 0, 0, 1))
        val SERVICE_UUID: UUID = MeshScanner.SERVICE_UUID
        val TO_RADIO_UUID: UUID = UUID.fromString("f75c76d2-129e-4dad-a1dd-7866124401e7")
        val FROM_RADIO_UUID: UUID = UUID.fromString("2c55e69e-4993-11ed-b878-0242ac120002")
        val FROM_NUM_UUID: UUID = UUID.fromString("ed9da18c-a800-4f66-a670-aa7547e34453")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        fun closeQuietly(c: Closeable?) {
            try {
                c?.close()
            } catch (_: IOException) {
            }
        }
    }
}
