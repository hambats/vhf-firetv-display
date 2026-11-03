package org.veteranshealingfarm.display

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
import android.util.Log
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.Executors

/**
 * Optional mesh bridge: makes the television look like a Wi-Fi Meshtastic node.
 *
 * A Meshtastic radio sits near the TV (powered from its USB port) and is reached over BLE.
 * This service exposes that radio on TCP 4403 — the Meshtastic network API, same port and
 * framing as a Wi-Fi node — bound only to the Tailscale address and loopback. Anything on the
 * tailnet can then use `meshtastic --host <tv>` or `TCPInterface("<tv>")` as if the radio
 * were plugged in locally.
 *
 * It is a byte pipe and deliberately knows nothing about protobufs:
 *   TCP frame [0x94 0xC3 lenHi lenLo payload]  →  payload written to the ToRadio characteristic
 *   FromRadio characteristic read (non-empty)  →  framed and sent to the TCP client
 *
 * Kept apart from the display on purpose: a failure here logs and retries, it never touches
 * the WebView. Logs under the tag VhfMesh (`adb logcat -s VhfMesh`).
 */
@SuppressLint("MissingPermission")
class MeshBridgeService : Service() {

    private lateinit var thread: HandlerThread
    private lateinit var handler: Handler
    private val tcpOut = Executors.newSingleThreadExecutor()

    // --- BLE state; touched only on `handler` ---
    private var gatt: BluetoothGatt? = null
    private var toRadio: BluetoothGattCharacteristic? = null
    private var fromRadio: BluetoothGattCharacteristic? = null
    private val ops = ArrayDeque<() -> Boolean>()
    private var opBusy = false
    private var readQueued = false
    private var bleFailures = 0
    private var stopping = false

    // --- TCP state ---
    private val servers = mutableListOf<ServerSocket>()
    private var boundTailscale: InetAddress? = null
    @Volatile private var client: Socket? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onCreate() {
        super.onCreate()
        startForeground(NOTIFICATION_ID, buildNotification())
        thread = HandlerThread("vhf-mesh").also { it.start() }
        handler = Handler(thread.looper)
        registerReceiver(pairingReceiver, IntentFilter(BluetoothDevice.ACTION_PAIRING_REQUEST).apply {
            priority = IntentFilter.SYSTEM_HIGH_PRIORITY - 1
        })
        handler.post { connectBle() }
        handler.post(rebindTcp)
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int) = START_STICKY

    override fun onDestroy() {
        stopping = true
        unregisterReceiver(pairingReceiver)
        handler.removeCallbacksAndMessages(null)
        handler.post {
            gatt?.close()
            gatt = null
            closeServers()
            closeClient()
            thread.quitSafely()
        }
        tcpOut.shutdown()
        super.onDestroy()
    }

    // ---------------------------------------------------------------- BLE

    private fun connectBle() {
        if (stopping) return
        val address = MeshConfig.nodeAddress(this)
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
        gatt = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            device.connectGatt(this, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        } else {
            device.connectGatt(this, false, gattCallback)
        }
    }

    /**
     * No node configured: take the strongest Meshtastic node in range and remember it, so the
     * bridge never wanders to a different node later. Clear it with `--es node ''` to re-pick.
     */
    private fun autoPickNode() {
        Log.i(TAG, "no node set; scanning to pick one")
        MeshScanner.scan(this, AUTO_SCAN_MS, handler) { found ->
            val best = found.firstOrNull()
            if (best == null) {
                scheduleReconnect()
                return@scan
            }
            Log.i(TAG, "auto-picked ${best.name ?: "(no name)"} ${best.address} (rssi=${best.rssi})")
            MeshConfig.setNode(this, best.address)
            connectBle()
        }
    }

    private fun scheduleReconnect() {
        if (stopping) return
        bleFailures++
        val delay = (RETRY_BASE_MS * (1 shl (bleFailures - 1).coerceAtMost(4))).coerceAtMost(RETRY_MAX_MS)
        Log.i(TAG, "reconnecting in ${delay}ms")
        handler.postDelayed({ connectBle() }, delay)
    }

    private fun resetBle() {
        gatt?.close()
        gatt = null
        toRadio = null
        fromRadio = null
        ops.clear()
        opBusy = false
        readQueued = false
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

    private fun queueDrain() {
        if (readQueued) return
        readQueued = true
        enqueue {
            readQueued = false
            val ch = fromRadio
            ch != null && gatt?.readCharacteristic(ch) == true
        }
    }

    private fun writeToRadio(payload: ByteArray) {
        enqueue {
            val ch = toRadio ?: return@enqueue false
            ch.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
            @Suppress("DEPRECATION")
            ch.value = payload
            @Suppress("DEPRECATION")
            gatt?.writeCharacteristic(ch) == true
        }
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            handler.post {
                if (g != gatt) return@post
                if (newState == BluetoothProfile.STATE_CONNECTED) {
                    Log.i(TAG, "BLE connected")
                    if (!g.requestMtu(MTU)) g.discoverServices()
                } else {
                    Log.w(TAG, "BLE disconnected (status=$status)")
                    resetBle()
                    scheduleReconnect()
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            handler.post { if (g == gatt) g.discoverServices() }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            handler.post {
                if (g != gatt) return@post
                val service = g.getService(SERVICE_UUID)
                toRadio = service?.getCharacteristic(TO_RADIO_UUID)
                fromRadio = service?.getCharacteristic(FROM_RADIO_UUID)
                val fromNum = service?.getCharacteristic(FROM_NUM_UUID)
                if (toRadio == null || fromRadio == null || fromNum == null) {
                    Log.e(TAG, "not a Meshtastic node (service missing); dropping")
                    g.disconnect()
                    return@post
                }
                bleFailures = 0
                g.setCharacteristicNotification(fromNum, true)
                enqueue {
                    val cccd = fromNum.getDescriptor(CCCD_UUID) ?: return@enqueue false
                    @Suppress("DEPRECATION")
                    cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
                    @Suppress("DEPRECATION")
                    g.writeDescriptor(cccd)
                }
                Log.i(TAG, "Meshtastic service ready")
                queueDrain()
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, d: BluetoothGattDescriptor, status: Int) {
            handler.post { if (g == gatt) opDone() }
        }

        @Deprecated("Deprecated in API 33; this app targets 28")
        override fun onCharacteristicRead(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            @Suppress("DEPRECATION")
            val value = ch.value?.copyOf()
            handler.post {
                if (g != gatt) return@post
                if (status == BluetoothGatt.GATT_SUCCESS && value != null && value.isNotEmpty()) {
                    sendToClient(value)
                    queueDrain() // keep reading until the node returns empty
                }
                opDone()
            }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, ch: BluetoothGattCharacteristic, status: Int) {
            handler.post {
                if (g != gatt) return@post
                if (status != BluetoothGatt.GATT_SUCCESS) Log.w(TAG, "ToRadio write failed ($status)")
                queueDrain()
                opDone()
            }
        }

        @Deprecated("Deprecated in API 33; this app targets 28")
        override fun onCharacteristicChanged(g: BluetoothGatt, ch: BluetoothGattCharacteristic) {
            // FromNum ticked: the node has something for us.
            handler.post { if (g == gatt) queueDrain() }
        }
    }

    /** Answers the node's pairing prompt with the configured PIN so nobody needs the remote. */
    private val pairingReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            @Suppress("DEPRECATION")
            val device = intent.getParcelableExtra<BluetoothDevice>(BluetoothDevice.EXTRA_DEVICE) ?: return
            if (!device.address.equals(MeshConfig.nodeAddress(context), ignoreCase = true)) return
            try {
                if (device.setPin(MeshConfig.pin(context).toByteArray())) {
                    Log.i(TAG, "answered pairing request with configured PIN")
                    abortBroadcast()
                }
            } catch (e: SecurityException) {
                Log.w(TAG, "could not set PIN automatically; pair once by hand", e)
            }
        }
    }

    // ---------------------------------------------------------------- TCP

    /** Re-checked every TAILSCALE_CHECK_MS so the server follows Tailscale coming up late. */
    private val rebindTcp = object : Runnable {
        override fun run() {
            val ts = tailscaleAddress()
            if (servers.isEmpty() || ts != boundTailscale) {
                closeServers()
                boundTailscale = ts
                // Loopback too, so `adb forward tcp:4403 tcp:4403` works for bench testing.
                listOfNotNull(InetAddress.getByName("127.0.0.1"), ts).forEach { listen(it) }
                if (ts == null) Log.w(TAG, "no Tailscale address yet; loopback only")
            }
            handler.postDelayed(this, TAILSCALE_CHECK_MS)
        }
    }

    private fun listen(address: InetAddress) {
        val server = try {
            ServerSocket(TCP_PORT, 2, address)
        } catch (e: IOException) {
            Log.w(TAG, "cannot listen on ${address.hostAddress}:$TCP_PORT", e)
            return
        }
        servers += server
        Log.i(TAG, "listening on ${address.hostAddress}:$TCP_PORT")
        Thread({
            while (!server.isClosed) {
                val socket = try { server.accept() } catch (e: IOException) { break }
                attachClient(socket)
            }
        }, "vhf-mesh-accept").start()
    }

    /** One client at a time; a newcomer replaces whoever was there. */
    private fun attachClient(socket: Socket) {
        closeClient()
        socket.tcpNoDelay = true
        client = socket
        Log.i(TAG, "client connected from ${socket.inetAddress.hostAddress}")
        Thread({
            try {
                readFrames(socket.getInputStream()) { payload -> handler.post { writeToRadio(payload) } }
            } catch (_: IOException) {
            }
            Log.i(TAG, "client ${socket.inetAddress.hostAddress} gone")
            if (client == socket) closeClient()
        }, "vhf-mesh-client").start()
    }

    /** Meshtastic stream framing; bytes outside a frame (the client's wake-up 0xC3s) are skipped. */
    private fun readFrames(input: InputStream, onFrame: (ByteArray) -> Unit) {
        while (true) {
            var b = input.read()
            if (b < 0) return
            if (b != START1) continue
            b = input.read()
            if (b < 0) return
            if (b != START2) continue
            val hi = input.read()
            val lo = input.read()
            if (hi < 0 || lo < 0) return
            val len = (hi shl 8) or lo
            if (len > MAX_PAYLOAD) continue
            val payload = ByteArray(len)
            var off = 0
            while (off < len) {
                val n = input.read(payload, off, len - off)
                if (n < 0) return
                off += n
            }
            onFrame(payload)
        }
    }

    private fun sendToClient(payload: ByteArray) {
        val socket = client ?: return // nobody listening; the node keeps its own history
        tcpOut.execute {
            try {
                val out: OutputStream = socket.getOutputStream()
                out.write(byteArrayOf(START1.toByte(), START2.toByte(), (payload.size shr 8).toByte(), payload.size.toByte()))
                out.write(payload)
                out.flush()
            } catch (_: IOException) {
                if (client == socket) closeClient()
            }
        }
    }

    private fun closeClient() {
        client?.let { try { it.close() } catch (_: IOException) {} }
        client = null
    }

    private fun closeServers() {
        servers.forEach { try { it.close() } catch (_: IOException) {} }
        servers.clear()
    }

    /** The Tailscale VPN address (100.64.0.0/10), or null if Tailscale is not up. */
    private fun tailscaleAddress(): InetAddress? =
        NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()
            .filter { it.isUp }
            .flatMap { it.inetAddresses.toList() }
            .firstOrNull { addr ->
                addr is Inet4Address && addr.address.let {
                    (it[0].toInt() and 0xFF) == 100 && (it[1].toInt() and 0xC0) == 64
                }
            }

    // ---------------------------------------------------------------- notification

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
            .setSmallIcon(R.mipmap.ic_launcher)
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
        const val MAX_PAYLOAD = 512
        const val START1 = 0x94
        const val START2 = 0xC3
        const val RETRY_BASE_MS = 5_000L
        const val RETRY_MAX_MS = 60_000L
        const val TAILSCALE_CHECK_MS = 30_000L
        const val AUTO_SCAN_MS = 10_000L

        val SERVICE_UUID: UUID = MeshScanner.SERVICE_UUID
        val TO_RADIO_UUID: UUID = UUID.fromString("f75c76d2-129e-4dad-a1dd-7866124401e7")
        val FROM_RADIO_UUID: UUID = UUID.fromString("2c55e69e-4993-11ed-b878-0242ac120002")
        val FROM_NUM_UUID: UUID = UUID.fromString("ed9da18c-a800-4f66-a670-aa7547e34453")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")
    }
}
