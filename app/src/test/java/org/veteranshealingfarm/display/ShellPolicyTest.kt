package org.veteranshealingfarm.display

import android.content.Intent
import android.view.Display
import android.view.KeyEvent
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** Run with: ./gradlew :app:testDebugUnitTest */
class ShellPolicyTest {

    /** Keys a resident (or staff) needs from the system; the display must never take them. */
    private val systemKeys = listOf(
        KeyEvent.KEYCODE_HOME,
        KeyEvent.KEYCODE_VOLUME_UP,
        KeyEvent.KEYCODE_VOLUME_DOWN,
        KeyEvent.KEYCODE_VOLUME_MUTE,
        KeyEvent.KEYCODE_MUTE,
        KeyEvent.KEYCODE_POWER,
        KeyEvent.KEYCODE_TV_POWER,
        KeyEvent.KEYCODE_SLEEP,
        KeyEvent.KEYCODE_WAKEUP,
        KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE,
        KeyEvent.KEYCODE_MEDIA_PLAY,
        KeyEvent.KEYCODE_MEDIA_PAUSE,
        KeyEvent.KEYCODE_MEDIA_FAST_FORWARD,
        KeyEvent.KEYCODE_MEDIA_REWIND,
        KeyEvent.KEYCODE_TV_INPUT,
        KeyEvent.KEYCODE_MENU,
        KeyEvent.KEYCODE_SEARCH,
        KeyEvent.KEYCODE_DPAD_CENTER,
        KeyEvent.KEYCODE_DPAD_UP,
    )

    @Test
    fun backPressIsTrackedSoLongPressCanFire() {
        assertEquals(KeyPolicy.Down.TRACK, KeyPolicy.onDown(KeyEvent.KEYCODE_BACK))
    }

    @Test
    fun shortBackReleaseIsConsumedAndDoesNothingElse() {
        // Consumed: the system never sees it, so onBackPressed/finish is never reached.
        assertTrue(KeyPolicy.consumeUp(KeyEvent.KEYCODE_BACK))
    }

    @Test
    fun longPressBackStepsAside() {
        assertTrue(KeyPolicy.onLongPress(KeyEvent.KEYCODE_BACK))
    }

    @Test
    fun everyOtherKeyPassesThroughToTheSystem() {
        for (key in systemKeys) {
            assertEquals("down $key", KeyPolicy.Down.PASS, KeyPolicy.onDown(key))
            assertFalse("up $key", KeyPolicy.consumeUp(key))
            assertFalse("long-press $key", KeyPolicy.onLongPress(key))
        }
    }

    @Test
    fun bootStartsTheDisplayOnlyWhenTheTelevisionIsOn() {
        assertTrue(BootGate.shouldStartDisplay(Intent.ACTION_BOOT_COMPLETED, true, Display.STATE_ON))
    }

    @Test
    fun bootIntoStandbyStaysDark() {
        val boot = Intent.ACTION_BOOT_COMPLETED
        assertFalse(BootGate.shouldStartDisplay(boot, false, Display.STATE_OFF))
        assertFalse(BootGate.shouldStartDisplay(boot, false, Display.STATE_ON))
        assertFalse(BootGate.shouldStartDisplay(boot, true, Display.STATE_OFF))
        assertFalse(BootGate.shouldStartDisplay(boot, true, Display.STATE_DOZE))
        assertFalse(BootGate.shouldStartDisplay(boot, true, Display.STATE_DOZE_SUSPEND))
        assertFalse(BootGate.shouldStartDisplay(boot, true, Display.STATE_UNKNOWN))
    }

    @Test
    fun onlyTheProtectedBootBroadcastCounts() {
        assertFalse(BootGate.shouldStartDisplay("android.intent.action.QUICKBOOT_POWERON", true, Display.STATE_ON))
        assertFalse(BootGate.shouldStartDisplay(Intent.ACTION_MY_PACKAGE_REPLACED, true, Display.STATE_ON))
        assertFalse(BootGate.shouldStartDisplay(null, true, Display.STATE_ON))
    }
}
