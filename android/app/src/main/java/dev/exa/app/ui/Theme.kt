package dev.exa.app.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

val ExaRed = Color(0xFFFF2338)
val ExaRedDark = Color(0xFFB00018)
val ExaBg = Color(0xFF050304)
val ExaSurface = Color(0xFF12090D)
val ExaSurface2 = Color(0xFF1A0C11)
val ExaLine = Color(0xFF34131A)
val ExaText = Color(0xFFF7E9EC)
val ExaMuted = Color(0xFFB18C93)
val ExaMuted2 = Color(0xFF7A575F)
val ExaGreen = Color(0xFF2EE6A5)
val ExaAmber = Color(0xFFFFB020)

private val ExaColors = darkColorScheme(
    primary = ExaRed,
    onPrimary = Color.White,
    primaryContainer = ExaRedDark,
    onPrimaryContainer = Color.White,
    secondary = ExaGreen,
    onSecondary = Color(0xFF032018),
    background = ExaBg,
    onBackground = ExaText,
    surface = ExaSurface,
    onSurface = ExaText,
    surfaceVariant = ExaSurface2,
    onSurfaceVariant = ExaMuted,
    outline = ExaLine,
    error = ExaRed,
    onError = Color.White
)

@Composable
fun ExaTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = ExaColors,
        typography = Typography(),
        content = content
    )
}
