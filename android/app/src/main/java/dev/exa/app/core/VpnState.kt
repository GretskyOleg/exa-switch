package dev.exa.app.core

sealed interface VpnState {
    data object Disconnected : VpnState
    data class Connecting(val profile: Profile) : VpnState
    data class Connected(val profile: Profile) : VpnState
    data class Error(val message: String) : VpnState
}
