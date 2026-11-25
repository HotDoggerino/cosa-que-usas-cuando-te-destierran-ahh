// =============================================================================
//  "cosa que usas cuando te botan del grupo"
//  Proxy entre un grupo A y una persona, a través de un grupo X.
// =============================================================================
//
//  QUÉ HACE
//  --------
//  Tu propia cuenta de WhatsApp (la que vinculas con el QR) hace de puente:
//    - Todo lo que se escribe en el grupo A se copia al grupo X (el proxy).
//    - Lo que escribe en X el usuario que elegiste sale en A desde tu cuenta,
//      con su apodo delante ("Pepe: Hola") para que se sepa quién lo dice.
//
//  CÓMO SE USA
//  -----------
//  1. En el grupo X (el proxy):   /select @usuario [apodo]   (o número, o respondiendo a un mensaje suyo)
//     /nick Pepe  cambia el apodo con el que salen sus mensajes en A ("Pepe: Hola")
//  2. En el grupo A (el real):    /invoke
//  3. Todo lo de A se copia a X. Lo que escriba @usuario en X sale en A desde tu cuenta.
//     /stop (en cualquiera de los dos) lo desactiva.  /status muestra el estado.
//
//  Los comandos solo los acepta si los envía tu propia cuenta (la conectada).
//  Nadie más del grupo puede activar, cambiar ni desactivar el proxy.
//
// =============================================================================
//  TRANSPARENCIA: QUÉ HACE Y QUÉ NO HACE CON TUS DATOS
// =============================================================================
//
//  ✔ Todo se ejecuta en TU máquina. No hay servidor propio, ni panel remoto,
//    ni base de datos en la nube, ni telemetría, ni analíticas.
//
//  ✔ Las ÚNICAS conexiones a internet que se hacen son:
//      1. A los servidores de WhatsApp (wss://web.whatsapp.com y sus servidores
//         de archivos). Es exactamente lo mismo que hace WhatsApp Web cuando
//         vinculas un dispositivo. Los mensajes viajan cifrados igual que siempre.
//      2. Una petición GET a raw.githubusercontent.com (repositorio público de
//         Baileys) solo para saber qué número de versión de WhatsApp Web usar.
//         No se envía ningún dato tuyo en esa petición. Ver fetchLatestBaileysVersion().
//    No hay ningún fetch(), webhook ni envío a ninguna otra dirección. Puedes
//    comprobarlo buscando "http" / "fetch" en este archivo.
//
//  ✔ La sesión (las claves que genera el QR) se guarda SOLO en la carpeta
//    ./auth de tu disco. El script no la lee para nada más, no la copia ni la
//    envía a ningún sitio. Si borras ./auth, la sesión desaparece.
//    También puedes cerrarla desde el móvil: WhatsApp → Dispositivos vinculados.
//
//  ✔ La web del QR solo escucha en 127.0.0.1 (tu propio equipo). Nadie desde
//    otra máquina, ni desde tu red local ni desde internet, puede abrirla.
//    Además rechaza peticiones cuyo "Host" no sea localhost (ver abajo).
//
//  ✔ No se guarda ningún historial de mensajes. Cada mensaje se procesa en
//    memoria, se reenvía y se olvida. En disco solo queda ./state.json con la
//    configuración (qué grupos y qué usuario), nada de contenido.
//
//  ✔ Los registros (logger) están en modo "silent": ni siquiera se escriben
//    los mensajes en la consola.
//
//  ⚠ Ten en cuenta: por diseño, lo que se dice en el grupo A se copia al grupo X.
//    Cualquiera que esté en X lo verá, y los miembros de A no reciben ningún
//    aviso de ello. Decide tú quién está en X.
//
// =============================================================================

// Baileys: librería que habla el protocolo de WhatsApp Web directamente por
// WebSocket. NO abre un navegador (sin Puppeteer/Chrome) y NO usa ninguna API
// de terceros: se conecta a WhatsApp como un "dispositivo vinculado" más.
import makeWASocket, {
  useMultiFileAuthState,     // guarda/lee la sesión en archivos locales (./auth)
  DisconnectReason,
  fetchLatestBaileysVersion, // única petición fuera de WhatsApp (ver cabecera)
  downloadMediaMessage,      // descarga archivos desde los servidores de WhatsApp
  getContentType,
  jidNormalizedUser,
  normalizeMessageContent,
} from '@whiskeysockets/baileys'
import QRCode from 'qrcode' // convierte el QR en imagen, en local, sin red
import pino from 'pino'     // logger; está en modo silent
import http from 'node:http' // servidor web mínimo para mostrar el QR (solo localhost)
import fs from 'node:fs'     // para leer/escribir ./state.json y ./auth en tu disco

const PORT = process.env.PORT || 3000
const STATE_FILE = './state.json' // solo configuración, nunca contenido de mensajes

// "silent": no se registra nada, ni en consola ni en archivos.
const logger = pino({ level: 'silent' })

// ---------- estado persistente (local) ----------
// Lo único que se guarda: id del grupo proxy (X), id del grupo destino (A),
// id del usuario elegido, su apodo y si está activo. Nada de mensajes.
let state = { proxy: null, user: null, target: null, active: false }
try { state = { ...state, ...JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } } catch { }
const save = () => fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))

// ---------- estado de conexión para la UI ----------
// Viven solo en memoria y solo se muestran en la web local.
let qrDataUrl = null
let connected = false
let me = null

// Ids de mensajes que manda el propio script, para no reenviarlos otra vez
// (evita bucles A -> X -> A). Solo ids, no contenido; se borran al usarse.
const sentByBot = new Set()

// ---------- utilidades ----------
// Extrae el texto o pie de foto de un mensaje (solo para reenviarlo).
const textOf = (m) =>
  m?.conversation ||
  m?.extendedTextMessage?.text ||
  m?.imageMessage?.caption ||
  m?.videoMessage?.caption ||
  m?.documentMessage?.caption ||
  ''

const ctxOf = (m) => m?.[getContentType(m)]?.contextInfo
const MEDIA = ['imageMessage', 'videoMessage', 'ptvMessage', 'audioMessage', 'stickerMessage', 'documentMessage']

// El remitente puede venir como @lid o como @s.whatsapp.net: comparamos ambos.
const senderIds = (key) =>
  [key.participant, key.participantAlt].filter(Boolean).map(jidNormalizedUser)

async function start() {
  // La sesión se lee/escribe SOLO en ./auth. No sale de tu equipo.
  const { state: auth, saveCreds } = await useMultiFileAuthState('./auth')

  // Única petición externa que no es a WhatsApp: consulta el número de versión
  // de WhatsApp Web en el repo público de Baileys. No envía datos tuyos.
  const { version } = await fetchLatestBaileysVersion()

  // Conexión directa a los servidores de WhatsApp como dispositivo vinculado.
  // Aparecerá en tu móvil como "Proxy" en Dispositivos vinculados.
  const sock = makeWASocket({ auth, version, logger, browser: ['Proxy', 'Chrome', '1.0'] })

  // Envía un mensaje por WhatsApp y apunta su id para no reenviarlo en bucle.
  const send = async (jid, content, opts) => {
    const r = await sock.sendMessage(jid, content, opts)
    if (r?.key?.id) sentByBot.add(r.key.id)
    return r
  }
  const reply = (msg, text) => send(msg.key.remoteJid, { text }, { quoted: msg })

  // Cuando WhatsApp renueva las claves de sesión, se guardan en ./auth (local).
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // El QR se convierte en imagen en memoria y solo se muestra en la web local.
      qrDataUrl = await QRCode.toDataURL(qr)
      console.log(`QR listo -> http://localhost:${PORT}`)
    }
    if (connection === 'open') {
      connected = true
      qrDataUrl = null
      me = sock.user
      console.log('Conectado como', me?.id)
    }
    if (connection === 'close') {
      connected = false
      const code = lastDisconnect?.error?.output?.statusCode
      if (code === DisconnectReason.loggedOut) {
        // Si cierras la sesión desde el móvil, se borran las claves locales.
        console.log('Sesión cerrada desde el móvil. Se borra ./auth; vuelve a escanear.')
        fs.rmSync('./auth', { recursive: true, force: true })
      }
      setTimeout(start, 2000) // reconecta (o muestra un QR nuevo)
    }
  })

  // Cada mensaje nuevo que recibe tu cuenta pasa por aquí. Solo se actúa sobre
  // los grupos X y A configurados; el resto de chats se ignoran por completo.
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return
    for (const msg of messages) {
      try { await handle(msg) } catch (e) { console.error('error:', e.message) }
    }
  })

  // Reintenta una operación de red hasta 3 veces (para no perder mensajes).
  const retry = async (fn, tries = 3) => {
    for (let i = 1; ; i++) {
      try { return await fn() } catch (e) {
        if (i >= tries) throw e
        await new Promise((r) => setTimeout(r, 1000 * i))
      }
    }
  }

  // Reenvía cualquier mensaje (texto, imagen, video, gif, sticker, audio, documento)
  // re-subiendo el archivo, con "*label:*" delante para saber quién lo mandó.
  // Los archivos se descargan a MEMORIA (buffer), se vuelven a subir a WhatsApp
  // y se descartan: nunca se escriben en disco.
  async function relay(msg, to, label) {
    const m = normalizeMessageContent(msg.message)
    const type = getContentType(m)
    const tag = `*${label}:*`
    const text = textOf(m).trim()

    if (!MEDIA.includes(type)) {
      if (text) await retry(() => send(to, { text: `${tag} ${text}` }))
      return
    }

    const src = m[type]
    let buf
    try {
      // Descarga desde los servidores de WhatsApp (los mismos que usa la app).
      buf = await retry(() =>
        downloadMediaMessage({ ...msg, message: m }, 'buffer', {}, { logger, reuploadRequest: sock.updateMediaMessage }),
      )
    } catch (e) {
      await send(to, { text: `${tag} [no se pudo descargar ${type.replace('Message', '')}: ${e.message}]` })
      return
    }

    const caption = text ? `${tag} ${text}` : tag
    let content
    switch (type) {
      case 'imageMessage':
        content = { image: buf, caption }
        break
      case 'videoMessage': // incluye GIFs (gifPlayback)
        content = { video: buf, caption, mimetype: src.mimetype || 'video/mp4', gifPlayback: !!src.gifPlayback }
        break
      case 'ptvMessage': // video circular
        await send(to, { text: tag })
        content = { video: buf, ptv: true, mimetype: src.mimetype || 'video/mp4' }
        break
      case 'stickerMessage': // los stickers no admiten caption: va el nombre antes
        await send(to, { text: tag })
        content = { sticker: buf }
        break
      case 'audioMessage':
        await send(to, { text: tag })
        content = { audio: buf, mimetype: src.mimetype || 'audio/ogg; codecs=opus', ptt: !!src.ptt }
        break
      case 'documentMessage':
        content = { document: buf, mimetype: src.mimetype, fileName: src.fileName || 'archivo', caption }
        break
    }
    await retry(() => send(to, content))
  }

  async function handle(msg) {
    const jid = msg.key.remoteJid
    const m = normalizeMessageContent(msg.message)
    // Solo grupos. Los chats privados se ignoran siempre: nunca se leen ni reenvían.
    if (!m || !jid?.endsWith('@g.us')) return
    if (sentByBot.has(msg.key.id)) return sentByBot.delete(msg.key.id)

    const text = textOf(m).trim()

    // ----- comandos (solo tu cuenta: msg.key.fromMe) -----
    // Nadie más puede controlar el proxy, aunque escriba los mismos comandos.
    if (msg.key.fromMe && text.startsWith('/')) {
      const [cmd, ...args] = text.split(/\s+/)

      if (cmd === '/select') {
        const ctx = ctxOf(m)
        let user = ctx?.mentionedJid?.[0] || ctx?.participant
        const digits = args.join('').replace(/\D/g, '')
        if (!user && digits) user = `${digits}@s.whatsapp.net`
        if (!user) return reply(msg, 'Uso: /select @usuario [apodo]  (o número, o respondiendo a un mensaje suyo)')
        // apodo opcional: lo que no sea @mención ni número
        const nick = args.filter((a) => !a.startsWith('@') && !/^\+?\d+$/.test(a)).join(' ') || null
        state = { proxy: jid, user: jidNormalizedUser(user), nick, fixedNick: !!nick, target: null, active: false }
        save()
        return reply(msg, `✅ Cargado: ${state.nick || state.user.split('@')[0]}\nAhora ve al grupo A y escribe /invoke`)
      }

      if (cmd === '/nick') {
        if (!args.length) return reply(msg, 'Uso: /nick Pepe')
        state.nick = args.join(' ')
        state.fixedNick = true
        save()
        return reply(msg, `✅ Apodo: ${state.nick}`)
      }

      if (cmd === '/invoke') {
        if (!state.proxy || !state.user) return reply(msg, 'Primero haz /select en el grupo proxy.')
        if (jid === state.proxy) return reply(msg, '/invoke va en el grupo A, no en el proxy.')
        state.target = jid
        state.active = true
        save()
        const meta = await sock.groupMetadata(jid).catch(() => null)
        await send(state.proxy, { text: `🟢 Proxy activo con "${meta?.subject || jid}"` })
        return
      }

      if (cmd === '/stop') {
        // Desactiva el reenvío al momento en los dos sentidos.
        state.active = false
        save()
        if (state.proxy) await send(state.proxy, { text: '🔴 Proxy desactivado' })
        return
      }

      if (cmd === '/status') {
        return reply(msg, '```' + JSON.stringify(state, null, 2) + '```')
      }
    }

    // Si el proxy no está activo, no se reenvía absolutamente nada.
    if (!state.active) return

    // ----- A -> X : se copia todo lo del grupo A al grupo proxy -----
    if (jid === state.target) {
      const who = msg.key.fromMe ? 'Yo' : msg.pushName || (msg.key.participant || '').split('@')[0]
      return relay(msg, state.proxy, who)
    }

    // ----- X -> A : solo el usuario seleccionado, con su apodo delante -----
    // Lo que escriba cualquier otra persona en X NO sale en A.
    if (jid === state.proxy && senderIds(msg.key).includes(state.user)) {
      if (!state.fixedNick && msg.pushName && msg.pushName !== state.nick) {
        state.nick = msg.pushName
        save()
      }
      return relay(msg, state.target, state.nick || state.user.split('@')[0])
    }

    // Cualquier otro grupo: se ignora.
  }
}

// =============================================================================
//  UI web mínima (solo en tu equipo)
// =============================================================================
// Muestra el QR para vincular y si está conectado. No carga nada de internet
// (sin CDNs, sin fuentes externas, sin scripts de terceros): todo está aquí.
// Los datos se pintan con textContent (no innerHTML) para que un nombre de
// WhatsApp con código raro no pueda ejecutarse en la página.
const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>WSP Proxy</title>
<style>
  body{font-family:system-ui,sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0}
  .card{background:#1c1c1c;padding:24px;border-radius:12px;text-align:center;max-width:360px;width:100%}
  img{width:280px;height:280px;background:#fff;border-radius:8px}
  .ok{color:#3ddc84;font-size:20px} pre{text-align:left;background:#000;padding:10px;border-radius:6px;font-size:12px;overflow:auto}
  small{color:#888}
</style></head><body><div class="card"><h2>cosa que usas cuando te botan</h2><div id="c">Cargando…</div>
<small>Se ejecuta solo en tu equipo · sesión guardada en ./auth</small></div>
<script>
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e }
async function tick(){
  const s = await fetch('/status').then(r=>r.json()).catch(()=>null)
  const c = document.getElementById('c')
  c.replaceChildren()
  if(!s){ c.textContent='Servidor caído'; return }
  if(s.connected){
    c.append(el('p','ok','● Conectado'), el('p',null,s.me||''), el('pre',null,JSON.stringify(s.state,null,2)))
  } else if(s.qr){
    const img = el('img'); img.src = s.qr
    c.append(el('p',null,'Escanea con WhatsApp → Dispositivos vinculados'), img)
  } else c.textContent='Esperando QR…'
}
tick(); setInterval(tick, 2000)
</script></body></html>`

http.createServer((req, res) => {
  // Protección extra: solo se responde si la petición va dirigida a localhost.
  // Evita que una web maliciosa use trucos de DNS (DNS rebinding) para leer
  // esta página desde tu navegador.
  const host = (req.headers.host || '').split(':')[0]
  if (!['localhost', '127.0.0.1'].includes(host)) {
    res.writeHead(403)
    return res.end('Solo accesible desde localhost')
  }

  if (req.url === '/status') {
    res.writeHead(200, { 'content-type': 'application/json' })
    return res.end(JSON.stringify({ connected, qr: qrDataUrl, me: me?.id, state }))
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
  res.end(page)
})
  // 127.0.0.1 = solo tu propio equipo. NO se usa 0.0.0.0, así que ni tu red
  // local ni internet pueden conectarse a este puerto.
  .listen(PORT, '127.0.0.1', () => console.log(`UI en http://localhost:${PORT} (solo accesible desde este equipo)`))

start()
