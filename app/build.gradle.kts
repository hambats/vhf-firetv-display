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
        versionCode = 1
        versionName = "0.1.0-phase1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
        }
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
