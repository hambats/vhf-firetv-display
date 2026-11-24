plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// The optional Meshtastic BLE-to-TCP bridge, as its own APK. Until display 1.3.0 it was packaged
// inside the display app; it shares no code with it and must never depend on the :app module.
// See docs/MESH_BRIDGE.md.
android {
    namespace = "org.veteranshealingfarm.meshbridge"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.veteranshealingfarm.meshbridge"
        minSdk = 28 // the VHF television: Fire OS 7 (Android 9)
        targetSdk = 28 // legacy BLUETOOTH/BLUETOOTH_ADMIN + location permissions apply below 31
        versionCode = 1
        versionName = "1.0.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Sideloaded onto one television, like the display: signed with the local debug key.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    lint {
        disable += "ExpiredTargetSdkVersion"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    // JVM unit tests for the pure bridge logic (MeshLogic.kt).
    testImplementation("junit:junit:4.13.2")
}
