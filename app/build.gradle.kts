plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "org.veteranshealingfarm.display"
    compileSdk = 34

    defaultConfig {
        applicationId = "org.veteranshealingfarm.display"
        minSdk = 28 // the VHF television: AFTTI43, Fire OS 7.7 (Android 9 / API 28)
        targetSdk = 28
        versionCode = 6
        versionName = "1.3.0"
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
        // Fire OS 7.
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

    // JVM unit tests for the pure shell decisions (app/src/test, ShellPolicy.kt).
    testImplementation("junit:junit:4.13.2")
}
