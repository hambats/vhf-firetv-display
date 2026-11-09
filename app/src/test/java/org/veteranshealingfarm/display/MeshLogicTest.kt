package org.veteranshealingfarm.display

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.veteranshealingfarm.display.MeshConfigEdits.Edit
import java.io.ByteArrayInputStream
import java.io.InputStream
import java.net.InetAddress

// Run with: JAVA_HOME="/c/Program Files/Android/Android Studio/jbr" ./gradlew testReleaseUnitTest
class MeshLogicTest {

    // ------------------------------------------------------------ framing

    private fun bytes(vararg v: Int) = ByteArray(v.size) { v[it].toByte() }

    private fun framesOf(input: InputStream): List<ByteArray> {
        val out = mutableListOf<ByteArray>()
        MeshFraming.readFrames(input) { out += it }
        return out
    }

    private fun framesOf(data: ByteArray) = framesOf(ByteArrayInputStream(data))

    /** Hands out at most one byte per read, like a slow socket. */
    private class Trickle(data: ByteArray) : InputStream() {
        private val inner = ByteArrayInputStream(data)
        override fun read(): Int = inner.read()
        override fun read(b: ByteArray, off: Int, len: Int): Int = inner.read(b, off, minOf(len, 1))
    }

    @Test
    fun frameRoundTrips() {
        val payload = bytes(1, 2, 3, 0x94, 0xC3)
        val framed = MeshFraming.frame(payload)
        assertArrayEquals(bytes(0x94, 0xC3, 0, 5, 1, 2, 3, 0x94, 0xC3), framed)
        val got = framesOf(framed)
        assertEquals(1, got.size)
        assertArrayEquals(payload, got[0])
    }

    @Test
    fun wakeBytesAndNoiseAreSkipped() {
        val data = bytes(0xC3, 0xC3, 0xC3, 0xC3, 0x00, 0x7F) + MeshFraming.frame(bytes(9))
        val got = framesOf(data)
        assertEquals(1, got.size)
        assertArrayEquals(bytes(9), got[0])
    }

    @Test
    fun backToBackFramesAndEmptyFrame() {
        val data = MeshFraming.frame(bytes(1)) + MeshFraming.frame(ByteArray(0)) + MeshFraming.frame(bytes(2, 3))
        val got = framesOf(data)
        assertEquals(3, got.size)
        assertArrayEquals(bytes(1), got[0])
        assertEquals(0, got[1].size)
        assertArrayEquals(bytes(2, 3), got[2])
    }

    @Test
    fun repeatedStartByteResyncs() {
        val data = bytes(0x94) + MeshFraming.frame(bytes(7))
        val got = framesOf(data)
        assertEquals(1, got.size)
        assertArrayEquals(bytes(7), got[0])
    }

    @Test
    fun oversizeHeaderIsSkippedAndNextFrameFound() {
        val data = bytes(0x94, 0xC3, 0x02, 0x01) + bytes(5, 5, 5) + MeshFraming.frame(bytes(4))
        val got = framesOf(data)
        assertEquals(1, got.size)
        assertArrayEquals(bytes(4), got[0])
    }

    @Test
    fun maxSizePayloadAndPartialReads() {
        val payload = ByteArray(MeshFraming.MAX_PAYLOAD) { (it % 251).toByte() }
        val got = framesOf(Trickle(MeshFraming.frame(payload) + MeshFraming.frame(bytes(1))))
        assertEquals(2, got.size)
        assertArrayEquals(payload, got[0])
    }

    @Test
    fun truncatedFrameAtEndOfStreamIsDropped() {
        assertTrue(framesOf(bytes(0x94, 0xC3, 0, 4, 1, 2)).isEmpty())
        assertTrue(framesOf(bytes(0x94, 0xC3, 0)).isEmpty())
        assertTrue(framesOf(bytes(0x94)).isEmpty())
    }

    // ------------------------------------------------------------ Tailscale address

    private fun ip(vararg v: Int) = InetAddress.getByAddress(bytes(*v))

    @Test
    fun picksTunCgnatAddress() {
        val ts = ip(100, 69, 183, 1)
        val ifaces = listOf(
            TailscaleAddress.Iface("lo", true, listOf(ip(127, 0, 0, 1))),
            TailscaleAddress.Iface("wlan0", true, listOf(ip(192, 168, 1, 40))),
            TailscaleAddress.Iface("tun0", true, listOf(InetAddress.getByName("fd7a:115c:a1e0::1"), ts)),
        )
        assertEquals(ts, TailscaleAddress.pick(ifaces))
    }

    @Test
    fun neverPicksALanInterfaceInCgnatSpace() {
        val ifaces = listOf(TailscaleAddress.Iface("wlan0", true, listOf(ip(100, 70, 1, 2))))
        assertNull(TailscaleAddress.pick(ifaces))
    }

    @Test
    fun ignoresDownTunAndAddressesOutsideTheRange() {
        assertNull(TailscaleAddress.pick(listOf(TailscaleAddress.Iface("tun0", false, listOf(ip(100, 69, 183, 1))))))
        assertNull(TailscaleAddress.pick(listOf(TailscaleAddress.Iface("tun0", true, listOf(ip(10, 0, 0, 1))))))
        assertNull(TailscaleAddress.pick(listOf(TailscaleAddress.Iface("tun0", true, listOf(ip(100, 128, 0, 1))))))
        assertNull(TailscaleAddress.pick(listOf(TailscaleAddress.Iface("tun0", true, listOf(ip(100, 63, 255, 255))))))
        assertTrue(TailscaleAddress.isCgnat(ip(100, 127, 255, 254)))
    }

    // ------------------------------------------------------------ config edits

    private fun applied(start: Map<String, Any>, edits: List<Edit>): Map<String, Any> {
        val m = start.toMutableMap()
        edits.forEach {
            when (it) {
                is Edit.PutBoolean -> m[it.key] = it.value
                is Edit.PutString -> m[it.key] = it.value
                is Edit.Remove -> m.remove(it.key)
            }
        }
        return m
    }

    private val saved = mapOf<String, Any>("enabled" to false, "node" to "F1:23:45:67:89:AB", "pin" to "654321")

    @Test
    fun enabledAloneKeepsNodeAndPin() {
        val after = applied(saved, MeshConfigEdits.from(true, null, false, null, null))
        assertEquals(mapOf("enabled" to true, "node" to "F1:23:45:67:89:AB", "pin" to "654321"), after)
    }

    @Test
    fun forgetRemovesTheNode() {
        val after = applied(saved, MeshConfigEdits.from(null, null, true, null, null))
        assertNull(after["node"])
        assertEquals("654321", after["pin"])
    }

    @Test
    fun emptyNodeStringStillForgets() {
        assertNull(applied(saved, MeshConfigEdits.from(null, "", false, null, null))["node"])
        assertNull(applied(saved, MeshConfigEdits.from(null, "  ", false, null, null))["node"])
    }

    @Test
    fun nodeIsTrimmedAndUppercasedAndBeatsForget() {
        val after = applied(saved, MeshConfigEdits.from(null, " aa:bb:cc:dd:ee:ff ", true, null, null))
        assertEquals("AA:BB:CC:DD:EE:FF", after["node"])
    }

    @Test
    fun blankPinAndMatchFallBackToDefaults() {
        val start = saved + ("match" to "Relay")
        val after = applied(start, MeshConfigEdits.from(null, null, false, "", " "))
        assertNull(after["pin"])
        assertNull(after["match"])
        assertEquals("777777", applied(saved, MeshConfigEdits.from(null, null, false, " 777777 ", null))["pin"])
    }

    // ------------------------------------------------------------ auto-pick

    @Test
    fun picksStrongestMatchingNodeOnly() {
        val found = listOf(
            MeshNode("11:11:11:11:11:11", "Meshtastic_1a2b", -40), // a neighbour's, louder
            MeshNode("22:22:22:22:22:22", "VHFT_89ab", -70),
            MeshNode("33:33:33:33:33:33", "vhf relay_c0de", -60),
            MeshNode("44:44:44:44:44:44", null, -30),
        )
        assertEquals("33:33:33:33:33:33", NodePicker.pick(found, "VHF")?.address)
    }

    @Test
    fun picksNothingWhenNoNameMatches() {
        val found = listOf(MeshNode("11:11:11:11:11:11", "Meshtastic_1a2b", -40))
        assertNull(NodePicker.pick(found, "VHF"))
        assertNull(NodePicker.pick(found, ""))
        assertNull(NodePicker.pick(emptyList(), "VHF"))
    }
}
