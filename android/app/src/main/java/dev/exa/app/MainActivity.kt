package dev.exa.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.VpnService
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.ActivityResultLauncher
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import dev.exa.app.core.Profile
import dev.exa.app.core.VpnController
import dev.exa.app.ui.ExaRoot
import dev.exa.app.ui.ExaTheme

class MainActivity : ComponentActivity() {
    private var pendingProfile: Profile? = null
    private lateinit var vpnPermissionLauncher: ActivityResultLauncher<Intent>
    private lateinit var notificationLauncher: ActivityResultLauncher<String>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        notificationLauncher = registerForActivityResult(ActivityResultContracts.RequestPermission()) {}
        vpnPermissionLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val profile = pendingProfile
            pendingProfile = null
            if (result.resultCode == Activity.RESULT_OK && profile != null) {
                VpnController.start(this, profile)
            }
        }

        if (Build.VERSION.SDK_INT >= 33 &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED
        ) {
            notificationLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
        }

        setContent {
            ExaTheme {
                ExaRoot(
                    onConnect = { profile -> connect(profile) },
                    onDisconnect = { VpnController.stop(this) }
                )
            }
        }
    }

    private fun connect(profile: Profile) {
        val prepare = VpnService.prepare(this)
        if (prepare != null) {
            pendingProfile = profile
            vpnPermissionLauncher.launch(prepare)
        } else {
            VpnController.start(this, profile)
        }
    }
}
