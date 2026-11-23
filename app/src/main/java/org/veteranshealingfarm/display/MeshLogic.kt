package org.veteranshealingfarm.display

import java.io.IOException
import java.io.InputStream
import java.net.Inet4Address
import java.net.InetAddress

/*
 * The pure pieces of the optional mesh bridge. Nothing in this file imports android.*, so it
 * runs in plain JVM unit tests (app/src/test). MeshBridgeService, MeshScanner and MeshConfig
 * wire these to the platform.
 */

/** Meshtastic stream framing, as used on TCP 4403: `0x94 0xC3 lenHi lenLo payload`. */
object MeshFraming {
    const val START1 = 0x94
    const val START2 = 0xC3
    const val MAX_PAYLOAD = 512

    fun frame(payload: ByteArray): ByteArray {
        require(payload.size <= MAX_PAYLOAD) { "payload of ${payload.size} bytes exceeds $MAX_PAYLOAD" }
        val out = ByteArray(4 + payload.size)
        out[0] = START1.toByte()
        out[1] = START2.toByte()
        out[2] = (payload.size shr 8).toByte()
        out[3] = payload.size.toByte()
        System.arraycopy(payload, 0, out, 4, payload.size)
        return out
    }

    /**
     * Reads frames until end of stream, handing each payload to [onFrame]. Bytes outside a
     * frame (a client's wake-up 0xC3s, line noise) are skipped. A header claiming more than
     * MAX_PAYLOAD is treated as lost sync: the reader resumes scanning right after it, as the
     * firmware's own stream reader does. A frame cut short by end of stream is dropped.
     */
    @Throws(IOException::class)
    fun readFrames(input: InputStream, onFrame: (ByteArray) -> Unit) {
        var b = input.read()
        while (b >= 0) {
            if (b != START1) {
                b = input.read()
                continue
            }
            b = input.read()
            if (b != START2) continue // re-examine b: it may be the START1 of a real frame
            val hi = input.read()
            val lo = input.read()
            if (hi < 0 || lo < 0) return
            val len = (hi shl 8) or lo
            if (len <= MAX_PAYLOAD) {
                val payload = ByteArray(len)
                var off = 0
                while (off < len) {
                    val n = input.read(payload, off, len - off)
                    if (n < 0) return
                    off += n
                }
                onFrame(payload)
            }
            b = input.read()
        }
    }
}

/** Finds the television's own Tailscale address among its network interfaces. */
object TailscaleAddress {
    data class Iface(val name: String, val up: Boolean, val addresses: List<InetAddress>)

    /** 100.64.0.0/10, the range Tailscale assigns from (it is also carrier-grade NAT space). */
    fun isCgnat(address: InetAddress): Boolean =
        address is Inet4Address && address.address.let {
            (it[0].toInt() and 0xFF) == 100 && (it[1].toInt() and 0xC0) == 64
        }

    /**
     * The 100.64/10 IPv4 address of an up VPN tun interface (Tailscale on Android is a
     * VpnService, so it is `tun0` or similar), or null. A Wi-Fi or Ethernet interface that
     * happens to sit in 100.64/10 behind carrier-grade NAT is never picked: binding there
     * would expose the radio to the farm's LAN instead of only to the tailnet.
     */
    fun pick(ifaces: List<Iface>): InetAddress? =
        ifaces.asSequence()
            .filter { it.up && it.name.startsWith("tun") }
            .flatMap { it.addresses.asSequence() }
            .firstOrNull { isCgnat(it) }
}

/** One Meshtastic node heard in a BLE scan. */
data class MeshNode(val address: String, val name: String?, val rssi: Int)

/** Auto-pick: the strongest node whose advertised name contains the match string. */
object NodePicker {
    fun matches(name: String?, match: String): Boolean {
        val m = match.trim()
        return m.isNotEmpty() && name != null && name.contains(m, ignoreCase = true)
    }

    /** Null when nothing heard matches; a stronger node with the wrong name never wins. */
    fun pick(found: List<MeshNode>, match: String): MeshNode? =
        found.filter { matches(it.name, match) }.maxByOrNull { it.rssi }
}

/**
 * One MESH_CONFIG broadcast turned into preference edits. Only extras that are present change
 * anything, so `--ez enabled true` on its own keeps the saved node, PIN and match.
 */
object MeshConfigEdits {
    const val KEY_ENABLED = "enabled"
    const val KEY_NODE = "node"
    const val KEY_PIN = "pin"
    const val KEY_MATCH = "match"

    sealed class Edit {
        data class PutBoolean(val key: String, val value: Boolean) : Edit()
        data class PutString(val key: String, val value: String) : Edit()
        data class Remove(val key: String) : Edit()
    }

    /**
     * @param enabled the `enabled` extra, or null when absent
     * @param node the `node` extra, or null when absent; blank (`--es node ''`) forgets it
     * @param forget the `forget` extra; true forgets the node unless a non-blank node is given
     * @param pin the `pin` extra; blank restores the default
     * @param match the `match` extra; blank restores the default
     */
    fun from(enabled: Boolean?, node: String?, forget: Boolean, pin: String?, match: String?): List<Edit> {
        val edits = mutableListOf<Edit>()
        if (enabled != null) edits += Edit.PutBoolean(KEY_ENABLED, enabled)
        val nodeValue = node?.trim()
        if (!nodeValue.isNullOrEmpty()) {
            edits += Edit.PutString(KEY_NODE, nodeValue.uppercase())
        } else if (forget || node != null) {
            edits += Edit.Remove(KEY_NODE)
        }
        pin?.trim()?.let { edits += if (it.isEmpty()) Edit.Remove(KEY_PIN) else Edit.PutString(KEY_PIN, it) }
        match?.trim()?.let { edits += if (it.isEmpty()) Edit.Remove(KEY_MATCH) else Edit.PutString(KEY_MATCH, it) }
        return edits
    }
}
