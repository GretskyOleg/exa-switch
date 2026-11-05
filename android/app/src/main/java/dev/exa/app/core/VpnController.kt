package dev.exa.app.core

import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import dev.exa.app.vpn.ExaVpnService
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

object VpnController {
    private val _state = MutableStateFlow<VpnState>(VpnState.Disconnected)
    val state: StateFlow<VpnState> = _state.asStateFlow()

    fun start(context: Context, profile: Profile) {
        val intent = Intent(context, ExaVpnService::class.java)
            .setAction(ExaVpnService.ACTION_START)
            .putExtra(ExaVpnService.EXTRA_PROFILE, profile.toJson().toString())
        _state.value = VpnState.Connecting(profile)
        ContextCompat.startForegroundService(context, intent)
    }

    fun stop(context: Context) {
        val intent = Intent(context, ExaVpnService::class.java)
            .setAction(ExaVpnService.ACTION_STOP)
        context.startService(intent)
    }

    internal fun setConnecting(profile: Profile) {
        _state.value = VpnState.Connecting(profile)
    }

    internal fun setConnected(profile: Profile) {
        _state.value = VpnState.Connected(profile)
    }

    internal fun setDisconnected() {
        _state.value = VpnState.Disconnected
    }

    internal fun setError(message: String) {
        _state.value = VpnState.Error(message)
    }
}
