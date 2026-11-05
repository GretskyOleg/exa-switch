package dev.exa.app.ui

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Article
import androidx.compose.material.icons.rounded.ContentPaste
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.Dns
import androidx.compose.material.icons.rounded.Home
import androidx.compose.material.icons.rounded.PowerSettingsNew
import androidx.compose.material.icons.rounded.Settings
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationBarItemDefaults
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.RadioButtonDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.exa.app.BuildConfig
import dev.exa.app.R
import dev.exa.app.core.Profile
import dev.exa.app.core.ProfileStore
import dev.exa.app.core.SubscriptionFetcher
import dev.exa.app.core.VlessParser
import dev.exa.app.core.VpnController
import dev.exa.app.core.VpnLog
import dev.exa.app.core.VpnState
import dev.exa.app.core.XrayBridge
import dev.exa.app.core.XrayConfig
import kotlinx.coroutines.launch

@Composable
fun ExaRoot(onConnect: (Profile) -> Unit, onDisconnect: () -> Unit) {
    val context = LocalContext.current
    val state by VpnController.state.collectAsStateWithLifecycle()
    var profiles by remember { mutableStateOf(ProfileStore.load(context)) }
    var activeId by remember { mutableStateOf(ProfileStore.activeId(context)) }
    var tab by rememberSaveable { mutableIntStateOf(0) }
    var showProfilesDialog by remember { mutableStateOf(false) }
    val snackbar = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val active = profiles.firstOrNull { it.id == activeId }

    fun refreshProfiles() {
        profiles = ProfileStore.load(context)
        activeId = ProfileStore.activeId(context)
    }

    fun toast(text: String) {
        scope.launch { snackbar.showSnackbar(text) }
    }

    fun importText(text: String) {
        val value = text.trim()
        if (value.isEmpty()) {
            toast("Вставь vless:// или https://")
            return
        }
        scope.launch {
            try {
                val body = if (value.startsWith("https://")) {
                    SubscriptionFetcher.fetch(value)
                } else {
                    value
                }
                val parsed = VlessParser.parseMany(body)
                if (parsed.isEmpty()) {
                    toast("VLESS-ссылки не найдены")
                    return@launch
                }
                var added = 0
                parsed.forEach { if (ProfileStore.add(context, it)) added++ }
                refreshProfiles()
                toast(if (added > 0) "Добавлено профилей: $added" else "Такие профили уже есть")
            } catch (t: Throwable) {
                toast(t.message ?: "Ошибка импорта")
            }
        }
    }

    fun select(id: String) {
        ProfileStore.setActive(context, id)
        activeId = id
    }

    fun delete(profile: Profile) {
        ProfileStore.remove(context, profile.id)
        refreshProfiles()
    }

    fun toggle() {
        when (state) {
            is VpnState.Connected, is VpnState.Connecting -> onDisconnect()
            else -> {
                val profile = active
                if (profile == null) {
                    tab = 1
                    toast("Сначала добавь профиль")
                } else {
                    onConnect(profile)
                }
            }
        }
    }

    Scaffold(
        containerColor = ExaBg,
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = { ExaNav(tab) { tab = it } }
    ) { padding ->
        Box(Modifier.fillMaxSize().padding(padding)) {
            when (tab) {
                0 -> HomeScreen(
                    state = state,
                    active = active,
                    profileCount = profiles.size,
                    onToggle = ::toggle,
                    onProfileClick = { showProfilesDialog = true },
                    onAdd = { tab = 1 },
                    onSettings = { tab = 3 }
                )
                1 -> ProfilesScreen(
                    profiles = profiles,
                    activeId = activeId,
                    onSelect = ::select,
                    onDelete = ::delete,
                    onImport = ::importText
                )
                2 -> LogsScreen()
                else -> SettingsScreen()
            }
        }
    }

    if (showProfilesDialog) {
        ProfileDialog(
            profiles = profiles,
            activeId = activeId,
            onSelect = { select(it); showProfilesDialog = false },
            onDismiss = { showProfilesDialog = false }
        )
    }
}

@Composable
private fun ExaNav(selected: Int, onSelect: (Int) -> Unit) {
    NavigationBar(containerColor = ExaSurface, contentColor = ExaText, tonalElevation = 0.dp) {
        val items = listOf(
            Triple("Главная", Icons.Rounded.Home, 0),
            Triple("Профили", Icons.Rounded.Dns, 1),
            Triple("Логи", Icons.Rounded.Article, 2),
            Triple("Ещё", Icons.Rounded.Settings, 3)
        )
        items.forEach { (label, icon, index) ->
            NavigationBarItem(
                selected = selected == index,
                onClick = { onSelect(index) },
                icon = { Icon(icon, contentDescription = label) },
                label = { Text(label, fontSize = 11.sp) },
                colors = NavigationBarItemDefaults.colors(
                    selectedIconColor = ExaRed,
                    selectedTextColor = ExaText,
                    indicatorColor = ExaRed.copy(alpha = 0.14f),
                    unselectedIconColor = ExaMuted2,
                    unselectedTextColor = ExaMuted2
                )
            )
        }
    }
}

@Composable
private fun HomeScreen(
    state: VpnState,
    active: Profile?,
    profileCount: Int,
    onToggle: () -> Unit,
    onProfileClick: () -> Unit,
    onAdd: () -> Unit,
    onSettings: () -> Unit
) {
    val connected = state is VpnState.Connected
    val connecting = state is VpnState.Connecting
    val error = (state as? VpnState.Error)?.message

    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(horizontal = 18.dp, vertical = 16.dp),
        verticalArrangement = Arrangement.spacedBy(14.dp)
    ) {
        BrandHeader(onSettings)
        HeroCard(connected, connecting, error, active, onToggle)
        ProfileCard(active, onProfileClick, onAdd)
        InfoCard(profileCount)
        Text(
            "EXA // SECURE TUNNEL // VLESS",
            color = ExaMuted2,
            fontSize = 9.sp,
            letterSpacing = 1.8.sp,
            modifier = Modifier.align(Alignment.CenterHorizontally).padding(top = 4.dp)
        )
    }
}

@Composable
private fun BrandHeader(onSettings: () -> Unit) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        Image(
            painter = painterResource(R.drawable.exa_logo),
            contentDescription = "EXA",
            modifier = Modifier.height(44.dp)
        )
        Spacer(Modifier.width(12.dp))
        Column(Modifier.weight(1f)) {
            Text("EXA", fontSize = 26.sp, fontWeight = FontWeight.Black, letterSpacing = 1.sp)
            Text("SECURE TUNNEL // VLESS", fontSize = 9.sp, color = ExaMuted2, letterSpacing = 1.4.sp)
        }
        IconButton(onClick = onSettings) {
            Icon(Icons.Rounded.Settings, contentDescription = "Настройки", tint = ExaMuted)
        }
    }
}

@Composable
private fun HeroCard(
    connected: Boolean,
    connecting: Boolean,
    error: String?,
    active: Profile?,
    onToggle: () -> Unit
) {
    Card(
        shape = RoundedCornerShape(22.dp),
        colors = CardDefaults.cardColors(containerColor = ExaSurface),
        border = BorderStroke(1.dp, ExaLine)
    ) {
        Box(Modifier.fillMaxWidth().height(320.dp)) {
            Image(
                painter = painterResource(R.drawable.exa_hero),
                contentDescription = null,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
                alpha = 0.28f
            )
            Box(
                Modifier.fillMaxSize().background(
                    Brush.verticalGradient(
                        listOf(Color.Transparent, ExaSurface.copy(alpha = 0.82f), ExaSurface)
                    )
                )
            )
            Column(
                Modifier.fillMaxSize().padding(20.dp),
                verticalArrangement = Arrangement.SpaceBetween
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    StatusDot(connected)
                    Spacer(Modifier.width(8.dp))
                    Text(
                        when {
                            connected -> "Подключено"
                            connecting -> "Подключение…"
                            else -> "Отключено"
                        },
                        fontWeight = FontWeight.Bold,
                        fontSize = 15.sp
                    )
                    Spacer(Modifier.weight(1f))
                    Text("EXA // 001", fontSize = 9.sp, color = ExaMuted2, letterSpacing = 1.2.sp)
                }

                Column(
                    Modifier.fillMaxWidth(),
                    horizontalAlignment = Alignment.CenterHorizontally
                ) {
                    Box(
                        Modifier.size(114.dp).clip(CircleShape)
                            .background(if (connected) ExaGreen.copy(alpha = 0.10f) else ExaRed.copy(alpha = 0.10f))
                            .border(1.dp, if (connected) ExaGreen else ExaRed, CircleShape)
                            .clickable { onToggle() },
                        contentAlignment = Alignment.Center
                    ) {
                        if (connecting) {
                            CircularProgressIndicator(
                                modifier = Modifier.size(40.dp),
                                color = ExaAmber,
                                strokeWidth = 3.dp
                            )
                        } else {
                            Icon(
                                Icons.Rounded.PowerSettingsNew,
                                contentDescription = null,
                                tint = if (connected) ExaGreen else ExaRed,
                                modifier = Modifier.size(52.dp)
                            )
                        }
                    }
                    Spacer(Modifier.height(12.dp))
                    Text(
                        if (connected) "Отключить" else "Подключить",
                        fontWeight = FontWeight.Bold,
                        fontSize = 17.sp
                    )
                    Text(
                        if (active != null) "${active.name} · ${active.host}:${active.port}" else "Нет профиля",
                        fontSize = 12.sp,
                        color = ExaMuted,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis
                    )
                }

                Text(
                    error ?: if (connected) "Весь трафик идёт через VLESS" else "Нажми, чтобы включить VPN",
                    color = if (error != null) ExaRed else ExaMuted2,
                    fontSize = 11.sp,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.align(Alignment.CenterHorizontally)
                )
            }
        }
    }
}

@Composable
private fun ProfileCard(active: Profile?, onProfileClick: () -> Unit, onAdd: () -> Unit) {
    ExaCard {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("Профиль", fontSize = 11.sp, color = ExaMuted2)
                Text(
                    active?.name ?: "Не выбран",
                    fontWeight = FontWeight.Bold,
                    fontSize = 16.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    active?.let { "${it.security.uppercase()} // ${it.network.uppercase()}" }
                        ?: "Добавь vless://",
                    fontSize = 11.sp,
                    color = ExaMuted
                )
            }
            TextButton(onClick = onProfileClick) { Text("Выбрать") }
            Button(onClick = onAdd) { Text("Добавить") }
        }
    }
}

@Composable
private fun InfoCard(profileCount: Int) {
    val xray = remember { XrayBridge.version() }
    ExaCard {
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            InfoItem("Xray", xray, Modifier.weight(1f))
            InfoItem("SOCKS", "127.0.0.1:${XrayConfig.SOCKS_PORT}", Modifier.weight(1f))
            InfoItem("Профилей", profileCount.toString(), Modifier.weight(0.7f))
        }
    }
}

@Composable
private fun InfoItem(label: String, value: String, modifier: Modifier = Modifier) {
    Column(modifier) {
        Text(label, fontSize = 9.sp, color = ExaMuted2, letterSpacing = 0.8.sp)
        Text(
            value,
            fontSize = 11.sp,
            color = ExaText,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis
        )
    }
}

@Composable
private fun ProfilesScreen(
    profiles: List<Profile>,
    activeId: String?,
    onSelect: (String) -> Unit,
    onDelete: (Profile) -> Unit,
    onImport: (String) -> Unit
) {
    LazyColumn(
        Modifier.fillMaxSize().padding(horizontal = 18.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Column(Modifier.padding(top = 16.dp)) {
                Text("Профили", fontSize = 24.sp, fontWeight = FontWeight.Black)
                Text(
                    "VLESS // Reality // TLS // WS // gRPC",
                    fontSize = 10.sp,
                    color = ExaMuted2,
                    letterSpacing = 1.2.sp
                )
            }
        }
        item { ImportCard(onImport) }
        if (profiles.isEmpty()) {
            item {
                ExaCard {
                    Text(
                        "Пока нет профилей. Вставь ссылку vless://… или HTTPS-подписку выше.",
                        color = ExaMuted,
                        fontSize = 13.sp
                    )
                }
            }
        } else {
            items(profiles, key = { it.id }) { profile ->
                ProfileCardItem(
                    profile = profile,
                    selected = profile.id == activeId,
                    onSelect = { onSelect(profile.id) },
                    onDelete = { onDelete(profile) }
                )
            }
        }
        item { Spacer(Modifier.height(24.dp)) }
    }
}

@Composable
private fun ImportCard(onImport: (String) -> Unit) {
    var text by rememberSaveable { mutableStateOf("") }
    val clipboard = LocalClipboardManager.current
    ExaCard {
        Text("Добавить конфигурацию", fontWeight = FontWeight.Bold, fontSize = 15.sp)
        Spacer(Modifier.height(8.dp))
        OutlinedTextField(
            value = text,
            onValueChange = { text = it },
            modifier = Modifier.fillMaxWidth().heightIn(min = 112.dp),
            minLines = 3,
            maxLines = 6,
            placeholder = { Text("vless://... или https:// подписка", fontSize = 12.sp) },
            textStyle = MaterialTheme.typography.bodySmall.copy(fontFamily = FontFamily.Monospace)
        )
        Row(
            Modifier.fillMaxWidth().padding(top = 8.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            TextButton(onClick = { clipboard.getText()?.text?.let { text = it } }) {
                Icon(Icons.Rounded.ContentPaste, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(5.dp))
                Text("Вставить", fontSize = 12.sp)
            }
            Spacer(Modifier.weight(1f))
            Button(
                onClick = { onImport(text); text = "" },
                enabled = text.isNotBlank()
            ) { Text("Импортировать") }
        }
        Text(
            "Подписки только по https://. При импорте проверяется лимит 2 МБ.",
            fontSize = 10.sp,
            color = ExaMuted2
        )
    }
}

@Composable
private fun ProfileCardItem(
    profile: Profile,
    selected: Boolean,
    onSelect: () -> Unit,
    onDelete: () -> Unit
) {
    Card(
        modifier = Modifier.fillMaxWidth().clickable { onSelect() },
        shape = RoundedCornerShape(16.dp),
        colors = CardDefaults.cardColors(
            containerColor = if (selected) ExaRed.copy(alpha = 0.055f) else ExaSurface
        ),
        border = BorderStroke(1.dp, if (selected) ExaRed.copy(alpha = 0.38f) else ExaLine)
    ) {
        Row(
            Modifier.fillMaxWidth().padding(12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            RadioButton(
                selected = selected,
                onClick = onSelect,
                colors = RadioButtonDefaults.colors(selectedColor = ExaRed)
            )
            Column(Modifier.weight(1f)) {
                Text(
                    profile.name,
                    fontWeight = FontWeight.Bold,
                    fontSize = 14.sp,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Text(
                    "${profile.host}:${profile.port}",
                    fontSize = 10.5.sp,
                    color = ExaMuted,
                    fontFamily = FontFamily.Monospace,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
                Row(horizontalArrangement = Arrangement.spacedBy(5.dp), modifier = Modifier.padding(top = 4.dp)) {
                    Badge(profile.security)
                    Badge(profile.network)
                }
            }
            IconButton(onClick = onDelete) {
                Icon(Icons.Rounded.Delete, contentDescription = "Удалить", tint = ExaMuted2)
            }
        }
    }
}

@Composable
private fun Badge(text: String) {
    Surface(
        color = ExaRed.copy(alpha = 0.10f),
        contentColor = ExaRed,
        shape = RoundedCornerShape(50)
    ) {
        Text(
            text.uppercase(),
            fontSize = 8.5.sp,
            fontWeight = FontWeight.Bold,
            letterSpacing = 0.5.sp,
            modifier = Modifier.padding(horizontal = 7.dp, vertical = 2.dp)
        )
    }
}

@Composable
private fun LogsScreen() {
    val logs by VpnLog.lines.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    LaunchedEffect(logs.size) {
        if (logs.isNotEmpty()) listState.animateScrollToItem(logs.lastIndex)
    }
    Column(Modifier.fillMaxSize().padding(horizontal = 18.dp)) {
        Row(
            Modifier.fillMaxWidth().padding(top = 16.dp, bottom = 10.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(Modifier.weight(1f)) {
                Text("Логи", fontSize = 24.sp, fontWeight = FontWeight.Black)
                Text("core, VPN, HEV", fontSize = 10.sp, color = ExaMuted2, letterSpacing = 1.2.sp)
            }
            TextButton(onClick = { VpnLog.clear() }) { Text("Очистить") }
        }
        ExaCard(Modifier.weight(1f)) {
            if (logs.isEmpty()) {
                Text("Пока пусто. Подключись, и здесь появятся события.", color = ExaMuted, fontSize = 12.sp)
            } else {
                LazyColumn(state = listState, modifier = Modifier.fillMaxSize()) {
                    items(logs) { line ->
                        Text(
                            line,
                            fontFamily = FontFamily.Monospace,
                            fontSize = 10.5.sp,
                            color = ExaMuted,
                            modifier = Modifier.padding(vertical = 2.dp)
                        )
                    }
                }
            }
        }
        Spacer(Modifier.height(16.dp))
    }
}

@Composable
private fun SettingsScreen() {
    val context = LocalContext.current
    var autoConnect by remember { mutableStateOf(ProfileStore.autoConnect(context)) }
    Column(
        Modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(18.dp),
        verticalArrangement = Arrangement.spacedBy(12.dp)
    ) {
        Text("Ещё", fontSize = 24.sp, fontWeight = FontWeight.Black)
        ExaCard {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("Автоподключение", fontWeight = FontWeight.Bold)
                    Text("При загрузке Android, если VPN уже разрешён", fontSize = 11.sp, color = ExaMuted)
                }
                Switch(
                    checked = autoConnect,
                    onCheckedChange = {
                        autoConnect = it
                        ProfileStore.setAutoConnect(context, it)
                    },
                    colors = SwitchDefaults.colors(checkedThumbColor = ExaRed)
                )
            }
        }
        ExaCard {
            Text("О приложении", fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            Text("EXA // SECURE TUNNEL", fontSize = 12.sp, color = ExaMuted)
            Text("Версия ${BuildConfig.VERSION_NAME}", fontSize = 12.sp, color = ExaMuted)
            Text("Xray: ${XrayBridge.version()}", fontSize = 12.sp, color = ExaMuted, maxLines = 2, overflow = TextOverflow.Ellipsis)
            Spacer(Modifier.height(8.dp))
            Text(
                "Android VPN-клиент: весь системный трафик через VLESS/Reality. Без рекламы и телеметрии.",
                fontSize = 11.sp,
                color = ExaMuted2
            )
            TextButton(onClick = {
                runCatching {
                    context.startActivity(
                        Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/GretskyOleg/exa-switch"))
                    )
                }
            }) { Text("GitHub") }
        }
        ExaCard {
            Text("Как пользоваться", fontWeight = FontWeight.Bold)
            Spacer(Modifier.height(6.dp))
            Text(
                "1. Профили → вставь vless://… → Импортировать\n" +
                    "2. Выбери профиль\n" +
                    "3. Нажми Подключить и разреши VPN\n" +
                    "4. Готово — весь трафик идёт через твой сервер",
                fontSize = 12.sp,
                color = ExaMuted,
                lineHeight = 18.sp
            )
        }
        Spacer(Modifier.height(12.dp))
    }
}

@Composable
private fun ProfileDialog(
    profiles: List<Profile>,
    activeId: String?,
    onSelect: (String) -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Профиль") },
        text = {
            if (profiles.isEmpty()) {
                Text("Нет профилей. Добавь vless:// на вкладке «Профили».")
            } else {
                LazyColumn {
                    items(profiles, key = { it.id }) { profile ->
                        Row(
                            Modifier.fillMaxWidth().clickable { onSelect(profile.id) }
                                .padding(vertical = 6.dp),
                            verticalAlignment = Alignment.CenterVertically
                        ) {
                            RadioButton(
                                selected = profile.id == activeId,
                                onClick = { onSelect(profile.id) },
                                colors = RadioButtonDefaults.colors(selectedColor = ExaRed)
                            )
                            Column {
                                Text(profile.name, fontWeight = FontWeight.Bold)
                                Text(
                                    "${profile.host}:${profile.port}",
                                    fontSize = 11.sp,
                                    color = ExaMuted
                                )
                            }
                        }
                    }
                }
            }
        },
        confirmButton = {
            TextButton(onClick = onDismiss) { Text("Закрыть") }
        },
        containerColor = ExaSurface,
        titleContentColor = ExaText,
        textContentColor = ExaText
    )
}

@Composable
private fun ExaCard(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Card(
        modifier = modifier.fillMaxWidth(),
        shape = RoundedCornerShape(18.dp),
        colors = CardDefaults.cardColors(containerColor = ExaSurface),
        border = BorderStroke(1.dp, ExaLine)
    ) {
        Column(Modifier.padding(16.dp), content = content)
    }
}

@Composable
private fun StatusDot(on: Boolean) {
    Box(
        Modifier.size(9.dp).clip(CircleShape)
            .background(if (on) ExaGreen else ExaMuted2)
            .then(
                if (on) Modifier.border(1.dp, ExaGreen.copy(alpha = 0.5f), CircleShape)
                else Modifier
            )
    )
}
