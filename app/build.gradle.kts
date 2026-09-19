plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.veteranshealingfarm.display"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.veteranshealingfarm.display"
        // Exact Fire TV Edition model/OS on the VHF television isn't confirmed yet.
        // One build spans Fire OS 5 (Android 5.1 / API 22, oldest Fire TV Edition sets)
        // through Fire OS 7 (Android 9 / API 28) so that's never a blocker — see
        // docs/ARCHITECTURE.md "Unconfirmed device" for the compatibility approach.
        minSdk = 21
        targetSdk = 28
        versionCode = 3
        versionName = "1.1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Signed with the local debug key on purpose. This APK is sideloaded onto one
            // television, never published to a store, and a release-key ceremony would only
            // add a secret to guard. What matters here is that the build is not debuggable.
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    lint {
        // This APK is sideloaded onto one television and is never published to Google Play,
        // so the Play target-API requirement does not apply. targetSdk stays at 28 to match
        // Fire OS 7 — see the note on defaultConfig above.
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
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.webkit:webkit:1.10.0")
}
