# cosa que usas cuando te botan del grupo

Proxy local de WhatsApp: si te botan de un grupo, sigue leyendo y escribiendo en él a través de un grupo puente.

Tu cuenta (vinculada por QR) copia todo lo del grupo **A** a un grupo **X**, y lo que escribe en X el usuario elegido sale en A con su apodo (`Pepe: Hola`). Texto, imágenes, videos, GIFs, stickers, audios y documentos.

Todo corre en tu equipo: sin servidores propios ni telemetría; la sesión queda en `./auth` y la web solo escucha en `localhost`.

## Uso (Termux)

```bash
bash run     # instala Node y dependencias (una vez)
./start      # arranca; abre http://localhost:3000 y vincula WhatsApp
```

## Comandos (solo desde tu cuenta)

| Dónde | Comando | Qué hace |
|---|---|---|
| Grupo X | `/select @usuario [apodo]` | Elige quién habla por el proxy |
| Grupo X | `/nick Pepe` | Cambia el apodo |
| Grupo A | `/invoke` | Activa el proxy |
| X o A | `/stop` | Lo desactiva |
| X o A | `/status` | Muestra la configuración |
